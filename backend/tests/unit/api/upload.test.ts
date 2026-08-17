import { describe, expect, it, afterAll } from 'bun:test';
import { mkdir, readdir, rm, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { BinaryFrameError, MAX_BINARY_HEADER_SIZE, decodeBinaryRequest } from '../../../src/api/api.ts';
import { type UploadLimits, initUploadHandlers, uploadFileName } from '../../../src/api/upload.ts';
import { Utils } from '../../../src/utils.ts';
import { COMPRESSION_ALGORITHMS, CodedError, ErrorCodes, MAX_API_MESSAGE_SIZE, MAX_UPLOAD_CHUNK_SIZE, WsClient, compressionExtension, detectCompression } from '@shared';

/** Byte length of the header-length prefix on a binary request frame. */
const BINARY_HEADER_PREFIX = 4;

const tempFiles: string[] = [];
const tempDirs: string[] = [];

afterAll(async () => {
	for (const path of tempFiles) await rm(path, { force: true });
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe('uploadFileName', () => {
	it('keeps the whole compression extension so the file can be read back', () => {
		for (const name of ['backup.lishset.gz', 'nets.lishnet.br', 'manifest.lish.zst', 'x.lish.zstd']) {
			expect(detectCompression(uploadFileName(name))).toBe(detectCompression(name));
		}
	});

	it('is unique per call so two uploads cannot collide', () => {
		expect(uploadFileName('a.lish')).not.toBe(uploadFileName('a.lish'));
	});

	it('strips path separators, so the name cannot escape the upload directory', () => {
		const name = uploadFileName('../../etc/passwd.lish');
		expect(name).not.toContain('/');
		expect(name).not.toContain('\\');
	});

	it('trims a pathological name from the front, keeping the extension', () => {
		const name = uploadFileName('x'.repeat(5000) + '.lish.br');
		expect(name.length).toBeLessThan(200);
		expect(detectCompression(name)).toBe('brotli');
	});

	it('falls back to a usable name when nothing survives sanitising', () => {
		expect(uploadFileName('///')).toEndWith('-upload');
	});

	it('measures the name in utf-8 bytes, not utf-16 units', () => {
		// 200 CJK characters are 600 UTF-8 bytes. Counted as characters they look
		// like a modest name and still blow past the 255-byte component limit.
		for (const name of ['字'.repeat(200) + '.lish', '😀'.repeat(200) + '.lish', 'ř'.repeat(200) + '.lish']) {
			expect(Buffer.byteLength(uploadFileName(name), 'utf8')).toBeLessThanOrEqual(255);
		}
	});

	it('never splits a character when trimming the name', () => {
		// A byte-wise cut through a multi-byte sequence decodes as U+FFFD, which is
		// both a corrupt name and a different one on every filesystem round trip.
		for (const filler of ['字', '😀', 'ř']) {
			for (let count = 30; count < 40; count++) {
				expect(uploadFileName(filler.repeat(count) + '.lish')).not.toContain('�');
			}
		}
	});

	it('strips control characters, including NUL', () => {
		// A NUL ends the path at the system-call boundary, so a name carrying one
		// can address a file other than the one it appears to name.
		const NUL = String.fromCharCode(0);
		const BEL = String.fromCharCode(7);
		const name = uploadFileName(`back${NUL}door${BEL}.lish`);
		expect(name).not.toContain(NUL);
		expect(name).not.toContain(BEL);
		expect(name).toEndWith('backdoor.lish');
	});
});

describe('uploaded file round trip', () => {
	for (const algorithm of COMPRESSION_ALGORITHMS) {
		it(`${algorithm}: survives the temp file name and reads back as the original JSON`, async () => {
			// The extension-loss failure mode surfaces as a JSON parse error rather
			// than a compression error, so assert on the parsed document.
			const document = { name: 'Kompresní test', values: [1, 2, 3] };
			const json = JSON.stringify(document);
			const path = join(tmpdir(), uploadFileName(`import.lish${compressionExtension(algorithm)}`));
			tempFiles.push(path);
			await Bun.write(path, Utils.compress(new TextEncoder().encode(json) as Uint8Array<ArrayBuffer>, algorithm));
			expect(JSON.parse(await Utils.readFileCompressed(path))).toEqual(document);
		});
	}

	it('reads an uncompressed upload as plain text', async () => {
		const path = join(tmpdir(), uploadFileName('import.lish'));
		tempFiles.push(path);
		await Bun.write(path, '{"a":1}');
		expect(JSON.parse(await Utils.readFileCompressed(path))).toEqual({ a: 1 });
	});
});

describe('decodeBinaryRequest', () => {
	/** Frame a request the way {@link WsClient.callBinary} does. */
	function frame(header: object, payload: Uint8Array): Uint8Array {
		const encoded = new TextEncoder().encode(JSON.stringify(header));
		const out = new Uint8Array(4 + encoded.byteLength + payload.byteLength);
		new DataView(out.buffer).setUint32(0, encoded.byteLength);
		out.set(encoded, 4);
		out.set(payload, 4 + encoded.byteLength);
		return out;
	}

	it('hands the trailing bytes to the handler as params.data', () => {
		const payload = new Uint8Array([0, 255, 128, 7]);
		const req = decodeBinaryRequest(frame({ id: 'x', method: 'upload.chunk', params: { uploadID: 'u' } }, payload));
		expect(req.id).toBe('x');
		expect(req.method).toBe('upload.chunk');
		expect(req.params?.['uploadID']).toBe('u');
		expect(Array.from(req.params?.['data'] as Uint8Array)).toEqual([0, 255, 128, 7]);
	});

	it('survives payload bytes that are not valid UTF-8', () => {
		// The whole reason binary frames are not run through toString(): these
		// bytes would each come back as U+FFFD.
		const payload = new Uint8Array([0xc3, 0x28, 0xa0, 0xa1, 0xff]);
		const req = decodeBinaryRequest(frame({ id: 'x', method: 'upload.chunk', params: {} }, payload));
		expect(Array.from(req.params?.['data'] as Uint8Array)).toEqual(Array.from(payload));
	});

	it('copies the payload rather than aliasing the received frame', () => {
		const source = frame({ id: 'x', method: 'upload.chunk', params: {} }, new Uint8Array([1, 2, 3]));
		const req = decodeBinaryRequest(source);
		source.fill(0);
		expect(Array.from(req.params?.['data'] as Uint8Array)).toEqual([1, 2, 3]);
	});

	it('rejects a payload larger than one chunk before copying it', () => {
		const payload = new Uint8Array(MAX_UPLOAD_CHUNK_SIZE + 1);
		expect(() => decodeBinaryRequest(frame({ id: 'x', method: 'upload.chunk', params: {} }, payload))).toThrow(ErrorCodes.UPLOAD_CHUNK_TOO_LARGE);
	});

	it('accepts a payload of exactly one chunk', () => {
		const payload = new Uint8Array(MAX_UPLOAD_CHUNK_SIZE);
		expect(decodeBinaryRequest(frame({ id: 'x', method: 'upload.chunk', params: {} }, payload)).params?.['data'].byteLength).toBe(MAX_UPLOAD_CHUNK_SIZE);
	});

	it('rejects an oversized json header before decoding it', () => {
		// The length prefix alone decides this — the header bytes are never read.
		const bad = new Uint8Array(BINARY_HEADER_PREFIX + 8);
		new DataView(bad.buffer).setUint32(0, MAX_BINARY_HEADER_SIZE + 1);
		expect(() => decodeBinaryRequest(bad)).toThrow(ErrorCodes.PARSE_ERROR);
	});

	it('rejects a frame too short to hold a length prefix', () => {
		expect(() => decodeBinaryRequest(new Uint8Array([1, 2]))).toThrow(ErrorCodes.PARSE_ERROR);
	});

	it('rejects a header length that runs past the end of the frame', () => {
		const bad = new Uint8Array(8);
		new DataView(bad.buffer).setUint32(0, 1000);
		expect(() => decodeBinaryRequest(bad)).toThrow(ErrorCodes.PARSE_ERROR);
	});
});

/**
 * Stand the upload handlers up behind a real WebSocket and drive them with the
 * real {@link WsClient}, so the chunking protocol is exercised end to end —
 * framing, dispatch, acks, and the error path — rather than by calling the
 * handlers directly. The dispatch mirrors `APIServer.handleMessage`; wiring the
 * methods into the live server is covered by running the app itself.
 */
function startUploadServer(limits: UploadLimits = {}): { url: string; dataDir: string; uploadDir: string; stop: () => void } {
	const dataDir = join(tmpdir(), `lish-upload-test-${crypto.randomUUID()}`);
	tempDirs.push(dataDir);
	const handlers = initUploadHandlers(dataDir, limits);
	let concurrentReads = 0;
	let peakConcurrentReads = 0;
	const table: Record<string, (p: any, client: unknown) => unknown> = {
		'upload.begin': handlers.begin,
		'upload.chunk': handlers.chunk,
		'upload.end': handlers.end,
		'upload.abort': handlers.abort,
		// Stand-ins for the real `*.parseFromUpload` handlers, which all consume a
		// finished upload through `withFile`. Tests go through them rather than
		// reading a path, because a path is exactly what the client no longer gets.
		'upload.digest': (p, client) =>
			handlers.withFile(p, client, async path => {
				const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
				return { size: bytes.byteLength, sha256: Bun.SHA256.hash(bytes, 'hex') };
			}),
		'upload.text': (p, client) => handlers.withFile(p, client, path => Utils.readFileCompressed(path)),
		// A read slow enough for a concurrent one to overlap it, reporting the
		// highest number that were ever in flight together.
		'upload.slowRead': (p, client) =>
			handlers.withFile(p, client, async () => {
				concurrentReads++;
				peakConcurrentReads = Math.max(peakConcurrentReads, concurrentReads);
				await Bun.sleep(150);
				concurrentReads--;
				return { peak: peakConcurrentReads };
			}),
	};
	const server = Bun.serve<Record<string, never>, never>({
		port: 0,
		fetch: (req, s) => (s.upgrade(req, { data: {} }) ? undefined : new Response('expected websocket', { status: 400 })),
		websocket: {
			maxPayloadLength: MAX_API_MESSAGE_SIZE,
			close(ws): void {
				handlers.closeClient(ws);
			},
			async message(ws, message): Promise<void> {
				let req;
				try {
					req = typeof message === 'string' ? JSON.parse(message) : decodeBinaryRequest(message);
				} catch (err: any) {
					const coded = err instanceof CodedError ? err : null;
					const id = err instanceof BinaryFrameError ? err.requestID : null;
					ws.send(JSON.stringify({ id, error: coded?.code ?? ErrorCodes.PARSE_ERROR, errorDetail: coded?.detail }));
					return;
				}
				try {
					ws.send(JSON.stringify({ id: req.id, result: await table[req.method]!(req.params ?? {}, ws) }));
				} catch (err: any) {
					if (err instanceof CodedError) ws.send(JSON.stringify({ id: req.id, error: err.code, errorDetail: err.detail }));
					else ws.send(JSON.stringify({ id: req.id, error: ErrorCodes.INTERNAL_ERROR, errorDetail: err.message }));
				}
			},
		},
	});
	return {
		url: `ws://localhost:${server.port}`,
		dataDir,
		uploadDir: join(dataDir, 'tmp'),
		stop: () => server.stop(true),
	};
}

/**
 * Assert a call came back as the given error code. Checks the machine-readable
 * code the frontend switches on rather than the message text, which is only a
 * repeat of it.
 */
async function expectRejection(promise: Promise<unknown>, code: string): Promise<void> {
	let thrown: any;
	try {
		await promise;
	} catch (err) {
		thrown = err;
	}
	expect(thrown?.code).toBe(code);
}

/**
 * Send one binary frame over a bare WebSocket and return the `error` code from
 * the reply. Bypasses {@link WsClient}, which enforces its own limits before
 * sending — the point here is what the server does with a frame no cooperating
 * client would produce.
 */
async function rawBinaryCall(url: string, header: object, payload: Uint8Array): Promise<any> {
	const encoded = new TextEncoder().encode(JSON.stringify(header));
	const out = new Uint8Array(4 + encoded.byteLength + payload.byteLength);
	new DataView(out.buffer).setUint32(0, encoded.byteLength);
	out.set(encoded, 4);
	out.set(payload, 4 + encoded.byteLength);
	const ws = new WebSocket(url);
	try {
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error('raw socket failed to open'));
		});
		const reply = new Promise<any>(resolve => (ws.onmessage = e => resolve(JSON.parse(String(e.data)))));
		ws.send(out);
		return await reply;
	} finally {
		ws.close();
	}
}

