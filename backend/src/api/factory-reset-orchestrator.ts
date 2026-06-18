import { type DataServer } from '../lish/data-server.ts';
import { type Networks } from '../lishnet/lishnets.ts';
import { type Settings } from '../settings.ts';
import { type FactoryResetResponse } from '@shared';
import { Downloader } from '../protocol/downloader.ts';
import { setMaxUploadSpeed, setMaxUploadPeersPerLISH, setMaxMessageSize, initUploadState } from '../protocol/lish-protocol.ts';
import { setMaxDownloadPeersPerLISH } from '../protocol/peer-manager.ts';
import { runFactoryReset } from './factory-reset.ts';
import { initDownloadState, triggerEnableDownload } from './transfer.ts';

/**
 * Dependencies consumed by the factory-reset orchestration. Provided by
 * APIServer via the DI pattern used throughout the codebase.
 */
export interface FactoryResetOrchestratorDeps {
	readonly dataServer: DataServer;
	readonly networks: Networks;
	readonly settings: Settings;
	/**
	 * Stops all running verification passes before the wipe. Must be provided
	 * by the lishs handler module. Return value is ignored.
	 */
	readonly stopVerifyAll: () => Promise<any>;
	/**
	 * Tears down all active download/upload transfers before the wipe. Must be
	 * provided by the transfer handler module. Return value is ignored.
	 */
	readonly clearAllTransfers: () => Promise<any>;
	/**
	 * Broadcasts a WebSocket event to all subscribed clients.
	 */
	readonly broadcastFn: (event: string, data: any) => void;
}

/**
 * Build the factory-reset handler for the given set of dependencies.
 * The returned function matches the `settings.factoryReset` API endpoint
 * signature: optional per-category flags (all default to true) and returns
 * a {@link FactoryResetResponse} with per-category outcomes.
 *
 * Extraction rationale: the orchestration was previously an inline closure
 * inside APIServer's constructor. Moving it here keeps api.ts focused on
 * wiring and makes the reset logic independently testable.
 */
export function buildFactoryResetHandler(deps: FactoryResetOrchestratorDeps): (p?: { settings?: boolean; identity?: boolean; downloads?: boolean; networks?: boolean; peers?: boolean }) => Promise<FactoryResetResponse> {
	const { dataServer, networks, settings, stopVerifyAll, clearAllTransfers, broadcastFn } = deps;

	return async (p?: { settings?: boolean; identity?: boolean; downloads?: boolean; networks?: boolean; peers?: boolean }): Promise<FactoryResetResponse> => {
		const wipeSettings = p?.settings ?? true;
		const wipeIdentity = p?.identity ?? true;
		const wipeDownloads = p?.downloads ?? true;
		const wipeNetworks = p?.networks ?? true;
		const wipePeers = p?.peers ?? false;

		// The libp2p node must restart when its identity is regenerated or its joined
		// networks are removed. A node restart also tears down every live transfer.
		// Wiping only the peerstore (wipePeers) does not require an identity change
		// but still needs the node stopped so the datastore is not in use.
		const restartNode = wipeIdentity || wipeNetworks || wipePeers;

		const restartNodeAndTransfers = async (): Promise<void> => {
			await networks.startEnabledNetworks();
			// Re-establish transfers that survived the wipe (e.g. downloads kept when
			// only identity/networks/peers were reset) — they were torn down for the
			// node restart.
			const enabledDownloads = dataServer.getDownloadEnabledLishs();
			initDownloadState(enabledDownloads, (id, en) => dataServer.setDownloadEnabled(id, en));
			initUploadState(dataServer.getUploadEnabledLishs(), (id, en) => dataServer.setUploadEnabled(id, en));
			for (const id of enabledDownloads) triggerEnableDownload(id);
		};

		// Each selected category is wiped INDEPENDENTLY (a failure in one never blocks
		// the others) and the node is always brought back up best-effort, so a partial
		// failure can't leave networks stopped. Per-category outcomes go to the FE,
		// which surfaces one notification per category. See runFactoryReset.
		const response = await runFactoryReset({
			prepare: async () => {
				if (wipeDownloads || restartNode) {
					await stopVerifyAll();
					await clearAllTransfers();
				}
				if (restartNode) await networks.stopAllNetworks();
			},
			// Table-level wipes (cascade clears children).
			downloads: wipeDownloads ? () => dataServer.clearLishs() : undefined,
			networks: wipeNetworks ? () => dataServer.clearLishnets() : undefined,
			peers: wipePeers ? () => networks.getNetwork().clearPeerstore() : undefined,
			identity: wipeIdentity ? () => networks.getNetwork().clearDatastore() : undefined,
			settings: wipeSettings
				? async () => {
						const defaults = await settings.reset();
						// Re-apply runtime knobs from the restored defaults (limits are module state).
						Downloader.setMaxDownloadSpeed(defaults.network.maxDownloadSpeed);
						setMaxUploadSpeed(defaults.network.maxUploadSpeed);
						setMaxDownloadPeersPerLISH(defaults.network.maxDownloadPeersPerLISH);
						setMaxUploadPeersPerLISH(defaults.network.maxUploadPeersPerLISH);
						setMaxMessageSize(defaults.network.maxMessageSize);
					}
				: undefined,
			restart: restartNode ? restartNodeAndTransfers : undefined,
		});

		broadcastFn('system:factoryReset', {});
		return response;
	};
}
