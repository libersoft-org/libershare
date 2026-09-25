import { describe, expect, it } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSONStorage, StorageWriteError } from '../../src/storage.ts';

function tempDir(): string {
	const dir = join(tmpdir(), `lish-atomic-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe('JSONStorage writes settings atomically', () => {
	it('replaces the file with the whole document and leaves no staging file behind', async () => {
		const dir = tempDir();
		try {
			const storage = await JSONStorage.create(dir, 'settings.json', { audio: { volume: 50 }, ui: { theme: 'dark' } });
			await storage.set('audio.volume', 7);
			expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ audio: { volume: 7 }, ui: { theme: 'dark' } });
			expect(readdirSync(dir)).toEqual(['settings.json']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('creates a missing data directory before the first write', async () => {
		const dir = join(tempDir(), 'nested', 'data');
		try {
			await JSONStorage.create(dir, 'settings.json', { audio: { volume: 50 } });
			expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ audio: { volume: 50 } });
		} finally {
			rmSync(join(dir, '..', '..'), { recursive: true, force: true });
		}
	});

	it('refuses to write through a symlinked settings file and keeps both files untouched', async () => {
		const dir = tempDir();
		const outside = join(tempDir(), 'elsewhere.json');
		try {
			writeFileSync(outside, '{"audio":{"volume":1}}');
			try {
				symlinkSync(outside, join(dir, 'settings.json'));
			} catch {
				return; // no symlink privilege on this host (unelevated Windows)
			}
			const storage = await JSONStorage.create(dir, 'settings.json', { audio: { volume: 50 } });
			const failure = await storage.set('audio.volume', 99).catch((err: unknown) => err);
			expect(failure).toBeInstanceOf(StorageWriteError);
			expect((failure as StorageWriteError).published).toBe(false);
			expect((failure as StorageWriteError).message).not.toContain('99');
			expect(readFileSync(outside, 'utf8')).toBe('{"audio":{"volume":1}}');
			expect(readdirSync(dir)).toEqual(['settings.json']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(join(outside, '..'), { recursive: true, force: true });
		}
	});
});

describe('StorageWriteError', () => {
	it('names the outcome and the I/O code, never a value', () => {
		const before = new StorageWriteError(Object.assign(new Error('x'), { code: 'EIO' }), false);
		expect(before.message).toBe('Settings file was not replaced; in-memory settings may differ from disk (EIO).');
		expect(before.code).toBe('EIO');
		const after = new StorageWriteError(Object.assign(new Error('x'), { code: 'EIO' }), true);
		expect(after.message).toBe('Settings file now contains the new settings, but durability could not be confirmed (EIO).');
		expect(after.published).toBe(true);
	});
});
