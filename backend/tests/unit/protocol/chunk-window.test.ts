import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, totalmem } from 'os';
import { pipelineDepth } from '../../../src/protocol/chunk-downloader.ts';
import { ByteBudget } from '../../../src/protocol/inflight-budget.ts';
import { CHUNK_WINDOW_MAX_REQUESTS } from '../../../src/protocol/constants.ts';
import { DEFAULT_CHUNK_INFLIGHT_BUDGET_BYTES, Settings, chunkInflightBudgetFor, usableMemoryBytes, useNetworkSettings, type SettingsData } from '../../../src/settings.ts';
import { ErrorCodes } from '@shared';

const MiB = 1024 * 1024;

let defaults: SettingsData['network'];
let defaultsDir: string;
beforeAll(async () => {
	defaultsDir = mkdtempSync(join(tmpdir(), 'lish-chunk-window-defaults-'));
	defaults = (await Settings.create(defaultsDir)).getDefaults().network;
});
afterAll(() => rmSync(defaultsDir, { recursive: true, force: true }));

function withNetwork(overrides: Partial<SettingsData['network']>): void {
	const network = { ...defaults, ...overrides };
	useNetworkSettings(() => network);
}

afterEach(() => useNetworkSettings(() => defaults));

describe('pipelineDepth', () => {
	it('pipelines as many chunks as fit in the 16 MiB default window', () => {
		withNetwork({});
		expect(pipelineDepth(1 * MiB)).toBe(16);
		expect(pipelineDepth(4 * MiB)).toBe(4);
		expect(pipelineDepth(16 * MiB)).toBe(1);
	});

	it('keeps one request in flight for chunks larger than the window', () => {
		withNetwork({});
		for (const size of [16 * MiB + 1, 17 * MiB, 64 * MiB, 100 * MiB, 1024 * MiB]) expect(pipelineDepth(size)).toBe(1);
	});

	it('caps tiny chunks at the request limit', () => {
		withNetwork({});
		expect(pipelineDepth(1024)).toBe(CHUNK_WINDOW_MAX_REQUESTS);
	});

	it('follows the window setting as it changes', () => {
		withNetwork({ chunkWindowBytes: 32 * MiB });
		expect(pipelineDepth(4 * MiB)).toBe(8);
		withNetwork({ chunkWindowBytes: 4 * MiB });
		expect(pipelineDepth(4 * MiB)).toBe(1);
	});
});

describe('ByteBudget.refresh', () => {
	it('grants a waiting reservation as soon as the capacity is raised', async () => {
		let capacity = 4;
		const budget = new ByteBudget(() => capacity);
		const first = await budget.reserve(3);
		let granted = false;
		const waiting = budget.reserve(3).then(release => {
			granted = true;
			return release;
		});
		await Bun.sleep(5);
		expect(granted).toBe(false);
		capacity = 8;
		budget.refresh();
		(await waiting)();
		expect(granted).toBe(true);
		first();
	});
});

describe('chunk window settings', () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	const create = async (): Promise<Settings> => {
		dir = mkdtempSync(join(tmpdir(), 'lish-chunk-window-'));
		return Settings.create(dir);
	};

	it('refuses a per-peer window above the shared budget, from either side', async () => {
		const settings = await create();
		await expect(settings.set('network.chunkWindowBytes', DEFAULT_CHUNK_INFLIGHT_BUDGET_BYTES + MiB)).rejects.toMatchObject({ code: ErrorCodes.SETTINGS_CHUNK_WINDOW_EXCEEDS_BUDGET });
		await expect(settings.set('network.chunkInflightBudgetBytes', 8 * MiB)).rejects.toMatchObject({ code: ErrorCodes.SETTINGS_CHUNK_WINDOW_EXCEEDS_BUDGET });
		await expect(settings.set('network', { ...settings.get('network'), chunkWindowBytes: 32 * MiB, chunkInflightBudgetBytes: 16 * MiB })).rejects.toMatchObject({ code: ErrorCodes.SETTINGS_CHUNK_WINDOW_EXCEEDS_BUDGET });
		expect(settings.get('network.chunkWindowBytes')).toBe(16 * MiB);
		expect(settings.get('network.chunkInflightBudgetBytes')).toBe(DEFAULT_CHUNK_INFLIGHT_BUDGET_BYTES);
	});

	it('accepts a window equal to the budget', async () => {
		const settings = await create();
		await settings.set('network.chunkWindowBytes', DEFAULT_CHUNK_INFLIGHT_BUDGET_BYTES);
		expect(settings.get('network.chunkWindowBytes')).toBe(DEFAULT_CHUNK_INFLIGHT_BUDGET_BYTES);
	});

	it('takes a fifth of the memory as the default budget, in whole megabytes and never below one largest message', () => {
		const GiB = 1024 * MiB;
		expect(chunkInflightBudgetFor(16 * GiB)).toBe(3276 * MiB);
		expect(chunkInflightBudgetFor(1536 * MiB)).toBe(307 * MiB);
		expect(chunkInflightBudgetFor(640 * MiB)).toBe(128 * MiB);
		expect(chunkInflightBudgetFor(256 * MiB)).toBe(128 * MiB);
		expect(chunkInflightBudgetFor(Number.NaN)).toBe(128 * MiB);
	});

	it('stores the default budget of this machine on the first start and restores it on a reset', async () => {
		const settings = await create();
		expect(usableMemoryBytes()).toBeGreaterThan(0);
		expect(usableMemoryBytes()).toBeLessThanOrEqual(totalmem());
		expect(DEFAULT_CHUNK_INFLIGHT_BUDGET_BYTES).toBe(chunkInflightBudgetFor(usableMemoryBytes()));
		expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).network.chunkInflightBudgetBytes).toBe(DEFAULT_CHUNK_INFLIGHT_BUDGET_BYTES);
		await settings.set('network.chunkInflightBudgetBytes', 64 * MiB);
		await settings.reset({ applyRuntime: false });
		expect(settings.get('network.chunkInflightBudgetBytes')).toBe(DEFAULT_CHUNK_INFLIGHT_BUDGET_BYTES);
	});

	it('refuses a window or budget that is not a positive whole number of bytes', async () => {
		const settings = await create();
		for (const value of [0, -1, 1.5, Number.NaN]) {
			await expect(settings.set('network.chunkWindowBytes', value)).rejects.toMatchObject({ code: ErrorCodes.INVALID_INPUT_TYPE });
			await expect(settings.set('network.chunkInflightBudgetBytes', value)).rejects.toMatchObject({ code: ErrorCodes.INVALID_INPUT_TYPE });
		}
	});

	it('brings an imported window down to the imported budget instead of dropping the import', async () => {
		const settings = await create();
		const result = await settings.setMany([
			{ path: 'network.chunkWindowBytes', value: 128 * MiB },
			{ path: 'network.chunkInflightBudgetBytes', value: 32 * MiB },
		]);
		expect(result.skipped).toEqual([]);
		expect(settings.get('network.chunkWindowBytes')).toBe(32 * MiB);
		expect(settings.get('network.chunkInflightBudgetBytes')).toBe(32 * MiB);
	});

	it('does not refuse an unrelated write', async () => {
		const settings = await create();
		await settings.set('network.maxDownloadSpeed', 100);
		expect(settings.get('network.maxDownloadSpeed')).toBe(100);
	});
});
