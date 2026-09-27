import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Settings } from '../../../src/settings.ts';
import { NetworkRestartManager } from '../../../src/api/network-restart.ts';
import { TransferTeardownError } from '../../../src/api/transfer-teardown.ts';
import { buildFactoryResetHandler } from '../../../src/api/factory-reset-orchestrator.ts';
import { effectiveNetworkConfig, type EffectiveNetworkConfig } from '../../../src/protocol/network-settings.ts';
import type { TransferRestoreSnapshot } from '../../../src/api/transfer.ts';
import { makeDeps } from '../helpers/factory-reset.ts';

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const snapshot: TransferRestoreSnapshot = new Map([['lish-x', { networkIDs: ['net-x'], originalNetworkIDs: ['net-x'], disabled: false, suspended: false }]]);
const settingsOnly = { settings: true, downloads: false, identity: false, peers: false, networks: false };

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), 'lish-maintenance-retry-'));
	dirs.push(dir);
	const settings = await Settings.create(dir);
	let running = true;
	let applied: EffectiveNetworkConfig | null = effectiveNetworkConfig(settings.list().network);
	let failStart = false;
	let failClear: Error | null = null;
	let cleared = false;
	const log: string[] = [];
	const restored: TransferRestoreSnapshot[] = [];
	const deps = { ...makeDeps({
		networkOverride: {
			cancelRunOperations: () => log.push('cancel'),
			stopAllNetworks: async () => { log.push('stop'); running = false; applied = null; },
			startEnabledNetworks: async () => {
				log.push(`start:${settings.list().network.incomingPort}`);
				if (failStart) throw new Error('port unavailable');
				running = true;
				applied = effectiveNetworkConfig(settings.list().network);
			},
		},
		clearAllTransfers: async () => {
			log.push('clear');
			if (failClear) throw failClear;
			const result = cleared ? new Map() : snapshot;
			cleared = true;
			return result;
		},
		restoreAllTransfers: async (_ids, state) => { restored.push(state as TransferRestoreSnapshot); },
		resumeAllTransfers: () => log.push('resume'),
	}), settings };
	const manager = new NetworkRestartManager({
		prepareMaintenance: () => deps.networks.prepareMaintenance(),
		cancelRunOperations: () => deps.networks.getNetwork().cancelRunOperations(),
		stopAllNetworks: () => deps.networks.stopAllNetworks(), startEnabledNetworks: () => deps.networks.startEnabledNetworks(),
		isRunning: () => running, appliedNetworkConfig: () => applied,
		pauseTransfers: deps.pauseAllTransfers, pauseLISHMutations: deps.pauseAllLISHMutations, resumeLISHMutations: deps.resumeAllLISHMutations,
		clearTransfers: deps.clearAllTransfers, restoreTransfers: deps.restoreAllTransfers, resumeTransfers: deps.resumeAllTransfers,
		downloadIntent: () => new Set(['lish-x']), applyLimits: () => {},
	});
	settings.setChangeApplier(change => manager.apply(change));
	return {
		settings, manager, reset: buildFactoryResetHandler({ ...deps, restartManager: manager }), log, restored,
		applied: () => applied,
		failStart: (value: boolean) => { failStart = value; },
		failClear: (value: Error | null) => { failClear = value; },
	};
}

test('a second factory reset restores the first failed reset snapshot', async () => {
	const f = await fixture();
	f.failStart(true);
	const flags = { ...settingsOnly, settings: false, peers: true };
	expect((await f.reset(flags)).success).toBe(false);
	expect(f.manager.pendingRestore()).toBe(snapshot);
	f.failStart(false);
	expect((await f.reset(flags)).success).toBe(true);
	expect(f.restored).toEqual([snapshot]);
	expect(f.manager.hasPendingRestore()).toBe(false);
});

test('settings-only reset retries a node whose saved settings already equal defaults', async () => {
	const f = await fixture();
	await f.settings.set('network.incomingPort', 29999);
	f.restored.length = 0;
	f.failStart(true);
	expect((await f.reset(settingsOnly)).success).toBe(false);
	expect(f.settings.list().network).toEqual(f.settings.getDefaults().network);
	f.failStart(false);
	expect((await f.reset(settingsOnly)).success).toBe(true);
	expect(f.applied()).toEqual(effectiveNetworkConfig(f.settings.getDefaults().network));
	expect(f.restored).toHaveLength(1);
});

test('reset decides whether to restart after a preceding settings write releases its lock', async () => {
	const f = await fixture();
	const hold = await f.settings.holdWrites();
	const changing = f.settings.set('network.incomingPort', 29999);
	const resetting = f.reset(settingsOnly);
	hold.release();
	await changing;
	expect((await resetting).success).toBe(true);
	expect(f.applied()).toEqual(effectiveNetworkConfig(f.settings.getDefaults().network));
	expect(f.log.filter(entry => entry.startsWith('start:'))).toEqual(['start:29999', `start:${f.settings.getDefaults().network.incomingPort}`]);
});

test('failed transfer preparation leaves network operations live and retry does not use the fast path', async () => {
	const f = await fixture();
	const port = f.settings.list().network.incomingPort;
	f.failClear(new Error('prepare failed'));
	await expect(f.settings.set('network.incomingPort', 29999)).rejects.toThrow('prepare failed');
	expect(f.log).not.toContain('cancel');
	f.failClear(null);
	await f.settings.set('network.incomingPort', port);
	expect(f.log).toContain('stop');
	expect(f.log).toContain('resume');
	expect(f.restored).toEqual([snapshot]);
});

test('an unsafe partial teardown keeps the complete binding snapshot for a later reset', async () => {
	const f = await fixture();
	f.failClear(new TransferTeardownError([], 'partial teardown', false, snapshot));
	await expect(f.settings.set('network.incomingPort', 29999)).rejects.toThrow('partial teardown');
	expect(f.manager.pendingRestore()).toBe(snapshot);
	f.failClear(null);
	expect((await f.reset({ ...settingsOnly, settings: false, peers: true })).success).toBe(true);
	expect(f.restored).toEqual([snapshot]);
});