/** Deterministic bytes whose value depends on position, so truncation or reordering shows up. */
function pattern(size: number, seed = 1): Uint8Array {
	const out = new Uint8Array(size);
	for (let i = 0; i < size; i++) out[i] = (i * 31 + seed * 7) & 0xff;
	return out;
}

/** The same loop the frontend runs, against the shared client. Returns the upload id. */
async function upload(client: WsClient, name: string, data: Uint8Array, chunkSize: number): Promise<string> {
	const { uploadID } = await client.call<{ uploadID: string }>('upload.begin', { name });
	for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
		await client.callBinary('upload.chunk', { uploadID }, data.subarray(offset, offset + chunkSize));
	}
	await client.call('upload.end', { uploadID });
	return uploadID;
}

/** Poll until the upload directory settles, since cleanup on socket close is fire-and-forget. */
async function entriesAfterSettle(uploadDir: string): Promise<string[]> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const entries = await readdir(uploadDir).catch(() => [] as string[]);
		if (entries.length === 0) return entries;
		await Bun.sleep(20);
	}
	return readdir(uploadDir).catch(() => [] as string[]);
}

/**
 * The handlers on their own, with a plain object standing in for the socket.
 * Driving them directly is the only way to land inside a specific await — over a
 * real socket the close can arrive before the server has even read the request,
 * so the window under test is never entered.
 */
