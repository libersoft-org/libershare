import type { LISHid } from '@shared';
import type { LISHClient } from './lish-protocol.ts';
import type { ConnectionType } from './peer-tracker.ts';
import { registerDownloadPeer, unregisterDownloadPeer, unregisterAllPeersForLISH, updatePeerHavePercent } from './peer-tracker.ts';
import { trace } from '../logger.ts';
type NodeID = string;
export interface PeerManagerCallbacks {
	/**
	 * Fired synchronously after a peer is successfully added via tryAdd().
	 * Used by downloadChunks() to dynamically spawn a peerLoop for newly-joined peers
	 * (whether they arrived via pubsub 'have' or probeTopicPeers).
	 */
	onPeerAdded?: (peerID: NodeID, client: LISHClient) => void;
}

/**
 * Central owner of peer-related state for a single download session.
 *
 * Invariants (maintained by atomic methods on this class):
 *  - A peerID is in at most one of `peers` / `dropped` / `banned` at any time.
 *  - `activeLoops ⊆ peers` (a peer has an active loop only while it's connected).
 *  - Every entry in `peers` maps to a live LISHClient; remove() always closes it.
 *
 * All check-then-act patterns (the "if not connected, dial + add" race) are replaced
 * by a single atomic tryAdd() — caller hands over the dialed client, which either becomes
 * the canonical client (true returned) or must be closed by the caller (false returned).
 *
 * Dropped peers are soft quarantine (auto-recover via 'have' pubsub or ~5min cyclic reset).
 * Banned peers are permanent for the app session (actively malicious behavior only).
 */
export class PeerManager {
	private lishID: LISHid | null = null;
	private readonly peers = new Map<NodeID, LISHClient>();
	private readonly activeLoops = new Set<NodeID>();
	private readonly bannedPeers = new Set<NodeID>();
	private readonly droppedPeers = new Set<NodeID>();
	/** Wall-clock timestamp of the last droppedPeers reset. Drives maybeResetDroppedAfter5Min(). */
	private lastDroppedReset = Date.now();
	private callbacks: PeerManagerCallbacks = {};

	// ============ Lifecycle ============

	/**
	 * Bind the manager to a concrete LISH. Must be called before any add/remove operation
	 * that interacts with the peer-tracker (i.e. before peers are added).
	 */
	setLishID(lishID: LISHid): void {
		this.lishID = lishID;
	}

	setCallbacks(cb: PeerManagerCallbacks): void {
		this.callbacks = cb;
	}

	clearCallbacks(): void {
		this.callbacks = {};
	}

	// ============ Membership queries ============

	size(): number {
		return this.peers.size;
	}

	has(peerID: NodeID): boolean {
		return this.peers.has(peerID);
	}

	isBanned(peerID: NodeID): boolean {
		return this.bannedPeers.has(peerID);
	}

	isDropped(peerID: NodeID): boolean {
		return this.droppedPeers.has(peerID);
	}

	bannedSize(): number {
		return this.bannedPeers.size;
	}

	droppedSize(): number {
		return this.droppedPeers.size;
	}

	/** True if the peer is eligible for a new dial (not connected, not banned, not dropped). */
	canDial(peerID: NodeID): boolean {
		return !this.peers.has(peerID) && !this.bannedPeers.has(peerID) && !this.droppedPeers.has(peerID);
	}

	// ============ Adding / removing peers ============

	/**
	 * Atomically try to add a peer. If another codepath already added the peer concurrently
	 * (classic check-then-act race), returns false — caller MUST close the passed client to
	 * avoid a stream leak.
	 *
	 * Fires onPeerAdded callback when add succeeds. Callback may synchronously spawn a peerLoop.
	 */
	tryAdd(peerID: NodeID, client: LISHClient, connectionType: ConnectionType, havePercent?: number): boolean {
		if (this.peers.has(peerID)) return false;
		this.peers.set(peerID, client);
		if (this.lishID) {
			if (havePercent !== undefined) registerDownloadPeer(this.lishID, peerID, connectionType, havePercent);
			else registerDownloadPeer(this.lishID, peerID, connectionType);
		}
		this.callbacks.onPeerAdded?.(peerID, client);
		return true;
	}

