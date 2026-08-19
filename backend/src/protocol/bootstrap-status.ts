import { type BootstrapStatus, type BootstrapPeerStatus, type BootstrapPeerDialStatus, type BootstrapPeerOrigin } from '@shared';
import { canonicalMultiaddr } from './multiaddr-utils.ts';

/**
 * Hard ceiling on DISCOVERED (gossip-learned) rows kept per network. A hostile
 * topic subscriber can announce unbounded unique addresses, all ending in one
 * connected peer's ID; without a cap the tracker map, its snapshots, and the
 * WebSocket updates grow without limit. Configured rows are never counted or
 * dropped — they are finite user data.
 */
const MAX_DISCOVERED_PER_NETWORK = 256;

/**
 * While a {@link BootstrapStatusTracker.batchDebounced} frame is open, how often the
 * changes accumulated so far are published.
 *
 * A plain batch frame publishes once, at close — which is wrong for a body that awaits a
 * dial per address: the frame would stay open for the whole list, one 10 s timeout at a
 * time, and the UI would show nothing until the last address settled. Flushing on this
 * interval keeps the run visible while still collapsing the burst of intake mutations
 * (two per address, each rebuilding the whole snapshot) into a handful of emissions.
 */
const BATCH_FLUSH_INTERVAL_MS = 75;

/**
 * A stored row: the status the UI sees, plus the clock {@link BootstrapStatusTracker.sweepStale}
 * measures against.
 *
 * `updatedAt` cannot serve as that clock. It is "when did anything about this row last
 * change", which is what the UI wants, and it moves on every dial outcome — failures
 * included. Gossip re-announces a dead peer far more often than the sweep TTL, and this
 * node answers each mention with a dial that fails, so measuring staleness from
 * `updatedAt` meant a dead row was refreshed by its own failures and could never expire.
 * `staleSince` moves only when the address actually answered.
 */
type TrackedPeer = BootstrapPeerStatus & { staleSince: number };

/**
 * Which spelling of an endpoint the UI should show.
 *
 * The row is keyed canonically, so several spellings can land on it. A configured one
 * always wins — it is what the user typed into the form and what they will look for when
 * fixing it — and otherwise the first spelling seen is kept, so a row does not visibly
 * change address every time gossip restates it differently.
 */
function displaySpelling(previous: TrackedPeer | undefined, incoming: string, origin: BootstrapPeerOrigin): string {
	if (!previous || origin === 'configured') return incoming;
	return previous.multiaddr;
}

