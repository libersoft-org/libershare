import { type BootstrapStatus, type BootstrapPeerStatus, type BootstrapPeerDialStatus, type BootstrapPeerOrigin } from '@shared';

/**
 * Tracks per-network, per-bootstrap-peer dial outcome status.
 *
 * Outer key is networkID; inner key is the exact multiaddr string from the network
 * config. Populated by markBootstrapPending / recordBootstrapOutcome when called
 * with a networkID context (initial join + manual updates). Lets the UI surface
 * which SPECIFIC bootstrap entry is stale (identity-mismatch) or unreachable
 * (timeout), rather than flagging the whole network.
 *
 * NOT populated for dynamic bootstrap additions from peer-announce gossip
 * (those have no single owning network and would dilute per-network stats).
 */
export class BootstrapStatusTracker {
	private readonly stats: Map<string, Map<string, BootstrapPeerStatus>> = new Map();
	private onStatusChange: ((networkID: string, status: BootstrapStatus) => void) | null = null;

	/** Register a callback that fires on every status mutation. */
	setOnChange(cb: ((networkID: string, status: BootstrapStatus) => void) | null): void {
		this.onStatusChange = cb;
	}

	/** Iterate over all tracked network IDs and their peer maps. Used for NET-CHURN dump. */
	entries(): IterableIterator<[string, Map<string, BootstrapPeerStatus>]> {
		return this.stats.entries();
	}

	/** Snapshot of all per-network bootstrap statuses. */
	getAllStatuses(): BootstrapStatus[] {
		return [...this.stats.keys()].map(id => this.buildStatus(id)!).filter(Boolean);
	}

	/** Snapshot of a single network's bootstrap status, or null if no attempts have been recorded. */
	getStatus(networkID: string): BootstrapStatus | null {
		return this.buildStatus(networkID);
	}

	/** Record that a peer has been accepted but outcome is not yet known. */
	markPending(networkID: string | null, multiaddr: string, expectedPeerID: string | null, origin: BootstrapPeerOrigin): void {
		if (!networkID) return;
		const net = this.ensureNetwork(networkID);
		// Preserve a stronger origin classification — once we know an entry is in
		// the saved config ('configured'), an inbound peer-announce later restating
		// the same multiaddr must not downgrade it to 'discovered'.
		const previous = net.get(multiaddr);
		const finalOrigin: BootstrapPeerOrigin = previous?.origin === 'configured' ? 'configured' : origin;
		net.set(multiaddr, { multiaddr, expectedPeerID, status: 'pending', origin: finalOrigin, actualPeerID: null, lastError: null, updatedAt: new Date().toISOString() });
		const snapshot = this.buildStatus(networkID);
		if (snapshot) this.onStatusChange?.(networkID, snapshot);
	}

	/** Record a dial outcome (connected, timeout, error, identity-mismatch). */
	recordOutcome(networkID: string | null, multiaddr: string, expectedPeerID: string | null, status: BootstrapPeerDialStatus, message: string | null, actualPeerID: string | null, origin: BootstrapPeerOrigin): void {
		if (!networkID) return;
		const net = this.ensureNetwork(networkID);
		const truncated = message ? (message.length > 200 ? message.slice(0, 200) + '…' : message) : null;
		const previous = net.get(multiaddr);
		const finalOrigin: BootstrapPeerOrigin = previous?.origin === 'configured' ? 'configured' : origin;
		net.set(multiaddr, { multiaddr, expectedPeerID, status, origin: finalOrigin, actualPeerID, lastError: truncated, updatedAt: new Date().toISOString() });
		const snapshot = this.buildStatus(networkID);
		if (snapshot) this.onStatusChange?.(networkID, snapshot);
	}

	/** Drop a single peer entry directly (used after identity-mismatch purge of discovered peers). */
	deletePeer(networkID: string, multiaddr: string): void {
		const net = this.stats.get(networkID);
		if (!net) return;
		net.delete(multiaddr);
		if (net.size === 0) this.stats.delete(networkID);
		const snap = this.buildStatus(networkID) ?? { networkID, peers: [] };
		this.onStatusChange?.(networkID, snap);
	}

	/** Drop bootstrap status entries no longer in the configured peer list (after an update). */
	pruneEntries(networkID: string, keepMultiaddrs: string[]): void {
		const peers = this.stats.get(networkID);
		if (!peers) return;
		const keep = new Set(keepMultiaddrs);
		for (const addr of [...peers.keys()]) {
			if (!keep.has(addr)) peers.delete(addr);
		}
		if (peers.size === 0) this.stats.delete(networkID);
		const snapshot = this.buildStatus(networkID);
		if (snapshot) this.onStatusChange?.(networkID, snapshot);
	}

	/** Reset the bootstrap status for a single network (used when re-joining). */
	resetNetwork(networkID: string): void {
		this.stats.delete(networkID);
		this.onStatusChange?.(networkID, { networkID, peers: [] });
	}

	/** Clear all tracked state (called from Network.stop()). */
	clear(): void {
		this.stats.clear();
	}

	private ensureNetwork(networkID: string): Map<string, BootstrapPeerStatus> {
		let net = this.stats.get(networkID);
		if (!net) {
			net = new Map();
			this.stats.set(networkID, net);
		}
		return net;
	}

	private buildStatus(networkID: string): BootstrapStatus | null {
		const peers = this.stats.get(networkID);
		if (!peers) return null;
		return { networkID, peers: [...peers.values()].map(p => ({ ...p })) };
	}
}