	/**
	 * Remove a peer with a given disposition:
	 *  - 'drop'       — soft quarantine (can auto-recover via 'have' pubsub or ~5min cyclic reset)
	 *  - 'ban'        — permanent for this app session (malicious behavior)
	 *  - 'disconnect' — plain removal (graceful end of download / enable/disable cycle)
	 *
	 * Fire-and-forget close. Returns immediately. Close errors logged at trace level.
	 */
	remove(peerID: NodeID, reason: 'drop' | 'ban' | 'disconnect'): void {
		const client = this.peers.get(peerID);
		this.peers.delete(peerID);
		this.activeLoops.delete(peerID);
		if (this.lishID) unregisterDownloadPeer(this.lishID, peerID);
		if (reason === 'drop') this.droppedPeers.add(peerID);
		if (reason === 'ban') this.bannedPeers.add(peerID);
		if (client) {
			client.close().catch((err: any) => trace(`[PM] remove(${reason}) close: ${err?.message ?? err}`));
		}
	}

	/** Like remove(), but awaits client.close() — for shutdown paths that want to ensure graceful close. */
	async removeAwait(peerID: NodeID, reason: 'drop' | 'ban' | 'disconnect'): Promise<void> {
		const client = this.peers.get(peerID);
		this.peers.delete(peerID);
		this.activeLoops.delete(peerID);
		if (this.lishID) unregisterDownloadPeer(this.lishID, peerID);
		if (reason === 'drop') this.droppedPeers.add(peerID);
		if (reason === 'ban') this.bannedPeers.add(peerID);
		if (client) {
			await client.close().catch((err: any) => trace(`[PM] removeAwait(${reason}) close: ${err?.message ?? err}`));
		}
	}

	// ============ Iteration ============

	/** Live view. Use when you need to see peers added after iteration started (e.g. dynamic loop spawn). */
	entries(): IterableIterator<[NodeID, LISHClient]> {
		return this.peers.entries();
	}

	/** Immutable point-in-time snapshot. */
	snapshot(): Array<[NodeID, LISHClient]> {
		return [...this.peers.entries()];
	}

	// ============ Active peerLoop tracking ============

	markActive(peerID: NodeID): void {
		this.activeLoops.add(peerID);
	}

	markInactive(peerID: NodeID): void {
		this.activeLoops.delete(peerID);
	}

	isActive(peerID: NodeID): boolean {
		return this.activeLoops.has(peerID);
	}

	// ============ Dropped cycle management ============

	/** A 'have' pubsub message arrived from a dropped peer — it's alive, remove from quarantine. */
	clearDropped(peerID: NodeID): boolean {
		return this.droppedPeers.delete(peerID);
	}

	clearAllDropped(): void {
		this.droppedPeers.clear();
		this.lastDroppedReset = Date.now();
	}

	/**
	 * Time-based dropped-peers reset. Called from any peer-discovery cycle.
	 * Returns true iff ≥5 minutes elapsed since the last reset and droppedPeers was cleared.
	 * Replaces the old fixed-cycle-count logic so the reset cadence is independent of the
	 * (now adaptive) discovery interval.
	 */
	maybeResetDroppedAfter5Min(): boolean {
		if (Date.now() - this.lastDroppedReset >= 5 * 60_000) {
			this.droppedPeers.clear();
			this.lastDroppedReset = Date.now();
			return true;
		}
		return false;
	}

	// ============ Have-percent passthrough ============

	updateHavePercent(peerID: NodeID, havePercent: number): void {
		if (this.lishID) updatePeerHavePercent(this.lishID, peerID, havePercent);
	}

	// ============ Bulk operations ============

	/**
	 * Close all peer clients and clear the peers map (preserves banned/dropped state).
	 * Fire-and-forget close. For hot paths (disable, setError, finally blocks).
	 */
	closeAll(reason: string): void {
		const clients = [...this.peers.values()];
		this.peers.clear();
		this.activeLoops.clear();
		if (this.lishID) unregisterAllPeersForLISH(this.lishID);
		for (const client of clients) client.close().catch((err: any) => trace(`[PM] closeAll(${reason}) close: ${err?.message ?? err}`));
	}

	/** Close-all with awaited closes — for destroy() / downloadChunks finally. */
	async closeAllAwait(reason: string): Promise<void> {
		const clients = [...this.peers.values()];
		this.peers.clear();
		this.activeLoops.clear();
		if (this.lishID) unregisterAllPeersForLISH(this.lishID);
		for (const client of clients) await client.close().catch((err: any) => trace(`[PM] closeAllAwait(${reason}) close: ${err?.message ?? err}`));
	}
}
