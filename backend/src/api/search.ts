import { randomUUID } from 'crypto';
import { type Networks } from '../lishnet/lishnets.ts';
import { type Settings } from '../settings.ts';
import { lishTopic } from '../protocol/constants.ts';
import { trace } from '../logger.ts';
import { LISH_PROTOCOL, LISHClient, registerSearchResultHandler, unregisterSearchResultHandler, type SearchResultAnnouncement } from '../protocol/lish-protocol.ts';
import type { LishSearchResult } from '@shared';

/**
 * Concurrency cap for the unicast `getLishs` fallback. Each fan-out opens a
 * fresh LISH protocol stream per peer; on large fleets a uncapped loop would
 * burst dozens of dials at once. 10 is a balance between LAN search latency
 * (sub-second for typical 5-30 peer fleets) and load on the libp2p dialer.
 */
const UNICAST_FALLBACK_PARALLEL = 10;

type BroadcastFn = (event: string, data: any) => void;

interface SearchSession {
	searchID: string;
	query: string;
	startedAt: number;
	timeout: ReturnType<typeof setTimeout>;
	/** Aggregated results, keyed by LISH id. New responders for the same LISH push into `peers`. */
	results: Map<string, LishSearchResult>;
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

	function endSession(searchID: string, reason: 'timeout' | 'cancel'): void {
		const session = sessions.get(searchID);
		if (!session) return;
		clearTimeout(session.timeout);
		unregisterSearchResultHandler(searchID);
		sessions.delete(searchID);
		broadcast('search:lishs:complete', { searchID, reason });
	}

	function handleResult(ann: SearchResultAnnouncement): void {
		trace(`[Search] result in: searchID=${ann.searchID.slice(0, 8)} from=${ann.peerID.slice(0, 12)} lishs=${ann.lishs.length} sessionExists=${sessions.has(ann.searchID)}`);
		const session = sessions.get(ann.searchID);
		if (!session) return;
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
		const session: SearchSession = {
			searchID,
			query,
			startedAt: Date.now(),
			results: new Map(),
			timeout: setTimeout(() => endSession(searchID, 'timeout'), timeoutMs),
		};
		sessions.set(searchID, session);
		registerSearchResultHandler(searchID, handleResult);
		// Broadcast the query on every joined network topic. If broadcast fails on a particular
		// topic, log and continue — the search is still useful on other networks.
		const network = networks.getRunningNetwork();
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
		// floodPublish only reaches peers already in pubsub.getSubscribers(topic)
		// AND scored above publishThreshold — a freshly-discovered peer (mDNS /
		// peer-announce / bootstrap dial) typically has a 100-500 ms window
		// after dial completes before its SUBSCRIBE RPC propagates back to us,
		// during which floodPublish silently skips them. Dialing them directly
		// via the LISH protocol bypasses gossipsub state entirely, so the
		// search works the instant the libp2p connection is up. Fire-and-forget:
		// rejections are logged but never bubble up into the FE response.
		runUnicastFallback(searchID, query).catch(err => trace(`[Search] unicast fallback ${searchID.slice(0, 8)} failed: ${err?.message ?? err}`));
		return { searchID };
	}

	/**
	 * Per-search unicast fan-out. Collects the union of topic-subscribed
	 * peers across every joined network, removes our own peerID, and sends a
	 * `getLishs(query)` request on a freshly-opened LISH protocol stream to
	 * each. Successful responses are routed through {@link handleResult},
	 * which dedupes peer-id collisions against any reply we may already have
	 * received via the pubsub `searchResult` path. Bounded concurrency via a
	 * cursor-based worker pool — see {@link UNICAST_FALLBACK_PARALLEL}.
	 */
	async function runUnicastFallback(searchID: string, query: string): Promise<void> {
		const network = networks.getRunningNetwork();
		const selfPeerID = network.getNodeInfo()?.peerID;
		const peers = new Set<string>();
		for (const config of networks.list()) {
			if (!config.enabled || !networks.isJoined(config.networkID)) continue;
			for (const p of network.getTopicPeers(config.networkID)) {
				if (p && p !== selfPeerID) peers.add(p);
			}
		}
		if (peers.size === 0) {
			trace(`[Search] unicast fallback ${searchID.slice(0, 8)}: no connected topic peers, skipping`);
			return;
		}
		const peerList = [...peers];
		trace(`[Search] unicast fallback ${searchID.slice(0, 8)}: dispatching to ${peerList.length} peer(s)`);
		let cursor = 0;
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

	async function queryOnePeer(searchID: string, query: string, peerID: string): Promise<void> {
		if (!sessions.has(searchID)) return;
		const network = networks.getRunningNetwork();
		let client: LISHClient | undefined;
		try {
			const { stream } = await network.dialProtocolByPeerId(peerID, LISH_PROTOCOL);
			client = new LISHClient(stream);
			const lishs = await client.requestList(query);
			if (sessions.has(searchID) && lishs.length > 0) {
				// Re-use the same aggregation/dedup path as the pubsub-driven
				// responses, so a peer reachable through both channels never
				// produces a duplicate row in the FE result list.
				handleResult({ searchID, peerID, lishs });
			}
		} catch (err: any) {
			trace(`[Search] unicast getLishs to ${peerID.slice(0, 12)} failed: ${err?.message ?? err}`);
		} finally {
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
