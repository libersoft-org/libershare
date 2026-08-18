import { describe, it, expect, afterAll, mock } from 'bun:test';
import * as zlib from 'node:zlib';
import { deflateRawSync, deflateSync, inflateRawSync, inflateSync } from 'node:zlib';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Utils } from '../../src/utils.ts';
import { initFsHandlers } from '../../src/api/fs.ts';
import { COMPRESSION_ALGORITHMS, compressionExtension, detectCompression, stripCompressionExtension, withCompressionExtensions, isCompressed, ErrorCodes, MAX_API_MESSAGE_SIZE } from '@shared';

/**
 * The real `node:zlib` exports, captured before any test can replace them. `mock.module`
 * swaps the module for the whole process, so restoring has to hand back a snapshot taken
 * while the module was still untouched rather than re-spreading a namespace already mocked.
 */
const realZlib = { ...zlib };

/** Mixed binary + UTF-8 payload — catches encoding-sensitive round-trip bugs. */
function samplePayload(): Uint8Array<ArrayBuffer> {
	const text = new TextEncoder().encode('Příliš žluťoučký kůň úpěl ďábelské ódy — ✓');
	const bytes = new Uint8Array(text.length + 256);
	bytes.set(text, 0);
	for (let i = 0; i < 256; i++) bytes[text.length + i] = i;
	return bytes as Uint8Array<ArrayBuffer>;
}

/**
 * A `deflate` body that is a complete, valid stream under *both* wire readings and means
 * something different under each. As zlib it is one stored block holding 65 534 bytes; as
 * raw DEFLATE the header bytes themselves open a one-byte stored block, and two empty
 * blocks inside that payload — the second of them final — end the stream after that byte.
 */
function dualValidDeflate(): Uint8Array<ArrayBuffer> {
	const payload = new Uint8Array(65534).fill(0x41);
	payload.set([0x00, 0x00, 0xff, 0xff], 0); // raw reading: empty stored block, non-final
	payload.set([0x01, 0x00, 0x00, 0xff, 0xff], 4); // raw reading: empty stored block, final
	const header = [0x78, 0x01, 0x00, 0xfe, 0xff, 0x01, 0x00]; // zlib header, then a stored block of 65 534
	const trailer = [0x01, 0x00, 0x00, 0xff, 0xff, ...adler32Trailer(payload)]; // final empty block + Adler-32
	return new Uint8Array([...header, ...payload, ...trailer]) as Uint8Array<ArrayBuffer>;
}

/** The four big-endian Adler-32 bytes that close a zlib stream over `data`. */
function adler32Trailer(data: Uint8Array): number[] {
	let a = 1;
	let b = 0;
	for (const byte of data) {
		a = (a + byte) % 65521;
		b = (b + a) % 65521;
	}
	return [(b >>> 8) & 0xff, b & 0xff, (a >>> 8) & 0xff, a & 0xff];
}

/** A complete raw DEFLATE stream that expands past the output cap. */
function rawDeflateBomb(): Buffer {
	return deflateRawSync(Buffer.alloc(MAX_API_MESSAGE_SIZE + 1024 * 1024));
}

/**
 * A `deflate` body whose zlib reading is a complete 65 278-byte stored block, and whose raw
 * reading stops only at the output cap. Read as raw DEFLATE the zlib header itself opens a
 * 257-byte stored block; a second stored block then covers the rest of the payload and the
 * Adler-32 along with it, and the block after that is a bomb appended behind the finished
 * zlib stream — trailing bytes the zlib reading ignores.
 */
function rawOverCapDeflate(): Uint8Array<ArrayBuffer> {
	const payload = Buffer.alloc(65278, 0x41);
	payload.set([0x00, 0xfe, 0xfd, 0x01, 0x02], 255); // raw reading: stored block of 65 022, non-final
	const header = [0x78, 0x01, 0x01, 0xfe, 0xfe, 0x01, 0x01]; // zlib header, then a final stored block of 65 278
	return Buffer.concat([Buffer.from(header), payload, Buffer.from(adler32Trailer(payload)), rawDeflateBomb()]) as Uint8Array<ArrayBuffer>;
}

