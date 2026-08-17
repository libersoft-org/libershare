import { mkdir, readdir, rm, stat } from 'fs/promises';
import { rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Mutex } from 'async-mutex';
import { CodedError, ErrorCodes, MAX_API_MESSAGE_SIZE, MAX_UPLOAD_CHUNK_SIZE, formatBytes, sanitizeFilename, truncateUTF8End } from '@shared';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;

/**
 * Longest original file name kept in a temp upload name, in UTF-8 bytes. Bytes
 * rather than characters because that is what the filesystem limits — typically
 * 255 per path component — and a hundred CJK or emoji characters are three or
 * four times that. Leaves ample room for the UUID prefix and separator.
 */
const MAX_UPLOAD_NAME_BYTES = 100;

/**
 * Shape an id must have for a client to name its own upload with it. The id
 * never reaches the filesystem — the temp file carries its own random prefix —
 * but it is a key in a long-lived map, which is not somewhere a client gets to
 * put strings of its own choosing and length.
 */
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a file with no upload record behind it is kept before it is swept. */
const UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * How long a live upload may go without a chunk, an end or an import before it
 * is dropped. Separate from {@link UPLOAD_MAX_AGE_MS}, which is about files
 * nobody owns: this one is what stops a client from parking four open transfers
 * and simply never touching them again.
 */
const UPLOAD_IDLE_MS = 15 * 60 * 1000;

/** How often the sweep runs. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Transfers one client may have open at once. Each holds an open file handle and
 * may grow to the size ceiling, so an unbounded number of them is a way to fill
 * the disk from a single socket.
 */
const MAX_CONCURRENT_UPLOADS = 4;

/**
 * Uploads that may exist across every socket at once. The per-socket cap alone
 * bounds nothing, because the number of sockets is not bounded: four transfers
 * each is unlimited disk once a client opens connections in a loop.
 */
const MAX_TOTAL_UPLOADS = 32;

/**
 * Disk every upload together may hold, in-progress and finished-but-unimported
 * alike. Deliberately far below the per-upload ceiling times the upload count —
 * that product is the worst case, not a budget anyone should be able to spend.
 */
const MAX_TOTAL_UPLOAD_BYTES = 1024 * 1024 * 1024;

/** Ceilings the upload handlers enforce. Only ever overridden by tests. */
export interface UploadLimits {
	/** Largest single upload, counted from the bytes actually received. */
	maxUploadSize?: number;
	/** Disk every upload together may hold. */
	maxTotalBytes?: number;
	/** Uploads that may exist at once across all sockets. */
	maxTotalUploads?: number;
	/** How long an unowned file survives in the upload directory. */
	maxAgeMs?: number;
	/** How long a live upload may sit untouched. */
	idleMs?: number;
	/** How often the sweep runs. Zero disables the timer. */
	sweepIntervalMs?: number;
}

/**
 * Temp file name for an uploaded import file. The random prefix keeps concurrent
 * uploads apart; the original name is appended verbatim because
 * `detectCompression()` reads the trailing extension — losing it would make a
 * brotli upload get read as UTF-8 and fail later as a JSON parse error.
 */
export function uploadFileName(originalName: string): string {
	const safe = truncateUTF8End(sanitizeFilename(originalName), MAX_UPLOAD_NAME_BYTES) || 'upload';
	return `${randomUUID()}-${safe}`;
}

/**
 * `receiving` while chunks are still being appended, `finalizing` while the
 * writer is being closed, `ready` once the file is closed and complete. A
 * `ready` upload stays in the map on purpose: the record is what proves the file
 * is finished, whose it is, and how much disk it holds, and dropping it the
 * moment `end()` returns leaves a file nobody is accountable for until a sweep
 * happens to notice it. `queued` and `parsing` are an import waiting for the
 * shared lock and then running under it. `cleanup` is the tail of every path:
 * the client can no longer reach the upload, but the file is still on the disk
 * and so the record still answers for it.
 */
type UploadState = 'receiving' | 'finalizing' | 'ready' | 'queued' | 'parsing' | 'cleanup';

/**
 * States in which nothing of ours is running and the client is the one who
 * should act next — the only ones an idle timeout can fairly apply to. A record
 * with an operation in flight is busy, not idle, and expiring it pulls the file
 * out from under the operation still writing to it.
 */
