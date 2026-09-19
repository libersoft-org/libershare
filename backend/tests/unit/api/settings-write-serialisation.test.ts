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

describe('the chunk/message floor repair rides with its own write', () => {
	/** The pair the protocol needs: a message limit at least as large as one chunk. */
	const MIB = 1024 * 1024;

	it('does not let one import put its floor on another import values', async () => {
		const settings = await makeSettings();

		// Two imports of the same two linked values. Repaired after the lock instead of inside
		// it, the first one read its own chunk size, waited, and then wrote the floor derived
		// from it over the second one's message size — leaving a pair neither import asked for.
		const first = settings.setMany([
			{ path: 'network.maxChunkSize', value: 64 * MIB },
			{ path: 'network.maxMessageSize', value: 65 * MIB },
		]);
		const second = settings.setMany([
			{ path: 'network.maxMessageSize', value: 9 * MIB },
			{ path: 'network.maxChunkSize', value: 8 * MIB },
		]);
		await Promise.all([first, second]);

		const chunk = settings.get('network.maxChunkSize');
		const message = settings.get('network.maxMessageSize');
		// Whichever import landed last, the two values have to be its own — and the message
		// limit must still carry one chunk.
		expect([64 * MIB, 8 * MIB]).toContain(chunk);
		expect(message).toBe(chunk === 64 * MIB ? 65 * MIB : 9 * MIB);
		expect(message).toBeGreaterThanOrEqual(chunk);
	});

	it('raises a message limit that cannot carry one chunk', async () => {
		const settings = await makeSettings();
		await settings.setMany([
			{ path: 'network.maxChunkSize', value: 32 * MIB },
			{ path: 'network.maxMessageSize', value: 1 },
		]);
		expect(settings.get('network.maxMessageSize')).toBeGreaterThanOrEqual(32 * MIB);
	});
});

describe('a reader never sees a half-applied import', () => {
	it('leaves the stored document untouched when every key is rejected', async () => {
		const settings = await makeSettings();
		await settings.setMany([{ path: 'network.incomingPort', value: 9091 }]);
		const result = await settings.setMany([{ path: '__proto__.x', value: 1 }]);
		expect(result).toEqual({ applied: 0, skipped: ['__proto__.x'] });
		expect(settings.get('network.incomingPort')).toBe(9091);
	});
});