/**
 * The mirror of {@link rawOverCapDeflate}, on the layout of {@link dualValidDeflate}: the
 * zlib reading runs on into a bomb instead of ending after the stored block, so it is the
 * oversized one, while the raw reading is still the same valid single byte.
 */
function zlibOverCapDeflate(): Uint8Array<ArrayBuffer> {
	const payload = Buffer.alloc(65534, 0x41);
	payload.set([0x00, 0x00, 0xff, 0xff], 0); // raw reading: empty stored block, non-final
	payload.set([0x01, 0x00, 0x00, 0xff, 0xff], 4); // raw reading: empty stored block, final
	const header = [0x78, 0x01, 0x00, 0xfe, 0xff, 0x01, 0x00]; // zlib header, then a stored block of 65 534
	// No Adler-32: the zlib reading hits the cap inside the bomb and never reaches a trailer.
	return Buffer.concat([Buffer.from(header), payload, rawDeflateBomb()]) as Uint8Array<ArrayBuffer>;
}

/**
 * A complete, valid zlib body whose raw reading is a stored block declaring more bytes than
 * the body holds, so the raw decode fails with `Z_BUF_ERROR` instead of `Z_DATA_ERROR`. The
 * zlib header bytes are `0x78 0xda` — a legal CMF/FLG pair with no preset dictionary — and
 * read as DEFLATE bits the first of them opens a stored block whose LEN and NLEN are the four
 * bytes behind it: 32 986, self-consistent and 426 bytes past the end of the buffer.
 */
function rawTruncatedDeflate(): Uint8Array<ArrayBuffer> {
	const payload = new Uint8Array(32549).fill(0x41);
	const header = [0x78, 0xda, 0x80, 0x25, 0x7f, 0xda, 0x80]; // zlib header, then a stored block of 32 549
	const trailer = [0x01, 0x00, 0x00, 0xff, 0xff, ...adler32Trailer(payload)]; // final empty block + Adler-32
	return new Uint8Array([...header, ...payload, ...trailer]) as Uint8Array<ArrayBuffer>;
}

const tempFiles: string[] = [];

function tempFile(name: string): string {
	const path = join(tmpdir(), `lish-compression-${process.pid}-${name}`);
	tempFiles.push(path);
	return path;
}

afterAll(async () => {
	for (const path of tempFiles) await rm(path, { force: true });
});

