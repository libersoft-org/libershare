import { mkdir, readdir, rm, stat } from 'fs/promises';
import { rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { CodedError, ErrorCodes, MAX_API_MESSAGE_SIZE, MAX_UPLOAD_CHUNK_SIZE, formatBytes, sanitizeFilename } from '@shared';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;

/** Longest original file name kept in a temp upload name, so a pathological name cannot blow the OS limit. */
const MAX_UPLOAD_NAME_LENGTH = 100;

/** How long an uploaded file that was never imported is kept before it is swept. */
const UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Transfers one client may have open at once. Each holds an open file handle and
 * may grow to the size ceiling, so an unbounded number of them is a way to fill
 * the disk from a single socket.
 */
const MAX_CONCURRENT_UPLOADS = 4;

/**
 * Temp file name for an uploaded import file. The random prefix keeps concurrent
 * uploads apart; the original name is appended verbatim because
 * `detectCompression()` reads the trailing extension — losing it would make a
 * brotli upload get read as UTF-8 and fail later as a JSON parse error.
 */
export function uploadFileName(originalName: string): string {
	const safe = sanitizeFilename(originalName).slice(-MAX_UPLOAD_NAME_LENGTH) || 'upload';
	return `${randomUUID()}-${safe}`;
}

interface Upload {
	path: string;
	writer: ReturnType<ReturnType<typeof Bun.file>['writer']>;
	written: number;
	/** Socket that started the transfer; nothing else may append to it or finish it. */
	client: unknown;
}

interface UploadHandlers {
	begin: (p: { name?: string }, client: unknown) => Promise<{ uploadID: string }>;
	chunk: (p: { uploadID: string; data: Uint8Array }, client: unknown) => Promise<{ received: number }>;
	end: (p: { uploadID: string }, client: unknown) => Promise<{ path: string }>;
	abort: (p: { uploadID: string }, client: unknown) => Promise<void>;
	/** Drop every transfer a disconnecting socket left half-written. */
	closeClient: (client: unknown) => void;
	/** Remove the whole temp directory, for use before the server starts listening. */
	wipe: () => void;
}

/**
 * Receive an import file in chunks over the API WebSocket and assemble it into a
 * temp file under the data directory. The client then imports it through the
 * existing `*.parseFromFile` handlers, which take a path.
 *
 * Chunking is what makes this work at all: a whole file in one message blows the
 * frame limit and takes the socket down with it. The bytes ride binary frames
 * (see `decodeBinaryRequest`) rather than base64 in JSON, so they cost their own
 * size and nothing more.
 *
 * `maxUploadSize` is only ever overridden by tests, which would otherwise have to
 * write the real ceiling to disk to reach it.
 */
export function initUploadHandlers(dataDir: string, maxUploadSize: number = MAX_API_MESSAGE_SIZE): UploadHandlers {
	const uploadDir = join(dataDir, 'tmp');
	const uploads = new Map<string, Upload>();

	/**
	 * Drop uploads nobody ever imported. The client removes its own temp file once
	 * the import is parsed, but a lost response or a killed tab leaves one behind,
	 * and on a node that runs for months the startup wipe alone would let those
	 * pile up until the disk is full. Runs when a transfer starts rather than on a
	 * timer, because that is the only thing that creates them. Never throws: a
	 * failed sweep must not fail the upload it was making room for.
	 */
	async function sweep(): Promise<void> {
		const cutoff = Date.now() - UPLOAD_MAX_AGE_MS;
		try {
			for (const name of await readdir(uploadDir)) {
				const path = join(uploadDir, name);
				// A transfer still running rewrites its mtime on every chunk, so it is never swept.
				try {
					if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
				} catch {}
			}
		} catch {}
	}

	/** Look up a transfer the given socket is allowed to touch. */
	function owned(uploadID: string, client: unknown): Upload {
		const upload = uploads.get(uploadID);
		if (!upload || upload.client !== client) throw new CodedError(ErrorCodes.UPLOAD_NOT_FOUND, uploadID);
		return upload;
	}

	/** Close and delete a partial transfer. Safe to call on one that is already gone. */
	async function discard(uploadID: string): Promise<void> {
		const upload = uploads.get(uploadID);
		if (!upload) return;
		uploads.delete(uploadID);
		// Ending the writer also releases the file handle, which Windows needs
		// before the half-written file can be removed.
		try {
			await upload.writer.end();
		} catch {}
		await rm(upload.path, { force: true }).catch(() => {});
	}

	async function begin(p: { name?: string }, client: unknown): Promise<{ uploadID: string }> {
		let open = 0;
		for (const upload of uploads.values()) if (upload.client === client) open++;
		if (open >= MAX_CONCURRENT_UPLOADS) throw new CodedError(ErrorCodes.TOO_MANY_UPLOADS, String(MAX_CONCURRENT_UPLOADS));
		await mkdir(uploadDir, { recursive: true });
		await sweep();
		const uploadID = randomUUID();
		const path = join(uploadDir, uploadFileName(p.name ?? 'upload'));
		uploads.set(uploadID, { path, writer: Bun.file(path).writer(), written: 0, client });
		console.log(`[API] Upload started: ${uploadID} → ${path}`);
		return { uploadID };
	}

	async function chunk(p: { uploadID: string; data: Uint8Array }, client: unknown): Promise<{ received: number }> {
		assert(p, ['uploadID', 'data']);
		// Ownership first: the discard below must not be reachable for a stranger
		// who merely guessed someone else's upload id.
		const upload = owned(p.uploadID, client);
		// A text frame lands in the same dispatch as a binary one, so `data` can be
		// a string that no envelope ever validated. A string has no `byteLength`,
		// which would turn `written` into NaN — and every later `written > limit`
		// comparison against NaN is false, so the size ceiling would be gone for the
		// rest of the transfer while `FileSink.write()` happily kept writing.
		if (!(p.data instanceof Uint8Array)) {
			await discard(p.uploadID);
			throw new CodedError(ErrorCodes.UPLOAD_INVALID_CHUNK, typeof p.data);
		}
		// The chunk size is a protocol rule, not a frontend preference: without it
		// one client can send a whole file as a single frame, which is exactly the
		// allocation the chunking was introduced to avoid.
		if (p.data.byteLength > MAX_UPLOAD_CHUNK_SIZE) {
			await discard(p.uploadID);
			throw new CodedError(ErrorCodes.UPLOAD_CHUNK_TOO_LARGE, formatBytes(MAX_UPLOAD_CHUNK_SIZE));
		}
		const nextWritten = upload.written + p.data.byteLength;
		// Enforced as the bytes arrive rather than from a declared total, which a
		// client is free to understate. The safe-integer check is the backstop for
		// the counter itself: a limit compared against NaN or Infinity never trips.
		if (!Number.isSafeInteger(nextWritten) || nextWritten > maxUploadSize) {
			await discard(p.uploadID);
			console.error(`[API] Upload rejected: ${p.uploadID} exceeds ${maxUploadSize} bytes`);
			throw new CodedError(ErrorCodes.UPLOAD_TOO_LARGE, formatBytes(maxUploadSize));
		}
		upload.written = nextWritten;
		await upload.writer.write(p.data);
		// Flushed before the response goes out, so the ack the client waits on means
		// the bytes are on disk. Without it the sink would buffer the whole file in
		// memory while the client happily kept sending.
		await upload.writer.flush();
		return { received: upload.written };
	}

	async function end(p: { uploadID: string }, client: unknown): Promise<{ path: string }> {
		assert(p, ['uploadID']);
		const upload = owned(p.uploadID, client);
		uploads.delete(p.uploadID);
		await upload.writer.end();
		console.log(`[API] Upload stored: ${upload.path} (${upload.written} bytes)`);
		return { path: upload.path };
	}

	async function abort(p: { uploadID: string }, client: unknown): Promise<void> {
		assert(p, ['uploadID']);
		// A transfer that is already gone is not an error: the client aborts on any
		// failure, including one that discarded the transfer on its way out.
		const upload = uploads.get(p.uploadID);
		if (!upload || upload.client !== client) return;
		await discard(p.uploadID);
	}

	function closeClient(client: unknown): void {
		for (const [uploadID, upload] of uploads) if (upload.client === client) void discard(uploadID);
	}

	function wipe(): void {
		// Synchronous so no transfer can race the removal, and only ever called
		// before the server accepts connections.
		rmSync(uploadDir, { recursive: true, force: true });
	}

	return { begin, chunk, end, abort, closeClient, wipe };
}
