import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { minMessageSizeFor } from '@shared';
import { Settings } from '../../../src/settings.ts';
import { JSONStorage, StorageWriteError } from '../../../src/storage.ts';
import { initSettingsHandlers } from '../../../src/api/settings.ts';
import { downloadLimiter, uploadLimiter } from '../../../src/protocol/speed-limiter.ts';
import { buildFactoryResetHandler } from '../../../src/api/factory-reset-orchestrator.ts';

const dirs: string[] = [];

afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'lish-persist-'));
	dirs.push(dir);
	return dir;
}

/** Count real file saves: the protected queue entry every write goes through. */
function countSaves(): { count: () => number; restore: () => void } {
	const proto = JSONStorage.prototype as any;
	const original = proto.saveFile;
	let n = 0;
	proto.saveFile = function (this: unknown, data: unknown) {
		n++;
		return original.call(this, data);
	};
	return { count: () => n, restore: () => (proto.saveFile = original) };
}

describe('Settings.set writes one normalized document', () => {
	it('stores a chunk size and the message-size floor it requires in a single save', async () => {
		const settings = await Settings.create(await tempDir());
		const chunk = settings.get('network.maxMessageSize') * 4;
		const saves = countSaves();
		try {
			await settings.set('network.maxChunkSize', chunk);
			expect(saves.count()).toBe(1);
		} finally {
			saves.restore();
		}
		expect(settings.get('network.maxMessageSize')).toBeGreaterThanOrEqual(minMessageSizeFor(chunk));
	});

	it('rejects an illegal key before anything is published or saved', async () => {
		const settings = await Settings.create(await tempDir());
		const saves = countSaves();
		try {
			await expect(settings.set('audio.__proto__', 1)).rejects.toThrow('Illegal settings key');
			expect(saves.count()).toBe(0);
		} finally {
			saves.restore();
		}
	});

	it('keeps the import contract: a rejected key is skipped, the rest lands', async () => {
		const settings = await Settings.create(await tempDir());
		const result = await settings.setMany([
			{ path: 'audio.volume', value: 3 },
			{ path: 'audio.__proto__', value: 1 },
		]);
		expect(result).toEqual({ applied: 1, skipped: ['audio.__proto__'] });
		expect(settings.get('audio.volume')).toBe(3);
	});
});

describe('settings API reports a failed save instead of success', () => {
	async function settingsBehindSymlink(): Promise<{ settings: Settings; outside: string } | null> {
		const dir = await tempDir();
		const outside = join(await tempDir(), 'real.json');
		await writeFile(outside, '{}');
		try {
			await symlink(outside, join(dir, 'settings.json'));
		} catch {
			return null; // no symlink privilege on this host
		}
		return { settings: await Settings.create(dir), outside };
	}

	for (const [name, call] of [
		['set', (h: ReturnType<typeof initSettingsHandlers>) => h.set({ path: 'audio.volume', value: 9 })],
		['applyImported', (h: ReturnType<typeof initSettingsHandlers>) => h.applyImported({ data: { audio: { volume: 9 } } })],
		['reset', (h: ReturnType<typeof initSettingsHandlers>) => h.reset()],
	] as const) {
		it(`${name} rejects with the storage message the dispatcher forwards as errorDetail`, async () => {
			const setup = await settingsBehindSymlink();
			if (!setup) return;
			const failure = await call(initSettingsHandlers(setup.settings)).then(
				() => null,
				(err: unknown) => err
			);
			expect(failure).toBeInstanceOf(StorageWriteError);
			expect((failure as Error).message).toStartWith('Settings file was not replaced');
			expect(await readFile(setup.outside, 'utf8')).toBe('{}');
		});
	}
});

describe('transfer limits follow the live settings even when the save fails', () => {
	async function brokenSettings(): Promise<Settings | null> {
		const dir = await tempDir();
		const outside = join(await tempDir(), 'real.json');
		await writeFile(outside, '{}');
		try {
			await symlink(outside, join(dir, 'settings.json'));
		} catch {
			return null;
		}
		return await Settings.create(dir);
	}

	it('set of a rate updates both real limiters before the error is returned', async () => {
		const settings = await brokenSettings();
		if (!settings) return;
		const handlers = initSettingsHandlers(settings);
		await expect(handlers.set({ path: 'network.maxDownloadSpeed', value: 321 })).rejects.toBeInstanceOf(StorageWriteError);
		await expect(handlers.set({ path: 'network', value: { ...settings.get('network'), maxUploadSpeed: 654 } })).rejects.toBeInstanceOf(StorageWriteError);
		expect(downloadLimiter.getLimit()).toBe(321 * 1024);
		expect(uploadLimiter.getLimit()).toBe(654 * 1024);
	});

	it('import and reset re-apply the live rates on failure', async () => {
		const settings = await brokenSettings();
		if (!settings) return;
		const handlers = initSettingsHandlers(settings);
		await expect(handlers.applyImported({ data: { network: { maxDownloadSpeed: 111, maxUploadSpeed: 222 } } })).rejects.toBeInstanceOf(StorageWriteError);
		expect([downloadLimiter.getLimit(), uploadLimiter.getLimit()]).toEqual([111 * 1024, 222 * 1024]);
		await expect(handlers.reset()).rejects.toBeInstanceOf(StorageWriteError);
		const defaults = settings.getDefaults().network;
		expect([downloadLimiter.getLimit(), uploadLimiter.getLimit()]).toEqual([defaults.maxDownloadSpeed * 1024, defaults.maxUploadSpeed * 1024]);
	});
});
