import { randomUUID } from 'crypto';
import { type Networks } from '../lishnet/lishnets.ts';
import { type Settings } from '../settings.ts';
import { lishTopic } from '../protocol/constants.ts';
import { trace } from '../logger.ts';
import { LISH_PROTOCOL, LISHClient, registerSearchResultHandler, unregisterSearchResultHandler, type SearchResultAnnouncement } from '../protocol/lish-protocol.ts';
import { ErrorCodes, type LishSearchResult } from '@shared';

/**
 * Concurrency cap for the unicast `getLishs` fallback. Each fan-out opens a
 * fresh LISH protocol stream per peer; on large fleets a uncapped loop would
 * burst dozens of dials at once. 10 is a balance between LAN search latency
 * (sub-second for typical 5-30 peer fleets) and load on the libp2p dialer.
 */
export const UNICAST_FALLBACK_PARALLEL = 10;
/**
 * How long to wait before re-asking a peer that refused the listing for want of a
 * membership it cannot see yet, and how many times. Both sides converge in well under a
 * second on a healthy mesh; three tries spread over that cover a slow one without ever
 * outliving the default 30 s search.
 */
export const LISTING_REFUSAL_RETRY_MS = 1_500;
/** Spread added to each retry delay so peers refused in the same moment do not retry in lockstep. */
export const LISTING_REFUSAL_RETRY_JITTER_MS = 500;
export const MAX_LISTING_REFUSAL_RETRIES = 3;
/**
 * Already-queried peer set lives on the session so the initial snapshot
 * dispatch and the live `peer:connect` listener can deduplicate against
 * each other without re-asking the same peer twice. handleResult's own
 * dedup catches the response side; this avoids the wasted dial.
 */
type Queried = Set<string>;

type BroadcastFn = (event: string, data: any) => void;

interface SearchSession {
	searchID: string;
	query: string;
	startedAt: number;
	timeout: ReturnType<typeof setTimeout>;
	/** Aggregated results, keyed by LISH id. New responders for the same LISH push into `peers`. */
	results: Map<string, LishSearchResult>;
	/** Peers we have already dispatched a unicast getLishs to. */
	queried: Queried;
	/** Disposer for the `peer:connect` listener, called on timeout/cancel. */
	disposePeerConnect: () => void;
	/** Disposer for the topic-subscribe listener, called on timeout/cancel. */
	disposePeerSubscribe: () => void;
	/** Retry bookkeeping for peers that refused us; see {@link RefusalState}. */
	refusals: Map<string, RefusalState>;
}

/**
 * What a peer that refused the listing is owed, as ONE record per peer.
 *
 * Both the timer and the subscribe event want to re-ask the same peer, and counting only
 * the refusals that came back let several of them pass the budget check before the first
 * answer landed. So the budget is spent when a query is DISPATCHED, and the record also
 * holds whether one is already in flight and which timer is pending — an immediate re-ask
 * cancels that timer rather than racing it.
 */
interface RefusalState {
	/** Queries dispatched to this peer because of a refusal, counted at dispatch. */
	attempts: number;
	/** A query is on the wire right now — nothing may start a second one. */
	inFlight: boolean;
	/** The pending timed re-ask, cancelled when anything else asks first. */
	timer: ReturnType<typeof setTimeout> | null;
}

export interface SearchManager {
	startSearch: (p: { query: string }) => Promise<{ searchID: string }>;
	cancelSearch: (p: { searchID: string }) => { ok: true };
	stopAll: () => void;
}

/**
 * Network-wide LISH search.
 *
 * Flow:
 * 1. Frontend calls `searchLishs({ query })` → backend creates a session, broadcasts a pubsub
 *    `searchLishs` query on every joined network topic.
 * 2. Each receiving peer (see Network.handleSearchLishs) filters its locally shared LISHs and
 *    replies with a unicast `searchResult` over the LISH protocol stream.
 * 3. We register a per-searchID handler (registerSearchResultHandler) that aggregates results
 *    by LISH id and incrementally broadcasts `search:lishs:update` over WebSocket.
 * 4. On timeout (`network.searchTimeout`) or explicit cancel, we unregister the handler and emit
 *    `search:lishs:complete`.
 */