function isIdleExpirable(state: UploadState): boolean {
	return state === 'receiving' || state === 'ready';
}

interface Upload {
	path: string;
	writer: ReturnType<ReturnType<typeof Bun.file>['writer']>;
	written: number;
	/** Socket that started the transfer; nothing else may append to it or finish it. */
	client: unknown;
	state: UploadState;
	/** When this upload was last begun, appended to, finished or read. */
	lastActivityAt: number;
	/** True while an operation for this upload is running. */
	busy: boolean;
	/** Set by an abort or a disconnect that arrived while the upload was busy. */
	cancelled: boolean;
}

interface UploadHandlers {
	begin: (p: { name?: string }, client: unknown) => Promise<{ uploadID: string }>;
	chunk: (p: { uploadID: string; data: Uint8Array }, client: unknown) => Promise<{ received: number }>;
	end: (p: { uploadID: string }, client: unknown) => Promise<{ uploadID: string }>;
	abort: (p: { uploadID: string }, client: unknown) => Promise<void>;
	/** Read a finished upload from disk and delete it, without exposing its path. */
	withFile: <T>(p: { uploadID: string }, client: unknown, read: (path: string) => Promise<T>) => Promise<T>;
	/** Drop every transfer a disconnecting socket left half-written. */
	closeClient: (client: unknown) => void;
	/** Remove the whole temp directory, for use before the server starts listening. */
	wipe: () => void;
	/** Stop the periodic sweep. Must be called when the API server shuts down. */
	stop: () => void;
	/** Run one cleanup pass now, rather than waiting for the timer. */
	sweep: () => Promise<void>;
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
 * The limits are only ever overridden by tests, which would otherwise have to
 * write the real ceilings to disk to reach them.
 */
export function initUploadHandlers(dataDir: string, limits: UploadLimits = {}): UploadHandlers {
	const maxUploadSize = limits.maxUploadSize ?? MAX_API_MESSAGE_SIZE;
	const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_UPLOAD_BYTES;
	const maxTotalUploads = limits.maxTotalUploads ?? MAX_TOTAL_UPLOADS;
	const maxAgeMs = limits.maxAgeMs ?? UPLOAD_MAX_AGE_MS;
	const idleMs = limits.idleMs ?? UPLOAD_IDLE_MS;
	const sweepIntervalMs = limits.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
	const uploadDir = join(dataDir, 'tmp');
	const uploads = new Map<string, Upload>();
	/**
	 * Bytes currently on disk across every upload. Kept as a running total rather
	 * than summed on demand, so the check that guards a write cannot itself become
	 * the slow part of receiving a file.
	 */
	let totalBytes = 0;

	/**
	 * Serialises reading an upload. Parsing an import is where the memory actually
	 * goes: the file is held as a buffer, decompressed into a second buffer, decoded
	 * into a string and then parsed into an object graph, and the last two are
	 * usually several times the file. Chunking bounds what arrives on the wire, not
	 * that. One at a time keeps peak memory at one import's worth however many
	 * clients ask at once — the alternative is a multiple of it with no bound but
	 * the socket count.
	 */
	const parseLock = new Mutex();

	/**
	 * Drop uploads nobody finished and files nobody owns. Two separate problems:
	 * a transfer still in the map whose client walked away, and a file on disk
	 * with no record behind it at all — the residue of a lost response or a
	 * killed process.
	 *
	 * Runs on a timer rather than when the next transfer starts. The age was
	 * previously only a condition, evaluated whenever another upload happened to
	 * arrive; on a node that imports twice a year that is indistinguishable from
	 * never, and the disk fills in the meantime.
	 *
	 * Never throws: a failed sweep must not take anything else down with it.
	 */
	async function sweep(): Promise<void> {
		const now = Date.now();
		// Cleanups whose unlink failed come first. Those bytes are still charged to
		// the global budget — correctly, since the file is still there — so a stuck
		// cleanup starves every other client until it is retried.
		for (const [uploadID, upload] of [...uploads]) {
			if (upload.state === 'cleanup') await release(uploadID, upload);
		}
		// Idle transfers next, so their files become unowned and the pass below
		// can see them rather than skipping them as active.
		for (const [uploadID, upload] of [...uploads]) {
			if (!isIdleExpirable(upload.state)) continue;
			if (now - upload.lastActivityAt < idleMs) continue;
			console.warn(`[API] Upload expired after ${Math.round((now - upload.lastActivityAt) / 1000)}s idle: ${uploadID}`);
			await discard(uploadID);
		}
		let names: string[];
		try {
			names = await readdir(uploadDir);
		} catch (err: any) {
			// ENOENT before the first upload is the normal case, not a fault.
			if (err?.code !== 'ENOENT') console.error(`[API] Upload sweep could not read ${uploadDir}: ${err.message}`);
			return;
		}
		const cutoff = now - maxAgeMs;
		for (const name of names) {
			const path = join(uploadDir, name);
			// Recomputed per file rather than snapshotted: the awaits in this loop
			// give a new transfer time to appear, and mtime is not a safe proxy for
			// "in use" — an upload can sit paused for longer than the cutoff and
			// still have an open writer pointed at this exact path.
			if (activePaths().has(path)) continue;
			try {
				if ((await stat(path)).mtimeMs >= cutoff) continue;
				await rm(path, { force: true });
				console.warn(`[API] Removed orphaned upload file: ${path}`);
			} catch (err: any) {
				// Logged rather than swallowed: silent failures here are how a disk
				// fills up with no indication of why.
				if (err?.code !== 'ENOENT') console.error(`[API] Upload sweep failed to remove ${path}: ${err.message}`);
			}
		}
	}

	/** Paths that belong to a live upload record and must never be swept. */
	function activePaths(): Set<string> {
		const paths = new Set<string>();
		for (const upload of uploads.values()) paths.add(upload.path);
		return paths;
	}

	/** Look up a transfer the given socket is allowed to touch. */
	function owned(uploadID: string, client: unknown): Upload {
		const upload = uploads.get(uploadID);
		// A record still here in `cleanup` is only here because its file is: it is
		// part of the disk accounting and nothing more, and must not be addressable.
		if (!upload || upload.client !== client || upload.state === 'cleanup') throw new CodedError(ErrorCodes.UPLOAD_NOT_FOUND, uploadID);
		return upload;
	}

	/**
	 * The operations still running for a socket, and the sockets that have
	 * disconnected. Both are keyed by the socket object itself, so the entries
	 * disappear with the socket rather than accumulating.
	 */
	const inFlight = new WeakMap<object, Set<Promise<void>>>();
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
	 * Note an operation for as long as it runs, so a disconnect can wait for
	 * everything the socket still has in flight rather than pulling a file out from
	 * under one. A set rather than a slot: a socket may legitimately be aborting
	 * one upload while another is still transferring.
	 */
	function track<T>(client: unknown, run: () => Promise<T>): Promise<T> {
		const key = clientKey(client);
		if (!key) return run();
		let running = inFlight.get(key);
		if (!running) {
			running = new Set();
			inFlight.set(key, running);
		}
		const result = run();
		// Held as a promise that always resolves, so disconnect cleanup can wait for
		// the operation to finish without inheriting its rejection.
		const settled = result.then(
			() => {},
			() => {}
		);
		running.add(settled);
		void settled.then(() => running.delete(settled));
		return result;
	}

	/**
	 * Run one operation against one upload, refusing a second while it is in
	 * flight. `Bun.serve` does not await an async `websocket.message` handler — it
	 * dispatches the next frame straight away (measured: five pipelined frames all
	 * entered the handler before the first returned) — so without this the handlers
	 * below could run concurrently against the same `Upload`, racing the size
	 * counter, the shared `FileSink` and the map entry itself.
	 *
	 * Per upload rather than per socket. A socket-wide gate refused every other
	 * upload call for as long as one import was running — including the `abort` the
	 * frontend sends when the user picks a different file, and the one it sends
	 * when a step times out — and an abort answered `UPLOAD_BUSY` is an abort that
	 * did not happen.
	 *
	 * Refusing rather than queueing is deliberate: a queue has no bound, and the
	 * only client that trips this is one ignoring the ack it is supposed to wait
	 * for.
	 */
	async function exclusiveUpload<T>(uploadID: string, upload: Upload, run: () => Promise<T>): Promise<T> {
		if (upload.busy) throw new CodedError(ErrorCodes.UPLOAD_BUSY);
		upload.busy = true;
		try {
			return await run();
		} finally {
			upload.busy = false;
			// An abort or a disconnect that landed mid-operation could not touch the
			// record while it was running, so it left a mark and the cleanup happens
			// here instead. A no-op if the operation already cleaned up itself.
			if (upload.cancelled) await discard(uploadID);
		}
	}

	/** Close and delete a partial transfer. Safe to call on one that is already gone. */
	async function discard(uploadID: string): Promise<void> {
		const upload = uploads.get(uploadID);
		if (!upload || upload.state === 'cleanup') return;
		// Moved into `cleanup` rather than removed. The record used to go first and
		// the bytes with it, so an unlink that failed left a file on the disk that
		// nothing was accounting for — repeat that and real disk use climbs past the
		// configured ceiling while the running total reads zero.
		upload.state = 'cleanup';
		// Ending the writer also releases the file handle, which Windows needs
		// before the half-written file can be removed.
		try {
			await upload.writer.end();
		} catch {}
		await release(uploadID, upload);
	}

	/**
	 * Delete an upload's file and, only if that worked, drop it from the map and
	 * give its bytes back to the budget. A failure leaves the record in `cleanup`
	 * for the next sweep to retry, which is the honest state of things: the file is
	 * still there, so it still counts.
	 */
	async function release(uploadID: string, upload: Upload): Promise<void> {
		try {
			await rm(upload.path, { force: true });
		} catch (err: any) {
			console.error(`[API] Upload cleanup failed for ${upload.path}: ${err.message}`);
			return;
		}
		// A sweep can retry a cleanup that is already running, so only whoever still
		// finds the record may credit the bytes back — otherwise they are returned
		// twice and the total drifts below what is really held. Nothing awaits
		// between the check and the delete, so the pair is atomic.
		if (uploads.get(uploadID) !== upload) return;
		uploads.delete(uploadID);
		totalBytes -= upload.written;
	}

	function begin(p: { uploadID?: string; name?: string }, client: unknown): Promise<{ uploadID: string }> {
		return track(client, async () => {
			// A client may name its own transfer, and that is what makes this call safe
			// to retry. The reply to a `begin` can go missing without the socket ever
			// noticing; with a server-chosen id that leaves a file on our disk the
			// client cannot name, finish or abort, and only the sweep ever clears it.
			if (p.uploadID !== undefined && !UPLOAD_ID_PATTERN.test(p.uploadID)) throw new CodedError(ErrorCodes.UPLOAD_NOT_FOUND, 'malformed upload id');
			await mkdir(uploadDir, { recursive: true });
			// The socket can close while the await above runs, and `closeClient`
			// would have found nothing to clean up. Registering the upload now would
			// leave one owned by a dead socket that nobody can finish or abort.
			if (isGone(client)) throw new CodedError(ErrorCodes.UPLOAD_NOT_FOUND, 'client disconnected');
			// Nothing below may await. The ceilings used to be read before the mkdir
			// above, and the per-socket gate does not reach across sockets: at one
			// short of the global cap every concurrent begin passed the check, stalled
			// on the mkdir together and then all inserted. Checking and inserting in
			// one synchronous run is what makes the cap a cap.
			const uploadID = p.uploadID ?? randomUUID();
			const existing = uploads.get(uploadID);
			if (existing) {
				// The retry of a lost reply, answered with the id it already carries and
				// no second file. Anything else — another socket's transfer, or one of
				// this socket's that has moved past `receiving` — is not something this
				// call may start or resume, and the answer says no more than that.
				if (existing.client !== client || existing.state !== 'receiving') throw new CodedError(ErrorCodes.UPLOAD_NOT_FOUND, uploadID);
				return { uploadID };
			}
			let open = 0;
			for (const upload of uploads.values()) if (upload.client === client) open++;
			if (open >= MAX_CONCURRENT_UPLOADS) throw new CodedError(ErrorCodes.TOO_MANY_UPLOADS, String(MAX_CONCURRENT_UPLOADS));
			if (uploads.size >= maxTotalUploads) throw new CodedError(ErrorCodes.UPLOAD_QUOTA_EXCEEDED, String(maxTotalUploads));
			const path = join(uploadDir, uploadFileName(p.name ?? 'upload'));
			uploads.set(uploadID, { path, writer: Bun.file(path).writer(), written: 0, client, state: 'receiving', lastActivityAt: Date.now(), busy: false, cancelled: false });
			console.log(`[API] Upload started: ${uploadID} → ${path}`);
			return { uploadID };
		});
	}

	function chunk(p: { uploadID: string; data: Uint8Array }, client: unknown): Promise<{ received: number }> {
		assert(p, ['uploadID', 'data']);
		return track(client, async () => {
			// Ownership first: the discard inside must not be reachable for a stranger
			// who merely guessed someone else's upload id. Nothing awaits between this
			// and taking the gate, so the pair cannot be interleaved.
			const upload = owned(p.uploadID, client);
			return exclusiveUpload(p.uploadID, upload, () => receiveChunk(p, upload));
		});
	}

	async function receiveChunk(p: { uploadID: string; data: Uint8Array }, upload: Upload): Promise<{ received: number }> {
		// The writer is closed once the transfer is finished, so a late chunk has
		// nowhere to go and must not silently look like it was accepted.
		if (upload.state !== 'receiving') throw new CodedError(ErrorCodes.UPLOAD_NOT_FOUND, p.uploadID);
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
		// The node's disk is shared by every socket, so one client staying inside
		// its own ceiling says nothing about what all of them together are holding.
		if (totalBytes + p.data.byteLength > maxTotalBytes) {
			await discard(p.uploadID);
			console.error(`[API] Upload rejected: ${p.uploadID} would exceed the ${maxTotalBytes} byte total`);
			throw new CodedError(ErrorCodes.UPLOAD_QUOTA_EXCEEDED, formatBytes(maxTotalBytes));
		}
		upload.written = nextWritten;
		upload.lastActivityAt = Date.now();
		totalBytes += p.data.byteLength;
		await upload.writer.write(p.data);
		// Flushed before the response goes out, so the ack the client waits on means
		// the bytes are on disk. Without it the sink would buffer the whole file in
		// memory while the client happily kept sending.
		await upload.writer.flush();
		return { received: upload.written };
	}

	function end(p: { uploadID: string }, client: unknown): Promise<{ uploadID: string }> {
		assert(p, ['uploadID']);
		return track(client, async () => {
			const upload = owned(p.uploadID, client);
			return exclusiveUpload(p.uploadID, upload, () => finish(p.uploadID, upload));
		});
	}

	async function finish(uploadID: string, upload: Upload): Promise<{ uploadID: string }> {
		// A second call on a finished upload is a retry of a reply that went missing,
		// not a second finish. The file is already closed and complete, so answering
		// with the same id is both true and the only way a client can recover from a
		// timeout on this step — a chunk cannot be retried, but this can.
		if (upload.state === 'ready') return { uploadID };
		// Any other state is a call at the wrong moment, and re-closing the writer
		// underneath it is not something to paper over.
		if (upload.state !== 'receiving') throw new CodedError(ErrorCodes.UPLOAD_NOT_FOUND, uploadID);
		// Claimed before the first await, or the sweep can find a record that still
		// looks like an untouched transfer while its writer is mid-close, discard it,
		// end the writer a second time and delete the file — after which this call
		// still answers with a success for an upload that no longer exists.
		upload.state = 'finalizing';
		upload.lastActivityAt = Date.now();
		try {
			await upload.writer.end();
		} catch (err) {
			// A failed close (ENOSPC, a broken handle) leaves a partial file. It
			// used to survive, because the record had already been removed and the
			// client's follow-up abort then found nothing to delete.
			await discard(uploadID);
			throw err;
		}
		upload.state = 'ready';
		upload.lastActivityAt = Date.now();
		console.log(`[API] Upload stored: ${upload.path} (${upload.written} bytes)`);
		// The path deliberately does not go back to the client. It used to, which
		// meant every authorised socket could learn the temp directory and then
		// use the generic `fs.*` methods to read, overwrite or delete a file
		// belonging to someone else's upload between this call and the import —
		// and left the client holding a path it had to remember to clean up.
		return { uploadID };
	}

	/**
	 * Hand a finished upload to a reader, then delete it. The file is identified
	 * by upload id rather than by path, so the client never learns where it lives
	 * and cannot race anything against it; the state moves on before the read so a
	 * second call cannot consume the same file twice.
	 */
	function withFile<T>(p: { uploadID: string }, client: unknown, read: (path: string) => Promise<T>): Promise<T> {
		assert(p, ['uploadID']);
		return track(client, async () => {
			const upload = owned(p.uploadID, client);
			return exclusiveUpload(p.uploadID, upload, () => consume(p.uploadID, upload, client, read));
		});
	}

	async function consume<T>(uploadID: string, upload: Upload, client: unknown, read: (path: string) => Promise<T>): Promise<T> {
		if (upload.state !== 'ready') throw new CodedError(ErrorCodes.UPLOAD_NOT_FOUND, uploadID);
		// Claimed synchronously so a second consume cannot get past the check above,
		// but deliberately still in the map and still charged for. The record used to
		// be dropped here, before the wait for the import lock: a queued file then
		// counted towards neither ceiling, so a client could park an unbounded number
		// of them by simply calling parse and uploading again — and the sweep, which
		// only ever knew about the map, would judge the file an orphan and delete it
		// before its parse had even started.
		upload.state = 'queued';
		try {
			return await parseLock.runExclusive(async () => {
				// The wait above is unbounded, so the owner may well be gone by the time
				// the lock comes free. Parsing an import nobody is listening for is pure
				// cost, and it is the expensive part of the whole operation.
				if (upload.cancelled || isGone(client) || uploads.get(uploadID) !== upload) throw new CodedError(ErrorCodes.UPLOAD_NOT_FOUND, uploadID);
				upload.state = 'parsing';
				return await read(upload.path);
			});
		} finally {
			// Removed whether or not the read worked: a file that failed to parse is no
			// more use than one that succeeded, and leaving it would let a bad import
			// linger until a sweep. The bytes come back with the file, not before it.
			upload.state = 'cleanup';
			await release(uploadID, upload);
		}
	}

	function abort(p: { uploadID: string }, client: unknown): Promise<void> {
		assert(p, ['uploadID']);
		return track(client, async () => {
			// A transfer that is already gone is not an error: the client aborts on any
			// failure, including one that discarded the transfer on its way out.
			const upload = uploads.get(p.uploadID);
			if (!upload || upload.client !== client) return;
			// Deliberately outside the per-upload gate. An abort refused as UPLOAD_BUSY
			// is an abort that did not happen, and the frontend sends one precisely
			// when something else on this upload has stopped answering. Marked instead,
			// and whatever is running discards on its way out.
			if (upload.busy) {
				upload.cancelled = true;
				return;
			}
			await discard(p.uploadID);
		});
	}

	function closeClient(client: unknown): void {
		const key = clientKey(client);
		// Recorded before anything else, so an operation still mid-await can see
		// that its socket is gone and stop rather than register an orphan.
		if (key) disconnected.add(key);
		// Marked before the wait below, so an operation parked behind the import lock
		// gives up at its next checkpoint instead of doing the work first and then
		// finding nobody to answer.
		for (const upload of uploads.values()) if (upload.client === client) upload.cancelled = true;
		// Snapshotted, since each entry removes itself as it settles.
		const running = key ? [...(inFlight.get(key) ?? [])] : [];
		void (async () => {
			// An operation can still be mid-await when the socket closes. Discarding
			// underneath it would end the writer while that operation is writing to
			// it, so wait for all of them to finish first.
			await Promise.all(running);
			for (const [uploadID, upload] of uploads) if (upload.client === client) await discard(uploadID);
		})();
	}

	function wipe(): void {
		// Synchronous so no transfer can race the removal, and only ever called
		// before the server accepts connections.
		rmSync(uploadDir, { recursive: true, force: true });
	}

	// Unreferenced so a node with nothing to do can still exit; the sweep is
	// housekeeping and never a reason to keep the process alive.
	const sweepTimer = sweepIntervalMs > 0 ? setInterval(() => void sweep(), sweepIntervalMs) : null;
	sweepTimer?.unref?.();

	function stop(): void {
		if (sweepTimer) clearInterval(sweepTimer);
	}

	return { begin, chunk, end, abort, withFile, closeClient, wipe, stop, sweep };
}
