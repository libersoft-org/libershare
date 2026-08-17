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

	/**
	 * The operation currently running for a socket, and the sockets that have
	 * disconnected. Both are keyed by the socket object itself, so the entries
	 * disappear with the socket rather than accumulating.
	 */
	const inFlight = new WeakMap<object, Promise<void>>();
	const disconnected = new WeakSet<object>();

	/** The socket as a weak-collection key, or null for a non-object caller (tests). */
	function clientKey(client: unknown): object | null {
		return typeof client === 'object' && client !== null ? client : null;
	}

	/** True once the owning socket has closed, so work started before that must stop. */
	function isGone(client: unknown): boolean {
		const key = clientKey(client);
		return key !== null && disconnected.has(key);
	}

	/**
	 * Run one upload operation for a socket, refusing a second while it is in
	 * flight. `Bun.serve` does not await an async `websocket.message` handler — it
	 * dispatches the next frame straight away (measured: five pipelined frames all
	 * entered the handler before the first returned) — so without this every
	 * handler below could run concurrently against the same `Upload`, racing the
	 * size counter, the shared `FileSink` and the map entry itself.
	 *
	 * Refusing rather than queueing is deliberate: a queue has no bound, and the
	 * only client that trips this is one ignoring the ack it is supposed to wait
	 * for.
	 */
	async function exclusive<T>(client: unknown, run: () => Promise<T>): Promise<T> {
		const key = clientKey(client);
		if (!key) return run();
		if (inFlight.has(key)) throw new CodedError(ErrorCodes.UPLOAD_BUSY);
		const result = run();
		// Stored as a promise that always resolves, so disconnect cleanup can wait
		// for the operation to finish without inheriting its rejection.
		inFlight.set(
			key,
			result.then(
				() => {},
				() => {}
			)
		);
		try {
			return await result;
		} finally {
			inFlight.delete(key);
		}
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

	function begin(p: { name?: string }, client: unknown): Promise<{ uploadID: string }> {
		return exclusive(client, async () => {
			let open = 0;
			for (const upload of uploads.values()) if (upload.client === client) open++;
			if (open >= MAX_CONCURRENT_UPLOADS) throw new CodedError(ErrorCodes.TOO_MANY_UPLOADS, String(MAX_CONCURRENT_UPLOADS));
			await mkdir(uploadDir, { recursive: true });
			await sweep();
			// The socket can close while the two awaits above run, and `closeClient`
			// would have found nothing to clean up. Registering the upload now would
			// leave one owned by a dead socket that nobody can finish or abort.
			if (isGone(client)) throw new CodedError(ErrorCodes.UPLOAD_NOT_FOUND, 'client disconnected');
			const uploadID = randomUUID();
			const path = join(uploadDir, uploadFileName(p.name ?? 'upload'));
			uploads.set(uploadID, { path, writer: Bun.file(path).writer(), written: 0, client });
			console.log(`[API] Upload started: ${uploadID} → ${path}`);
			return { uploadID };
		});
	}

	function chunk(p: { uploadID: string; data: Uint8Array }, client: unknown): Promise<{ received: number }> {
		assert(p, ['uploadID', 'data']);
		return exclusive(client, () => receiveChunk(p, client));
	}

	async function receiveChunk(p: { uploadID: string; data: Uint8Array }, client: unknown): Promise<{ received: number }> {
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

	function end(p: { uploadID: string }, client: unknown): Promise<{ path: string }> {
		assert(p, ['uploadID']);
		return exclusive(client, async () => {
			const upload = owned(p.uploadID, client);
			uploads.delete(p.uploadID);
			await upload.writer.end();
			console.log(`[API] Upload stored: ${upload.path} (${upload.written} bytes)`);
			return { path: upload.path };
		});
	}

	function abort(p: { uploadID: string }, client: unknown): Promise<void> {
		assert(p, ['uploadID']);
		return exclusive(client, async () => {
			// A transfer that is already gone is not an error: the client aborts on any
			// failure, including one that discarded the transfer on its way out.
			const upload = uploads.get(p.uploadID);
			if (!upload || upload.client !== client) return;
			await discard(p.uploadID);
		});
	}

	function closeClient(client: unknown): void {
		const key = clientKey(client);
		// Recorded before anything else, so an operation still mid-await can see
		// that its socket is gone and stop rather than register an orphan.
		if (key) disconnected.add(key);
		const pending = key ? inFlight.get(key) : undefined;
		void (async () => {
			// An operation can still be mid-await when the socket closes. Discarding
			// underneath it would end the writer while that operation is writing to
			// it, so wait for it to finish first.
			if (pending) await pending;
			for (const [uploadID, upload] of uploads) if (upload.client === client) await discard(uploadID);
		})();
	}

	function wipe(): void {
		// Synchronous so no transfer can race the removal, and only ever called
		// before the server accepts connections.
		rmSync(uploadDir, { recursive: true, force: true });
	}

	return { begin, chunk, end, abort, closeClient, wipe };
}