describe('Utils.compress / Utils.decompress', () => {
	for (const algorithm of COMPRESSION_ALGORITHMS) {
		it(`${algorithm}: round-trips the exact bytes`, () => {
			const original = samplePayload();
			const restored = Utils.decompress(Utils.compress(original, algorithm), algorithm);
			expect(Array.from(restored)).toEqual(Array.from(original));
		});

		it(`${algorithm}: really compresses redundant data`, () => {
			const raw = new Uint8Array(100 * 1024).fill(65) as Uint8Array<ArrayBuffer>;
			const compressed = Utils.compress(raw, algorithm);
			// A pass-through "algorithm" would fail both of these.
			expect(compressed.length).toBeLessThan(raw.length / 2);
			expect(Array.from(compressed)).not.toEqual(Array.from(raw));
		});
	}

	it('compresses brotli fast enough not to freeze the backend', () => {
		// Every compression call here is synchronous. At the library default quality (11)
		// this payload takes tens of seconds; the ceiling keeps that regression out.
		const raw = new TextEncoder().encode(JSON.stringify(Array.from({ length: 120000 }, (_, i) => ({ i, h: i.toString(16).padStart(64, 'a') })))) as Uint8Array<ArrayBuffer>;
		const started = Bun.nanoseconds();
		const compressed = Utils.compress(raw, 'brotli');
		const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
		expect(elapsedMs).toBeLessThan(5000);
		expect(Array.from(Utils.decompress(compressed, 'brotli'))).toEqual(Array.from(raw));
	});

	for (const algorithm of COMPRESSION_ALGORITHMS) {
		it(`${algorithm}: refuses to expand past the output cap`, () => {
			// A few hundred bytes of compressed zeroes expand past the cap. Without
			// the guard this allocation is what kills the process instead of the call.
			const bomb = Utils.compress(new Uint8Array(MAX_API_MESSAGE_SIZE + 1024 * 1024) as Uint8Array<ArrayBuffer>, algorithm);
			expect(bomb.length).toBeLessThan(1024 * 1024);
			expect(() => Utils.decompress(bomb, algorithm)).toThrow(ErrorCodes.DECOMPRESSED_TOO_LARGE);
		});

		it(`${algorithm}: still decompresses a payload that fits`, () => {
			const raw = new Uint8Array(4 * 1024 * 1024).fill(7) as Uint8Array<ArrayBuffer>;
			expect(Utils.decompress(Utils.compress(raw, algorithm), algorithm).length).toBe(raw.length);
		});
	}

	// HTTP `deflate` is zlib-wrapped (RFC 1950) on most servers and bare DEFLATE (RFC 1951)
	// on the rest, and only the leading bytes say which. Both have to read, under the same cap.
	for (const [variant, deflate] of [
		['zlib-wrapped', deflateSync],
		['raw', deflateRawSync],
	] as const) {
		it(`deflate (${variant}): round-trips the exact bytes`, () => {
			const original = samplePayload();
			const restored = Utils.decompress(deflate(original) as Uint8Array<ArrayBuffer>, 'deflate');
			expect(Array.from(restored)).toEqual(Array.from(original));
		});

		it(`deflate (${variant}): refuses to expand past the output cap`, () => {
			const bomb = deflate(new Uint8Array(MAX_API_MESSAGE_SIZE + 1024 * 1024)) as Uint8Array<ArrayBuffer>;
			expect(bomb.byteLength).toBeLessThan(1024 * 1024);
			expect(() => Utils.decompress(bomb, 'deflate')).toThrow(ErrorCodes.DECOMPRESSED_TOO_LARGE);
		});
	}

	it('deflate: throws on a corrupt stream instead of returning what it managed to read', () => {
		const whole = deflateSync(samplePayload());
		// Truncated mid-stream, and pure garbage: neither fits either wire variant, so the
		// raw retry has to fail too rather than hand back a partial or bogus decode. The
		// failure has to come out of the decoder — reaching it at all is half the assertion.
		for (const corrupt of [whole.subarray(0, whole.byteLength - 4), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]) {
			let failure: any;
			try {
				Utils.decompress(corrupt as Uint8Array<ArrayBuffer>, 'deflate');
			} catch (err) {
				failure = err;
			}
			expect(failure?.code).toMatch(/^Z_/);
		}
	});

	it('deflate: a failed zlib stream is not re-read as raw DEFLATE', () => {
		// Bytes that are simultaneously a valid RFC 1950 header and a complete raw DEFLATE
		// stream. 0x78 is a legal zlib CMF, and read as DEFLATE bits it opens a non-final
		// stored block, so the byte after it — the FLG the % 31 check runs on — doubles as
		// the low byte of that block's length. Pad the payload to 94 so both readings hold.
		const payload = new TextEncoder().encode('{"maxChunkSize":1048576}'.padEnd(94, ' '));
		const len = payload.byteLength;
		const bothWays = new Uint8Array([0x78, len & 0xff, len >> 8, ~len & 0xff, (~len >> 8) & 0xff, ...payload, 0x01, 0x00, 0x00, 0xff, 0xff]) as Uint8Array<ArrayBuffer>;
		// As zlib the header is accepted and the body underneath it is not a stream at all;
		// as raw DEFLATE the whole thing decodes cleanly to the payload. Only the second
		// reading succeeds, and taking it would hand the caller content no server sent.
		expect(new TextDecoder().decode(inflateRawSync(bothWays)).trim()).toBe('{"maxChunkSize":1048576}');
		let failure: any;
		try {
			Utils.decompress(bothWays, 'deflate');
		} catch (err) {
			failure = err;
		}
		expect(failure?.code).toBe('Z_DATA_ERROR');
	});

	it('deflate: refuses a body that decodes cleanly under both readings', () => {
		const bothWays = dualValidDeflate();
		// Genuinely dual-valid: neither decoder complains, and they disagree about the content.
		// Guessing either way would hand the caller bytes the sender never meant, so the only
		// honest answer is to refuse — and it has to be our error, not a decoder failure.
		expect(inflateSync(bothWays).byteLength).toBe(65534);
		expect(Array.from(inflateRawSync(bothWays))).toEqual([0x01]);
		expect(() => Utils.decompress(bothWays, 'deflate')).toThrow(ErrorCodes.AMBIGUOUS_DEFLATE);
	});

	it('deflate: refuses a body whose raw reading stops only at the output cap', () => {
		const body = rawOverCapDeflate();
		const options = { maxOutputLength: MAX_API_MESSAGE_SIZE };
		// The zlib reading is complete and small, so handing it back looks safe. It is not: the
		// raw decode did not reject these bytes, it ran out of budget on them, which is a second
		// reading existing and being large. Returning the first would be a silent pick between two.
		expect(inflateSync(body, options).byteLength).toBe(65278);
		let rawFailure: any;
		try {
			inflateRawSync(body, options);
		} catch (err) {
			rawFailure = err;
		}
		expect(rawFailure?.code).toBe('ERR_BUFFER_TOO_LARGE');
		expect(() => Utils.decompress(body, 'deflate')).toThrow(ErrorCodes.AMBIGUOUS_DEFLATE);
	});

	it('deflate: reports the cap when the zlib reading is the oversized one', () => {
		const body = zlibOverCapDeflate();
		// The mirror case. Here the overrun is in the reading RFC 9110 names, so the cap is the
		// accurate answer and a valid raw reading beside it cannot make returning anything safe.
		expect(Array.from(inflateRawSync(body, { maxOutputLength: MAX_API_MESSAGE_SIZE }))).toEqual([0x01]);
		expect(() => Utils.decompress(body, 'deflate')).toThrow(ErrorCodes.DECOMPRESSED_TOO_LARGE);
	});

	it('deflate: decodes a body whose raw reading runs off the end of the buffer', () => {
		const body = rawTruncatedDeflate();
		// The raw decode fails here with Z_BUF_ERROR, not Z_DATA_ERROR: the block header it
		// reads is well-formed and only the bytes behind it are missing. That is still the data
		// saying it is not a raw stream, so the zlib reading stands. Dropping this code from the
		// allowlist would refuse an ordinary body as ambiguous — and the pair of length fields a
		// raw reader needs lines up by chance often enough to matter at internet scale.
		let rawFailure: any;
		try {
			inflateRawSync(body, { maxOutputLength: MAX_API_MESSAGE_SIZE });
		} catch (err) {
			rawFailure = err;
		}
		expect(rawFailure?.code).toBe('Z_BUF_ERROR');
		expect(Utils.decompress(body, 'deflate').byteLength).toBe(32549);
	});

	it('deflate: refuses when the raw decode fails for a reason that is not about the data', () => {
		// Z_MEM_ERROR is an allocation that failed, not a verdict that these bytes are not a raw
		// stream: the raw reading was never disproven, only left unchecked. Testing for a `Z_`
		// prefix would return the zlib content here and silently pick one of two readings.
		// zlib cannot be starved on demand, so the failure is injected at the node:zlib seam —
		// what is faked is the decoder running out of memory, not the outcome being asserted.
		const body = deflateSync(samplePayload()) as Uint8Array<ArrayBuffer>;
		const decoded = samplePayload().byteLength;
		expect(Utils.decompress(body, 'deflate').byteLength).toBe(decoded);
		mock.module('node:zlib', () => ({
			...realZlib,
			inflateRawSync: () => {
				const err: any = new Error('Out of memory');
				err.code = 'Z_MEM_ERROR';
				err.errno = realZlib.constants.Z_MEM_ERROR;
				throw err;
			},
		}));
		try {
			expect(() => Utils.decompress(body, 'deflate')).toThrow(ErrorCodes.AMBIGUOUS_DEFLATE);
		} finally {
			mock.module('node:zlib', () => realZlib);
		}
		// The seam is shared with every other test in the run, so prove it really came back.
		expect(Utils.decompress(body, 'deflate').byteLength).toBe(decoded);
	});

	it('rejects an unsupported algorithm instead of silently passing data through', () => {
		const data = samplePayload();
		expect(() => Utils.compress(data, 'bzip2' as any)).toThrow(ErrorCodes.UNSUPPORTED_COMPRESSION);
		expect(() => Utils.decompress(data, 'xz' as any)).toThrow(ErrorCodes.UNSUPPORTED_DECOMPRESSION);
		// Decode-only: nothing may ever write deflate, so it stays out of the compressor.
		expect(() => Utils.compress(data, 'deflate' as any)).toThrow(ErrorCodes.UNSUPPORTED_COMPRESSION);
	});
});

