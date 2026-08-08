import { describe, it, expect, afterAll } from 'bun:test';
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

	it('rejects an unsupported algorithm instead of silently passing data through', () => {
		const data = samplePayload();
		expect(() => Utils.compress(data, 'bzip2' as any)).toThrow(ErrorCodes.UNSUPPORTED_COMPRESSION);
		expect(() => Utils.decompress(data, 'xz' as any)).toThrow(ErrorCodes.UNSUPPORTED_DECOMPRESSION);
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

describe('fs.decompressText / fs.readCompressed handlers', () => {
	const fs = initFsHandlers();

	for (const algorithm of COMPRESSION_ALGORITHMS) {
		it(`${algorithm}: decompresses a base64 upload using the file name alone`, async () => {
			const json = '{"name":"Kompresní test"}';
			const compressed = Utils.compress(new TextEncoder().encode(json) as Uint8Array<ArrayBuffer>, algorithm);
			const base64 = Buffer.from(compressed).toString('base64');
			const result = await fs.decompressText({ data: base64, fileName: `backup.lishset${compressionExtension(algorithm)}` });
			expect(result.content).toBe(json);
		});
	}

	it('returns an uncompressed upload unchanged', async () => {
		const base64 = Buffer.from('plain text', 'utf-8').toString('base64');
		expect((await fs.decompressText({ data: base64, fileName: 'notes.json' })).content).toBe('plain text');
	});

	it('pretty-prints JSON on request and leaves non-JSON alone', async () => {
		const base64 = Buffer.from('{"a":1}', 'utf-8').toString('base64');
		expect((await fs.decompressText({ data: base64, fileName: 'a.json', prettyJSON: true })).content).toBe('{\n\t"a": 1\n}');
		const notJSON = Buffer.from('hello', 'utf-8').toString('base64');
		expect((await fs.decompressText({ data: notJSON, fileName: 'a.txt', prettyJSON: true })).content).toBe('hello');
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
