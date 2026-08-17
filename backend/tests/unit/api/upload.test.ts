import { describe, expect, it, afterAll } from 'bun:test';
import { readdir, rm } from 'fs/promises';
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
			await expectRejection(client.call('upload.end', { uploadID }), ErrorCodes.UPLOAD_NOT_FOUND);
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
