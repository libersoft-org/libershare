import { describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFatalStorageError, fatalStorageMessage, FATAL_STORAGE_CODES, JSONStorage } from '../../src/storage.ts';

describe('storage fatal-error classifier', () => {
	for (const code of FATAL_STORAGE_CODES) {
		it(`classifies ${code} as fatal`, () => {
			const err = Object.assign(new Error('boom'), { code });
			expect(isFatalStorageError(err)).toBe(true);
		});
	}

	it('does not classify ENOENT as fatal', () => {
		const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
		expect(isFatalStorageError(err)).toBe(false);
	});

	it('does not classify a plain Error as fatal', () => {
		expect(isFatalStorageError(new Error('plain'))).toBe(false);
	});

	it('does not classify null/undefined as fatal', () => {
		expect(isFatalStorageError(null)).toBe(false);
		expect(isFatalStorageError(undefined)).toBe(false);
	});
});

describe('storage fatal-error message', () => {
	const fixture = '/app/config/settings.json';

	it('mentions the file path and code on every line block', () => {
		const lines = fatalStorageMessage(fixture, 'EACCES');
		expect(lines[0]).toContain(fixture);
		expect(lines[0]).toContain('EACCES');
		expect(lines.length).toBeGreaterThan(1);
	});

	it('points permission codes at the service UID/GID, never at re-owning to root', () => {
		for (const code of ['EACCES', 'EROFS', 'EPERM'] as const) {
			const joined = fatalStorageMessage(fixture, code).join('\n');
			expect(joined).toContain('LISH_UID/LISH_GID');
			expect(joined).not.toContain('chown 0:0');
		}
	});

	it('uses a disk-full hint for ENOSPC instead of the chown hint', () => {
		const joined = fatalStorageMessage(fixture, 'ENOSPC').join('\n');
		expect(joined).toContain('full');
		expect(joined).not.toContain('chown 0:0');
	});

	it('uses a directory-clash hint for EISDIR', () => {
		const joined = fatalStorageMessage(fixture, 'EISDIR').join('\n');
		expect(joined).toContain('directory');
		expect(joined).not.toContain('chown 0:0');
	});
});

describe('JSONStorage concurrent writes', () => {
	it('serializes a burst of set() calls and lands on the latest value', async () => {
		const dir = join(tmpdir(), `storage-test-${process.pid}-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		try {
			const storage = await JSONStorage.create(dir, 'settings.json', { audio: { volume: 50 } });
			// Unawaited overlapping writes — the per-instance chain must keep the
			// file valid JSON and finish on the newest value, never an older one.
			const writes: Array<Promise<void>> = [];
			for (let v = 1; v <= 20; v++) writes.push(storage.set('audio.volume', v));
			await Promise.all(writes);
			const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
			expect(onDisk.audio.volume).toBe(20);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('JSONStorage.setMany publishes a batch in one step', () => {
	function makeStorage(): Promise<JSONStorage<{ network: { port: number; discovery: boolean } }>> {
		const dir = join(tmpdir(), `lish-batch-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		return JSONStorage.create(dir, 'settings.json', { network: { port: 9090, discovery: true } });
	}

	it('never exposes a document with only part of the batch applied', async () => {
		const storage = await makeStorage();

		// Deliberately not awaited: this is the reader that takes no lock — the node is built
		// straight off `list()`. Applied key by key, the document at this instant carries the
		// new port beside the old discovery flag, a pair no caller ever asked for.
		const writing = storage.setMany([
			{ path: 'network.port', value: 19090 },
			{ path: 'network.discovery', value: false },
		]);
		const live = storage.list().network;
		expect(`${live.port}/${live.discovery}`).toBe('19090/false');

		await writing;
		expect(storage.get('network.discovery')).toBe(false);
	});

	it('reports a rejected key and keeps the rest of the batch', async () => {
		const storage = await makeStorage();
		const result = await storage.setMany([
			{ path: 'network.port', value: 19091 },
			{ path: '__proto__.polluted', value: true },
		]);
		expect(result).toEqual({ applied: 1, skipped: ['__proto__.polluted'] });
		expect(storage.get('network.port')).toBe(19091);
		expect(({} as any).polluted).toBeUndefined();
	});
});
