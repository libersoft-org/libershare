import { describe, it, expect, afterAll } from 'bun:test';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Utils } from '../../src/utils.ts';
import { COMPRESSION_ALGORITHMS, compressionExtension, detectCompression, stripCompressionExtension, withCompressionExtensions, isCompressed, ErrorCodes } from '@shared';

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
