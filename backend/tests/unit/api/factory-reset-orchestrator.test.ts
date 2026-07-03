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
		clearPeerstore: overrides['clearPeerstore'] ?? (() => Promise.resolve()),
	};
	return {
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
		getDownloadEnabledLishs: () => new Set<string>(),
		getUploadEnabledLishs: () => new Set<string>(),
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
		clearAllTransfers?: () => Promise<any>;
		broadcastFn?: (event: string, data: any) => void;
		log?: string[];
	} = {}
): FactoryResetOrchestratorDeps {
	return {
		networks: makeNetworks(overrides.networkOverride ?? {}),
		dataServer: makeDataServer(overrides.dataServerOverride ?? {}),
		settings: makeSettings(overrides.settingsOverride ?? {}),
		stopVerifyAll: overrides.stopVerifyAll ?? (() => Promise.resolve()),
		clearAllTransfers: overrides.clearAllTransfers ?? (() => Promise.resolve()),
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
				clearDatastore: () => {
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
	it('does NOT stop the node when only settings or downloads are wiped', async () => {
		const stopped: string[] = [];
		const deps = makeDeps({
			networkOverride: {
				stopAllNetworks: () => {
					stopped.push('stopped');
					return Promise.resolve();
				},
			},
		});
		const handler = buildFactoryResetHandler(deps);
		await handler({ settings: true, downloads: true, identity: false, networks: false, peers: false });
		expect(stopped).toHaveLength(0);
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

	it('prepare failure is best-effort — wipes still run and success reflects only categories', async () => {
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
		// prepare threw but downloads still ran.
		expect(ran).toContain('stopVerify');
		expect(ran).toContain('downloads');
		expect(res.success).toBe(true);
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

	it('peers defaults to false when no options are given (does not wipe by default)', async () => {
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
		expect(called).not.toContain('clearPeerstore');
	});
});

// ---------------------------------------------------------------------------
// broadcast
// ---------------------------------------------------------------------------

describe('buildFactoryResetHandler — broadcast', () => {
	it('emits system:factoryReset after the wipe regardless of category outcomes', async () => {
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
		expect(emitted.some(e => e.event === 'system:factoryReset')).toBe(true);
	});
});