describe('Utils.writeJSONToFile / Utils.readFileCompressed', () => {
	for (const algorithm of COMPRESSION_ALGORITHMS) {
		it(`${algorithm}: writes and reads back without naming the algorithm`, async () => {
			const data = { name: 'Kompresní test', values: [1, 2, 3], nested: { ok: true } };
			const path = tempFile(`roundtrip${compressionExtension(algorithm)}`);
			await Utils.writeJSONToFile(data, path, true, true, algorithm);
			// No algorithm argument — it must be recovered from the file extension.
			expect(JSON.parse(await Utils.readFileCompressed(path))).toEqual(data);
		});
	}

	it('reads an uncompressed file as plain text', async () => {
		const path = tempFile('plain.lish');
		await Utils.writeJSONToFile({ a: 1 }, path, false, false);
		expect(JSON.parse(await Utils.readFileCompressed(path))).toEqual({ a: 1 });
	});

	it('minifies only when asked to', async () => {
		const pretty = tempFile('pretty.lish');
		const minified = tempFile('minified.lish');
		await Utils.writeJSONToFile({ a: 1 }, pretty, false, false);
		await Utils.writeJSONToFile({ a: 1 }, minified, true, false);
		expect(await Bun.file(pretty).text()).toContain('\n');
		expect(await Bun.file(minified).text()).toBe('{"a":1}');
	});
});

