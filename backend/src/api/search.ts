import { randomUUID } from 'crypto';
import { type Networks } from '../lishnet/lishnets.ts';
import { type Settings } from '../settings.ts';
import { lishTopic } from '../protocol/constants.ts';
import { registerSearchResultHandler, unregisterSearchResultHandler, type SearchResultAnnouncement } from '../protocol/lish-protocol.ts';
import type { LishSearchResult } from '@shared';

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
		return { searchID };
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
