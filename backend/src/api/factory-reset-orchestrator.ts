import { type DataServer } from '../lish/data-server.ts';
import { type Networks } from '../lishnet/lishnets.ts';
import { type Settings } from '../settings.ts';
import { type FactoryResetResponse } from '@shared';
import { initUploadState } from '../protocol/lish-protocol.ts';
import { applyNetworkLimits } from '../protocol/network-limits.ts';
import { runFactoryReset } from './factory-reset.ts';
import { initDownloadState } from './transfer.ts';
import { Mutex } from 'async-mutex';

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
	/** Close LISH mutation admission and drain operations already past the gate. */
	readonly pauseAllLISHMutations: () => Promise<void>;
	/** Re-open LISH mutation admission after reset orchestration finishes. */
	readonly resumeAllLISHMutations: () => void;
	/** Close public transfer admission and drain handlers already past the gate. */
	readonly pauseAllTransfers: () => Promise<void>;
	/**
	 * Tears down all active download/upload transfers before the wipe. Must be
	 * provided by the transfer handler module. Return value is ignored.
	 */
	readonly clearAllTransfers: () => Promise<any>;
	/** Clear upload runtime after inbound handlers and the node are fully stopped. */
	readonly clearUploadRuntime: () => void;
	/** Restore persisted downloads while public transfer admission is still closed. */
	readonly restoreAllTransfers: (lishIDs: Set<string>) => Promise<void>;
	/** Re-opens transfer admission after the reset barrier is no longer active. */
	readonly resumeAllTransfers: () => void;
	/**
	 * Broadcasts a WebSocket event to subscribed clients, skipping `except` when given.
	 */
	readonly broadcastFn: (event: string, data: any, except?: unknown) => void;
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
export function buildFactoryResetHandler(deps: FactoryResetOrchestratorDeps): (p?: { settings?: boolean; identity?: boolean; downloads?: boolean; networks?: boolean; peers?: boolean }, client?: unknown) => Promise<FactoryResetResponse> {
	const { dataServer, networks, settings, stopVerifyAll, pauseAllLISHMutations, resumeAllLISHMutations, pauseAllTransfers, clearAllTransfers, clearUploadRuntime, restoreAllTransfers, resumeAllTransfers, broadcastFn } = deps;
	const resetMutex = new Mutex();

	return (p?: { settings?: boolean; identity?: boolean; downloads?: boolean; networks?: boolean; peers?: boolean }, client?: unknown): Promise<FactoryResetResponse> =>
		resetMutex.runExclusive(async () => {
			const wipeSettings = p?.settings ?? true;
			const wipeIdentity = p?.identity ?? true;
			const wipeDownloads = p?.downloads ?? true;
			const wipeNetworks = p?.networks ?? true;
			const wipePeers = p?.peers ?? true;

			// The libp2p node must restart when its identity is regenerated or its joined
			// networks are removed. A node restart also tears down every live transfer.
			// Wiping only the peerstore (wipePeers) does not require an identity change
			// but still needs the node stopped so the datastore is not in use.
			//
			// Settings belong here too. Part of them is read when the node is BUILT — the
			// listening port, mDNS, UPnP, relay, peer exchange — so restoring the defaults
			// without a restart leaves the running node on the old ones while the UI, and
			// every later read of the settings, already shows the new. The two would only
			// agree again after some unrelated restart.
			// Downloads include data currently served by upload streams. Stopping the node
			// closes those streams before their database rows are removed; clearing only the
			// in-memory counters would still leave an in-flight stream using wiped state.
			const restartNode = wipeDownloads || wipeIdentity || wipeNetworks || wipePeers || wipeSettings;
			// Close lishnet writes now, but do not wait for an older join/leave yet. A stalled
			// runtime operation is cancelled only after the fallible transfer preparation has
			// succeeded, so a failed prepare can safely release admission without poisoning the
			// still-running node's dial controller.
			const networkMaintenance = restartNode ? await networks.prepareMaintenance() : undefined;
			let transferAdmissionClosed = false;
			let lishMutationAdmissionClosed = false;
			let transferRuntimeSafe = true;
			const resumeTransfers = (): void => {
				if (!transferAdmissionClosed || !transferRuntimeSafe) return;
				if (lishMutationAdmissionClosed) {
					lishMutationAdmissionClosed = false;
					resumeAllLISHMutations();
				}
				transferAdmissionClosed = false;
				resumeAllTransfers();
			};

			const restartNodeAndTransfers = async (): Promise<void> => {
				// Re-establish transfers that survived the wipe (e.g. downloads kept when
				// only identity/networks/peers were reset) — they were torn down for the
				// node restart.
				const enabledDownloads = dataServer.getDownloadEnabledLishs();
				initDownloadState(enabledDownloads, (id, en) => dataServer.setDownloadEnabled(id, en));
				initUploadState(dataServer.getUploadEnabledLishs(), (id, en) => dataServer.setUploadEnabled(id, en));
				await networks.startEnabledNetworks();
				try {
					await restoreAllTransfers(enabledDownloads);
					transferRuntimeSafe = true;
				} catch (error) {
					transferRuntimeSafe = false;
					throw error;
				}
				resumeTransfers();
			};

			// `prepare` is a barrier: if the transfers or the node cannot be stopped, every
			// wipe that works on state the node owns is skipped and nothing is restarted.
			// Categories that do run are independent of each other. Per-category and
			// per-phase outcomes go to the FE, one notification each. See runFactoryReset.
			let response: FactoryResetResponse;
			try {
				response = await runFactoryReset({
					requiresPrepare: wipeSettings ? ['settings'] : undefined,
					prepare: async () => {
						if (wipeDownloads || restartNode) {
							// Close both gates before the first await. Creation/import/move/finalize and
							// transfer initialisation all await I/O before their final state writes.
							transferAdmissionClosed = true;
							lishMutationAdmissionClosed = true;
							await Promise.all([pauseAllTransfers(), pauseAllLISHMutations()]);
							await stopVerifyAll();
							transferRuntimeSafe = false;
							try {
								await clearAllTransfers();
							} catch (error) {
								transferRuntimeSafe = (error as { runtimeRestored?: boolean })?.runtimeRestored === true;
								throw error;
							}
						}
						if (restartNode) {
							try {
								networks.getNetwork().cancelRunOperations();
								await networkMaintenance?.drain();
								await networks.stopAllNetworks();
								clearUploadRuntime();
							} catch (error) {
								// The transfer runtime is already gone and the node's lifecycle is now
								// uncertain. Keep admission closed until a clean process restart.
								transferRuntimeSafe = false;
								throw error;
							}
						}
					},
					// Table-level wipes (cascade clears children).
					downloads: wipeDownloads ? () => dataServer.clearLishs() : undefined,
					networks: wipeNetworks ? () => dataServer.clearLishnets() : undefined,
					peers: wipePeers ? () => networks.getNetwork().clearPeerstore() : undefined,
					// Identity and discovered peers are separate UI/API categories. Regenerating
					// the private key must not silently wipe the peerstore when peers=false.
					identity: wipeIdentity ? () => networks.getNetwork().clearIdentityKey() : undefined,
					settings: wipeSettings
						? async () => {
								const defaults = await settings.reset();
								// Re-apply runtime knobs from the restored defaults (limits are module state).
								applyNetworkLimits(defaults.network);
							}
						: undefined,
					restart: restartNode ? restartNodeAndTransfers : undefined,
				});
			} finally {
				resumeTransfers();
				networkMaintenance?.release();
			}

			// Everyone else is told to reload, because identity, networks and state moved under
			// them. The caller is not: it gets this response and its own screen showing which
			// category failed, and a reload here would replace that with a fresh page before it
			// could be read. And when `prepare` failed nothing was wiped at all — announcing a
			// reset would send every other window to a clean slate over an operation that did
			// not happen.
			if (response.results.some(result => result.ok) && response.phases.every(phase => phase.phase !== 'prepare' || phase.ok)) {
				broadcastFn('system:factoryReset', response, client);
			}
			return response;
		});
}
