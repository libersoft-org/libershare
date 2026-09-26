import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NetworkRestartManager } from '../../../src/api/network-restart.ts';
import { Settings } from '../../../src/settings.ts';
import { effectiveNetworkConfig, type EffectiveNetworkConfig } from '../../../src/protocol/network-settings.ts';
import type { TransferRestoreSnapshot } from '../../../src/api/transfer.ts';

/**
 * A settings change goes live through one manager: a non-P2P write is only saved, a P2P write
 * the running node already reflects is saved and pushed live, and anything else restarts the
 * node once around the save. A failed restart keeps the saved value, keeps transfers closed and
 * keeps the transfer snapshot, so a retry — even with the same value — restores exactly those
 * downloads.
 */

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SNAPSHOT: TransferRestoreSnapshot = new Map([['lish-a', { networkIDs: ['net'], originalNetworkIDs: ['net'], disabled: false, suspended: false }]]);

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), 'lish-settings-runtime-'));
	dirs.push(dir);
	const settings = await Settings.create(dir);
	const log: string[] = [];
	let running = true;
	let applied: EffectiveNetworkConfig | null = effectiveNetworkConfig(settings.list().network);
	let startFails = false;
	const restored: TransferRestoreSnapshot[] = [];
	/** Set to model a lishnet leave that ends only when the node's operations are cancelled. */
	let stuckLeave: { cancelled: boolean; resolve?: () => void } | null = null;
	const manager = new NetworkRestartManager({
		prepareMaintenance: async () => {
			log.push('maintenance');
			return {
				drain: () => (stuckLeave && !stuckLeave.cancelled ? new Promise<void>(resolve => (stuckLeave!.resolve = resolve)) : Promise.resolve()),
				release: () => void log.push('release'),
			};
		},
		cancelRunOperations: () => {
			if (!stuckLeave) return;
			stuckLeave.cancelled = true;
			stuckLeave.resolve?.();
		},
		stopAllNetworks: async () => {
			log.push('stop');
			running = false;
			applied = null;
		},
		startEnabledNetworks: async () => {
			log.push(`start:${settings.list().network.incomingPort}`);
			if (startFails) throw new Error('port in use');
			running = true;
			applied = effectiveNetworkConfig(settings.list().network);
		},
		isRunning: () => running,
		appliedNetworkConfig: () => applied,
		pauseTransfers: async () => void log.push('pause'),
		pauseLISHMutations: async () => {},
		resumeLISHMutations: () => {},
		clearTransfers: async () => {
			log.push('clear');
			return SNAPSHOT;
		},
		restoreTransfers: async (_ids, snapshot) => {
			log.push('restore');
			restored.push(snapshot);
		},
		resumeTransfers: () => void log.push('resume'),
		downloadIntent: () => new Set(['lish-a']),
		applyLimits: () => void log.push('limits'),
	});
	settings.setChangeApplier(change => manager.apply(change));
	return { settings, manager, log, restored, failStart: (fails: boolean) => (startFails = fails), holdLeave: () => (stuckLeave = { cancelled: false }) };
}

describe('settings changes on the running node', () => {
	it('only saves a write that touches no P2P setting', async () => {
		const { settings, log } = await setup();
		await settings.set('audio.volume', 40);
		expect(settings.get('audio.volume')).toBe(40);
		expect(log).toEqual([]);
	});

	it('pushes a live limit without restarting', async () => {
		const { settings, log } = await setup();
		await settings.set('network.maxUploadSpeed', 512);
		expect(log).toEqual(['limits']);
	});

	it('restarts the node once around a port change, in order', async () => {
		const { settings, log, restored } = await setup();
		await settings.set('network.incomingPort', 29999);
		expect(log).toEqual(['maintenance', 'pause', 'clear', 'stop', 'limits', 'start:29999', 'restore', 'resume', 'release']);
		expect(restored).toEqual([SNAPSHOT]);
	});

	it('keeps the value, the snapshot and closed transfers after a failed start, and retries the same value', async () => {
		const { settings, manager, log, restored, failStart } = await setup();
		failStart(true);
		await expect(settings.set('network.incomingPort', 29999)).rejects.toThrow('port in use');
		expect(settings.get('network.incomingPort')).toBe(29999);
		expect(manager.hasPendingRestore()).toBe(true);
		expect(log).not.toContain('resume');

		// A write of something unrelated in between neither restarts nor spends the snapshot.
		log.length = 0;
		await settings.set('audio.volume', 10);
		expect(log).toEqual([]);
		expect(manager.hasPendingRestore()).toBe(true);

		// The same port again, once it is free: not a no-op — the node is down.
		failStart(false);
		await settings.set('network.incomingPort', 29999);
		expect(log).toEqual(['maintenance', 'pause', 'stop', 'limits', 'start:29999', 'restore', 'resume', 'release']);
		expect(restored).toEqual([SNAPSHOT]);
		expect(manager.hasPendingRestore()).toBe(false);
	});

	it('does not publish a change whose save failed', async () => {
		const { settings } = await setup();
		settings.setChangeApplier(async () => {
			throw new Error('preparation failed');
		});
		await expect(settings.set('network.incomingPort', 30001)).rejects.toThrow('preparation failed');
		expect(settings.get('network.incomingPort')).not.toBe(30001);
	});

	it('cancels a stuck leave instead of waiting for it before restarting', async () => {
		const { settings, log, holdLeave } = await setup();
		holdLeave();
		const outcome = await Promise.race([settings.set('network.incomingPort', 29999).then(() => 'done'), Bun.sleep(2000).then(() => 'stuck')]);
		expect(outcome).toBe('done');
		expect(log).toContain('start:29999');
	});
});
