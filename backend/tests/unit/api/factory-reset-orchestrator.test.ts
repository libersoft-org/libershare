import { describe, it, expect } from 'bun:test';
import { buildFactoryResetHandler } from '../../../src/api/factory-reset-orchestrator.ts';
import type { FactoryResetOrchestratorDeps } from '../../../src/api/factory-reset-orchestrator.ts';

// ---------------------------------------------------------------------------
// Minimal stub helpers
// ---------------------------------------------------------------------------

/** Build a stub Networks object with controllable per-method behaviour. */
function makeNetworks(overrides: Record<string, () => any> = {}): FactoryResetOrchestratorDeps['networks'] {
	const network = {
		clearDatastore: overrides['clearDatastore'] ?? (() => Promise.resolve()),
		clearIdentityKey: overrides['clearIdentityKey'] ?? (() => Promise.resolve()),
		clearPeerstore: overrides['clearPeerstore'] ?? (() => Promise.resolve()),
		cancelRunOperations: overrides['cancelRunOperations'] ?? (() => {}),
	};
	return {
		beginMaintenance: overrides['beginMaintenance'] ?? (() => Promise.resolve(() => {})),
		prepareMaintenance:
			overrides['prepareMaintenance'] ??
			(() =>
				Promise.resolve({
					drain: () => Promise.resolve(),
					release: () => {},
				})),
		stopAllNetworks: overrides['stopAllNetworks'] ?? (() => Promise.resolve()),
		startEnabledNetworks: overrides['startEnabledNetworks'] ?? (() => Promise.resolve()),
		getNetwork: () => network,
	} as any;
}

/** Build a stub DataServer. */
function makeDataServer(overrides: Record<string, () => any> = {}): FactoryResetOrchestratorDeps['dataServer'] {
	return {
		clearLishs: overrides['clearLishs'] ?? (() => {}),
		clearLishnets: overrides['clearLishnets'] ?? (() => {}),
		getDownloadEnabledLishs: overrides['getDownloadEnabledLishs'] ?? (() => new Set<string>()),
		getUploadEnabledLishs: overrides['getUploadEnabledLishs'] ?? (() => new Set<string>()),
		setDownloadEnabled: () => {},
		setUploadEnabled: () => {},
	} as any;
}

/** Build a stub Settings object whose reset returns an object with the required network knob fields. */
function makeSettings(overrides: Record<string, () => any> = {}): FactoryResetOrchestratorDeps['settings'] {
	return {
		reset:
			overrides['reset'] ??
			(() =>
				Promise.resolve({
					network: { maxDownloadSpeed: 0, maxUploadSpeed: 0, maxDownloadPeersPerLISH: 30, maxUploadPeersPerLISH: 30, maxMessageSize: 128 * 1024 * 1024 },
				})),
	} as any;
}

/** Build a fully-wired deps object with optional per-dep overrides. */
function makeDeps(
	overrides: {
		networks?: Partial<ReturnType<typeof makeNetworks>>;
		dataServer?: Partial<ReturnType<typeof makeDataServer>>;
		settingsOverride?: Record<string, () => any>;
		networkOverride?: Record<string, () => any>;
		dataServerOverride?: Record<string, () => any>;
		stopVerifyAll?: () => Promise<any>;
		pauseAllLISHMutations?: () => Promise<void>;
		resumeAllLISHMutations?: () => void;
		pauseAllTransfers?: () => Promise<void>;
		clearAllTransfers?: () => Promise<any>;
		clearUploadRuntime?: () => void;
		restoreAllTransfers?: (lishIDs: Set<string>) => Promise<void>;
		resumeAllTransfers?: () => void;
		broadcastFn?: (event: string, data: any, except?: unknown) => void;
		log?: string[];
	} = {}
): FactoryResetOrchestratorDeps {
	return {
		networks: makeNetworks(overrides.networkOverride ?? {}),
		dataServer: makeDataServer(overrides.dataServerOverride ?? {}),
		settings: makeSettings(overrides.settingsOverride ?? {}),
		stopVerifyAll: overrides.stopVerifyAll ?? (() => Promise.resolve()),
		pauseAllLISHMutations: overrides.pauseAllLISHMutations ?? (() => Promise.resolve()),
		resumeAllLISHMutations: overrides.resumeAllLISHMutations ?? (() => {}),
		pauseAllTransfers: overrides.pauseAllTransfers ?? (() => Promise.resolve()),
		clearAllTransfers: overrides.clearAllTransfers ?? (() => Promise.resolve()),
		clearUploadRuntime: overrides.clearUploadRuntime ?? (() => {}),
		restoreAllTransfers: overrides.restoreAllTransfers ?? (() => Promise.resolve()),
		resumeAllTransfers: overrides.resumeAllTransfers ?? (() => {}),
		broadcastFn: overrides.broadcastFn ?? (() => {}),
	};
}