function directHandlers(): { handlers: ReturnType<typeof initUploadHandlers>; uploadDir: string } {
	const dataDir = join(tmpdir(), `lish-upload-direct-${crypto.randomUUID()}`);
	tempDirs.push(dataDir);
	return { handlers: initUploadHandlers(dataDir), uploadDir: join(dataDir, 'tmp') };
}

describe('upload lifecycle races', () => {
	it('leaves no file behind when the socket closes during begin', async () => {
		const { handlers, uploadDir } = directHandlers();
		const client = {};
		// Started but not awaited, so `closeClient` runs while `begin` is still
		// inside its mkdir await — the window where the upload does not exist yet
		// and the cleanup sweep therefore finds nothing to remove.
		const started = handlers.begin({ name: 'orphan.lish' }, client).catch(() => null);
		handlers.closeClient(client);
		await started;
		expect(await entriesAfterSettle(uploadDir)).toEqual([]);
	});

	it('leaves no file behind when the socket closes mid-chunk', async () => {
		const { handlers, uploadDir } = directHandlers();
		const client = {};
		const { uploadID } = await handlers.begin({ name: 'midchunk.lish' }, client);
		// The chunk is still writing when the close arrives; the cleanup must not
		// end the writer underneath it.
		const writing = handlers.chunk({ uploadID, data: pattern(2 * 1024 * 1024) }, client).catch(() => null);
		handlers.closeClient(client);
		await writing;
		expect(await entriesAfterSettle(uploadDir)).toEqual([]);
	});
});

describe('queued imports', () => {
	/** Handlers with the sweep timer off and a small byte budget, driven directly. */
	function queueHandlers(limits: UploadLimits): { handlers: ReturnType<typeof initUploadHandlers>; uploadDir: string } {
		const dataDir = join(tmpdir(), `lish-upload-queue-${crypto.randomUUID()}`);
		tempDirs.push(dataDir);
		return { handlers: initUploadHandlers(dataDir, { sweepIntervalMs: 0, ...limits }), uploadDir: join(dataDir, 'tmp') };
	}

	/** A promise plus the function that settles it, for holding an import open. */
	function gate(): { wait: Promise<void>; open: () => void } {
		let open!: () => void;
		const wait = new Promise<void>(resolve => (open = resolve));
		return { wait, open };
	}

	/** Push a finished upload of the given size onto a socket and return its id. */
	async function finished(handlers: ReturnType<typeof initUploadHandlers>, client: unknown, name: string, size: number): Promise<string> {
		const { uploadID } = await handlers.begin({ name }, client);
		await handlers.chunk({ uploadID, data: pattern(size) }, client);
		await handlers.end({ uploadID }, client);
		return uploadID;
	}

	it('keeps an import waiting for the lock counted and unswept', async () => {
		// Both cutoffs at zero: anything the sweep is allowed to touch, it will.
		const { handlers, uploadDir } = queueHandlers({ idleMs: 0, maxAgeMs: 0, maxTotalBytes: 256 * 1024 });
		const [first, second, third] = [{}, {}, {}];
		const idA = await finished(handlers, first, 'a.lish', 100 * 1024);
		const idB = await finished(handlers, second, 'b.lish', 100 * 1024);
		const held = gate();
		const entered: string[] = [];

		const parseA = handlers.withFile({ uploadID: idA }, first, async path => {
			entered.push('a');
			await held.wait;
			return Bun.file(path).size;
		});
		await Bun.sleep(20);
		const parseB = handlers.withFile({ uploadID: idB }, second, async path => {
			entered.push('b');
			return Bun.file(path).size;
		});
		await Bun.sleep(20);
		// One at a time, so B is sitting on the lock with its file untouched.
		expect(entered).toEqual(['a']);

		await handlers.sweep();
		// Neither file may be judged an orphan. B's parse has not started, so before
		// the fix its record was already gone and the sweep deleted it outright.
		expect((await readdir(uploadDir)).length).toBe(2);
		// And both still count: 200 KiB of a 256 KiB budget is spoken for, so this
		// third file does not fit. Released early, the queue was free disk.
		const idC = (await handlers.begin({ name: 'c.lish' }, third)).uploadID;
		await expect(handlers.chunk({ uploadID: idC, data: pattern(200 * 1024) }, third)).rejects.toThrow(ErrorCodes.UPLOAD_QUOTA_EXCEEDED);

		held.open();
		expect(await parseA).toBe(100 * 1024);
		expect(await parseB).toBe(100 * 1024);
		expect(await readdir(uploadDir)).toEqual([]);
		handlers.stop();
	});

	it('bounds the parse queue by the same upload cap as everything else', async () => {
		const { handlers } = queueHandlers({ maxTotalUploads: 2 });
		const [first, second, third] = [{}, {}, {}];
		const idA = await finished(handlers, first, 'a.lish', 1024);
		const idB = await finished(handlers, second, 'b.lish', 1024);
		const held = gate();
		const parseA = handlers.withFile({ uploadID: idA }, first, async () => {
			await held.wait;
			return 1;
		});
		await Bun.sleep(20);
		const parseB = handlers.withFile({ uploadID: idB }, second, async () => 2);
		await Bun.sleep(20);
		// Both records are still in the map, so the cap is reached and nothing new
		// may start. Dropping them at the head of the queue is what made the cap
		// stop applying to queued work at all.
		await expect(handlers.begin({ name: 'c.lish' }, third)).rejects.toThrow(ErrorCodes.UPLOAD_QUOTA_EXCEEDED);
		held.open();
		await parseA;
		await parseB;
		expect(await handlers.begin({ name: 'c.lish' }, third)).toHaveProperty('uploadID');
		handlers.stop();
	});

	it('does not parse an upload whose socket left while it waited for the lock', async () => {
		const { handlers, uploadDir } = queueHandlers({});
		const [first, second] = [{}, {}];
		const idA = await finished(handlers, first, 'a.lish', 1024);
		const idB = await finished(handlers, second, 'b.lish', 1024);
		const held = gate();
		let parsedB = false;

		const parseA = handlers.withFile({ uploadID: idA }, first, async () => {
			await held.wait;
			return 'a';
		});
		await Bun.sleep(20);
		const parseB = handlers
			.withFile({ uploadID: idB }, second, async () => {
				parsedB = true;
				return 'b';
			})
			.catch(() => 'gone');
		await Bun.sleep(20);
		// The socket goes while its parse is still queued behind A's.
		handlers.closeClient(second);
		held.open();

		expect(await parseA).toBe('a');
		expect(await parseB).toBe('gone');
		// The work was never done, and the file did not survive it either.
		expect(parsedB).toBe(false);
		expect(await entriesAfterSettle(uploadDir)).toEqual([]);
		handlers.stop();
	});
});