/**
 * Tracks per-network, per-bootstrap-peer dial outcome status.
 *
 * Outer key is networkID; inner key is the CANONICAL form of the multiaddr, while the
 * row keeps the spelling as written for display. Keying by the raw string let two
 * spellings of one endpoint — DNS case, a trailing dot, an expanded IPv6 literal — open
 * two rows that then contradicted each other, spent the row budget twice and survived a
 * delete aimed at only one of them.
 *
 * Populated by markBootstrapPending / recordBootstrapOutcome when called
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
	private readonly stats: Map<string, Map<string, TrackedPeer>> = new Map();
	private onStatusChange: ((networkID: string, status: BootstrapStatus) => void) | null = null;
	/** Open {@link batch} frames, keyed by networkID. See that method for why. */
	private readonly batches: Map<string, { depth: number; dirty: boolean }> = new Map();
	/** Current members of a network, for {@link capDiscovered}. See {@link setMembersProvider}. */
	private membersProvider: ((networkID: string) => Set<string>) | null = null;

	/** Register a callback that fires on every status mutation. */
	setOnChange(cb: ((networkID: string, status: BootstrapStatus) => void) | null): void {
		this.onStatusChange = cb;
	}

	/**
	 * Supply the current member set of a network, so {@link capDiscovered} can tell a row
	 * that describes a live participant from one that describes an address nobody answers
	 * on. Asked for the whole set rather than per peer because the cap ranks every row at
	 * once and a per-peer question would rebuild the same snapshot for each of them.
	 */
	setMembersProvider(fn: ((networkID: string) => Set<string>) | null): void {
		this.membersProvider = fn;
	}

	/**
	 * Group many mutations of one network into a SINGLE status emission.
	 *
	 * Every mutation otherwise rebuilds and emits the whole peer list, and a caller
	 * that walks a list of addresses performs two of them per address (pending, then
	 * outcome) — so intake of one large announce costs a snapshot per row per address,
	 * each copying every row, all but the last of which is thrown away by the UI.
	 *
	 * The frame closes on every exit path, throw included, so a body that fails still
	 * publishes what it managed to change — the tracker is already mutated by then and
	 * silence would leave the UI showing pre-batch state indefinitely. An async body is
	 * held open until its promise settles, because the caller this exists for awaits a
	 * dial between mutations; the return value keeps the body's own type either way.
	 * Nested calls for the same network collapse into the outermost frame, and a batch
	 * in which nothing actually changed emits nothing.
	 */
	batch<T>(networkID: string, fn: () => T): T {
		let frame = this.batches.get(networkID);
		if (!frame) {
			frame = { depth: 0, dirty: false };
			this.batches.set(networkID, frame);
		}
		frame.depth++;
		const open = frame;
		let result: T;
		try {
			result = fn();
		} catch (err) {
			this.closeBatch(networkID, open);
			throw err;
		}
		if (result instanceof Promise) {
			return result.then(
				value => {
					this.closeBatch(networkID, open);
					return value;
				},
				err => {
					this.closeBatch(networkID, open);
					throw err;
				}
			) as T;
		}
		this.closeBatch(networkID, open);
		return result;
	}

	/**
	 * Like {@link batch}, but for an async body long enough that holding every change to
	 * the end would leave the UI stale: what has accumulated is published every
	 * {@link BATCH_FLUSH_INTERVAL_MS} while the frame is open, and once more at close.
	 *
	 * This is the shape bootstrap intake needs — it awaits a dial between each address's
	 * pending mark and its outcome, so the alternatives are one emission per mutation
	 * (what it used to do) or one emission for the entire list (a frozen UI).
	 */
	async batchDebounced<T>(networkID: string, fn: () => Promise<T>): Promise<T> {
		let frame = this.batches.get(networkID);
		if (!frame) {
			frame = { depth: 0, dirty: false };
			this.batches.set(networkID, frame);
		}
		frame.depth++;
		const open = frame;
		const timer = setInterval(() => {
			// A frame replaced by clear() belongs to a torn-down run; publishing its
			// leftovers under the same networkID would speak for whatever came next.
			if (!open.dirty || this.batches.get(networkID) !== open) return;
			open.dirty = false;
			this.onStatusChange?.(networkID, this.buildStatus(networkID) ?? { networkID, peers: [] });
		}, BATCH_FLUSH_INTERVAL_MS);
		timer.unref?.();
		try {
			return await fn();
		} finally {
			clearInterval(timer);
			this.closeBatch(networkID, open);
		}
	}

	/** Leave one {@link batch} frame, emitting the grouped snapshot when the last one exits. */
	private closeBatch(networkID: string, frame: { depth: number; dirty: boolean }): void {
		frame.depth--;
		if (frame.depth > 0) return;
		// clear() drops open frames on teardown; a pending emission from before it
		// belongs to the run that was torn down, not to whatever comes next.
		if (this.batches.get(networkID) !== frame) return;
		this.batches.delete(networkID);
		if (frame.dirty) this.onStatusChange?.(networkID, this.buildStatus(networkID) ?? { networkID, peers: [] });
	}

	/**
	 * Publish one network's current status, or defer to the end of the open batch.
	 *
	 * Deferring skips {@link buildStatus} as well as the callback — building the
	 * snapshot is the part that copies every row, so suppressing only the callback
	 * would leave the cost in place.
	 */
	private notify(networkID: string): void {
		const frame = this.batches.get(networkID);
		if (frame) {
			frame.dirty = true;
			return;
		}
		this.onStatusChange?.(networkID, this.buildStatus(networkID) ?? { networkID, peers: [] });
	}

	/** Iterate over all tracked network IDs and their peer maps. Used for NET-CHURN dump. */
	entries(): IterableIterator<[string, Map<string, TrackedPeer>]> {
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
		const key = canonicalMultiaddr(multiaddr);
		// Preserve a stronger origin classification — once we know an entry is in
		// the saved config ('configured'), an inbound peer-announce later restating
		// the same multiaddr must not downgrade it to 'discovered'.
		const previous = net.get(key);
		const finalOrigin: BootstrapPeerOrigin = previous?.origin === 'configured' ? 'configured' : origin;
		const display = displaySpelling(previous, multiaddr, origin);
		// Only the staleness clock is kept — `updatedAt` is this row's "when did anything
		// about it last change", and a new attempt IS a change: the UI shows it, and the
		// row-cap tiebreak reads it, where a frozen value makes an actively retried row
		// look older than rows nobody has touched. See sweepStale. Reaching this point means
		// someone MENTIONED the peer again — gossip repeating an address it still
		// remembers — which is evidence about the announcer, not about the peer. Letting
		// a mention move the clock made a dead peer's row immortal: every announce cycle
		// is far shorter than the sweep TTL, so the row was refreshed long before it
		// could expire, no matter how many dials to it had already failed. Only a dial
		// that actually CONNECTED advances it, in recordOutcome below.
		// Keep any identity a previous dial actually PROVED on this endpoint. Clearing it
		// here threw away the one piece of evidence the row-cap ranking trusts, and gossip
		// re-mentions an address constantly — so a verified member's row was demoted to an
		// ordinary one within an announce cycle of being verified. A new dial result
		// overwrites it in recordOutcome; only that can change who is behind the address.
		net.set(key, { multiaddr: display, expectedPeerID, status: 'pending', origin: finalOrigin, actualPeerID: previous?.actualPeerID ?? null, lastError: null, updatedAt: new Date().toISOString(), staleSince: previous?.staleSince ?? Date.now() });
		this.capDiscovered(networkID, net);
		this.notify(networkID);
	}

	/** Record a dial outcome (connected, timeout, error, identity-mismatch). */
	recordOutcome(networkID: string | null, multiaddr: string, expectedPeerID: string | null, status: BootstrapPeerDialStatus, message: string | null, actualPeerID: string | null, origin: BootstrapPeerOrigin, verified: boolean = true): void {
		if (!networkID) return;
		const net = this.ensureNetwork(networkID);
		const key = canonicalMultiaddr(multiaddr);
		const truncated = message ? (message.length > 200 ? message.slice(0, 200) + '…' : message) : null;
		const previous = net.get(key);
		const finalOrigin: BootstrapPeerOrigin = previous?.origin === 'configured' ? 'configured' : origin;
		const display = displaySpelling(previous, multiaddr, origin);
		// Only a VERIFIED success restarts the staleness clock. A FAILING outcome is the
		// node's own reaction to somebody else's mention of a dead peer, so letting it
		// advance the clock kept exactly the rows this sweep exists to remove: gossip
		// mentions the peer, the dial fails, the row is refreshed, and the TTL is never
		// reached.
		//
		// `verified` closes the same hole from the other side. A discovered dial does not
		// force, so libp2p may answer it with a connection it already holds to that peer
		// over a DIFFERENT address — which says the peer is alive somewhere, not that it is
		// still taking part in THIS network. A peer that left one lishnet while staying
		// connected through another was kept in the list it had left by exactly that: every
		// gossip mention produced a 'connected' its other membership had earned.
		net.set(key, { multiaddr: display, expectedPeerID, status, origin: finalOrigin, actualPeerID, lastError: truncated, updatedAt: new Date().toISOString(), staleSince: status === 'connected' && verified ? Date.now() : (previous?.staleSince ?? Date.now()) });
		this.capDiscovered(networkID, net);
		this.notify(networkID);
	}

	/**
	 * Mark every row for one endpoint reachable, in every network that has one.
	 *
	 * For the loops that probe an ADDRESS rather than a network's list: they know the
	 * endpoint answered but not who was waiting to hear it. The parked-bootstrap probe is
	 * the case that matters — it is the only thing that ever retries an address the
	 * routability filter rejected at configure time, and it used to keep its success to
	 * itself, so the row stayed red for an address that had been working for hours.
	 *
	 * Matching is canonical, not by string identity: the probe walks parsed multiaddrs
	 * while the rows are keyed by the spelling the user typed.
	 */
	recordAddressReachable(address: string): void {
		const target = canonicalMultiaddr(address);
		for (const [networkID, peers] of this.stats) {
			const peer = peers.get(target);
			if (!peer || peer.status === 'connected') continue;
			// Only the rows the probe speaks for. The probe walks the CONFIGURED addresses
			// of this node, so all it establishes is that a saved entry answers — nothing
			// about whether the peer is still a participant of some other network that once
			// heard the same address over gossip. Refreshing a discovered row here restarted
			// its staleness clock on evidence that had nothing to do with that network, and
			// the row then outlived every sweep.
			if (peer.origin !== 'configured') continue;
			// The probe knows the endpoint answered, not who answered — so it neither sets
			// nor clears the verified identity a real dial may already have established.
			peers.set(target, { ...peer, status: 'connected', lastError: null, updatedAt: new Date().toISOString(), staleSince: Date.now() });
			this.notify(networkID);
		}
	}

	/**
	 * Bound discovered rows per network — see MAX_DISCOVERED_PER_NETWORK.
	 *
	 * Age alone is the wrong order. It looks at neither the row's state nor whether the
	 * peer is actually in the network, so a flood of freshly invented dead addresses could
	 * push a live, connected participant out of the list — the stale sweep protects an
	 * active member deliberately, and this used to undo that. Least useful goes first:
	 * a row whose address failed, then one that has never answered, then one that once
	 * connected, and rows belonging to a VERIFIED member last.
	 *
	 * Verified is the operative word. Ranking on `expectedPeerID` — the identity the
	 * ADDRESS claims — handed the protection to whoever was making the claim: invented
	 * addresses that all named a live member each took the top rank, and the member's own
	 * genuine row, being the oldest of them, was the one evicted. Only `actualPeerID`, set
	 * from a connection we actually made, is evidence of anything.
	 */
	private capDiscovered(networkID: string, net: Map<string, TrackedPeer>): void {
		let discovered = 0;
		for (const p of net.values()) if (p.origin === 'discovered') discovered++;
		if (discovered <= MAX_DISCOVERED_PER_NETWORK) return;
		const members = this.membersProvider?.(networkID) ?? new Set<string>();
		const rankOf = (p: TrackedPeer): number => {
			if (p.actualPeerID && members.has(p.actualPeerID)) return 3;
			if (p.status === 'connected') return 2;
			if (p.status === 'pending') return 1;
			return 0;
		};
		// Ranked once per row, not inside the comparator — the member lookup would
		// otherwise run O(n log n) times over the same snapshot.
		const victims = [...net.entries()]
			.filter(([, p]) => p.origin === 'discovered')
			.map(([key, p]) => ({ key, rank: rankOf(p), age: Date.parse(p.updatedAt) }))
			.sort((a, b) => a.rank - b.rank || a.age - b.age);
		for (let i = 0; i < discovered - MAX_DISCOVERED_PER_NETWORK; i++) net.delete(victims[i]!.key);
	}

	/** Drop a single peer entry directly (used after identity-mismatch purge of discovered peers). */
	deletePeer(networkID: string, multiaddr: string): void {
		const net = this.stats.get(networkID);
		if (!net) return;
		net.delete(canonicalMultiaddr(multiaddr));
		if (net.size === 0) this.stats.delete(networkID);
		this.notify(networkID);
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
			this.notify(networkID);
		}
	}

	/**
	 * Drop discovered-origin entries that have gone stale: nothing has CONNECTED on the
	 * address within `ttlMs` AND the peer is not an active member of THAT network. A peer
	 * that dies stops answering, so its clock freezes and the row expires here — whether
	 * gossip keeps naming it or not, and whether the row is frozen at 'connected' or
	 * cycling through failures that this node produces itself. See {@link TrackedPeer}. The
	 * liveness predicate is scoped to the network (its topic subscribers), NOT the
	 * shared libp2p connection: a peer that left network B but is still connected
	 * through network A must not keep a stale row under B. Membership is judged on the
	 * VERIFIED identity only — see the check below. Configured entries are exempt (user
	 * data). `now` is injectable for tests.
	 */
	sweepStale(ttlMs: number, isMember: (networkID: string, peerID: string) => boolean, now: number = Date.now()): void {
		for (const [networkID, peers] of [...this.stats]) {
			let changed = false;
			for (const [addr, p] of [...peers]) {
				if (p.origin !== 'discovered') continue;
				// Only a VERIFIED identity exempts a row. `expectedPeerID` is whatever the
				// address claims, and a discovered multiaddr practically always carries one —
				// so reading it here handed the exemption to the announcer: any address ending
				// /p2p/<a-live-member> was treated as that member's, never dialed successfully,
				// and never expired. The cap bounds how many such rows exist; this is what
				// stops them from occupying the budget permanently.
				if (p.actualPeerID && isMember(networkID, p.actualPeerID)) continue;
				if (now - p.staleSince < ttlMs) continue;
				peers.delete(addr);
				changed = true;
			}
			if (!changed) continue;
			if (peers.size === 0) this.stats.delete(networkID);
			this.notify(networkID);
		}
	}

	/**
	 * Drop bootstrap status entries no longer in the configured peer list (after an update).
	 *
	 * `keepMultiaddrs` is the network's CONFIGURED list, so only configured rows may be
	 * judged by it. Discovered rows are not in it and never will be — deleting them here
	 * would clear the participant list of everything gossip has found, on nothing more
	 * than a bootstrap edit or a "refresh from public list", until gossip happens to
	 * mention each peer again. Discovered rows leave via their own paths: the staleness
	 * sweep, the per-network cap, or eviction of the peer ID.
	 */
	pruneEntries(networkID: string, keepMultiaddrs: string[]): void {
		const peers = this.stats.get(networkID);
		if (!peers) return;
		// Canonical, like the keys themselves: a configured entry re-typed in a different
		// but equivalent spelling is the same entry, not a removed one.
		const keep = new Set(keepMultiaddrs.map(canonicalMultiaddr));
		for (const [addr, peer] of [...peers.entries()]) {
			if (peer.origin === 'configured' && !keep.has(addr)) peers.delete(addr);
		}
		if (peers.size === 0) this.stats.delete(networkID);
		// Emit the empty list rather than nothing when the last row goes: buildStatus
		// returns null for a dropped network, and skipping the callback would leave the
		// UI showing the very row that was just removed. Same fallback the other
		// removal paths use.
		this.notify(networkID);
	}

	/** Reset the bootstrap status for a single network (used when re-joining). */
	resetNetwork(networkID: string): void {
		this.stats.delete(networkID);
		this.notify(networkID);
	}

	/** Clear all tracked state (called from Network.stop()). */
	clear(): void {
		this.stats.clear();
		// An in-flight batch belongs to the run being torn down; its pending emission
		// would publish the next run's (empty) state under the old run's networkID.
		this.batches.clear();
	}

	private ensureNetwork(networkID: string): Map<string, TrackedPeer> {
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
		// staleSince is internal bookkeeping, not part of the wire contract.
		return { networkID, peers: [...peers.values()].map(({ staleSince: _staleSince, ...p }) => p) };
	}
}
