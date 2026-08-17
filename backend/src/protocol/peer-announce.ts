import { trace } from '../logger.ts';
import { getLocalCidrs, shouldDenyDial } from './address-filter.ts';
import { multiaddr as Multiaddr } from '@multiformats/multiaddr';
import { canonicalMultiaddr, extractDestinationPeerID } from './multiaddr-utils.ts';
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
/**
 * Hard bound on RAW entries examined per announce, before anything is deduplicated.
 *
 * {@link PEER_ANNOUNCE_MAX_TOTAL_ADDRS} caps the UNIQUE addresses admitted, which bounds
 * what intake costs downstream but not what the walk itself costs: every raw entry is
 * parsed, canonicalised and routability-tested first, and a message can carry thousands
 * of duplicates or unparseable values that never reach the unique cap at all. Eight times
 * the unique cap leaves ample room for a legitimate announce (which is already trimmed to
 * the unique cap by its emitter) while putting a ceiling on the work one message can buy.
 */
const PEER_ANNOUNCE_MAX_RAW_ADDRS = PEER_ANNOUNCE_MAX_TOTAL_ADDRS * 8;
/**
 * Longest announced address we will even attempt to parse. Real multiaddrs are well under
 * this; anything longer is a parser workload, not an address.
 */
const PEER_ANNOUNCE_MAX_ADDR_LENGTH = 512;
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

/**
 * Per-source announce budget, in unique addresses admitted per minute.
 *
 * Every address that survives intake costs a dial, a status row and a snapshot, and
 * nothing about gossipsub stops one topic subscriber from announcing as fast as it
 * likes — so the cost of a single hostile (or merely broken) emitter is otherwise
 * unbounded. The budget is spent per announcing peer ID, so throttling one source
 * never starves the rest of the topic.
 *
 * Sizing: the worst LEGITIMATE emitter is a mid-convergence peer (peerStore 20..80,
 * {@link PEER_ANNOUNCE_INTERVAL_STEADY_MS} cadence) sending the full
 * {@link PEER_ANNOUNCE_MAX_TOTAL_ADDRS} list twice a minute — 256 addresses. The
 * sustained rate matches that exactly, and the bucket holds one and a half cycles'
 * worth so downward jitter, a topic re-join or a cold-start burst still pass intact.
 * A source that exceeds it is not a shape we emit.
 */
const PEER_ANNOUNCE_RATE_PER_MINUTE = PEER_ANNOUNCE_MAX_TOTAL_ADDRS * 2;
/** Bucket depth — burst allowance on top of {@link PEER_ANNOUNCE_RATE_PER_MINUTE}. */
const PEER_ANNOUNCE_RATE_BURST = PEER_ANNOUNCE_MAX_TOTAL_ADDRS * 3;
/**
 * Cap on tracked sources. Buckets are keyed by peer ID, which is unbounded input, so
 * the map is an LRU: the least recently heard-from source is evicted first. Eviction
 * hands that source a fresh budget if it ever returns, which is acceptable — refilling
 * the table costs an attacker a distinct peer ID per slot, and 1024 is far above any
 * real topic's subscriber count.
 */
const PEER_ANNOUNCE_RATE_MAX_SOURCES = 1024;
/** Bucket key for an announce that arrived without an attributable sender. */
const PEER_ANNOUNCE_UNKNOWN_SOURCE = '<unknown>';

/**
 * Token bucket keyed by announcing peer ID, bounding how many addresses one source
 * can push through peer-announce intake per unit of time.
 *
 * Partial grants are deliberate: a source over budget is trimmed rather than silenced,
 * so a legitimate peer that overshoots still makes discovery progress. `now` is a
 * parameter rather than a read of the clock so the refill curve is testable.
 */
export class AnnounceRateLimiter {
	private readonly buckets = new Map<string, { tokens: number; seenAt: number }>();
	private readonly burst: number;
	private readonly perMinute: number;
	private readonly maxSources: number;

