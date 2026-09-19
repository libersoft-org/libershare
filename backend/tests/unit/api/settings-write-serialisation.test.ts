import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Settings } from '../../../src/settings.ts';

/**
 * A settings import and a reset must not mix their results.
 *
 * Both write through the same storage, and an import applies its keys one at a time with
 * a file write between them. A reset landing inside that loop replaced the whole document
 * with the defaults, after which the rest of the import was applied on top — leaving a
 * document that is neither, while both calls reported success. The node reads part of
 * these values only when it is built, so the mixture outlives the request that made it.
 */

const dirs: string[] = [];

afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function makeSettings(): Promise<Settings> {
	const dir = await mkdtemp(join(tmpdir(), 'lish-settings-'));
	dirs.push(dir);
	return await Settings.create(dir);
}

/** Keys the defaults do not define, so "present" and "absent" separate the two outcomes. */
const KEYS = Array.from({ length: 40 }, (_, i) => ({ path: `importProbe.k${i}`, value: i }));

describe('settings writes are serialised', () => {
	it('never leaves an import half-replaced by a reset', async () => {
		const settings = await makeSettings();

		const imported = settings.setMany(KEYS);
		// Starts while the import is between two of its key writes.
		await Promise.resolve();
		const reset = settings.reset();
		await Promise.all([imported, reset]);

		const probe = settings.get('importProbe');
		const present = KEYS.filter(k => settings.get(k.path) === k.value).length;
		// Either the reset ran first and the import landed whole, or the import ran first
		// and the reset wiped all of it. A count in between is the mixed document.
		expect(present === KEYS.length || present === 0).toBe(true);
		if (present === 0) expect(probe).toBeUndefined();
	});

	it('reports every key it applied', async () => {
		const settings = await makeSettings();
		const result = await settings.setMany(KEYS);
		expect(result).toEqual({ applied: KEYS.length, skipped: [] });
		expect(settings.get('importProbe.k39')).toBe(39);
	});

	it('skips a rejected key and keeps writing the rest', async () => {
		const settings = await makeSettings();
		const result = await settings.setMany([
			{ path: 'importProbe.a', value: 1 },
			{ path: '__proto__.polluted', value: true },
			{ path: 'importProbe.b', value: 2 },
		]);
		expect(result.applied).toBe(2);
		expect(result.skipped).toEqual(['__proto__.polluted']);
		expect(settings.get('importProbe.b')).toBe(2);
		expect(({} as any).polluted).toBeUndefined();
	});

	it('keeps single writes from interleaving with a reset', async () => {
		const settings = await makeSettings();
		await settings.setMany([{ path: 'importProbe.k0', value: 0 }]);

		const written = settings.set('importProbe.k0', 99);
		await Promise.resolve();
		const reset = settings.reset();
		await Promise.all([written, reset]);

		// The write either survived the reset or was wiped by it; a write that lands on the
		// document the reset already replaced would leave the key alone with no siblings.
		const value = settings.get('importProbe.k0');
		expect(value === 99 || value === undefined).toBe(true);
	});
});
