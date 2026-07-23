import { trace } from '../logger.ts';
import { getLocalCidrs, shouldDenyDial } from './address-filter.ts';
import { multiaddr as Multiaddr } from '@multiformats/multiaddr';
import { LISH_TOPIC_PREFIX } from './constants.ts';
import { type Libp2p } from 'libp2p';
import { type BootstrapPeerOrigin } from '@shared';

/**
 * Gossip-based peer-discovery bootstrap.
 *
 * Periodically each node broadcasts, per lishnet topic it is subscribed to, its
 * reachable multiaddrs plus the transitive multiaddrs of the peers subscribed to
 * THAT topic. Scoping the transitive list to a topic's subscribers keeps peers of
 * one network from being advertised into another. Receivers parse the list and
 * pass it through `addBootstrapPeers`, which dedupes against known peers and calls
 * `dial()`. This augments gossipsub PX (which only propagates on PRUNE) and libp2p
 * autodial (which is gated by peerStore) in topologies where bootstrap hubs are
 * few and NATed fleet members rely on relay reservations that expire before libp2p
 * would normally re-dial.
 */
export interface PeerAnnounceMessage {
	type: 'peer-announce';
	/** Multiaddrs (as strings) we claim to be reachable on, including /p2p/<peerID>. */
	multiaddrs: string[];
}

/**
 * Adaptive peer-announce interval. Instead of a fixed cadence that spams the network
 * once saturated, the emitter picks an interval based on peerStore size — aggressive
 * when isolated, lazy when near full visibility. Traffic at saturation is reduced
 * roughly 6× compared to a fixed 20s cadence.
 */
const PEER_ANNOUNCE_INTERVAL_ISOLATED_MS = 15_000; // peerStore < 20 (cold start / edge peer)
const PEER_ANNOUNCE_INTERVAL_STEADY_MS = 30_000; // peerStore 20..80 (mid-convergence)
const PEER_ANNOUNCE_INTERVAL_SATURATED_MS = 180_000; // peerStore > 80 (near full visibility)
const PEER_ANNOUNCE_JITTER_RATIO = 0.25; // ±25% jitter of chosen interval (thunder-herd avoidance)
/** Minimum peerStore size before we consider ourselves worth advertising. */
const PEER_ANNOUNCE_MIN_PEER_STORE = 5;
/** Hard cap on number of multiaddrs we include in a single announce (safety bound). */
const PEER_ANNOUNCE_MAX_ADDRS = 32;
/**
 * Cap on TOTAL multiaddrs in a peer-announce (self + peerStore transitive).
 * 128 covers ~half a 100-peer fleet per announce; receivers fill in the rest
 * from their own peerStore + subsequent announce cycles. Halving from 256
 * cuts saturation-time announce bandwidth ~50% with negligible discovery
 * latency cost (sub-2 announce cycles to fill peerStore).
 */
const PEER_ANNOUNCE_MAX_TOTAL_ADDRS = 128;
/** Max addrs we take from a single known peer when including transitive list. */
const PEER_ANNOUNCE_MAX_ADDRS_PER_PEER = 3;
/**
 * How long a peer stays an eligible transitive-announce target for a topic after
 * we last saw it in that topic's subscriber list. gossipsub drops a peer from
 * getSubscribers the moment it disconnects — but that is exactly when the peer
 * needs its addrs re-advertised so others can re-dial it (NAT / relay reservations
 * expire on drop). We keep it eligible (scoped to peers of its OWN topic, so no
 * cross-network leak) until this TTL lapses. Sized to a few saturated announce
 * cycles + relay-reservation churn; the real ceiling is peerStore eviction — once
 * its addrs are gone we cannot advertise it regardless.
 */
const PEER_ANNOUNCE_MEMBER_TTL_MS = PEER_ANNOUNCE_INTERVAL_SATURATED_MS * 3;

/** Dependencies for PeerAnnounceManager. */
export interface PeerAnnounceManagerDeps {
	/** Returns the current libp2p node (may be null if not started or already stopped). */
	getNode(): Libp2p | null;
	/** Returns the current pubsub instance (may be null). */
	getPubsub(): any | null;
	/** Broadcast a message on a gossipsub topic. */
	broadcast(topic: string, msg: Record<string, any>): Promise<void>;
	/** Process an inbound peer-announce payload: dial/tag discovered peers. */
	addBootstrapPeers(multiaddrs: string[], networkID: string, origin: BootstrapPeerOrigin): Promise<void>;
}

/**
 * Manages the periodic peer-announce gossip emitter and the inbound peer-announce handler.
 * Extracted from Network to keep protocol/network.ts focused on connection management.
 *
 * Lifecycle: call `start()` once the node is running, `stop()` before/during shutdown.
 * The internal timer uses a recursive setTimeout pattern; `stop()` sets a guard flag so
 * any in-flight tick that fires after `stop()` will not schedule the next tick.
 */