describe('fs.readCompressed handler', () => {
	const fs = initFsHandlers();

	for (const algorithm of COMPRESSION_ALGORITHMS) {
		it(`${algorithm}: reads an uploaded file using its name alone`, async () => {
			// This is the path an upload takes now: it lands in a temp file and is
			// read back, so the algorithm has to come from the extension.
			const json = '{"name":"Kompresní test"}';
			const path = tempFile(`upload.lishset${compressionExtension(algorithm)}`);
			await Bun.write(path, Utils.compress(new TextEncoder().encode(json) as Uint8Array<ArrayBuffer>, algorithm));
			expect((await fs.readCompressed({ path })).content).toBe(json);
		});
	}

	it('pretty-prints JSON on request and leaves non-JSON alone', async () => {
		const jsonPath = tempFile('pretty.json');
		const textPath = tempFile('plain.txt');
		await Bun.write(jsonPath, '{"a":1}');
		await Bun.write(textPath, 'hello');
		expect((await fs.readCompressed({ path: jsonPath, prettyJSON: true })).content).toBe('{\n\t"a": 1\n}');
		expect((await fs.readCompressed({ path: textPath, prettyJSON: true })).content).toBe('hello');
	});

	it('reads a compressed file and an uncompressed one through the same handler', async () => {
		const compressedPath = tempFile('handler.lishset.zst');
		const plainPath = tempFile('handler.lishset');
		await Utils.writeJSONToFile({ a: 1 }, compressedPath, true, true, 'zstd');
		await Utils.writeJSONToFile({ a: 1 }, plainPath, true, false);
		expect((await fs.readCompressed({ path: compressedPath })).content).toBe('{"a":1}');
		expect((await fs.readCompressed({ path: plainPath, prettyJSON: true })).content).toBe('{\n\t"a": 1\n}');
	});
});