	constructor(burst: number = PEER_ANNOUNCE_RATE_BURST, perMinute: number = PEER_ANNOUNCE_RATE_PER_MINUTE, maxSources: number = PEER_ANNOUNCE_RATE_MAX_SOURCES) {
		this.burst = burst;
		this.perMinute = perMinute;
		this.maxSources = maxSources;
	}

	/**
	 * Spend up to `wanted` tokens on behalf of `source` and return how many were
	 * granted (0..wanted). An unknown source starts with a full bucket.
	 */
	take(source: string, wanted: number, now: number = Date.now()): number {
		if (wanted <= 0) return 0;
		const existing = this.buckets.get(source);
		let tokens = this.burst;
		if (existing) {
			// Re-insert below so Map iteration order stays least-recently-used first.
			this.buckets.delete(source);
			tokens = Math.min(this.burst, existing.tokens + (Math.max(0, now - existing.seenAt) * this.perMinute) / 60_000);
		}
		const granted = Math.min(wanted, Math.floor(tokens));
		this.buckets.set(source, { tokens: tokens - granted, seenAt: now });
		while (this.buckets.size > this.maxSources) {
			const oldest = this.buckets.keys().next();
			if (oldest.done) break;
			this.buckets.delete(oldest.value);
		}
		return granted;
	}

