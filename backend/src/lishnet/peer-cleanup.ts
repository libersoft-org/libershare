import type { PeerId } from '@libp2p/interface';
import type { Database } from 'bun:sqlite';
import type { LISHNetworkConfig } from '@shared';
import { peerIdFromString } from '@libp2p/peer-id';
import type { Network } from '../protocol/network.ts';
import { LISH_TOPIC_PREFIX } from '../protocol/constants.ts';
import { relayPeerIDs } from '../protocol/relay-peer-ids.ts';
import { confirmPeerCleanup, listPeerCleanup, recordPeerClaim, recordPeerCleanup } from '../db/peer-cleanup.ts';

export function configuredPeerIDs(addresses: readonly string[]): string[] {
	return addresses.flatMap(address => [...address.matchAll(/\/p2p\/([^/]+)/g)].map(match => match[1]!));
}

function connections(network: Network): Array<{ remotePeer: { toString(): string }; remoteAddr: { toString(): string } }> {
	return network.getNode?.()?.getConnections() ?? [];
}

function withRelays(network: Network, peers: Iterable<string>): Set<string> {
	const ids = new Set(peers);
	for (const connection of connections(network)) {
		if (ids.has(connection.remotePeer.toString())) for (const relay of relayPeerIDs(connection.remoteAddr.toString())) ids.add(relay);
	}
	return ids;
}

/** Observe new ownership before an interrupted leave can lose it across a restart. */
export function observePeerCleanupClaims(db: Database, network: Network, enabled: () => LISHNetworkConfig[]): () => void {
	const pending = new Map<string, Set<string>>();
	const flush = (): void => {
		for (const [networkID, peers] of pending) {
			recordPeerClaim(db, networkID, peers);
			// An enclosing catalog transaction can still roll back this write.
			if (!db.inTransaction) pending.delete(networkID);
		}
	};
	const claim = (networkID: string, peers: Iterable<string>): void => {
		const queued = new Set(listPeerCleanup(db).map(row => row.peerID));
		const claims = pending.get(networkID) ?? new Set<string>();
		for (const peer of peers) if (queued.has(peer)) claims.add(peer);
		if (claims.size > 0) pending.set(networkID, claims);
		flush();
	};
	network.beforePeerCleanup = flush;
	network.onPeerMembership = (peerID, topic) => {
		if (!topic.startsWith(LISH_TOPIC_PREFIX)) return;
		const networkID = topic.slice(LISH_TOPIC_PREFIX.length);
		if (!enabled().some(row => row.networkID === networkID)) return;
		claim(networkID, withRelays(network, [peerID]));
	};
	network.onRelayConnection = (peerID, relays) => {
		const rows = listPeerCleanup(db);
		const failures: unknown[] = [];
		for (const config of enabled()) {
			if (rows.some(row => row.networkID === config.networkID && row.peerID === peerID) || network.getTopicPeers(config.networkID).includes(peerID) || network.getRecentTopicMembers(config.networkID).includes(peerID) || configuredPeerIDs(config.bootstrapPeers).includes(peerID)) {
				try {
					claim(config.networkID, relays);
				} catch (error) {
					failures.push(error);
				}
			}
		}
		if (failures.length > 0) throw new AggregateError(failures, 'Could not save relay cleanup claims');
	};
	return flush;
}

/** Candidates and all current owners are written in the catalog transaction. */
export function recordLeavingPeerCleanup(db: Database, network: Network, leaving: readonly string[], remaining: ReadonlySet<string>, operationID: string, bootstraps: (id: string) => string[]): void {
	const recorded = listPeerCleanup(db);
	const peers = (id: string): Set<string> => withRelays(network, [...network.getTopicPeers(id), ...network.getRecentTopicMembers(id), ...configuredPeerIDs(bootstraps(id)), ...recorded.filter(row => row.networkID === id).map(row => row.peerID)]);
	const owners = [...remaining].filter(id => !leaving.includes(id)).map(id => ({ id, peers: peers(id) }));
	for (const id of leaving) {
		const candidates = [...peers(id)].filter(peer => {
			try {
				peerIdFromString(peer);
				return true;
			} catch {
				return false;
			}
		});
		recordPeerCleanup(db, id, candidates, operationID);
		for (const owner of owners)
			recordPeerCleanup(
				db,
				owner.id,
				candidates.filter(peer => owner.peers.has(peer)),
				operationID
			);
	}
}

/** The caller excludes catalog writes until every queued deletion has finished. */
export async function replayPeerCleanup(db: Database, node: { peerStore: { delete(peerID: PeerId): Promise<void> } }, enabled: () => LISHNetworkConfig[]): Promise<void> {
	const rows = listPeerCleanup(db);
	const configs = enabled();
	const enabledIDs = new Set(configs.map(config => config.networkID));
	const configured = new Set(configs.flatMap(config => configuredPeerIDs(config.bootstrapPeers)));
	const byPeer = new Map<string, typeof rows>();
	for (const row of rows) {
		const group = byPeer.get(row.peerID);
		if (group) group.push(row);
		else byPeer.set(row.peerID, [row]);
	}
	let removed = 0;
	for (const [peer, peerRows] of byPeer) {
		let id: PeerId;
		try {
			id = peerIdFromString(peer);
		} catch {
			confirmPeerCleanup(db, peerRows);
			continue;
		}
		if (configured.has(peer) || peerRows.some(row => enabledIDs.has(row.networkID))) continue;
		await node.peerStore.delete(id);
		confirmPeerCleanup(db, peerRows);
		removed++;
	}
	if (removed > 0) console.log(`[Networks] Finished the peer cleanup of left lishnets: ${removed} peer(s) removed before start`);
}
