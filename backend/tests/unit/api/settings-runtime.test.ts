import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NetworkRestartManager, SettingsCommittedError, type NetworkRestartDeps } from '../../../src/api/network-restart.ts';
import { initSettingsHandlers } from '../../../src/api/settings.ts';
import { StorageWriteError } from '../../../src/storage.ts';
import { CodedError, ErrorCodes } from '@shared';
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

async function setup(overrides: Partial<NetworkRestartDeps> = {}) {
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
		...overrides,
	});
	settings.setChangeApplier(change => manager.apply(change));
	return { dir, settings, manager, log, restored, failStart: (fails: boolean) => (startFails = fails), holdLeave: () => (stuckLeave = { cancelled: false }) };
}

describe('settings changes on the running node', () => {
	it('does not infer a committed import from matching values after preparation fails', async () => {
		const failure = new CodedError(ErrorCodes.NETWORK_NOT_RUNNING);
		const { settings, dir } = await setup({
			isRunning: () => false,
			pauseTransfers: async () => {
				throw failure;
			},
		});
		const previous = readFileSync(join(dir, 'settings.json'), 'utf8');
		const incomingPort = settings.get('network.incomingPort');
		await expect(initSettingsHandlers(settings).applyImported({ data: { network: { incomingPort } } })).rejects.toBe(failure);
		expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(previous);
	});

	it('marks committed imports while preserving the original settings.set error code and detail', async () => {
		const failure = new CodedError(ErrorCodes.NETWORK_PORT_IN_USE, '29999');
		const { settings, dir } = await setup({
			startEnabledNetworks: async () => {
				throw failure;
			},
		});
		const single = await settings.set('network.incomingPort', 29999).catch(error => error);
		expect(single).toBeInstanceOf(SettingsCommittedError);
		expect(single).toMatchObject({ code: failure.code, detail: failure.detail });
		const imported = await initSettingsHandlers(settings)
			.applyImported({ data: { network: { incomingPort: 29999 }, audio: { volume: 37 } } })
			.catch(error => error);
		expect(imported).toMatchObject({ code: ErrorCodes.SETTINGS_SAVED_NOT_APPLIED, detail: JSON.stringify({ code: ErrorCodes.NETWORK_PORT_IN_USE, detail: '29999' }) });
		expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toMatchObject({ network: { incomingPort: 29999 }, audio: { volume: 37 } });
	});

	it('marks a failed live apply only after its settings commit has completed', async () => {
		const { settings, manager } = await setup({
			applyLimits: () => {
				throw new Error('private runtime detail');
			},
		});
		const handlers = initSettingsHandlers(settings);
		await expect(handlers.applyImported({ data: { network: { maxUploadSpeed: 123 } } })).rejects.toMatchObject({ code: ErrorCodes.SETTINGS_SAVED_NOT_APPLIED, detail: JSON.stringify({ code: ErrorCodes.INTERNAL_ERROR }) });
		expect(settings.get('network.maxUploadSpeed')).toBe(123);
		const failure = new StorageWriteError(new Error('save failed'), true);
		settings.setChangeApplier(change =>
			manager.apply({
				...change,
				commit: async () => {
					throw failure;
				},
			})
		);
		await expect(handlers.applyImported({ data: { network: { maxUploadSpeed: 456 } } })).rejects.toBe(failure);
	});

	it('waits for verification draining after transfer pause fails', async () => {
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		let reopened = false;
		const { settings } = await setup({
			pauseTransfers: async () => {
				throw new Error('pause failed');
			},
			pauseLISHMutations: async () => {
				entered.resolve();
				await release.promise;
			},
			resumeLISHMutations: () => {
				reopened = true;
			},
		});
		const changing = settings.set('network.incomingPort', 29999).catch(error => error);
		try {
			await entered.promise;
			await Bun.sleep(0);
			expect(reopened).toBe(false);
		} finally {
			release.resolve();
		}
		expect((await changing).message).toBe('pause failed');
		expect(reopened).toBe(true);
	});

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
		expect(log).toEqual(['maintenance', 'pause', 'clear', 'stop', 'limits', 'start:29999', 'restore', 'resume', 'release']);
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
