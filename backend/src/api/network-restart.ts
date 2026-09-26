import { type SettingsChange, type SettingsData } from '../settings.ts';
import { effectiveNetworkConfig, requestsP2PApply, sameEffectiveNetworkConfig, type EffectiveNetworkConfig } from '../protocol/network-settings.ts';
import { type TransferRestoreSnapshot } from './transfer.ts';

/** What the restart manager drives; the handlers and `Networks` keep owning their state. */
export interface NetworkRestartDeps {
	/** Block new lishnet writes; the lease drains the running ones and releases the block. */
	readonly prepareMaintenance: () => Promise<{ drain: () => Promise<void>; release: () => void }>;
	/** End the node's in-flight dials and hang-ups, which a lishnet write may be waiting on. */
	readonly cancelRunOperations: () => void;
	readonly stopAllNetworks: () => Promise<void>;
	readonly startEnabledNetworks: () => Promise<void>;
	readonly isRunning: () => boolean;
	/** The projection the running node was built from, or null when none is running. */
	readonly appliedNetworkConfig: () => EffectiveNetworkConfig | null;
	readonly pauseTransfers: () => Promise<void>;
	readonly pauseLISHMutations: () => Promise<void>;
	readonly resumeLISHMutations: () => void;
	/** Tear the transfer runtime down, returning what is needed to bring it back. */
	readonly clearTransfers: () => Promise<TransferRestoreSnapshot>;
	readonly restoreTransfers: (lishIDs: Set<string>, snapshot: TransferRestoreSnapshot) => Promise<void>;
	readonly resumeTransfers: () => void;
	/** Downloads the database says should run. */
	readonly downloadIntent: () => Set<string>;
	/** Push the live transfer limits of a published settings document. */
	readonly applyLimits: (network: SettingsData['network']) => void;
}

/**
 * Applies a settings change to the running node: live where the node already runs with the
 * requested values, by one controlled restart where it does not.
 *
 * A single instance serves the whole API. When a restart fails — the new port is taken, a
 * download cannot be restored — the transfer snapshot it took stays here and transfers stay
 * closed, so the next attempt (even with the same value, once the port is free) brings back the
 * downloads exactly as they were instead of starting from an empty runtime.
 */
export class NetworkRestartManager {
	private readonly deps: NetworkRestartDeps;
	/** Transfers torn down by a restart that has not finished restoring them. */
	private pendingSnapshot: TransferRestoreSnapshot | null = null;

	constructor(deps: NetworkRestartDeps) {
		this.deps = deps;
	}

	/** Whether a restart left transfers that still have to be restored. */
	hasPendingRestore(): boolean {
		return this.pendingSnapshot !== null;
	}

	/**
	 * The transfers a failed restart tore down, for another node restart (a factory reset) to
	 * bring back instead of the empty runtime it would otherwise capture.
	 */
	pendingRestore(): TransferRestoreSnapshot | null {
		return this.pendingSnapshot;
	}

	/** Forget the pending transfers once another restart has restored them. */
	clearPendingRestore(): void {
		this.pendingSnapshot = null;
	}

	/**
	 * Decide how `change` goes live and commit it. A write that touches no P2P setting is only
	 * committed. One that does is committed live when the node runs, was built from the same
	 * values and has nothing left to restore; otherwise the node is restarted around the commit.
	 */
	async apply(change: SettingsChange): Promise<void> {
		if (!requestsP2PApply(change.scope.paths)) {
			await change.commit();
			return;
		}
		const applied = this.deps.isRunning() ? this.deps.appliedNetworkConfig() : null;
		if (applied !== null && this.pendingSnapshot === null && sameEffectiveNetworkConfig(applied, effectiveNetworkConfig(change.after.network))) {
			await change.commit();
			this.deps.applyLimits(change.after.network);
			return;
		}
		await this.restart(change);
	}

	/**
	 * Stop the node, publish the settings, start it once and bring the transfers back. On a
	 * failure the settings that were saved stay saved, the snapshot stays for the next attempt
	 * and transfers stay closed; the error reaches the caller.
	 */
	private async restart(change: SettingsChange): Promise<void> {
		const lease = await this.deps.prepareMaintenance();
		try {
			// Cancel BEFORE draining, as the factory reset and the identity change do: a leave
			// stuck hanging up an unresponsive peer ends only through this, and the drain would
			// otherwise wait for it forever with the settings write and every later one behind.
			this.deps.cancelRunOperations();
			await lease.drain();
			await Promise.all([this.deps.pauseTransfers(), this.deps.pauseLISHMutations()]);
			// A retry keeps the first snapshot: the runtime it would take now is already empty.
			if (this.pendingSnapshot === null) this.pendingSnapshot = await this.deps.clearTransfers();
			await this.deps.stopAllNetworks();
			await change.commit();
			this.deps.applyLimits(change.after.network);
			await this.deps.startEnabledNetworks();
			await this.deps.restoreTransfers(this.deps.downloadIntent(), this.pendingSnapshot);
			this.pendingSnapshot = null;
			this.deps.resumeTransfers();
		} finally {
			this.deps.resumeLISHMutations();
			lease.release();
		}
	}
}