describe('upload sweep', () => {
	/** Handlers with the timer off, so a sweep only happens when a test asks for one. */
	function sweepHandlers(limits: UploadLimits): { handlers: ReturnType<typeof initUploadHandlers>; uploadDir: string } {
		const dataDir = join(tmpdir(), `lish-upload-sweep-${crypto.randomUUID()}`);
		tempDirs.push(dataDir);
		return { handlers: initUploadHandlers(dataDir, { sweepIntervalMs: 0, ...limits }), uploadDir: join(dataDir, 'tmp') };
	}

	/** Push a file's mtime well past any cutoff a test sets. */
	async function backdate(path: string): Promise<void> {
		const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		await utimes(path, longAgo, longAgo);
	}

	it('keeps an active upload whose file is older than the cutoff', async () => {
		const { handlers, uploadDir } = sweepHandlers({ idleMs: 60_000, maxAgeMs: 60_000 });
		const client = {};
		const { uploadID } = await handlers.begin({ name: 'paused.lish' }, client);
		await handlers.chunk({ uploadID, data: pattern(1024) }, client);
		// An upload can sit paused for longer than the cutoff. The old sweep judged
		// purely by mtime, so it would delete this file out from under an open
		// writer while the record was still in the map.
		const [name] = await readdir(uploadDir);
		await backdate(join(uploadDir, name!));

		await handlers.sweep();
		expect(await readdir(uploadDir)).toEqual([name!]);
		// Still genuinely usable, not merely still present.
		expect(await handlers.chunk({ uploadID, data: pattern(1024) }, client)).toEqual({ received: 2048 });
		handlers.stop();
	});

	it('expires an upload that has gone quiet for too long', async () => {
		const { handlers, uploadDir } = sweepHandlers({ idleMs: 0, maxAgeMs: 60_000 });
		const client = {};
		const { uploadID } = await handlers.begin({ name: 'forgotten.lish' }, client);
		await handlers.chunk({ uploadID, data: pattern(1024) }, client);
		// Idle expiry drops the record, which is what lets the file be removed —
		// an active path is never swept on age alone.
		await handlers.sweep();
		expect(await readdir(uploadDir)).toEqual([]);
		await expect(handlers.chunk({ uploadID, data: pattern(16) }, client)).rejects.toThrow(ErrorCodes.UPLOAD_NOT_FOUND);
		handlers.stop();
	});

	it('does not expire an upload whose writer is still being closed', async () => {
		const { handlers, uploadDir } = sweepHandlers({ idleMs: 0, maxAgeMs: 60_000 });
		const client = {};
		const { uploadID } = await handlers.begin({ name: 'closing.lish' }, client);
		await handlers.chunk({ uploadID, data: pattern(4096) }, client);
		// Not awaited: `end` runs its synchronous prefix and then suspends inside
		// `writer.end()`, which is exactly the window the sweep used to walk into —
		// the record still looked like an untouched transfer, so it was discarded,
		// the writer closed twice and the file deleted while `end` was mid-close.
		const finishing = handlers.end({ uploadID }, client);
		await handlers.sweep();
		expect(await finishing).toEqual({ uploadID });
		// The success it just reported has to be true: the file is still there and
		// the upload is still consumable.
		expect((await readdir(uploadDir)).length).toBe(1);
		expect((await handlers.withFile({ uploadID }, client, async path => Bun.file(path).size)) as number).toBe(4096);
		handlers.stop();
	});

	it('removes a file no upload record owns', async () => {
		const { handlers, uploadDir } = sweepHandlers({ idleMs: 60_000, maxAgeMs: 60_000 });
		const client = {};
		// One real upload to create the directory, then an orphan beside it — the
		// residue of a killed process or a lost reply.
		const { uploadID } = await handlers.begin({ name: 'live.lish' }, client);
		await handlers.chunk({ uploadID, data: pattern(64) }, client);
		const orphan = join(uploadDir, 'orphan.lish');
		await Bun.write(orphan, 'left behind');
		await backdate(orphan);

		await handlers.sweep();
		expect(await Bun.file(orphan).exists()).toBe(false);
		// The live upload is untouched.
		expect((await readdir(uploadDir)).length).toBe(1);
		handlers.stop();
	});

	it('keeps charging for an upload whose file could not be deleted', async () => {
		const budget = 256 * 1024;
		const { handlers, uploadDir } = sweepHandlers({ idleMs: 60_000, maxAgeMs: 60_000, maxTotalBytes: budget });
		const client = {};
		const { uploadID } = await handlers.begin({ name: 'stuck.lish' }, client);
		await handlers.chunk({ uploadID, data: pattern(200 * 1024) }, client);
		await handlers.end({ uploadID }, client);

		// A deletion that fails for real: the path is replaced by a non-empty
		// directory, which `rm` without `recursive` refuses. Standing in for ENOSPC,
		// a permission change or a handle another process is holding.
		const [name] = await readdir(uploadDir);
		const path = join(uploadDir, name!);
		await rm(path, { force: true });
		await mkdir(path, { recursive: true });
		await Bun.write(join(path, 'in-the-way'), 'x');

		await handlers.abort({ uploadID }, client);
		// Unreachable for its owner — the abort did happen.
		await expect(handlers.withFile({ uploadID }, client, async () => 1)).rejects.toThrow(ErrorCodes.UPLOAD_NOT_FOUND);
		// But still charged for, because the bytes are still on the disk. Released
		// early, this second upload of the same size would fit and real disk use
		// would quietly pass the ceiling.
		const { uploadID: next } = await handlers.begin({ name: 'next.lish' }, client);
		await expect(handlers.chunk({ uploadID: next, data: pattern(200 * 1024) }, client)).rejects.toThrow(ErrorCodes.UPLOAD_QUOTA_EXCEEDED);

		// Once the obstruction is gone the sweep retries and the budget comes back.
		await rm(path, { recursive: true, force: true });
		await handlers.sweep();
		const { uploadID: after } = await handlers.begin({ name: 'after.lish' }, client);
		expect(await handlers.chunk({ uploadID: after, data: pattern(200 * 1024) }, client)).toEqual({ received: 200 * 1024 });
		handlers.stop();
	});

	it('runs on its own timer rather than only when a transfer starts', async () => {
		const { handlers, uploadDir } = sweepHandlers({ maxAgeMs: 60_000, sweepIntervalMs: 50 });
		// Nothing else will ever touch this node: with the sweep tied to the next
		// upload.begin, this file would sit here until the process restarted.
		await mkdir(uploadDir, { recursive: true });
		const stale = join(uploadDir, 'stale.lish');
		await Bun.write(stale, 'forgotten');
		await backdate(stale);

		for (let attempt = 0; attempt < 100 && (await readdir(uploadDir)).length > 0; attempt++) await Bun.sleep(20);
		expect(await readdir(uploadDir)).toEqual([]);
		handlers.stop();
	}, 30000);
});

