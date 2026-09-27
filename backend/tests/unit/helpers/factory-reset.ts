import type { FactoryResetOrchestratorDeps } from '../../../src/api/factory-reset-orchestrator.ts';
import { NetworkRestartManager } from '../../../src/api/network-restart.ts';
import { effectiveNetworkConfig } from '../../../src/protocol/network-settings.ts';

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
		recordPeersForCatalogReset: overrides['recordPeersForCatalogReset'] ?? (() => {}),
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

/**
 * Build a stub Settings object: reset publishes defaults with the required network knob
 * fields, and get() reads the live document the way the orchestrator applies limits from it.
 */
function makeSettings(overrides: Record<string, () => any> = {}): FactoryResetOrchestratorDeps['settings'] {
	let live: any = { network: { maxDownloadSpeed: 0, maxUploadSpeed: 0, maxDownloadPeersPerLISH: 30, maxUploadPeersPerLISH: 30, maxMessageSize: 128 * 1024 * 1024 } };
	const reset =
		overrides['reset'] ??
		(() => {
			live = structuredClone(live);
			return Promise.resolve(live);
		});
	return {
		get: overrides['get'] ?? (() => live),
		// A node-level setting differs from the defaults unless a test says otherwise, so a
		// settings reset restarts the node as it does for a real changed port.
		list: overrides['list'] ?? (() => ({ network: { ...live.network, incomingPort: 4001 } })),
		getDefaults: overrides['getDefaults'] ?? (() => ({ network: { ...live.network, incomingPort: 9090 } })),
		reset,
		// The reset takes the settings session before the network lease; its reset is the same one.
		holdWrites: async () => ({ reset, release: () => {} }),
	} as any;
}

/** Build a fully-wired deps object with optional per-dep overrides. */
export function makeDeps(
	overrides: {
		networks?: Partial<ReturnType<typeof makeNetworks>>;
		dataServer?: Partial<ReturnType<typeof makeDataServer>>;
		settingsOverride?: Record<string, () => any>;
		networkOverride?: Record<string, () => any>;
		dataServerOverride?: Record<string, () => any>;
		stopVerifyAll?: () => Promise<any>;
		stopCreate?: () => Promise<any>;
		pauseAllLISHMutations?: () => Promise<void>;
		resumeAllLISHMutations?: () => void;
		pauseAllTransfers?: () => Promise<void>;
		clearAllTransfers?: () => Promise<any>;
		clearUploadRuntime?: () => void;
		restoreAllTransfers?: (lishIDs: Set<string>, snapshot?: unknown) => Promise<void>;
		resumeAllTransfers?: () => void;
		broadcastFn?: (event: string, data: any, except?: unknown) => void;
		log?: string[];
	} = {}
): FactoryResetOrchestratorDeps {
	const deps = {
		networks: makeNetworks(overrides.networkOverride ?? {}),
		dataServer: makeDataServer(overrides.dataServerOverride ?? {}),
		settings: makeSettings(overrides.settingsOverride ?? {}),
		stopVerifyAll: overrides.stopVerifyAll ?? (() => Promise.resolve()),
		stopCreate: overrides.stopCreate ?? (() => Promise.resolve()),
		pauseAllLISHMutations: overrides.pauseAllLISHMutations ?? (() => Promise.resolve()),
		resumeAllLISHMutations: overrides.resumeAllLISHMutations ?? (() => {}),
		pauseAllTransfers: overrides.pauseAllTransfers ?? (() => Promise.resolve()),
		clearAllTransfers: overrides.clearAllTransfers ?? (() => Promise.resolve(new Map())),
		clearUploadRuntime: overrides.clearUploadRuntime ?? (() => {}),
		restoreAllTransfers: overrides.restoreAllTransfers ?? (() => Promise.resolve()),
		resumeAllTransfers: overrides.resumeAllTransfers ?? (() => {}),
		broadcastFn: overrides.broadcastFn ?? (() => {}),
	};
	const restartManager = new NetworkRestartManager({
		prepareMaintenance: () => deps.networks.prepareMaintenance(),
		cancelRunOperations: () => deps.networks.getNetwork().cancelRunOperations(),
		stopAllNetworks: () => deps.networks.stopAllNetworks(),
		startEnabledNetworks: () => deps.networks.startEnabledNetworks(),
		isRunning: () => true,
		appliedNetworkConfig: () => effectiveNetworkConfig(deps.settings.list().network),
		pauseTransfers: deps.pauseAllTransfers, pauseLISHMutations: deps.pauseAllLISHMutations,
		resumeLISHMutations: deps.resumeAllLISHMutations, clearTransfers: deps.clearAllTransfers,
		restoreTransfers: deps.restoreAllTransfers, resumeTransfers: deps.resumeAllTransfers,
		downloadIntent: () => deps.dataServer.getDownloadEnabledLishs(), applyLimits: () => {},
	});
	return { ...deps, restartManager };
}
