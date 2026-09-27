import type { Database } from 'bun:sqlite';
import type { LISHNetworkConfig } from '@shared';
import { peerIdFromString } from '@libp2p/peer-id';
import type { Network } from '../protocol/network.ts';
import { LISH_TOPIC_PREFIX } from '../protocol/constants.ts';
import { relayPeerIDs } from '../protocol/relay-peer-ids.ts';
import { listPeerCleanup, recordPeerClaim, recordPeerCleanup } from '../db/peer-cleanup.ts';

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
export function observePeerCleanupClaims(db: Database, network: Network, enabled: () => LISHNetworkConfig[]): void {
	network.onPeerSubscribe((peerID, topic) => {
		if (!topic.startsWith(LISH_TOPIC_PREFIX)) return;
		const networkID = topic.slice(LISH_TOPIC_PREFIX.length);
		if (!enabled().some(row => row.networkID === networkID)) return;
		recordPeerClaim(db, networkID, withRelays(network, [peerID]));
	});
	network.onRelayConnection = (peerID, relays) => {
		const rows = listPeerCleanup(db);
		for (const config of enabled()) {
			if (rows.some(row => row.networkID === config.networkID && row.peerID === peerID) || network.getTopicPeers(config.networkID).includes(peerID) || network.getRecentTopicMembers(config.networkID).includes(peerID) || configuredPeerIDs(config.bootstrapPeers).includes(peerID))
				recordPeerClaim(db, config.networkID, relays);
		}
	};
}

/** Candidates and all current owners are written in the catalog transaction. */
export function recordLeavingPeerCleanup(db: Database, network: Network, leaving: readonly string[], remaining: ReadonlySet<string>, operationID: string, bootstraps: (id: string) => string[]): void {
	const recorded = listPeerCleanup(db);
	const peers = (id: string): Set<string> => withRelays(network, [...network.getTopicPeers(id), ...network.getRecentTopicMembers(id), ...configuredPeerIDs(bootstraps(id)), ...recorded.filter(row => row.networkID === id).map(row => row.peerID)]);
	const owners = [...remaining].filter(id => !leaving.includes(id)).map(id => ({ id, peers: peers(id) }));
	for (const id of leaving) {
		const candidates = [...peers(id)].filter(peer => {
			try { peerIdFromString(peer); return true; } catch { return false; }
		});
		recordPeerCleanup(db, id, candidates, operationID);
		for (const owner of owners) recordPeerCleanup(db, owner.id, candidates.filter(peer => owner.peers.has(peer)), operationID);
	}
}