describe('Utils.fetchURL', () => {
	it('decompresses according to the URL it was redirected to', async () => {
		const json = '{"redirected":true}';
		const body = Utils.compress(new TextEncoder().encode(json) as Uint8Array<ArrayBuffer>, 'zstd');
		const server = Bun.serve({
			port: 0,
			fetch(req): Response {
				// The entry point carries no compression extension — only the target does.
				if (new URL(req.url).pathname === '/latest.lish') return Response.redirect(new URL('/v2.lish.zst', req.url).href, 302);
				return new Response(body);
			},
		});
		try {
			expect(await Utils.fetchURL(`http://localhost:${server.port}/latest.lish`)).toBe(json);
		} finally {
			await server.stop(true);
		}
	});

	it('refuses a Content-Encoding bomb without ever allocating it', async () => {
		// 192 concatenated zstd frames of zeros: 9.6 KB on the wire, 192 MiB decoded. A zstd
		// decoder treats concatenated frames as one stream, so this is the cheap shape of the
		// attack — no oversized buffer is needed to build it, on either side.
		const frame = Utils.compress(new Uint8Array(1024 * 1024) as Uint8Array<ArrayBuffer>, 'zstd');
		const bomb = new Uint8Array(frame.byteLength * 192);
		for (let i = 0; i < 192; i++) bomb.set(frame, i * frame.byteLength);
		expect(bomb.byteLength).toBeLessThan(64 * 1024);
		const server = Bun.serve({
			port: 0,
			// A truthful Content-Length, so nothing about the response looks suspicious up front.
			fetch: (): Response => new Response(bomb, { headers: { 'content-encoding': 'zstd', 'content-length': String(bomb.byteLength) } }),
		});
		// Sample RSS across the call. The error alone proves nothing here: the runtime can
		// expand the whole body natively and only then hand over a chunk to be rejected,
		// which is the out-of-memory this cap exists to prevent. So the allocation is what
		// gets asserted first, and the error code second.
		Bun.gc(true);
		const baseline = process.memoryUsage.rss();
		let peak = baseline;
		const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage.rss())), 4);
		let failure: unknown;
		try {
			await Utils.fetchURL(`http://localhost:${server.port}/settings.json`);
		} catch (err) {
			failure = err;
		} finally {
			clearInterval(sampler);
			await server.stop(true);
		}
		// Decoded output is 192 MiB; anything close to that means the bytes were materialised.
		expect(peak - baseline).toBeLessThan(64 * 1024 * 1024);
		expect((failure as Error | undefined)?.message).toContain(ErrorCodes.DECOMPRESSED_TOO_LARGE);
	});

	it('undoes a transfer encoding and a file extension that name different codecs', async () => {
		// Nothing decodes this body for us any more, so both layers are ours to unwrap.
		const json = '{"double":true}';
		const inner = Utils.compress(new TextEncoder().encode(json) as Uint8Array<ArrayBuffer>, 'gzip');
		const outer = Utils.compress(inner, 'brotli');
		const server = Bun.serve({
			port: 0,
			fetch: (): Response => new Response(outer, { headers: { 'content-encoding': 'br' } }),
		});
		try {
			expect(await Utils.fetchURL(`http://localhost:${server.port}/settings.json.gz`)).toBe(json);
		} finally {
			await server.stop(true);
		}
	});

	it('treats an extension and a matching transfer encoding as one layer', async () => {
		// The common ambiguous case: a .gz file served as Content-Encoding: gzip is gzipped
		// once, whatever the two labels suggest between them.
		const json = '{"single":true}';
		const body = Utils.compress(new TextEncoder().encode(json) as Uint8Array<ArrayBuffer>, 'gzip');
		const server = Bun.serve({
			port: 0,
			fetch: (): Response => new Response(body, { headers: { 'content-encoding': 'gzip' } }),
		});
		try {
			expect(await Utils.fetchURL(`http://localhost:${server.port}/settings.json.gz`)).toBe(json);
		} finally {
			await server.stop(true);
		}
	});

	for (const [variant, deflate] of [
		['zlib-wrapped', deflateSync],
		['raw', deflateRawSync],
	] as const) {
		it(`decodes a ${variant} deflate transfer encoding`, async () => {
			// The runtime decoded both variants for us until this path took the job over;
			// a URL that worked before must not start failing because of which one arrives.
			const json = '{"deflated":true}';
			const server = Bun.serve({
				port: 0,
				fetch: (): Response => new Response(deflate(new TextEncoder().encode(json)), { headers: { 'content-encoding': 'deflate' } }),
			});
			try {
				expect(await Utils.fetchURL(`http://localhost:${server.port}/settings.json`)).toBe(json);
			} finally {
				await server.stop(true);
			}
		});
	}

	it('undoes a deflate transfer encoding and the file extension underneath it', async () => {
		// `deflate` is never a file extension, so the two layers can never collapse into one:
		// the transport comes off first, and the .gz the URL names is still there afterwards.
		const json = '{"both":true}';
		const body = deflateSync(Utils.compress(new TextEncoder().encode(json) as Uint8Array<ArrayBuffer>, 'gzip'));
		const server = Bun.serve({
			port: 0,
			fetch: (): Response => new Response(body, { headers: { 'content-encoding': 'deflate' } }),
		});
		try {
			expect(await Utils.fetchURL(`http://localhost:${server.port}/settings.json.gz`)).toBe(json);
		} finally {
			await server.stop(true);
		}
	});

	it('caps a deflate Content-Encoding bomb like any other', async () => {
		const bomb = deflateSync(new Uint8Array(MAX_API_MESSAGE_SIZE + 1024 * 1024));
		expect(bomb.byteLength).toBeLessThan(1024 * 1024);
		const server = Bun.serve({
			port: 0,
			fetch: (): Response => new Response(bomb, { headers: { 'content-encoding': 'deflate' } }),
		});
		try {
			await expect(Utils.fetchURL(`http://localhost:${server.port}/settings.json`)).rejects.toThrow(ErrorCodes.DECOMPRESSED_TOO_LARGE);
		} finally {
			await server.stop(true);
		}
	});

	it('rejects a transfer encoding it cannot decode instead of returning the bytes', async () => {
		// `compress` (LZW) is a real HTTP content coding that nothing here can read.
		const server = Bun.serve({
			port: 0,
			fetch: (): Response => new Response(Utils.compress(new TextEncoder().encode('{"a":1}') as Uint8Array<ArrayBuffer>, 'gzip'), { headers: { 'content-encoding': 'compress' } }),
		});
		try {
			await expect(Utils.fetchURL(`http://localhost:${server.port}/settings.json`)).rejects.toThrow(ErrorCodes.UNSUPPORTED_DECOMPRESSION);
		} finally {
			await server.stop(true);
		}
	});

	it('falls back to the requested URL when the redirect target has no extension', async () => {
		const json = '{"cdn":true}';
		const body = Utils.compress(new TextEncoder().encode(json) as Uint8Array<ArrayBuffer>, 'gzip');
		const server = Bun.serve({
			port: 0,
			fetch(req): Response {
				// A release/CDN redirect: the request names .lish.gz, the target is an opaque blob.
				if (new URL(req.url).pathname === '/dl/project.lish.gz') return Response.redirect(new URL('/objects/9f3a2b1c', req.url).href, 302);
				return new Response(body);
			},
		});
		try {
			expect(await Utils.fetchURL(`http://localhost:${server.port}/dl/project.lish.gz`)).toBe(json);
		} finally {
			await server.stop(true);
		}
	});
});