export function initSearchManager(networks: Networks, settings: Settings, broadcast: BroadcastFn): SearchManager {
	const sessions = new Map<string, SearchSession>();
	/**
	 * One dial budget for every unicast getLishs, opening fan-out and retry alike.
	 *
	 * {@link UNICAST_FALLBACK_PARALLEL} exists to keep the libp2p dialer from being hit with
	 * dozens of streams at once, and a retry is the same kind of dial — so it cannot have a
	 * budget of its own beside the fan-out's, or the real ceiling is the sum of the two.
	 * Retries are also the case most likely to arrive together: a node that has just joined
	 * is refused by EVERY peer, so their re-asks come due in the same tick and would dial the
	 * whole fleet at once, precisely when connections are still settling.
	 */
	let dialsInFlight = 0;
	const dialWaiters: Array<() => void> = [];

	async function acquireDial(): Promise<void> {
		if (dialsInFlight >= UNICAST_FALLBACK_PARALLEL) await new Promise<void>(resolve => dialWaiters.push(resolve));
		dialsInFlight++;
	}

	function releaseDial(): void {
		dialsInFlight--;
		dialWaiters.shift()?.();
	}

	function endSession(searchID: string, reason: 'timeout' | 'cancel'): void {
		const session = sessions.get(searchID);
		if (!session) return;
		clearTimeout(session.timeout);
		// No armed re-ask may outlive the session it belongs to.
		for (const state of session.refusals.values()) if (state.timer) clearTimeout(state.timer);
		session.refusals.clear();
		session.disposePeerConnect();
		session.disposePeerSubscribe();
		unregisterSearchResultHandler(searchID);
		sessions.delete(searchID);
		broadcast('search:lishs:complete', { searchID, reason });
	}

	function handleResult(ann: SearchResultAnnouncement): void {
		trace(`[Search] result in: searchID=${ann.searchID.slice(0, 8)} from=${ann.peerID.slice(0, 12)} lishs=${ann.lishs.length} sessionExists=${sessions.has(ann.searchID)}`);
		const session = sessions.get(ann.searchID);
		if (!session) return;
		// This peer has served us, so a re-ask armed by an earlier refusal is moot however the
		// answer reached us — the pubsub path lands here too, not only the unicast one.
		clearRefusal(session, ann.peerID);
		// Map peerID → networkID is non-trivial without checking pubsub subscribers across topics;
		// for the UI we only need the peerID + a representative networkID. Pick the first joined network
		// the peer is a member of (so the FE can later open PeerDetail with that networkID).
		const networkID = findNetworkForPeer(ann.peerID);
		const updates: LishSearchResult[] = [];
		for (const lish of ann.lishs) {
			if (typeof lish.id !== 'string' || lish.id.length === 0) continue;
			let row = session.results.get(lish.id);
			if (!row) {
				row = {
					id: lish.id,
					...(lish.name !== undefined ? { name: lish.name } : {}),
					...(lish.totalSize !== undefined ? { totalSize: lish.totalSize } : {}),
					peers: [],
				};
				session.results.set(lish.id, row);
			}
			// Avoid duplicate peer entries for the same LISH (same peer responding twice via mesh paths).
			if (!row.peers.some(p => p.peerID === ann.peerID)) {
				row.peers.push({ peerID: ann.peerID, networkID });
			}
			updates.push(row);
		}
		if (updates.length > 0) broadcast('search:lishs:update', { searchID: ann.searchID, lishs: updates });
	}

	/**
	 * Best-effort lookup: find any joined network this peer is currently subscribed to.
	 * Used so the FE can later dial the peer through that network. Empty string if not found
	 * (peer is reachable on a different network or already disconnected — FE shows it but dial may fail).
	 */
	function findNetworkForPeer(peerID: string): string {
		const network = networks.getNetwork();
		if (!network.isRunning()) return '';
		for (const config of networks.list()) {
			if (!config.enabled || !networks.isJoined(config.networkID)) continue;
			if (network.getTopicPeers(config.networkID).includes(peerID)) return config.networkID;
		}
		return '';
	}

	async function startSearch(p: { query: string }): Promise<{ searchID: string }> {
		const query = (p.query ?? '').trim();
		if (query.length === 0) throw new Error('search query is empty');
		const searchID = randomUUID();
		const timeoutMs = settings.get('network.searchTimeout') ?? 30_000;
		const network = networks.getRunningNetwork();
		const selfPeerID = network.getNodeInfo()?.peerID ?? '';
		const queried: Queried = new Set();
		const refusals = new Map<string, RefusalState>();
		// Live listener: every peer that completes a libp2p connection while
		// this search is in flight gets a unicast `getLishs(query)`. Catches
		// the case where a peer appears via mDNS / peer-announce / hole-punch
		// AFTER the user clicked Search but BEFORE the timeout fires, so the
		// result shows up without the user having to retry.
		const disposePeerConnect = network.onPeerConnect(peerID => {
			if (!sessions.has(searchID)) return;
			if (!peerID || peerID === selfPeerID) return;
			if (queried.has(peerID)) return;
			queried.add(peerID);
			void queryOnePeer(searchID, query, peerID).catch(() => {
				/* logged inside queryOnePeer */
			});
		});
		// Seeing a peer's SUBSCRIBE only says WE now know it is a member; the refusal we are
		// recovering from is the other direction — it has not processed OUR subscription yet.
		// So this event cannot decide the retry, it can only make one we already owe happen
		// sooner than its timer would: a peer that refused us is worth re-asking as soon as
		// anything about the membership picture changes.
		const disposePeerSubscribe = network.onPeerSubscribe(peerID => {
			const session = sessions.get(searchID);
			if (!session) return;
			if (!peerID || peerID === selfPeerID) return;
			// Only a peer that owes us a retry, and only through the one dispatcher that
			// enforces the budget — a peer flapping its subscription must not buy a dial per
			// flap, and must not overtake a query it already has on the wire.
			if (!session.refusals.has(peerID)) return;
			dispatchRefusalRetry(session, peerID);
		});
		const session: SearchSession = {
			searchID,
			query,
			startedAt: Date.now(),
			results: new Map(),
			timeout: setTimeout(() => endSession(searchID, 'timeout'), timeoutMs),
			queried,
			disposePeerConnect,
			disposePeerSubscribe,
			refusals,
		};
		sessions.set(searchID, session);
		registerSearchResultHandler(searchID, handleResult);
		// Broadcast the query on every joined network topic. If broadcast fails on a particular
		// topic, log and continue — the search is still useful on other networks.
		const message = { type: 'searchLishs', searchID, query };
		for (const config of networks.list()) {
			if (!config.enabled || !networks.isJoined(config.networkID)) continue;
			try {
				await network.broadcast(lishTopic(config.networkID), message);
			} catch (err: any) {
				console.warn(`[Search] broadcast on ${config.networkID.slice(0, 8)} failed: ${err?.message ?? err}`);
			}
		}
		// Kick off the unicast fallback in parallel with the pubsub broadcast.
		// The fallback covers two windows the pubsub path leaves open:
		//  1. Peer subscribed but skipped by floodPublish (NaN score, dead
		//     RPC stream, sparse mesh) — `getPeers()` returns them too.
		//  2. Peer connected at the libp2p layer but the gossipsub SUBSCRIBE
		//     RPC has not yet propagated. floodPublish only iterates
		//     `pubsub.getSubscribers(topic)` so these peers silently miss the
		//     query; the unicast dial reaches them the moment the connection
		//     is up, independent of gossipsub state.
		runUnicastFallback(session).catch(err => trace(`[Search] unicast fallback ${searchID.slice(0, 8)} failed: ${err?.message ?? err}`));
		return { searchID };
	}

	/**
	 * Initial unicast fan-out at search start. Queries the union of every
	 * libp2p-connected peer (across all networks; we don't try to map peers
	 * to lishnets here — the server-side `isUploadAdvertisable` guard plus
	 * the optional query filter handle that on the responder). Live peers
	 * that connect AFTER this snapshot are picked up by the
	 * `peer:connect` listener installed in `startSearch`.
	 */
	async function runUnicastFallback(session: SearchSession): Promise<void> {
		const { searchID, query, queried } = session;
		const network = networks.getRunningNetwork();
		const selfPeerID = network.getNodeInfo()?.peerID ?? '';
		// `getPeers()` is the libp2p-connection peer set, NOT the gossipsub
		// subscriber set. Includes peers freshly dialed via mDNS for whom
		// gossipsub SUBSCRIBE has not yet completed — exactly the case the
		// fallback exists to fix.
		const peerList = network.getPeers().filter(p => p && p !== selfPeerID && !queried.has(p));
		for (const p of peerList) queried.add(p);
		if (peerList.length === 0) {
			trace(`[Search] unicast fallback ${searchID.slice(0, 8)}: no connected peers in snapshot`);
			return;
		}
		trace(`[Search] unicast fallback ${searchID.slice(0, 8)}: snapshot dispatching to ${peerList.length} peer(s)`);
		let cursor = 0;
		// The dial permit inside queryOnePeer is what now enforces the ceiling — the retry path
		// shares it, so this pool alone could not. It stays because it also bounds how many
		// pending queries exist at once: without it a large fleet would build one promise per
		// peer up front, all of them queued on the same permit.
		const workerCount = Math.min(UNICAST_FALLBACK_PARALLEL, peerList.length);
		const workers = Array.from({ length: workerCount }, async () => {
			for (;;) {
				// Bail immediately if the session has been cancelled or timed
				// out — no point opening a stream for results we will discard.
				if (!sessions.has(searchID)) return;
				const idx = cursor++;
				if (idx >= peerList.length) return;
				await queryOnePeer(searchID, query, peerList[idx]!);
			}
		});
		await Promise.allSettled(workers);
	}

	/** Forget a peer's retry state and cancel whatever it still had pending. */
	function clearRefusal(session: SearchSession, peerID: string): void {
		const state = session.refusals.get(peerID);
		if (!state) return;
		if (state.timer) clearTimeout(state.timer);
		session.refusals.delete(peerID);
	}

	/**
	 * Arm the delayed re-ask of a peer that just refused us.
	 *
	 * The refusal means the peer has not yet processed our own subscription — a state the
	 * two sides converge out of on their own, but on no schedule we control or can observe.
	 * Waiting for an event is what made this order-dependent, so the retry is timed, and a
	 * subscribe event can only bring the same retry forward (see
	 * {@link dispatchRefusalRetry}).
	 */
	function scheduleRefusalRetry(session: SearchSession, peerID: string): void {
		const state = session.refusals.get(peerID);
		if (!state || state.timer) return;
		if (state.attempts >= MAX_LISTING_REFUSAL_RETRIES) {
			trace(`[Search] ${session.searchID.slice(0, 8)}: ${peerID.slice(0, 12)} still refuses the listing, giving up`);
			session.refusals.delete(peerID);
			return;
		}
		// Jittered, because the peers that refuse us usually refuse us together — a fixed
		// delay would line their retries up into one burst on every tick.
		const delay = LISTING_REFUSAL_RETRY_MS + Math.floor(Math.random() * LISTING_REFUSAL_RETRY_JITTER_MS);
		state.timer = setTimeout(() => {
			state.timer = null;
			dispatchRefusalRetry(session, peerID);
		}, delay);
	}

	/**
	 * The single door every refusal-driven re-ask goes through, so the budget is real.
	 *
	 * Spends an attempt when the query is DISPATCHED, not when its refusal comes back:
	 * counting the answers let any number of events pass the check while the first query
	 * was still on the wire. `inFlight` closes the same hole for concurrent events, and
	 * arming here cancels a pending timer so an immediate re-ask replaces it instead of
	 * both firing.
	 */
	function dispatchRefusalRetry(session: SearchSession, peerID: string): void {
		if (!sessions.has(session.searchID)) return;
		const state = session.refusals.get(peerID);
		if (!state || state.inFlight) return;
		if (state.attempts >= MAX_LISTING_REFUSAL_RETRIES) {
			trace(`[Search] ${session.searchID.slice(0, 8)}: ${peerID.slice(0, 12)} still refuses the listing, giving up`);
			clearRefusal(session, peerID);
			return;
		}
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = null;
		}
		state.attempts++;
		state.inFlight = true;
		// queryOnePeer waits for a dial permit, so a fleet-wide burst of re-asks queues up
		// behind the same cap the opening fan-out obeys instead of going out at once.
		void queryOnePeer(session.searchID, session.query, peerID).catch(() => {
			/* logged inside queryOnePeer */
		});
	}

	async function queryOnePeer(searchID: string, query: string, peerID: string): Promise<void> {
		if (!sessions.has(searchID)) return;
		// Every caller funnels through here, so holding the dial permit around the whole
		// exchange is what makes UNICAST_FALLBACK_PARALLEL a real ceiling rather than one the
		// retry path can step around.
		await acquireDial();
		try {
			await queryOnePeerAdmitted(searchID, query, peerID);
		} finally {
			releaseDial();
		}
	}

	async function queryOnePeerAdmitted(searchID: string, query: string, peerID: string): Promise<void> {
		// Re-read after the wait: the session may have ended while we queued for a permit.
		const session = sessions.get(searchID);
		if (!session) return;
		const network = networks.getRunningNetwork();
		let client: LISHClient | undefined;
		try {
			const { stream } = await network.dialProtocolByPeerId(peerID, LISH_PROTOCOL);
			client = new LISHClient(stream);
			const lishs = await client.requestList(query);
			if (!sessions.has(searchID)) return;
			// Defense-in-depth: peers running an older version silently ignore
			// the `query` field in our getLishs request and respond with their
			// FULL advertised list. Without a client-side filter that would
			// produce false-positive matches in the UI. Apply the same
			// case-insensitive substring rule used by the server-side filter
			// (network.ts:handleSearchLishs) so old peers behave identically
			// to upgraded ones from the caller's perspective.
			const q = query.toLowerCase();
			const matches = lishs.filter(l => {
				if (typeof l.id !== 'string') return false;
				if (l.id.toLowerCase().includes(q)) return true;
				return (l.name?.toLowerCase() ?? '').includes(q);
			});
			// An empty list is now a final answer — a peer that cannot serve us says so with
			// PEER_LISTING_NOT_AUTHORIZED instead, handled below.
			if (matches.length > 0) {
				// Re-use the same aggregation/dedup path as the pubsub-driven
				// responses, so a peer reachable through both channels never
				// produces a duplicate row in the FE result list.
				handleResult({ searchID, peerID, lishs: matches });
			}
			// The peer answered, so nothing is owed — including a timer armed by an earlier
			// refusal, which would otherwise fire after the question was already settled.
			clearRefusal(session, peerID);
		} catch (err: any) {
			if (err?.code === ErrorCodes.PEER_LISTING_NOT_AUTHORIZED) {
				if (!session.refusals.has(peerID)) session.refusals.set(peerID, { attempts: 0, inFlight: false, timer: null });
				scheduleRefusalRetry(session, peerID);
				return;
			}
			trace(`[Search] unicast getLishs to ${peerID.slice(0, 12)} failed: ${err?.message ?? err}`);
			// A peer already in the retry cycle that now fails to answer at all is in the same
			// unsettled state the cycle exists for, so keep it going on its remaining budget.
			// Dropping it here left the peer holding spent state that nothing would ever arm.
			if (session.refusals.has(peerID)) scheduleRefusalRetry(session, peerID);
		} finally {
			const state = session.refusals.get(peerID);
			if (state) state.inFlight = false;
			await client?.close().catch(() => {});
		}
	}

	function cancelSearch(p: { searchID: string }): { ok: true } {
		endSession(p.searchID, 'cancel');
		return { ok: true };
	}

	function stopAll(): void {
		for (const id of [...sessions.keys()]) endSession(id, 'cancel');
	}

	return { startSearch, cancelSearch, stopAll };
}