// ---------------------------------------------------------------------------
// Category ordering
// ---------------------------------------------------------------------------

describe('buildFactoryResetHandler — category ordering', () => {
	it('runs selected categories in fixed order: downloads → networks → peers → identity → settings', async () => {
		const order: string[] = [];
		const deps = makeDeps({
			dataServerOverride: {
				clearLishs: () => {
					order.push('downloads');
				},
				clearLishnets: () => {
					order.push('networks');
				},
			},
			networkOverride: {
				clearIdentityKey: () => {
					order.push('identity');
					return Promise.resolve();
				},
				clearPeerstore: () => {
					order.push('peers');
					return Promise.resolve();
				},
			},
			settingsOverride: {
				reset: () => {
					order.push('settings');
					return Promise.resolve({ network: { maxDownloadSpeed: 0, maxUploadSpeed: 0, maxDownloadPeersPerLISH: 30, maxUploadPeersPerLISH: 30, maxMessageSize: 0 } });
				},
			},
		});
		const handler = buildFactoryResetHandler(deps);
		await handler({ settings: true, identity: true, downloads: true, networks: true, peers: true });
		expect(order).toEqual(['downloads', 'networks', 'peers', 'identity', 'settings']);
	});

	it('only includes selected categories in the response', async () => {
		const deps = makeDeps();
		const handler = buildFactoryResetHandler(deps);
		const res = await handler({ downloads: true, networks: false, identity: false, settings: false, peers: false });
		expect(res.results.map(r => r.category)).toEqual(['downloads']);
	});
});

// ---------------------------------------------------------------------------
// Restart behaviour
// ---------------------------------------------------------------------------