describe('compression extension helpers', () => {
	it('detects every canonical extension and the legacy aliases', () => {
		expect(detectCompression('a.lish.gz')).toBe('gzip');
		expect(detectCompression('a.lish.GZIP')).toBe('gzip');
		expect(detectCompression('a.lish.br')).toBe('brotli');
		expect(detectCompression('a.lish.zst')).toBe('zstd');
		expect(detectCompression('a.lish.zstd')).toBe('zstd');
		expect(detectCompression('a.lish')).toBeNull();
		expect(isCompressed('a.lish')).toBe(false);
		expect(isCompressed('a.lish.br')).toBe(true);
	});

	it('strips only a trailing compression extension', () => {
		expect(stripCompressionExtension('a.lish.zst')).toBe('a.lish');
		expect(stripCompressionExtension('a.lish')).toBe('a.lish');
	});

	it('sees through a URL query string and fragment', () => {
		expect(detectCompression(Utils.urlPath('https://example.com/a.lish.zst?token=1'))).toBe('zstd');
		expect(detectCompression(Utils.urlPath('https://example.com/a.lish.br#part'))).toBe('brotli');
		expect(detectCompression(Utils.urlPath('https://example.com/a.lish'))).toBeNull();
		// A local path is not a URL — it must survive unchanged, including a '#' in the name.
		expect(detectCompression(Utils.urlPath('C:\\data\\note#1.lish.gz'))).toBe('gzip');
	});

	it('expands a picker pattern with every recognised extension', () => {
		const patterns = withCompressionExtensions(['*.lish']);
		expect(patterns).toContain('*.lish');
		expect(patterns).toContain('*.lish.gz');
		expect(patterns).toContain('*.lish.gzip');
		expect(patterns).toContain('*.lish.br');
		expect(patterns).toContain('*.lish.zst');
		expect(patterns).toContain('*.lish.zstd');
	});
});
