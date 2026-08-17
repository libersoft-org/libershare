import { describe, expect, it, afterAll } from 'bun:test';
import { readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { decodeBinaryRequest } from '../../../src/api/api.ts';
import { initUploadHandlers, uploadFileName } from '../../../src/api/upload.ts';
import { Utils } from '../../../src/utils.ts';
import { COMPRESSION_ALGORITHMS, CodedError, ErrorCodes, MAX_API_MESSAGE_SIZE, WsClient, compressionExtension, detectCompression } from '@shared';

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
function startUploadServer(maxUploadSize?: number): { url: string; dataDir: string; uploadDir: string; stop: () => void } {
	const dataDir = join(tmpdir(), `lish-upload-test-${crypto.randomUUID()}`);
	tempDirs.push(dataDir);
	const handlers = initUploadHandlers(dataDir, maxUploadSize);
	const table: Record<string, (p: any, client: unknown) => unknown> = {
		'upload.begin': handlers.begin,
		'upload.chunk': handlers.chunk,
		'upload.end': handlers.end,
		'upload.abort': handlers.abort,
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
				} catch {
					ws.send(JSON.stringify({ id: null, error: ErrorCodes.PARSE_ERROR }));
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

/** Deterministic bytes whose value depends on position, so truncation or reordering shows up. */
function pattern(size: number, seed = 1): Uint8Array {
	const out = new Uint8Array(size);
	for (let i = 0; i < size; i++) out[i] = (i * 31 + seed * 7) & 0xff;
	return out;
}

/** The same loop the frontend runs, against the shared client. */
async function upload(client: WsClient, name: string, data: Uint8Array, chunkSize: number): Promise<string> {
	const { uploadID } = await client.call<{ uploadID: string }>('upload.begin', { name });
	for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
		await client.callBinary('upload.chunk', { uploadID }, data.subarray(offset, offset + chunkSize));
	}
	const { path } = await client.call<{ path: string }>('upload.end', { uploadID });
	return path;
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

describe('chunked upload over the websocket', () => {
	it('assembles a file far larger than the old 16 MiB frame limit', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			// 20 MiB: base64 in a single frame is what used to drop the socket here.
			const data = pattern(20 * 1024 * 1024);
			const path = await upload(client, 'big.lish', data, 4 * 1024 * 1024);
			const written = new Uint8Array(await Bun.file(path).arrayBuffer());
			expect(written.byteLength).toBe(data.byteLength);
			expect(Bun.SHA256.hash(written, 'hex')).toBe(Bun.SHA256.hash(data, 'hex'));
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	}, 60000);

	it('writes an empty file for an empty pick rather than failing', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			const path = await upload(client, 'empty.lish', new Uint8Array(0), 1024);
			expect(Bun.file(path).size).toBe(0);
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
		const srv = startUploadServer(128 * 1024);
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
			expect(await owner.call<{ path: string }>('upload.end', { uploadID })).toHaveProperty('path');
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

	it('reads a compressed upload back through the same path an import takes', async () => {
		const srv = startUploadServer();
		const client = new WsClient(srv.url, () => {});
		try {
			const document = { name: 'Kompresní test', values: [1, 2, 3] };
			const compressed = Utils.compress(new TextEncoder().encode(JSON.stringify(document)) as Uint8Array<ArrayBuffer>, 'brotli');
			const path = await upload(client, 'import.lish.br', compressed, 4096);
			expect(JSON.parse(await Utils.readFileCompressed(path))).toEqual(document);
		} finally {
			client.stopReconnect();
			srv.stop();
		}
	});
});