describe('buildFactoryResetHandler — restart behaviour', () => {
	it('cancels stalled lishnet work only after admission closes and before waiting for its drain', async () => {
		const actions: string[] = [];
		let cancelled = false;
		let releaseDrain!: () => void;
		const cancelledRun = new Promise<void>(resolve => {
			releaseDrain = resolve;
		});
		const deps = makeDeps({
			networkOverride: {
				// The old one-phase orchestration waits here forever and can never reach
				// cancelRunOperations. The two-phase lease must be used instead.
				beginMaintenance: () => new Promise<never>(() => {}),
				prepareMaintenance: async () => {
					actions.push('maintenance-close');
					return {
						drain: async () => {
							actions.push('maintenance-drain');
							await cancelledRun;
						},
						release: () => actions.push('maintenance-release'),
					};
				},
				cancelRunOperations: () => {
					cancelled = true;
					actions.push('cancel-runs');
					releaseDrain();
				},
				stopAllNetworks: async () => {
					actions.push('stop');
				},
			},
		});

		const outcome = await Promise.race([
			buildFactoryResetHandler(deps)({ downloads: false, settings: false, identity: true, networks: false, peers: false }).then(() => 'settled'),
			Bun.sleep(250).then(() => 'timeout'),
		]);

		expect(outcome).toBe('settled');
		expect(cancelled).toBe(true);
		expect(actions).toEqual(['maintenance-close', 'cancel-runs', 'maintenance-drain', 'stop', 'maintenance-release']);
	});

	it('holds exclusive lishnet maintenance through the wipe and restart', async () => {
		const actions: string[] = [];
		const deps = makeDeps({
			networkOverride: {
				prepareMaintenance: async () => {
					actions.push('maintenance-acquire');
					return {
						drain: async () => {},
						release: () => actions.push('maintenance-release'),
					};
				},
				stopAllNetworks: async () => {
					actions.push('stop');
				},
				startEnabledNetworks: async () => {
					actions.push('start');
				},
			},
			dataServerOverride: {
				clearLishnets: () => actions.push('wipe-networks'),
			},
		});

		await buildFactoryResetHandler(deps)({ downloads: false, settings: false, identity: false, networks: true, peers: false });

		expect(actions).toEqual(['maintenance-acquire', 'stop', 'wipe-networks', 'start', 'maintenance-release']);
	});

	it('stops and restarts the node when only downloads are wiped', async () => {
		const actions: string[] = [];
		const deps = makeDeps({
			networkOverride: {
				stopAllNetworks: () => {
					actions.push('stop');
					return Promise.resolve();
				},
				startEnabledNetworks: () => {
					actions.push('start');
					return Promise.resolve();
				},
			},
		});
		const handler = buildFactoryResetHandler(deps);
		await handler({ downloads: true, settings: false, identity: false, networks: false, peers: false });
		expect(actions).toEqual(['stop', 'start']);
	});

	it('stops and restarts the node when only settings are wiped', async () => {
		// Restoring the defaults rewrites values the node only reads while it is being
		// built — port, mDNS, UPnP, relay — so without the restart the running node keeps
		// the old ones and disagrees with everything that reads the settings afterwards.
		const actions: string[] = [];
		const deps = makeDeps({
			networkOverride: {
				stopAllNetworks: () => {
					actions.push('stop');
					return Promise.resolve();
				},
				startEnabledNetworks: () => {
					actions.push('start');
					return Promise.resolve();
				},
			},
		});
		const handler = buildFactoryResetHandler(deps);
		await handler({ settings: true, downloads: false, identity: false, networks: false, peers: false });
		expect(actions).toEqual(['stop', 'start']);
	});

	it('stops and restarts the node when identity is wiped', async () => {
		const actions: string[] = [];
		const deps = makeDeps({
			networkOverride: {
				stopAllNetworks: () => {
					actions.push('stop');
					return Promise.resolve();
				},
				startEnabledNetworks: () => {
					actions.push('start');
					return Promise.resolve();
				},
			},
		});
		const handler = buildFactoryResetHandler(deps);
		await handler({ identity: true, settings: false, downloads: false, networks: false, peers: false });
		expect(actions).toContain('stop');
		expect(actions).toContain('start');
	});

	it('stops and restarts the node when only peers is wiped', async () => {
		const actions: string[] = [];
		const deps = makeDeps({
			networkOverride: {
				stopAllNetworks: () => {
					actions.push('stop');
					return Promise.resolve();
				},
				startEnabledNetworks: () => {
					actions.push('start');
					return Promise.resolve();
				},
			},
		});
		const handler = buildFactoryResetHandler(deps);
		await handler({ peers: true, identity: false, settings: false, downloads: false, networks: false });
		expect(actions).toContain('stop');
		expect(actions).toContain('start');
	});

	it('keeps transfer admission closed through the wipe and re-opens it once', async () => {
		const actions: string[] = [];
		const deps = makeDeps({
			pauseAllTransfers: async () => {
				actions.push('pause');
			},
			clearAllTransfers: async () => {
				actions.push('clear');
			},
			resumeAllTransfers: () => actions.push('resume'),
			dataServerOverride: {
				clearLishs: () => actions.push('wipe'),
			},
		});

		await buildFactoryResetHandler(deps)({ downloads: true, settings: false, identity: false, networks: false, peers: false });

		expect(actions).toEqual(['pause', 'clear', 'wipe', 'resume']);
	});

	it('closes transfer admission before stopping verification', async () => {
		const actions: string[] = [];
		const deps = makeDeps({
			pauseAllTransfers: async () => {
				actions.push('pause');
			},
			stopVerifyAll: async () => {
				actions.push('stop-verification');
			},
			clearAllTransfers: async () => {
				actions.push('clear');
			},
		});

		await buildFactoryResetHandler(deps)({ downloads: true, settings: false, identity: false, networks: false, peers: false });

		expect(actions.slice(0, 3)).toEqual(['pause', 'stop-verification', 'clear']);
	});

	it('drains every writer before wiping and clears uploads only after the node stops', async () => {
		const actions: string[] = [];
		const deps = makeDeps({
			pauseAllTransfers: async () => {
				actions.push('pause-transfers');
			},
			pauseAllLISHMutations: async () => {
				actions.push('pause-lish');
			},
			stopVerifyAll: async () => {
				actions.push('drain-verification');
			},
			clearAllTransfers: async () => {
				actions.push('drain-downloads');
			},
			networkOverride: {
				stopAllNetworks: async () => {
					actions.push('stop-node');
				},
				startEnabledNetworks: async () => {
					actions.push('start-node');
				},
			},
			clearUploadRuntime: () => actions.push('clear-uploads'),
			dataServerOverride: {
				clearLishs: () => actions.push('wipe'),
			},
			restoreAllTransfers: async () => {
				actions.push('restore-transfers');
			},
			resumeAllLISHMutations: () => actions.push('resume-lish'),
			resumeAllTransfers: () => actions.push('resume-transfers'),
		});

		await buildFactoryResetHandler(deps)({ downloads: true, settings: false, identity: false, networks: false, peers: false });

		expect(actions).toEqual(['pause-transfers', 'pause-lish', 'drain-verification', 'drain-downloads', 'stop-node', 'clear-uploads', 'wipe', 'start-node', 'restore-transfers', 'resume-lish', 'resume-transfers']);
	});

	it('waits for persisted downloads to be restored before re-opening admission', async () => {
		const actions: string[] = [];
		let finishRestore!: () => void;
		const restoreMayFinish = new Promise<void>(resolve => {
			finishRestore = resolve;
		});
		const deps = makeDeps({
			dataServerOverride: {
				getDownloadEnabledLishs: () => new Set(['lish-a']),
			},
			restoreAllTransfers: async ids => {
				actions.push(`restore:${[...ids].join(',')}`);
				await restoreMayFinish;
			},
			resumeAllTransfers: () => actions.push('resume'),
		});

		let settled = false;
		const resetting = buildFactoryResetHandler(deps)({ downloads: false, settings: true, identity: false, networks: false, peers: false }).then(result => {
			settled = true;
			return result;
		});
		while (!actions.some(action => action.startsWith('restore:'))) await Promise.resolve();

		expect(settled).toBe(false);
		expect(actions).toEqual(['restore:lish-a']);
		finishRestore();
		const response = await resetting;
		expect(response.success).toBe(true);
		expect(actions).toEqual(['restore:lish-a', 'resume']);
	});

	it('keeps transfer admission closed when teardown safety is unknown', async () => {
		const actions: string[] = [];
		const deps = makeDeps({
			pauseAllTransfers: async () => {
				actions.push('pause');
			},
			clearAllTransfers: async () => {
				actions.push('clear');
				throw new Error('download teardown failed');
			},
			resumeAllTransfers: () => actions.push('resume'),
			dataServerOverride: {
				clearLishs: () => actions.push('wipe'),
			},
		});

		const response = await buildFactoryResetHandler(deps)({ downloads: true, settings: false, identity: false, networks: false, peers: false });

		expect(response.success).toBe(false);
		expect(actions).toEqual(['pause', 'clear']);
	});

	it('serializes concurrent resets so their transfer barriers cannot overlap', async () => {
		let releaseFirst!: () => void;
		const firstMayFinish = new Promise<void>(resolve => {
			releaseFirst = resolve;
		});
		let entered = 0;
		let firstEntered!: () => void;
		const firstStarted = new Promise<void>(resolve => {
			firstEntered = resolve;
		});
		const deps = makeDeps({
			clearAllTransfers: async () => {
				entered++;
				if (entered === 1) {
					firstEntered();
					await firstMayFinish;
				}
			},
		});
		const handler = buildFactoryResetHandler(deps);
		const options = { downloads: true, settings: false, identity: false, networks: false, peers: false };

		const first = handler(options);
		await firstStarted;
		const second = handler(options);
		await Promise.resolve();
		expect(entered).toBe(1);

		releaseFirst();
		await Promise.all([first, second]);
		expect(entered).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Partial failure resilience
// ---------------------------------------------------------------------------

describe('buildFactoryResetHandler — partial failure', () => {
	it('runs every selected category even when one throws — failure is isolated', async () => {
		const ran: string[] = [];
		const deps = makeDeps({
			dataServerOverride: {
				clearLishs: () => {
					ran.push('downloads');
					throw new Error('disk full');
				},
				clearLishnets: () => {
					ran.push('networks');
				},
			},
			settingsOverride: {
				reset: () => {
					ran.push('settings');
					return Promise.resolve({ network: { maxDownloadSpeed: 0, maxUploadSpeed: 0, maxDownloadPeersPerLISH: 30, maxUploadPeersPerLISH: 30, maxMessageSize: 0 } });
				},
			},
		});
		const handler = buildFactoryResetHandler(deps);
		const res = await handler({ downloads: true, networks: true, settings: true, identity: false, peers: false });

		// All three ran.
		expect(ran).toContain('downloads');
		expect(ran).toContain('networks');
		expect(ran).toContain('settings');

		// Overall result is failure.
		expect(res.success).toBe(false);

		// Per-category outcomes are precise.
		const dl = res.results.find(r => r.category === 'downloads')!;
		expect(dl.ok).toBe(false);
		expect(dl.detail).toContain('disk full');

		const net = res.results.find(r => r.category === 'networks')!;
		expect(net.ok).toBe(true);

		const set = res.results.find(r => r.category === 'settings')!;
		expect(set.ok).toBe(true);
	});

	it('reports success=true when every selected category passes', async () => {
		const deps = makeDeps();
		const handler = buildFactoryResetHandler(deps);
		const res = await handler({ settings: true, downloads: true, networks: false, identity: false, peers: false });
		expect(res.success).toBe(true);
		expect(res.results.every(r => r.ok)).toBe(true);
	});

	it('prepare failure is a barrier — the download wipe is skipped and success is false', async () => {
		const ran: string[] = [];
		const deps = makeDeps({
			stopVerifyAll: async () => {
				ran.push('stopVerify');
				throw new Error('verify-stop boom');
			},
			dataServerOverride: {
				clearLishs: () => {
					ran.push('downloads');
				},
			},
		});
		const handler = buildFactoryResetHandler(deps);
		const res = await handler({ downloads: true, settings: false, identity: false, networks: false, peers: false });
		// Live transfers were never stopped, so wiping the tables they write to is not safe.
		expect(ran).toEqual(['stopVerify']);
		expect(res.success).toBe(false);
		expect(res.phases[0]).toEqual({ phase: 'prepare', ok: false, detail: 'verify-stop boom' });
	});

	it('does not reset node-backed settings when preparation fails', async () => {
		const ran: string[] = [];
		const deps = makeDeps({
			stopVerifyAll: async () => {
				throw new Error('verify-stop boom');
			},
			settingsOverride: {
				reset: () => {
					ran.push('settings');
					return Promise.resolve({ network: { maxDownloadSpeed: 0, maxUploadSpeed: 0, maxDownloadPeersPerLISH: 30, maxUploadPeersPerLISH: 30, maxMessageSize: 0 } });
				},
			},
		});

		const res = await buildFactoryResetHandler(deps)({ settings: true, downloads: false, networks: false, identity: false, peers: false });

		expect(ran).toEqual([]);
		expect(res.results.find(result => result.category === 'settings')?.ok).toBe(false);
		expect(res.success).toBe(false);
	});

	it('a node that cannot be stopped blocks every destructive wipe and the restart', async () => {
		const called: string[] = [];
		const deps = makeDeps({
			pauseAllTransfers: async () => {
				called.push('pause');
			},
			clearAllTransfers: async () => {
				called.push('clear-transfers');
			},
			resumeAllTransfers: () => called.push('resume-transfers'),
			networkOverride: {
				stopAllNetworks: () => {
					called.push('stop-node');
					return Promise.reject(new Error('node.stop failed'));
				},
				startEnabledNetworks: () => {
					called.push('restart');
					return Promise.resolve();
				},
				clearIdentityKey: () => {
					called.push('clearIdentityKey');
					return Promise.resolve();
				},
				clearPeerstore: () => {
					called.push('clearPeerstore');
					return Promise.resolve();
				},
			},
			dataServerOverride: {
				clearLishs: () => {
					called.push('clearLishs');
				},
				clearLishnets: () => {
					called.push('clearLishnets');
				},
			},
		});
		const handler = buildFactoryResetHandler(deps);
		const res = await handler({ settings: false, identity: true, downloads: true, networks: true, peers: true });

		// The node may still own its datastore, its peerstore and its identity. Wiping any
		// of them here — and then bringing a second node up over the result — is exactly
		// what the barrier exists to stop.
		expect(called).toEqual(['pause', 'clear-transfers', 'stop-node']);
		expect(res.success).toBe(false);
		expect(res.results.every(r => !r.ok)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Peers category — selective peerstore wipe
// ---------------------------------------------------------------------------

describe('buildFactoryResetHandler — peers category', () => {
	it('calls clearPeerstore (not clearDatastore) when peers=true and identity=false', async () => {
		const called: string[] = [];
		const deps = makeDeps({
			networkOverride: {
				clearDatastore: () => {
					called.push('clearDatastore');
					return Promise.resolve();
				},
				clearPeerstore: () => {
					called.push('clearPeerstore');
					return Promise.resolve();
				},
			},
		});
		const handler = buildFactoryResetHandler(deps);
		await handler({ peers: true, identity: false, settings: false, downloads: false, networks: false });
		expect(called).toContain('clearPeerstore');
		expect(called).not.toContain('clearDatastore');
	});

	it('peers defaults to true when no options are given (wipes by default)', async () => {
		const called: string[] = [];
		const deps = makeDeps({
			networkOverride: {
				clearPeerstore: () => {
					called.push('clearPeerstore');
					return Promise.resolve();
				},
			},
		});
		const handler = buildFactoryResetHandler(deps);
		// Call with explicit all-true for the four original categories only
		await handler({ settings: true, identity: true, downloads: true, networks: true });
		expect(called).toContain('clearPeerstore');
	});
});

// ---------------------------------------------------------------------------
// Identity category — selective private-key wipe
// ---------------------------------------------------------------------------

describe('buildFactoryResetHandler — identity category', () => {
	it('calls clearIdentityKey without wiping the peerstore', async () => {
		const called: string[] = [];
		const deps = makeDeps({
			networkOverride: {
				clearIdentityKey: () => {
					called.push('clearIdentityKey');
					return Promise.resolve();
				},
				clearDatastore: () => {
					called.push('clearDatastore');
					return Promise.resolve();
				},
				clearPeerstore: () => {
					called.push('clearPeerstore');
					return Promise.resolve();
				},
			},
		});

		await buildFactoryResetHandler(deps)({ identity: true, peers: false, settings: false, downloads: false, networks: false });

		expect(called).toEqual(['clearIdentityKey']);
	});
});

// ---------------------------------------------------------------------------
// broadcast
// ---------------------------------------------------------------------------

describe('buildFactoryResetHandler — broadcast', () => {
	it('does not announce a reset when no selected category changed', async () => {
		const emitted: Array<{ event: string; data: any }> = [];
		const deps = makeDeps({
			broadcastFn: (event, data) => emitted.push({ event, data }),
			dataServerOverride: {
				clearLishs: () => {
					throw new Error('boom');
				},
			},
		});
		const handler = buildFactoryResetHandler(deps);
		await handler({ downloads: true, settings: false, identity: false, networks: false, peers: false });
		expect(emitted).toEqual([]);
	});

	it('broadcasts the complete outcome when at least one category changed', async () => {
		const emitted: Array<{ event: string; data: any }> = [];
		const deps = makeDeps({
			broadcastFn: (event, data) => emitted.push({ event, data }),
			dataServerOverride: {
				clearLishs: () => {
					throw new Error('downloads failed');
				},
				clearLishnets: () => {},
			},
		});

		const response = await buildFactoryResetHandler(deps)({ downloads: true, networks: true, settings: false, identity: false, peers: false });

		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.event).toBe('system:factoryReset');
		expect(emitted[0]?.data).toEqual(response);
	});
});

/**
 * The reset event says "somebody else wiped this instance, reload". The caller is not
 * somebody else: it has the response and a screen listing what failed, which a reload
 * would throw away before it could be read.
 */
describe('buildFactoryResetHandler — who hears about the reset', () => {
	it('skips the calling client and tells the rest', async () => {
		const sent: Array<{ event: string; except: unknown }> = [];
		const caller = { id: 'the-tab-that-asked' };
		const deps = makeDeps({ broadcastFn: (event, _data, except) => sent.push({ event, except }) });
		await buildFactoryResetHandler(deps)({ settings: true }, caller);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.except).toBe(caller);
	});

	it('says nothing at all when prepare failed and no category ran', async () => {
		const sent: string[] = [];
		const deps = makeDeps({
			stopVerifyAll: () => Promise.reject(new Error('transfers are stuck')),
			broadcastFn: event => sent.push(event),
		});
		const response = await buildFactoryResetHandler(deps)({ identity: true }, { id: 'caller' });
		expect(response.phases.some(phase => phase.phase === 'prepare' && !phase.ok)).toBe(true);
		expect(sent).toEqual([]);
	});

	it('does not announce a reset when every category is disabled', async () => {
		const sent: string[] = [];
		const deps = makeDeps({ broadcastFn: event => sent.push(event) });
		const response = await buildFactoryResetHandler(deps)({ settings: false, identity: false, downloads: false, networks: false, peers: false });
		expect(response.success).toBe(true);
		expect(response.results).toEqual([]);
		expect(sent).toEqual([]);
	});
});
