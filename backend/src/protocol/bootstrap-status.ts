import { type BootstrapStatus, type BootstrapPeerStatus, type BootstrapPeerDialStatus, type BootstrapPeerOrigin } from '@shared';

/**
 * Tracks per-network, per-bootstrap-peer dial outcome status.
 *
 * Outer key is networkID; inner key is the exact multiaddr string from the network
 * config. Populated by markBootstrapPending / recordBootstrapOutcome when called
 * with a networkID context. Lets the UI surface which SPECIFIC bootstrap entry is
 * stale (identity-mismatch) or unreachable (timeout), rather than flagging the
 * whole network.
 *
 * Populated both for configured bootstrap entries (initial join + manual updates)
 * and for peers discovered via peer-announce gossip: the inbound handler passes the
 * networkID of the topic the announce arrived on, so discovered peers are tracked
 * under the network through which they were learned.
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

	/**
	 * Drop every discovered-origin entry recorded for the given peer identity, in
	 * every network. Used when a peer is evicted as unreachable — its gossip-learned
	 * rows are pure noise at that point. Configured rows are kept: they are user
	 * data and must stay visible (red) so the user can fix or remove them.
	 */
	deleteDiscoveredByPeerID(peerID: string): void {
		for (const [networkID, peers] of [...this.stats]) {
			let changed = false;
			for (const [addr, p] of [...peers]) {
				if (p.origin !== 'discovered') continue;
				if (p.expectedPeerID !== peerID && p.actualPeerID !== peerID) continue;
				peers.delete(addr);
				changed = true;
			}
			if (!changed) continue;
			if (peers.size === 0) this.stats.delete(networkID);
			this.onStatusChange?.(networkID, this.buildStatus(networkID) ?? { networkID, peers: [] });
		}
	}

	/**
	 * Drop discovered-origin entries that have gone stale: no status refresh within
	 * `ttlMs` AND no current connection to the peer. Dead peers stop being mentioned
	 * by gossip, so their rows stop refreshing and expire here — including rows
	 * frozen at 'connected' for a peer that silently died. Configured entries are
	 * exempt (user data). `now` is injectable for tests.
	 */
	sweepStale(ttlMs: number, isConnected: (peerID: string) => boolean, now: number = Date.now()): void {
		for (const [networkID, peers] of [...this.stats]) {
			let changed = false;
			for (const [addr, p] of [...peers]) {
				if (p.origin !== 'discovered') continue;
				const pid = p.expectedPeerID ?? p.actualPeerID;
				if (pid && isConnected(pid)) continue;
				const updated = Date.parse(p.updatedAt);
				if (Number.isFinite(updated) && now - updated < ttlMs) continue;
				peers.delete(addr);
				changed = true;
			}
			if (!changed) continue;
			if (peers.size === 0) this.stats.delete(networkID);
			this.onStatusChange?.(networkID, this.buildStatus(networkID) ?? { networkID, peers: [] });
		}
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
