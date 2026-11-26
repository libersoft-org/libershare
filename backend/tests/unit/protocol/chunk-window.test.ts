import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, totalmem } from 'os';
import { pipelineDepth } from '../../../src/protocol/chunk-downloader.ts';
import { ByteBudget } from '../../../src/protocol/inflight-budget.ts';
import { CHUNK_WINDOW_MAX_REQUESTS } from '../../../src/protocol/constants.ts';
import { Settings, chunkInflightBudgetFor, defaultChunkInflightBudgetBytes, usableMemoryBytes, useMemorySource, useNetworkSettings, type SettingsData } from '../../../src/settings.ts';
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
		await expect(settings.set('network.chunkWindowBytes', defaultChunkInflightBudgetBytes() + MiB)).rejects.toMatchObject({ code: ErrorCodes.SETTINGS_CHUNK_WINDOW_EXCEEDS_BUDGET });
		await expect(settings.set('network.chunkInflightBudgetBytes', 8 * MiB)).rejects.toMatchObject({ code: ErrorCodes.SETTINGS_CHUNK_WINDOW_EXCEEDS_BUDGET });
		await expect(settings.set('network', { ...settings.get('network'), chunkWindowBytes: 32 * MiB, chunkInflightBudgetBytes: 16 * MiB })).rejects.toMatchObject({ code: ErrorCodes.SETTINGS_CHUNK_WINDOW_EXCEEDS_BUDGET });
		expect(settings.get('network.chunkWindowBytes')).toBe(16 * MiB);
		expect(settings.get('network.chunkInflightBudgetBytes')).toBe(defaultChunkInflightBudgetBytes());
	});

	it('accepts a window equal to the budget', async () => {
		const settings = await create();
		await settings.set('network.chunkWindowBytes', defaultChunkInflightBudgetBytes());
		expect(settings.get('network.chunkWindowBytes')).toBe(defaultChunkInflightBudgetBytes());
	});

	it('takes a fifth of the memory as the default budget, in whole megabytes and never below one largest message', () => {
		const GiB = 1024 * MiB;
		expect(chunkInflightBudgetFor(16 * GiB)).toBe(3276 * MiB);
		expect(chunkInflightBudgetFor(1536 * MiB)).toBe(307 * MiB);
		expect(chunkInflightBudgetFor(640 * MiB)).toBe(128 * MiB);
		expect(chunkInflightBudgetFor(256 * MiB)).toBe(128 * MiB);
		expect(chunkInflightBudgetFor(Number.NaN)).toBe(128 * MiB);
	});

	it('reads the memory limit of a container, whichever way the system shows it', () => {
		const GiB = 1024 * MiB;
		const V2 = '/sys/fs/cgroup/memory.max';
		const V1 = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
		const files =
			(present: Record<string, string>) =>
			(path: string): string => {
				if (!(path in present)) throw new Error(`ENOENT: ${path}`);
				return present[path]!;
			};
		const meminfo = (bytes: number): string => `MemTotal:       ${bytes / 1024} kB\nMemFree:          1024 kB\n`;
		// None of the files: not Linux.
		expect(usableMemoryBytes(64 * GiB, files({}))).toBe(64 * GiB);
		// A limit in cgroup v2; the reported total is the host's.
		expect(usableMemoryBytes(64 * GiB, files({ [V2]: `${GiB}\n`, '/proc/meminfo': meminfo(64 * GiB) }))).toBe(GiB);
		// A limit in cgroup v1, also when a v2 tree without a memory limit is mounted beside it.
		expect(usableMemoryBytes(64 * GiB, files({ [V1]: `${GiB}\n`, '/proc/meminfo': meminfo(64 * GiB) }))).toBe(GiB);
		expect(usableMemoryBytes(64 * GiB, files({ [V2]: 'max\n', [V1]: `${GiB}\n`, '/proc/meminfo': meminfo(64 * GiB) }))).toBe(GiB);
		// No limit: "max" in v2, a number above any machine in v1.
		expect(usableMemoryBytes(64 * GiB, files({ [V2]: 'max\n', [V1]: '9223372036854771712\n', '/proc/meminfo': meminfo(64 * GiB) }))).toBe(64 * GiB);
		// The limit sits on the group of the process, not on the root of the tree: a service with a
		// memory limit, or a container that shares the host's cgroup namespace.
		const scope = '/system.slice/docker-0123abcd.scope';
		expect(usableMemoryBytes(64 * GiB, files({ '/proc/self/cgroup': `0::${scope}\n`, [`/sys/fs/cgroup${scope}/memory.max`]: `${GiB}\n`, '/proc/meminfo': meminfo(64 * GiB) }))).toBe(GiB);
		expect(usableMemoryBytes(64 * GiB, files({ '/proc/self/cgroup': `12:pids:/x\n9:cpu,memory:${scope}\n`, [`/sys/fs/cgroup/memory${scope}/memory.limit_in_bytes`]: `${GiB}\n`, '/proc/meminfo': meminfo(64 * GiB) }))).toBe(GiB);
		// A hybrid setup with the memory controller in v2: that tree is mounted one level down.
		expect(usableMemoryBytes(64 * GiB, files({ '/proc/self/cgroup': '1:name=openrc:/svc\n0::/openrc.svc\n', '/sys/fs/cgroup/unified/openrc.svc/memory.max': `${GiB}\n`, '/proc/meminfo': meminfo(64 * GiB) }))).toBe(GiB);
		// Or on a group above it, while its own has none.
		expect(usableMemoryBytes(64 * GiB, files({ '/proc/self/cgroup': `0::${scope}\n`, [`/sys/fs/cgroup${scope}/memory.max`]: 'max\n', '/sys/fs/cgroup/system.slice/memory.max': `${2 * GiB}\n`, '/proc/meminfo': meminfo(64 * GiB) }))).toBe(2 * GiB);
		// A system container: its cgroup says "max" and only the reported total is its own.
		expect(usableMemoryBytes(320 * GiB, files({ [V2]: 'max\n', '/proc/meminfo': meminfo(1536 * MiB) }))).toBe(1536 * MiB);
		// This machine, read for real.
		expect(usableMemoryBytes()).toBeGreaterThan(0);
		expect(usableMemoryBytes()).toBeLessThanOrEqual(totalmem());
	});

	it('stores the default budget on the first start and works it out again on a reset, from the memory as it is then', async () => {
		const GiB = 1024 * MiB;
		let memory = 4 * GiB;
		useMemorySource(() => memory);
		try {
			const settings = await create();
			const stored = (): number => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).network.chunkInflightBudgetBytes;
			expect(stored()).toBe(819 * MiB);
			// Less memory later leaves the stored value alone; only the defaults follow it.
			memory = 512 * MiB;
			expect(settings.get('network.chunkInflightBudgetBytes')).toBe(819 * MiB);
			expect(settings.getDefaults().network.chunkInflightBudgetBytes).toBe(128 * MiB);
			await settings.reset({ applyRuntime: false });
			expect(stored()).toBe(128 * MiB);
			// The reset under a write hold, as the factory reset does it.
			memory = 2 * GiB;
			const hold = await settings.holdWrites();
			try {
				await hold.reset();
			} finally {
				hold.release();
			}
			expect(stored()).toBe(409 * MiB);
			expect(settings.get('network.chunkInflightBudgetBytes')).toBe(409 * MiB);
		} finally {
			useMemorySource();
		}
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
