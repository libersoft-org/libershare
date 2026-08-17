import { describe, it, expect, afterAll } from 'bun:test';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Utils } from '../../src/utils.ts';
import { initFsHandlers } from '../../src/api/fs.ts';
import { COMPRESSION_ALGORITHMS, compressionExtension, detectCompression, stripCompressionExtension, withCompressionExtensions, isCompressed, ErrorCodes, MAX_API_MESSAGE_SIZE } from '@shared';

/** Mixed binary + UTF-8 payload — catches encoding-sensitive round-trip bugs. */
function samplePayload(): Uint8Array<ArrayBuffer> {
	const text = new TextEncoder().encode('Příliš žluťoučký kůň úpěl ďábelské ódy — ✓');
	const bytes = new Uint8Array(text.length + 256);
	bytes.set(text, 0);
	for (let i = 0; i < 256; i++) bytes[text.length + i] = i;
	return bytes as Uint8Array<ArrayBuffer>;
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