	/** Forget every source's budget. Used when the owning manager is stopped. */
	clear(): void {
		this.buckets.clear();
	}
}

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
	 * Which start() a tick belongs to, bumped by both start() and stop().
	 *
	 * The `stopped` flag alone cannot tell a tick apart from its successor: a loop parked
	 * in `await peerStore.all()` across a stop() AND a start() found the flag false again
	 * and carried on, so two loops armed timers into one `timer` field and the next stop()
	 * cancelled only the last of them. A generation is not reusable, so the parked loop
	 * ends where it stands.
	 */
	private generation = 0;
	/**
	 * Per-topic recently-seen subscribers (peerID → last-seen ms). Lets a
	 * momentarily-disconnected same-network peer stay an eligible transitive-announce
	 * target (see PEER_ANNOUNCE_MEMBER_TTL_MS) without ever admitting a peer of
	 * another network — a peerID only enters a topic's map via that topic's own
	 * getSubscribers, so the cross-network leak stays closed. Pruned each emit().
	 */
	private readonly topicMembers = new Map<string, Map<string, number>>();
	/** Per-announcing-peer intake budget — see {@link AnnounceRateLimiter}. */
	private readonly rateLimiter = new AnnounceRateLimiter();

	constructor(deps: PeerAnnounceManagerDeps) {
		this.deps = deps;
	}

	/**
	 * Recently-seen subscribers of a topic (union of getSubscribers over the last
	 * {@link PEER_ANNOUNCE_MEMBER_TTL_MS}), so a same-network peer that is momentarily
	 * disconnected at query time is still reported. Used by leave-network to suppress
	 * offline content peers that a live subscriber snapshot would miss.
	 */
	getRecentMembers(topic: string): string[] {
		const members = this.topicMembers.get(topic);
		if (!members) return [];
		const now = Date.now();
		const out: string[] = [];
		for (const [pid, seen] of members) if (now - seen <= PEER_ANNOUNCE_MEMBER_TTL_MS) out.push(pid);
		return out;
	}

	/**
	 * Record a peer as a member of a topic outside the emit cycle. Fed by the
	 * gossipsub GRAFT event, which fires the moment a peer joins our mesh for the
	 * topic — earlier and independently of both the announce cadence and the
	 * {@link PEER_ANNOUNCE_MIN_PEER_STORE} broadcast threshold. leave-network reads
	 * this cache to decide who to hang up, so it must be populated on a two-node
	 * network that never emits an announce at all.
	 */
	noteMember(topic: string, peerID: string): void {
		let members = this.topicMembers.get(topic);
		if (!members) {
			members = new Map<string, number>();
			this.topicMembers.set(topic, members);
		}
		members.set(peerID, Date.now());
	}

	/**
	 * Refresh every topic's membership from the live subscriber snapshot and drop
	 * entries past the TTL. Split out of {@link emit} so membership tracking never
	 * depends on whether this tick actually broadcasts — a small network stays below
	 * the announce threshold forever, and leave-network still needs to know who was
	 * on the topic.
	 */
	refreshMembers(lishTopics: string[], pubsub: any): void {
		const now = Date.now();
		for (const t of this.topicMembers.keys()) if (!lishTopics.includes(t)) this.topicMembers.delete(t);
		for (const topic of lishTopics) {
			let members = this.topicMembers.get(topic);
			if (!members) {
				members = new Map<string, number>();
				this.topicMembers.set(topic, members);
			}
			try {
				for (const p of pubsub.getSubscribers(topic)) members.set(p.toString(), now);
			} catch {
				/* pubsub may be mid-teardown — keep whatever we already know */
			}
			for (const [pid, seen] of members) if (now - seen > PEER_ANNOUNCE_MEMBER_TTL_MS) members.delete(pid);
		}
	}

	/** Start the periodic emitter. Safe to call only once per start/stop cycle. */
	start(): void {
		this.stopped = false;
		const generation = ++this.generation;
		this.scheduleNext(generation).catch(() => {
			/* first-tick scheduling failure would leave emitter stopped — acceptable fallback */
		});
	}

	/**
	 * Stop the emitter and drop everything the previous run learned. Idempotent; any
	 * in-flight tick will not reschedule.
	 *
	 * Both maps are per-run state. Membership is read by leave-network to decide who to
	 * hang up, and it is recorded against the libp2p node that was running when the peer
	 * was seen — carrying it into the next start() means a leave acting on the previous
	 * node's mesh. The rate-limiter buckets are the same kind of thing from the other
	 * side: an exhausted budget surviving a restart throttles a source that has not sent
	 * anything to THIS run yet.
	 */
	stop(): void {
		this.stopped = true;
		this.generation++;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.topicMembers.clear();
		this.rateLimiter.clear();
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
		// Third stage: collapse addresses that mean the same thing. The cap counts
		// UNIQUE addresses, so a message repeating one address 128 times no longer
		// consumes the whole budget — and, more to the point, no longer turns into
		// 128 markPending + dial + recordOutcome rounds downstream, since every stage
		// after this one keys off the address string. Canonicalisation (not raw string
		// equality) is what makes two spellings of one address — DNS case, expanded vs
		// compressed IPv6 — count once.
		const unique = new Map<string, string>();
		let droppedNonRoutable = 0;
		let droppedDuplicate = 0;
		let droppedAnonymous = 0;
		let examined = 0;
		for (const a of data.multiaddrs) {
			// Counted over RAW entries, so duplicates and junk are spent from the same
			// budget as anything else — the unique cap alone bounds only what survives.
			if (++examined > PEER_ANNOUNCE_MAX_RAW_ADDRS) break;
			if (typeof a !== 'string' || a.length === 0 || a.length > PEER_ANNOUNCE_MAX_ADDR_LENGTH) continue;
			if (unique.size >= PEER_ANNOUNCE_MAX_TOTAL_ADDRS) break;
			try {
				const ma = Multiaddr(a);
				if (shouldDenyDial(ma, localCidrs)) {
					droppedNonRoutable++;
					continue;
				}
				// An address with no trailing /p2p/<peerID> names no identity, and every
				// per-peer control downstream is keyed by one: backoff, quarantine,
				// leave-network suppression and purge-by-peer-ID all silently do nothing
				// for it, while a single successful dial is enough to park it on the
				// recovery list that nothing can then take it off. Our own emitter always
				// appends the identity, so requiring it costs nothing legitimate.
				if (extractDestinationPeerID(ma) === null) {
					droppedAnonymous++;
					continue;
				}
			} catch {
				// Unparseable multiaddr → drop (can't safely dial it anyway).
				droppedNonRoutable++;
				continue;
			}
			const canonical = canonicalMultiaddr(a);
			if (unique.has(canonical)) {
				droppedDuplicate++;
				continue;
			}
			// Keep the spelling as announced: downstream keys status rows by this exact
			// string, and rewriting it here would split one peer's row in two.
			unique.set(canonical, a);
		}
		if (unique.size === 0) {
			if (droppedNonRoutable > 0 || droppedDuplicate > 0 || droppedAnonymous > 0) trace(`[NET] peer-announce from ${fromPeerID?.slice(0, 16) ?? 'unknown'}: dropped all ${rawCount} addrs (${droppedNonRoutable} non-routable, ${droppedDuplicate} duplicate, ${droppedAnonymous} without /p2p)`);
			return;
		}
		// Rate-limit AFTER dedup: a duplicate flood must not be able to drain the
		// sender's budget and starve the addresses it announced legitimately.
		const source = fromPeerID ?? PEER_ANNOUNCE_UNKNOWN_SOURCE;
		const admitted = this.rateLimiter.take(source, unique.size);
		if (admitted === 0) {
			trace(`[NET] peer-announce from ${source.slice(0, 16)}: rate limited, dropped all ${unique.size} addrs`);
			return;
		}
		const filtered = admitted < unique.size ? [...unique.values()].slice(0, admitted) : [...unique.values()];
		if (admitted < unique.size) trace(`[NET] peer-announce from ${source.slice(0, 16)}: rate limited to ${admitted}/${unique.size} addrs`);
		trace(`[NET] peer-announce from ${source.slice(0, 16)}: ${filtered.length}/${rawCount} addrs (dropped ${droppedNonRoutable} non-routable, ${droppedDuplicate} duplicate, ${droppedAnonymous} without /p2p, network ${networkID.slice(0, 8)})`);
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

	/** Arm the next announce tick for `generation`; see {@link generation}. */
	private async scheduleNext(generation: number): Promise<void> {
		if (this.isSuperseded(generation)) return;
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
		// Checked before the timer is armed, not only before the work: a superseded loop
		// that still armed one would leave two timers behind a single `timer` field.
		if (this.isSuperseded(generation)) return;
		const jitter = Math.floor((Math.random() * 2 - 1) * base * PEER_ANNOUNCE_JITTER_RATIO);
		const delay = Math.max(5_000, base + jitter);
		this.timer = setTimeout(async () => {
			// Guard: stop() may have been called while we were sleeping.
			if (this.isSuperseded(generation)) return;
			try {
				await this.emit(generation);
			} catch (err: any) {
				trace(`[NET] peer-announce emit error: ${err?.message ?? err}`);
			}
			// Guard again before scheduling the next tick.
			if (this.isSuperseded(generation)) return;
			this.scheduleNext(generation).catch(() => {
				/* schedule is async but errors handled inline */
			});
		}, delay);
	}

	/** True once this tick's start() has been superseded by a stop() or a newer start(). */
	private isSuperseded(generation: number): boolean {
		return this.stopped || generation !== this.generation;
	}

	private async emit(generation: number = this.generation): Promise<void> {
		const node = this.deps.getNode();
		const pubsub = this.deps.getPubsub();
		if (!node || !pubsub) return;
		const lishTopics = pubsub.getTopics().filter((t: string) => t.startsWith(LISH_TOPIC_PREFIX));
		// Membership first, and unconditionally: it feeds leave-network's disconnect
		// set, which must work on a network too small to ever clear the announce
		// threshold below. Broadcasting is what the threshold gates, not tracking.
		this.refreshMembers(lishTopics, pubsub);
		const allPeers = await node.peerStore.all();
		// The node and pubsub captured above belong to the run this tick started in; a
		// restart landing in that await would otherwise have us publish the previous run's
		// addresses onto the new node's topics.
		if (this.isSuperseded(generation)) return;
		if (allPeers.length < PEER_ANNOUNCE_MIN_PEER_STORE) return;
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
		let skippedTransitive = 0;
		for (const topic of lishTopics) {
			const current = new Set<string>();
			try {
				for (const p of pubsub.getSubscribers(topic)) current.add(p.toString());
			} catch {}
			// Membership was already refreshed above; read the resulting set.
			const members = this.topicMembers.get(topic) ?? new Map<string, number>();
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
