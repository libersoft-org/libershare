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

/**
 * Real writes with an injected I/O failure, each in its own process so the module mock cannot
 * reach other tests. Before the rename the old file must stay whole; after it the new content
 * is on disk and the caller is told durability was not confirmed.
 */
describe('JSONStorage write failures', () => {
	async function faultyWrite(fault: 'rename' | 'dirsync'): Promise<{ content: unknown; entries: string[]; error: { name: string; published: boolean; code: string } | null; flushed: string }> {
		const dir = tempDir();
		writeFileSync(join(dir, 'settings.json'), JSON.stringify({ audio: { volume: 50 } }));
		const script = `
			import { mock } from 'bun:test';
			const fsp = { ...(await import('node:fs/promises')) };
			const { resolve } = await import('node:path');
			const DIR = resolve(${JSON.stringify(dir)});
			const eio = () => Object.assign(new Error('injected'), { code: 'EIO' });
			mock.module('node:fs/promises', () => ({
				...fsp,
				rename: ${JSON.stringify(fault)} === 'rename' ? async () => { throw eio(); } : fsp.rename,
				open: async (path, flags, mode) => {
					const handle = await fsp.open(path, flags, mode);
					if (${JSON.stringify(fault)} === 'dirsync' && resolve(String(path)) === DIR) return { sync: async () => { throw eio(); }, close: () => handle.close() };
					return handle;
				},
			}));
			const { JSONStorage } = await import('./src/storage.ts');
			const storage = await JSONStorage.create(DIR, 'settings.json', { audio: { volume: 1 } });
			const error = await storage.set('audio.volume', 7).then(() => null, e => ({ name: e.name, published: e.published, code: e.code }));
			const flushed = await storage.flush().then(() => 'ok', e => e.name);
			console.log(JSON.stringify({ error, flushed }));
		`;
		try {
			const child = Bun.spawn([process.execPath, '--eval', script], { cwd: join(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });
			const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
			if (code !== 0) throw new Error(`fixture exited ${code}: ${err}`);
			const lines = out.trim().split(String.fromCharCode(10));
			const result = JSON.parse(lines[lines.length - 1]!);
			return { ...result, content: JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')), entries: readdirSync(dir) };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it('keeps the old file whole when the write fails before the rename', async () => {
		const result = await faultyWrite('rename');
		expect(result.error).toEqual({ name: 'StorageWriteError', published: false, code: 'EIO' });
		expect(result.content).toEqual({ audio: { volume: 50 } });
		expect(result.entries).toEqual(['settings.json']);
		expect(result.flushed).toBe('StorageWriteError');
	}, 30_000);

	it('reports unconfirmed durability when the directory flush after the rename fails', async () => {
		const result = await faultyWrite('dirsync');
		expect(result.error).toEqual({ name: 'StorageWriteError', published: true, code: 'EIO' });
		expect(result.content).toEqual({ audio: { volume: 7 } });
		expect(result.flushed).toBe('StorageWriteError');
	}, 30_000);
});