describe('chunked upload over the websocket', () => {
	it('assembles a file far larger than the old 16 MiB frame limit', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			// 20 MiB: base64 in a single frame is what used to drop the socket here.
			const data = pattern(20 * 1024 * 1024);
			const uploadID = await upload(client, 'big.lish', data, 4 * 1024 * 1024);
			const digest = await client.call<{ size: number; sha256: string }>('upload.digest', { uploadID });
			expect(digest.size).toBe(data.byteLength);
			expect(digest.sha256).toBe(Bun.SHA256.hash(data, 'hex'));
			// Consuming the upload removes it, so nothing is left on disk afterwards.
			expect(await readdir(srv.uploadDir)).toEqual([]);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	}, 60000);

	it('writes an empty file for an empty pick rather than failing', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			const uploadID = await upload(client, 'empty.lish', new Uint8Array(0), 1024);
			expect((await client.call<{ size: number }>('upload.digest', { uploadID })).size).toBe(0);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});

	it('leaves nothing behind when a transfer is aborted', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			const { uploadID } = await client.call<{ uploadID: string }>('upload.begin', { name: 'gone.lish' });
			await client.callBinary('upload.chunk', { uploadID }, pattern(64 * 1024));
			await client.call('upload.abort', { uploadID });
			expect(await readdir(srv.uploadDir)).toEqual([]);
			// The transfer is gone for good — a late chunk cannot resurrect it.
			await expectRejection(client.callBinary('upload.chunk', { uploadID }, pattern(16)), ErrorCodes.UPLOAD_NOT_FOUND);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});

	it('discards the partial file when the socket drops mid-transfer', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			const { uploadID } = await client.call<{ uploadID: string }>('upload.begin', { name: 'halfway.lish' });
			await client.callBinary('upload.chunk', { uploadID }, pattern(256 * 1024));
			expect((await readdir(srv.uploadDir)).length).toBe(1);
			client.stopReconnect();
			expect(await entriesAfterSettle(srv.uploadDir)).toEqual([]);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});

	it('refuses a transfer that grows past the ceiling and deletes what arrived', async () => {
		const srv = startUploadServer({ maxUploadSize: 128 * 1024 });
		const client = new WsClient(srv.url, () => {});
		try {
			const { uploadID } = await client.call<{ uploadID: string }>('upload.begin', { name: 'huge.lish' });
			await client.callBinary('upload.chunk', { uploadID }, pattern(100 * 1024));
			await expectRejection(client.callBinary('upload.chunk', { uploadID }, pattern(100 * 1024)), ErrorCodes.UPLOAD_TOO_LARGE);
			expect(await readdir(srv.uploadDir)).toEqual([]);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});

	it('rejects a text chunk instead of letting it poison the size counter', async () => {
		const srv = startUploadServer({ maxUploadSize: 128 * 1024 });
		const client = new WsClient(srv.url, () => {});
		try {
			const { uploadID } = await client.call<{ uploadID: string }>('upload.begin', { name: 'text.lish' });
			// A string has no byteLength: unchecked this makes `written` NaN, and
			// every later `written > limit` comparison against NaN is false — the
			// ceiling would be gone for the rest of the transfer.
			await expectRejection(client.call('upload.chunk', { uploadID, data: 'x' }), ErrorCodes.UPLOAD_INVALID_CHUNK);
			// The transfer is discarded outright rather than left with a poisoned counter.
			await expectRejection(client.callBinary('upload.chunk', { uploadID }, pattern(16)), ErrorCodes.UPLOAD_NOT_FOUND);
			expect(await readdir(srv.uploadDir)).toEqual([]);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});

	it('never writes past the ceiling once a text chunk has been sent', async () => {
		const ceiling = 128 * 1024;
		const srv = startUploadServer({ maxUploadSize: ceiling });
		const client = new WsClient(srv.url, () => {});
		try {
			const { uploadID } = await client.call<{ uploadID: string }>('upload.begin', { name: 'poison.lish' });
			// One text chunk is the whole exploit: it makes `written` NaN, and NaN
			// fails every `> ceiling` test that follows, so the binary chunks after
			// it can run to any size at all.
			await client.call('upload.chunk', { uploadID, data: 'x' }).catch(() => {});
			for (let i = 0; i < 8; i++) await client.callBinary('upload.chunk', { uploadID }, pattern(64 * 1024)).catch(() => {});
			await client.call('upload.end', { uploadID }).catch(() => {});
			// Whatever survives on disk, none of it may be over the ceiling.
			for (const name of await readdir(srv.uploadDir).catch(() => [] as string[])) {
				expect(Bun.file(join(srv.uploadDir, name)).size).toBeLessThanOrEqual(ceiling);
			}
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});

	it('will not let a stranger discard a transfer with a text chunk', async () => {
		const srv = startUploadServer();
		const owner = new WsClient(srv.url, () => {});
		const intruder = new WsClient(srv.url, () => {});
		try {
			const { uploadID } = await owner.call<{ uploadID: string }>('upload.begin', { name: 'mine.lish' });
			await owner.callBinary('upload.chunk', { uploadID }, pattern(16));
			// Ownership is checked before the discard, so a guessed id is inert.
			await expectRejection(intruder.call('upload.chunk', { uploadID, data: 'x' }), ErrorCodes.UPLOAD_NOT_FOUND);
			await owner.callBinary('upload.chunk', { uploadID }, pattern(16));
		} finally {
			owner.stopReconnect();
			intruder.stopReconnect();
			srv.stop();
		}
	});

	it('refuses an oversized chunk sent by a client that ignores the limit', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			const { uploadID } = await client.call<{ uploadID: string }>('upload.begin', { name: 'fat.lish' });
			// The shared client refuses to build this frame, so the server side is
			// only reachable over a raw socket — which is exactly what a client that
			// does not cooperate looks like.
			const reply = await rawBinaryCall(srv.url, { id: 'raw', method: 'upload.chunk', params: { uploadID } }, new Uint8Array(MAX_UPLOAD_CHUNK_SIZE + 1));
			expect(reply.error).toBe(ErrorCodes.UPLOAD_CHUNK_TOO_LARGE);
			// The id comes back, so the caller's promise is rejected rather than
			// left waiting for a reply it can never correlate.
			expect(reply.id).toBe('raw');
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	}, 30000);

	it('gives up on a call whose reply never comes', async () => {
		// A server that accepts the frame and answers nothing: the socket stays
		// open, so the disconnect path that normally settles pending requests never
		// runs and without a timeout the caller waits forever.
		const silent = Bun.serve<Record<string, never>, never>({
			port: 0,
			fetch: (req, s) => (s.upgrade(req, { data: {} }) ? undefined : new Response('expected websocket', { status: 400 })),
			websocket: { message: (): void => {} },
		});
		const client = new WsClient(`ws://localhost:${silent.port}`, () => {});
		try {
			await expectRejection(client.call('upload.begin', { name: 'void.lish' }, 300), ErrorCodes.REQUEST_TIMEOUT);
		} finally {
			client.stopReconnect();
			silent.stop(true);
		}
	}, 30000);

	it('rejects a chunk for an upload id nobody started', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			await expectRejection(client.callBinary('upload.chunk', { uploadID: 'made-up' }, pattern(16)), ErrorCodes.UPLOAD_NOT_FOUND);
			await expectRejection(client.call('upload.end', { uploadID: 'made-up' }), ErrorCodes.UPLOAD_NOT_FOUND);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});

	it('will not let one socket append to a transfer another one started', async () => {
		const srv = startUploadServer();
		const owner = new WsClient(srv.url, () => {});
		const intruder = new WsClient(srv.url, () => {});
		try {
			const { uploadID } = await owner.call<{ uploadID: string }>('upload.begin', { name: 'mine.lish' });
			await expectRejection(intruder.callBinary('upload.chunk', { uploadID }, pattern(16)), ErrorCodes.UPLOAD_NOT_FOUND);
			await expectRejection(intruder.call('upload.end', { uploadID }), ErrorCodes.UPLOAD_NOT_FOUND);
			// The owner's transfer is untouched by the attempt.
			await owner.callBinary('upload.chunk', { uploadID }, pattern(16));
			expect(await owner.call<{ uploadID: string }>('upload.end', { uploadID })).toEqual({ uploadID });
		} finally {
			owner.stopReconnect();
			intruder.stopReconnect();
			srv.stop();
		}
	});

	it('caps how many transfers one socket may hold open', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			const ids: string[] = [];
			for (let i = 0; i < 4; i++) ids.push((await client.call<{ uploadID: string }>('upload.begin', { name: `n${i}.lish` })).uploadID);
			await expectRejection(client.call('upload.begin', { name: 'one-too-many.lish' }), ErrorCodes.TOO_MANY_UPLOADS);
			// Finishing one frees the slot again.
			await client.call('upload.abort', { uploadID: ids[0] });
			expect(await client.call<{ uploadID: string }>('upload.begin', { name: 'now-fits.lish' })).toHaveProperty('uploadID');
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});

	it('does not let parallel begins exceed the per-socket cap', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			// Fired without awaiting each other, which is what a client that ignores
			// the acks looks like. The cap is computed before an await, so without
			// serialisation every one of these sees `open === 0` and succeeds.
			const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => client.call<{ uploadID: string }>('upload.begin', { name: `p${i}.lish` })));
			const started = results.filter(r => r.status === 'fulfilled').length;
			expect(started).toBeLessThanOrEqual(4);
			// Every rejection is one of the two limits, never an internal error.
			for (const r of results) {
				if (r.status === 'rejected') expect([ErrorCodes.TOO_MANY_UPLOADS, ErrorCodes.UPLOAD_BUSY]).toContain((r.reason as any).code);
			}
			expect((await readdir(srv.uploadDir)).length).toBe(started);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	}, 30000);

	it('refuses a second upload operation while one is in flight', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			const { uploadID } = await client.call<{ uploadID: string }>('upload.begin', { name: 'pipelined.lish' });
			// Pipelined chunks would otherwise interleave on one FileSink and race
			// the size counter.
			const results = await Promise.allSettled([client.callBinary('upload.chunk', { uploadID }, pattern(1024 * 1024, 1)), client.callBinary('upload.chunk', { uploadID }, pattern(1024 * 1024, 2)), client.callBinary('upload.chunk', { uploadID }, pattern(1024 * 1024, 3))]);
			const accepted = results.filter(r => r.status === 'fulfilled').length;
			expect(accepted).toBeGreaterThanOrEqual(1);
			for (const r of results) {
				if (r.status === 'rejected') expect((r.reason as any).code).toBe(ErrorCodes.UPLOAD_BUSY);
			}
			// The file holds exactly the chunks that were acknowledged — no partial
			// or interleaved write survived.
			await client.call('upload.end', { uploadID });
			expect((await client.call<{ size: number }>('upload.digest', { uploadID })).size).toBe(accepted * 1024 * 1024);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	}, 30000);

	it('answers a repeated end with the same id rather than an error', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			const { uploadID } = await client.call<{ uploadID: string }>('upload.begin', { name: 'retried.lish' });
			await client.callBinary('upload.chunk', { uploadID }, pattern(2048));
			expect(await client.call<{ uploadID: string }>('upload.end', { uploadID })).toEqual({ uploadID });
			// A reply can go missing without the socket noticing, and the frontend then
			// retries this step. The file is already whole, so the retry has to succeed
			// — refusing it strands a finished upload the client can no longer name.
			expect(await client.call<{ uploadID: string }>('upload.end', { uploadID })).toEqual({ uploadID });
			// And it really is the same upload, not an empty one left by a re-close.
			expect((await client.call<{ size: number }>('upload.digest', { uploadID })).size).toBe(2048);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});

	it('lets a socket abort one upload and begin the next in the same breath', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			const { uploadID: first } = await client.call<{ uploadID: string }>('upload.begin', { name: 'first.lish' });
			await client.callBinary('upload.chunk', { uploadID: first }, pattern(64 * 1024));
			// Exactly what picking a second file in the import form does: the abort is
			// not awaited and the next begin goes out on the same socket right behind
			// it. Under a socket-wide gate whichever arrived second was refused —
			// either the new transfer never started or the old file was left with no
			// id on the frontend at all.
			const aborting = client.call('upload.abort', { uploadID: first });
			const { uploadID: second } = await client.call<{ uploadID: string }>('upload.begin', { name: 'second.lish' });
			await aborting;
			await client.callBinary('upload.chunk', { uploadID: second }, pattern(64 * 1024));
			await client.call('upload.end', { uploadID: second });
			// Both took effect: the new transfer is whole and the old file is gone.
			expect((await client.call<{ size: number }>('upload.digest', { uploadID: second })).size).toBe(64 * 1024);
			expect(await readdir(srv.uploadDir)).toEqual([]);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	}, 30000);

	it('does not let one long import block the rest of the socket', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			const idA = await upload(client, 'slow.lish', pattern(4096), 4096);
			const idB = await upload(client, 'other.lish', pattern(4096), 4096);
			// Held open for 150 ms inside the import lock. The gate used to be the
			// whole socket, so every call below came back UPLOAD_BUSY.
			const parsing = client.call<{ peak: number }>('upload.slowRead', { uploadID: idA });
			await client.call('upload.abort', { uploadID: idB });
			const { uploadID: idC } = await client.call<{ uploadID: string }>('upload.begin', { name: 'new.lish' });
			expect(await client.callBinary<{ received: number }>('upload.chunk', { uploadID: idC }, pattern(1024))).toEqual({ received: 1024 });
			await parsing;
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	}, 30000);

	it('never hands the client a filesystem path', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			const { uploadID } = await client.call<{ uploadID: string }>('upload.begin', { name: 'secret.lish' });
			await client.callBinary('upload.chunk', { uploadID }, pattern(1024));
			// The reply used to carry the absolute temp path, which let any
			// authorised socket point the generic fs.* methods at another client's
			// upload between finishing and importing it.
			const finished = await client.call<Record<string, unknown>>('upload.end', { uploadID });
			expect(Object.keys(finished)).toEqual(['uploadID']);
			expect(JSON.stringify(finished)).not.toContain(srv.dataDir);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});

	it('consumes a finished upload exactly once', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			const uploadID = await upload(client, 'once.lish', pattern(4096), 1024);
			expect((await client.call<{ size: number }>('upload.digest', { uploadID })).size).toBe(4096);
			// The record and the file both go with the first consume, so a replay
			// cannot read it again.
			await expectRejection(client.call('upload.digest', { uploadID }), ErrorCodes.UPLOAD_NOT_FOUND);
			expect(await readdir(srv.uploadDir)).toEqual([]);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});

	it('deletes the upload even when parsing it fails', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			// Not valid brotli, so readFileCompressed throws — the temp file must
			// still go, or a bad import lingers until a sweep.
			const uploadID = await upload(client, 'broken.lish.br', pattern(512), 512);
			await expectRejection(client.call('upload.text', { uploadID }), ErrorCodes.INTERNAL_ERROR);
			expect(await readdir(srv.uploadDir)).toEqual([]);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});

	it('refuses to consume a transfer that was never finished', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			const { uploadID } = await client.call<{ uploadID: string }>('upload.begin', { name: 'partial.lish' });
			await client.callBinary('upload.chunk', { uploadID }, pattern(1024));
			// Still receiving: the writer is open and the file is incomplete.
			await expectRejection(client.call('upload.digest', { uploadID }), ErrorCodes.UPLOAD_NOT_FOUND);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});

	it('will not let a stranger consume a finished upload', async () => {
		const srv = startUploadServer();
		const owner = new WsClient(srv.url, () => {});
		const intruder = new WsClient(srv.url, () => {});
		try {
			const uploadID = await upload(owner, 'mine.lish', pattern(1024), 1024);
			await expectRejection(intruder.call('upload.digest', { uploadID }), ErrorCodes.UPLOAD_NOT_FOUND);
			// Untouched for its owner.
			expect((await owner.call<{ size: number }>('upload.digest', { uploadID })).size).toBe(1024);
		} finally {
			owner.stopReconnect();
			intruder.stopReconnect();
			srv.stop();
		}
	});

	it('rejects a chunk that arrives after the transfer was finished', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			const uploadID = await upload(client, 'late.lish', pattern(1024), 1024);
			// The writer is closed; a late chunk must not look accepted.
			await expectRejection(client.callBinary('upload.chunk', { uploadID }, pattern(16)), ErrorCodes.UPLOAD_NOT_FOUND);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});

	it('drops a finished but unconsumed upload when the socket goes', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			await upload(client, 'abandoned.lish', pattern(2048), 1024);
			expect((await readdir(srv.uploadDir)).length).toBe(1);
			// The record survives `end` now, which is what makes this cleanup
			// possible at all — previously the file was already unowned.
			client.stopReconnect();
			expect(await entriesAfterSettle(srv.uploadDir)).toEqual([]);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});

	it('caps total bytes across separate sockets, not just per socket', async () => {
		// Each socket stays well inside its own per-upload ceiling; together they
		// would still fill the disk, which the per-socket limits cannot see.
		const srv = startUploadServer({ maxTotalBytes: 256 * 1024 });
		const clients = [new WsClient(srv.url, () => {}), new WsClient(srv.url, () => {}), new WsClient(srv.url, () => {})];
		try {
			const codes: (string | undefined)[] = [];
			for (const client of clients) {
				const { uploadID } = await client.call<{ uploadID: string }>('upload.begin', { name: 'share.lish' });
				try {
					await client.callBinary('upload.chunk', { uploadID }, pattern(128 * 1024));
					codes.push(undefined);
				} catch (err: any) {
					codes.push(err.code);
				}
			}
			// Two fit in 256 KiB, the third must not.
			expect(codes.slice(0, 2)).toEqual([undefined, undefined]);
			expect(codes[2]).toBe(ErrorCodes.UPLOAD_QUOTA_EXCEEDED);
		} finally {
			for (const client of clients) client.stopReconnect();
			srv.stop();
		}
	}, 30000);

	it('frees global budget again once an upload is consumed', async () => {
		const srv = startUploadServer({ maxTotalBytes: 256 * 1024 });
		const client = new WsClient(srv.url, () => {});
		try {
			const first = await upload(client, 'a.lish', pattern(200 * 1024), 64 * 1024);
			// Full: a second file of the same size does not fit alongside the first.
			const { uploadID: second } = await client.call<{ uploadID: string }>('upload.begin', { name: 'b.lish' });
			await expectRejection(client.callBinary('upload.chunk', { uploadID: second }, pattern(200 * 1024)), ErrorCodes.UPLOAD_QUOTA_EXCEEDED);
			// Importing the first returns its bytes to the budget.
			await client.call('upload.digest', { uploadID: first });
			const { uploadID: third } = await client.call<{ uploadID: string }>('upload.begin', { name: 'c.lish' });
			expect(await client.callBinary<{ received: number }>('upload.chunk', { uploadID: third }, pattern(200 * 1024))).toEqual({ received: 200 * 1024 });
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	}, 30000);

	it('caps how many uploads exist at once across all sockets', async () => {
		const srv = startUploadServer({ maxTotalUploads: 6 });
		const clients = [new WsClient(srv.url, () => {}), new WsClient(srv.url, () => {})];
		try {
			// Four each is the per-socket cap; the global cap of six stops the eighth
			// — and the seventh — regardless of how many sockets are opened.
			let started = 0;
			let rejected = 0;
			for (const client of clients) {
				for (let i = 0; i < 4; i++) {
					try {
						await client.call('upload.begin', { name: `g${i}.lish` });
						started++;
					} catch {
						rejected++;
					}
				}
			}
			expect(started).toBe(6);
			expect(rejected).toBe(2);
		} finally {
			for (const client of clients) client.stopReconnect();
			srv.stop();
		}
	}, 30000);

	it('does not let concurrent begins on separate sockets overshoot the global cap', async () => {
		const srv = startUploadServer({ maxTotalUploads: 4 });
		const filler = new WsClient(srv.url, () => {});
		const racers = [new WsClient(srv.url, () => {}), new WsClient(srv.url, () => {}), new WsClient(srv.url, () => {}), new WsClient(srv.url, () => {}), new WsClient(srv.url, () => {})];
		try {
			// One short of the cap, so exactly one of the racers below may win.
			for (let i = 0; i < 3; i++) await filler.call('upload.begin', { name: `f${i}.lish` });
			// Connect first: a begin that is still opening its socket is not racing
			// the others, and the window under test is between the check and the insert.
			await Promise.all(racers.map(client => client.call('upload.abort', { uploadID: 'warm-up' })));
			// The per-socket gate cannot see across sockets, so this is the case the
			// global cap has to survive on its own.
			const results = await Promise.allSettled(racers.map((client, i) => client.call<{ uploadID: string }>('upload.begin', { name: `r${i}.lish` })));
			expect(results.filter(r => r.status === 'fulfilled').length).toBe(1);
			for (const r of results) {
				if (r.status === 'rejected') expect((r.reason as any).code).toBe(ErrorCodes.UPLOAD_QUOTA_EXCEEDED);
			}
			expect((await readdir(srv.uploadDir)).length).toBe(4);
		} finally {
			filler.stopReconnect();
			for (const client of racers) client.stopReconnect();
			srv.stop();
		}
	}, 30000);

	it('parses one import at a time however many clients ask at once', async () => {
		const srv = startUploadServer();
		const clients = [new WsClient(srv.url, () => {}), new WsClient(srv.url, () => {}), new WsClient(srv.url, () => {})];
		try {
			const ids = await Promise.all(clients.map((client, i) => upload(client, `p${i}.lish`, pattern(256 * 1024), 64 * 1024)));
			// `upload.slowRead` reports how many reads overlapped. Each holds the
			// whole file plus its decompressed and parsed forms, so overlapping them
			// multiplies peak memory by the number of clients.
			const overlaps = await Promise.all(clients.map((client, i) => client.call<{ peak: number }>('upload.slowRead', { uploadID: ids[i] })));
			for (const result of overlaps) expect(result.peak).toBe(1);
		} finally {
			for (const client of clients) client.stopReconnect();
			srv.stop();
		}
	}, 30000);

	it('reads a compressed upload back through the same path an import takes', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			const document = { name: 'Kompresní test', values: [1, 2, 3] };
			const compressed = Utils.compress(new TextEncoder().encode(JSON.stringify(document)) as Uint8Array<ArrayBuffer>, 'brotli');
			const uploadID = await upload(client, 'import.lish.br', compressed, 4096);
			expect(JSON.parse(await client.call<string>('upload.text', { uploadID }))).toEqual(document);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});
});
