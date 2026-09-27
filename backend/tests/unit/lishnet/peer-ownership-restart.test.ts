import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { peerIdFromString } from '@libp2p/peer-id';
import { Networks } from '../../../src/lishnet/lishnets.ts';
import { initLISHnetsTables, addLISHnet, setLISHnetEnabled, updateLISHnet } from '../../../src/db/lishnets.ts';
import { listPeerCleanup, recordPeerCleanup } from '../../../src/db/peer-cleanup.ts';

const peer = '12D3KooWQyNzs3o2PqCdxmSAxmn8AG5FDnbmTiSx3QRwsKTXaT3E';
const relay = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
	const db = new Database(':memory:');
	databases.push(db);
	initLISHnetsTables(db);
	for (const networkID of ['left', 'remaining']) addLISHnet(db, { networkID, name: networkID, description: '', created: '2026-01-01T00:00:00.000Z', bootstrapPeers: [], enabled: networkID === 'remaining' });
	const networks = new Networks(db, '.', {} as never, {} as never);
	const network = networks.getNetwork() as any;
	const liveConnections: unknown[] = [];
	const node = Object.assign(new EventTarget(), { getConnections: () => liveConnections });
	network.node = node;
	network.pubsub = { getTopics: () => ['lish/remaining'], getSubscribers: () => [peer] };
	const subscribe = () => network.noteSubscriptionChange({ peerId: peerIdFromString(peer), subscriptions: [{ topic: 'lish/remaining', subscribe: true }] });
	const connection = { remotePeer: peerIdFromString(peer), remoteAddr: { toString: () => `/ip4/192.0.2.1/tcp/9090/p2p/${relay}/p2p-circuit/p2p/${peer}` } };
	return { db, networks, network, node, liveConnections, subscribe, connection };
}

test('a new owner during a pending leave protects its peer and relay across restart', async () => {
	const f = fixture();
	recordPeerCleanup(f.db, 'left', [peer, relay], 'leave');
	f.liveConnections.push(f.connection);
	f.subscribe();
	expect(listPeerCleanup(f.db).filter(row => row.networkID === 'remaining').map(row => row.peerID).sort()).toEqual([peer, relay].sort());
	const restarted = new Networks(f.db, '.', {} as never, {} as never) as any;
	const deleted: string[] = [];
	const node = { peerStore: { delete: async (id: { toString(): string }) => { deleted.push(id.toString()); } } };
	await restarted.replayPeerCleanup(node);
	expect(deleted).toEqual([]);
	setLISHnetEnabled(f.db, 'remaining', false);
	await restarted.replayPeerCleanup(node);
	expect(deleted.sort()).toEqual([peer, relay].sort());
	expect(listPeerCleanup(f.db)).toEqual([]);
});

test('a new circuit after membership was recorded protects the queued relay synchronously', () => {
	const f = fixture();
	recordPeerCleanup(f.db, 'left', [peer, relay], 'leave');
	f.subscribe();
	expect(listPeerCleanup(f.db).filter(row => row.networkID === 'remaining').map(row => row.peerID)).toEqual([peer]);
	f.network.setupEventListeners();
	f.liveConnections.push(f.connection);
	f.node.dispatchEvent(new CustomEvent('connection:open', { detail: f.connection }));
	expect(listPeerCleanup(f.db).some(row => row.networkID === 'remaining' && row.peerID === relay)).toBe(true);
});

test('ordinary membership without a pending cleanup creates no persistent history', () => {
	const f = fixture();
	f.subscribe();
	expect(listPeerCleanup(f.db)).toEqual([]);
});

test('a newly configured circuit protects its relay before the first connection is made', async () => {
	const f = fixture();
	recordPeerCleanup(f.db, 'left', [relay], 'leave');
	updateLISHnet(f.db, { ...f.networks.get('remaining')!, bootstrapPeers: [f.connection.remoteAddr.toString()] });
	const deleted: string[] = [];
	await (f.networks as any).replayPeerCleanup({ peerStore: { delete: async (id: { toString(): string }) => { deleted.push(id.toString()); } } });
	expect(deleted).toEqual([]);
	expect(listPeerCleanup(f.db)).toHaveLength(1);
});

test('catalog reset records active relays as candidates instead of silently excluding them', () => {
	const f = fixture();
	f.liveConnections.push(f.connection);
	f.network.getTopicPeers = (id: string) => id === 'remaining' ? [peer] : [];
	f.networks.recordPeersForCatalogReset();
	expect(listPeerCleanup(f.db).map(row => row.peerID).sort()).toEqual([peer, relay].sort());
});