export class PeerAnnounceManager {
	private readonly deps: PeerAnnounceManagerDeps;
	private timer: NodeJS.Timeout | null = null;
	private stopped = false;
	/**
	 * Per-topic recently-seen subscribers (peerID → last-seen ms). Lets a
	 * momentarily-disconnected same-network peer stay an eligible transitive-announce
	 * target (see PEER_ANNOUNCE_MEMBER_TTL_MS) without ever admitting a peer of
	 * another network — a peerID only enters a topic's map via that topic's own
	 * getSubscribers, so the cross-network leak stays closed. Pruned each emit().
	 */
	private readonly topicMembers = new Map<string, Map<string, number>>();

	constructor(deps: PeerAnnounceManagerDeps) {
		this.deps = deps;
	}

	/** Start the periodic emitter. Safe to call only once per start/stop cycle. */
	start(): void {
		this.stopped = false;
		this.scheduleNext().catch(() => {
			/* first-tick scheduling failure would leave emitter stopped — acceptable fallback */
		});
	}

	/** Stop the emitter. Idempotent. Any in-flight tick will not reschedule. */
	stop(): void {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/** Handle an inbound peer-announce pubsub message. */
	async handle(data: PeerAnnounceMessage, networkID: string, fromPeerID?: string): Promise<void> {
		if (!Array.isArray(data.multiaddrs) || data.multiaddrs.length === 0) return;
		// Two-stage filter: shape (non-empty string) THEN routability (drop
		// loopback + non-local private through shouldDenyDial). Without the
		// routability stage, broadcasters with buggy emitters can inject their
		// /ip4/127.0.0.1 into our bootstrap set, causing TCP loop → Noise
		// identity-mismatch storm. Even though emitPeerAnnounce now filters
		// these out on our side, we cannot trust older peers in the fleet to
		// do the same — every receiver must be defensive.
		const localCidrs = getLocalCidrs();
		const rawCount = data.multiaddrs.length;
		const filtered: string[] = [];
		let droppedNonRoutable = 0;
		for (const a of data.multiaddrs) {
			if (typeof a !== 'string' || a.length === 0) continue;
			if (filtered.length >= PEER_ANNOUNCE_MAX_TOTAL_ADDRS) break;
			try {
				if (shouldDenyDial(Multiaddr(a), localCidrs)) {
					droppedNonRoutable++;
					continue;
				}
			} catch {
				// Unparseable multiaddr → drop (can't safely dial it anyway).
				droppedNonRoutable++;
				continue;
			}
			filtered.push(a);
		}
		if (filtered.length === 0) {
			if (droppedNonRoutable > 0) trace(`[NET] peer-announce from ${fromPeerID?.slice(0, 16) ?? 'unknown'}: dropped all ${droppedNonRoutable}/${rawCount} addrs as non-routable`);
			return;
		}
		trace(`[NET] peer-announce from ${fromPeerID?.slice(0, 16) ?? 'unknown'}: ${filtered.length}/${rawCount} addrs (dropped ${droppedNonRoutable} non-routable, network ${networkID.slice(0, 8)})`);
		// Pass networkID so per-peer outcomes from gossiped entries surface in the
		// UI under the network through which they arrived. Identity-mismatch
		// outcomes inside addBootstrapPeers also trigger purgeStalePeer.
		//
		// Deliberately NO peerStore.merge / keep-alive tagging here: an announce is
		// an unverified claim. Writing tags for every mentioned peerID would (a) let
		// any topic subscriber inject arbitrary peerIDs that we then persist and
		// re-dial forever, and (b) refresh peerStore maxPeerAge for long-dead peers
		// on every cycle, so they never expire. Keep-alive tagging happens only
		// after a dial actually succeeds (addBootstrapPeers, peer:connect, re-dial
		// maintenance) — a dead peer mentioned by gossip is still dialed below, it
		// just no longer leaves a permanent peerStore footprint when unreachable.
		await this.deps.addBootstrapPeers(filtered, networkID, 'discovered');
	}

	private async scheduleNext(): Promise<void> {
		if (this.stopped) return;
		const node = this.deps.getNode();
		const pubsub = this.deps.getPubsub();
		if (!node || !pubsub) return;
		// Pick base interval from current peerStore saturation.
		let base: number;
		try {
			const storeSize = (await node.peerStore.all()).length;
			if (storeSize < 20) base = PEER_ANNOUNCE_INTERVAL_ISOLATED_MS;
			else if (storeSize < 80) base = PEER_ANNOUNCE_INTERVAL_STEADY_MS;
			else base = PEER_ANNOUNCE_INTERVAL_SATURATED_MS;
		} catch {
			base = PEER_ANNOUNCE_INTERVAL_STEADY_MS;
		}
		if (this.stopped) return;
		const jitter = Math.floor((Math.random() * 2 - 1) * base * PEER_ANNOUNCE_JITTER_RATIO);
		const delay = Math.max(5_000, base + jitter);
		this.timer = setTimeout(async () => {
			// Guard: stop() may have been called while we were sleeping.
			if (this.stopped) return;
			try {
				await this.emit();
			} catch (err: any) {
				trace(`[NET] peer-announce emit error: ${err?.message ?? err}`);
			}
			// Guard again before scheduling the next tick.
			if (this.stopped) return;
			this.scheduleNext().catch(() => {
				/* schedule is async but errors handled inline */
			});
		}, delay);
	}

	private async emit(): Promise<void> {
		const node = this.deps.getNode();
		const pubsub = this.deps.getPubsub();
		if (!node || !pubsub) return;
		const allPeers = await node.peerStore.all();
		if (allPeers.length < PEER_ANNOUNCE_MIN_PEER_STORE) return;
		const lishTopics = pubsub.getTopics().filter((t: string) => t.startsWith(LISH_TOPIC_PREFIX));
		if (lishTopics.length === 0) return;
		const localCidrs = getLocalCidrs();
		const myID = node.peerId.toString();
		// Our own multiaddrs (shared across all topics — we are a member of every
		// topic we are subscribed to, so advertising self everywhere is correct).
		// Filter loopback (127.0.0.0/8) and non-local private addresses through
		// shouldDenyDial — a remote peer receiving our /ip4/127.0.0.1 would otherwise
		// TCP-loop to itself and hit identity-mismatch on every dial (validated on a
		// test node 2026-05-24: the moment debug logging landed it captured 3×
		// back-to-back loopback dials from peer-announce intake within 3s of startup).
		const selfAddrs: string[] = [];
		let skippedSelf = 0;
		for (const ma of node.getMultiaddrs()) {
			const s = ma.toString();
			if (s.includes('/p2p-circuit')) continue;
			if (shouldDenyDial(ma, localCidrs)) {
				skippedSelf++;
				continue;
			}
			selfAddrs.push(s);
			if (selfAddrs.length >= PEER_ANNOUNCE_MAX_ADDRS) break;
		}
		// Broadcast per topic. The transitive peerStore addrs are scoped to the
		// recently-seen subscribers of THAT topic so peers of one network are never
		// advertised into another. Membership is the union of this topic's
		// getSubscribers over the last PEER_ANNOUNCE_MEMBER_TTL_MS (same source as the
		// participant count badge), not just the live snapshot — a peer that just
		// dropped is still re-advertised so others can re-dial it, while a peer of
		// another network never enters this topic's set. Edge-of-mesh peers thus learn
		// the rest of their OWN network in one hop, without cross-network leak.
		const now = Date.now();
		for (const t of this.topicMembers.keys()) if (!lishTopics.includes(t)) this.topicMembers.delete(t);
		let skippedTransitive = 0;
		for (const topic of lishTopics) {
			const current = new Set<string>();
			try {
				for (const p of pubsub.getSubscribers(topic)) current.add(p.toString());
			} catch {}
			// Refresh recently-seen membership from the live snapshot, then prune stale.
			let members = this.topicMembers.get(topic);
			if (!members) {
				members = new Map<string, number>();
				this.topicMembers.set(topic, members);
			}
			for (const pid of current) members.set(pid, now);
			for (const [pid, seen] of members) if (now - seen > PEER_ANNOUNCE_MEMBER_TTL_MS) members.delete(pid);
			// No one currently subscribed → the broadcast would reach nobody, skip it.
			if (current.size === 0) continue;
			const collected = new Set<string>(selfAddrs);
			let transitiveAdded = 0;
			for (const peer of allPeers) {
				if (collected.size >= PEER_ANNOUNCE_MAX_TOTAL_ADDRS) break;
				const pid = peer.id.toString();
				if (pid === myID) continue;
				if (!members.has(pid)) continue;
				let perPeer = 0;
				for (const addr of peer.addresses) {
					if (perPeer >= PEER_ANNOUNCE_MAX_ADDRS_PER_PEER) break;
					if (collected.size >= PEER_ANNOUNCE_MAX_TOTAL_ADDRS) break;
					const base = addr.multiaddr.toString();
					if (base.includes('/p2p-circuit')) continue;
					if (shouldDenyDial(addr.multiaddr, localCidrs)) {
						skippedTransitive++;
						continue;
					}
					const full = base.includes('/p2p/') ? base : `${base}/p2p/${pid}`;
					if (!collected.has(full)) transitiveAdded++;
					collected.add(full);
					perPeer++;
				}
			}
			// Broadcast even if only self made it in — subscribers with unusable
			// (e.g. /p2p-circuit-only) addresses still need our self addrs to
			// reconnect to us. Only skip the edge where nothing routable exists.
			if (collected.size === 0) continue;
			const msg: PeerAnnounceMessage = { type: 'peer-announce', multiaddrs: Array.from(collected) };
			trace(`[NET] peer-announce emit topic=${topic.slice(0, 16)}: ${collected.size} addrs (self + ${transitiveAdded} scoped transitive)`);
			try {
				await this.deps.broadcast(topic, msg as unknown as Record<string, any>);
			} catch (err: any) {
				trace(`[NET] peer-announce publish failed topic=${topic}: ${err?.message ?? err}`);
			}
		}
		if (skippedSelf > 0 || skippedTransitive > 0) {
			trace(`[NET] peer-announce filter: skipped ${skippedSelf} self + ${skippedTransitive} transitive non-routable addrs`);
		}
	}
}
