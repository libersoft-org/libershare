import { describe, expect, it, afterAll } from 'bun:test';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { uploadFileName } from '../../../src/api/upload.ts';
import { Utils } from '../../../src/utils.ts';
import { COMPRESSION_ALGORITHMS, compressionExtension, detectCompression } from '@shared';

const tempFiles: string[] = [];

afterAll(async () => {
	for (const path of tempFiles) await rm(path, { force: true });
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
