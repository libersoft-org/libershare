import { describe, expect, it, afterAll } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSONStorage, StorageLoadError } from '../../src/storage.ts';

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function dirWith(content: string | null): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'lish-load-'));
	dirs.push(dir);
	if (content !== null) await writeFile(join(dir, 'settings.json'), content);
	return dir;
}

const DEFAULTS = { audio: { volume: 50 }, ui: { theme: 'dark' } };

describe('JSONStorage.create refuses a settings file it cannot use', () => {
	for (const [name, content] of [
		['truncated JSON', '{"audio":{"volume":7'],
		['empty file', ''],
		['null root', 'null'],
		['array root', '[1,2]'],
		['primitive root', '42'],
	] as const) {
		it(`${name}: throws and leaves the file byte-for-byte`, async () => {
			const dir = await dirWith(content);
			await expect(JSONStorage.create(dir, 'settings.json', DEFAULTS)).rejects.toBeInstanceOf(StorageLoadError);
			expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(content);
		});
	}

	it('a directory where the file should be is refused, not replaced', async () => {
		const dir = await dirWith(null);
		await mkdir(join(dir, 'settings.json'));
		await expect(JSONStorage.create(dir, 'settings.json', DEFAULTS)).rejects.toBeInstanceOf(StorageLoadError);
	});

	it('the error names the recovery, not the content', async () => {
		const dir = await dirWith('{"secret":"do-not-log"');
		const error = await JSONStorage.create(dir, 'settings.json', DEFAULTS).catch((e: Error) => e);
		expect((error as Error).message).toContain('restore a verified settings export');
		expect((error as Error).message).not.toContain('do-not-log');
	});

	it('only a missing file starts from the defaults and writes them', async () => {
		const dir = await dirWith(null);
		const storage = await JSONStorage.create(dir, 'settings.json', DEFAULTS);
		expect(storage.list()).toEqual(DEFAULTS);
		expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))).toEqual(DEFAULTS);
	});

	it('a partial object from an older version is completed from the defaults', async () => {
		const dir = await dirWith('{"audio":{"volume":7}}');
		const storage = await JSONStorage.create(dir, 'settings.json', DEFAULTS);
		expect(storage.list()).toEqual({ audio: { volume: 7 }, ui: { theme: 'dark' } });
	});
});
