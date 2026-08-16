import { describe, it, expect } from 'bun:test';
import { multiaddr } from '@multiformats/multiaddr';
import { PeerAnnounceManager } from '../../../src/protocol/peer-announce.ts';
import { Network } from '../../../src/protocol/network.ts';
import { lishTopic } from '../../../src/protocol/constants.ts';

/**
 * Topic membership is what leave-network reads to decide which peers to hang up.
 * These tests drive the REAL PeerAnnounceManager rather than a stubbed
 * getRecentTopicMembers, because every bug in this area has been in how the set is
 * derived, not in how leaveNetwork filters an already-correct set — a suite that
 * mocks the source cannot see them.
 */

const TOPIC = lishTopic('net-a');

/** peerStore size below PEER_ANNOUNCE_MIN_PEER_STORE (5) — a two/three-node network. */
function tinyPeerStore(n: number) {
	return { all: async () => Array.from({ length: n }, (_, i) => ({ id: { toString: () => `stored-${i}` }, addresses: [] })) };
}

function makeManager(subscribers: string[], peerStoreSize: number, topics: string[] = [TOPIC]) {
	const broadcasts: string[] = [];
	const node: any = {
		peerStore: tinyPeerStore(peerStoreSize),
		peerId: { toString: () => 'self' },
		// A routable self address, or the announce would carry nothing and be skipped
		// before it reaches the broadcast. RFC5737 documentation range.
		getMultiaddrs: () => [multiaddr('/ip4/203.0.113.5/tcp/9090')],
	};
	const pubsub: any = {
		getTopics: () => topics,
		getSubscribers: (t: string) => (t === TOPIC ? subscribers.map(p => ({ toString: () => p })) : []),
	};
	const mgr = new PeerAnnounceManager({
		getNode: () => node,
		getPubsub: () => pubsub,
		async broadcast(topic: string): Promise<void> {
			broadcasts.push(topic);
		},
		async addBootstrapPeers(): Promise<void> {},
	});
	return { mgr, broadcasts, pubsub };
}

/** emit() is private; the tick is what a running node would perform. */
const tick = (mgr: PeerAnnounceManager): Promise<void> => (mgr as any).emit();

describe('PeerAnnounceManager topic membership', () => {
	it('records a subscriber on a network too small to broadcast', async () => {
		// The regression: membership used to be a side effect of the announce, which is
		// skipped below PEER_ANNOUNCE_MIN_PEER_STORE — so on a 2-node network the cache
		// stayed empty and leave-network had no one to disconnect.
		const { mgr, broadcasts } = makeManager(['peer-b'], 2);
		await tick(mgr);
		expect(broadcasts).toEqual([]); // still below the announce threshold
		expect(mgr.getRecentMembers(TOPIC)).toEqual(['peer-b']);
	});

	it('records a subscriber on a network large enough to broadcast', async () => {
		const { mgr, broadcasts } = makeManager(['peer-b'], 10);
		await tick(mgr);
		expect(broadcasts).toEqual([TOPIC]);
		expect(mgr.getRecentMembers(TOPIC)).toEqual(['peer-b']);
	});

	it('records a subscriber without any announce tick at all', async () => {
		// subscription-change lands the moment the RPC is processed, well before the
		// next announce cadence would refresh the map from getSubscribers.
		const { mgr } = makeManager([], 2);
		expect(mgr.getRecentMembers(TOPIC)).toEqual([]);
		mgr.noteMember(TOPIC, 'peer-sub');
		expect(mgr.getRecentMembers(TOPIC)).toEqual(['peer-sub']);
	});

	it('keeps a noted subscriber that the live snapshot does not list', async () => {
		const { mgr } = makeManager([], 2);
		mgr.noteMember(TOPIC, 'peer-sub');
		await tick(mgr);
		expect(mgr.getRecentMembers(TOPIC)).toEqual(['peer-sub']);
	});

	/**
	 * The gossipsub payload is `{ peerId, subscriptions: [{ topic, subscribe }] }`, with
	 * `peerId` a PeerId object rather than a string. Reading either field under the wrong
	 * name type-checks against an `any` event and silently records nothing, so the
	 * membership feed has to be driven with the real shape to be worth anything.
	 */
	it('records a member from a real gossipsub subscription-change payload', () => {
		const { mgr } = makeManager([], 2);
		const net = Object.create(Network.prototype) as Network;
		(net as any).peerAnnounce = mgr;

		(net as any).noteSubscriptionChange({ peerId: { toString: () => 'peer-sub' }, subscriptions: [{ topic: TOPIC, subscribe: true }] });

		expect(mgr.getRecentMembers(TOPIC)).toEqual(['peer-sub']);
	});

	it('revokes membership as soon as the peer unsubscribes', () => {
		// gossipsub removes the peer from its subscriber map on subscribe:false. A recent
		// union that outlived that would keep authorizing a withdrawn claim for a minute.
		const { mgr } = makeManager([], 2);
		const net = Object.create(Network.prototype) as Network;
		(net as any).peerAnnounce = mgr;
		const peerId = { toString: () => 'peer-sub' };

		(net as any).noteSubscriptionChange({ peerId, subscriptions: [{ topic: TOPIC, subscribe: true }] });
		expect(mgr.getRecentMembers(TOPIC)).toEqual(['peer-sub']);

		(net as any).noteSubscriptionChange({ peerId, subscriptions: [{ topic: TOPIC, subscribe: false }] });
		expect(mgr.getRecentMembers(TOPIC)).toEqual([]);
	});

	it('records nothing from a mesh GRAFT', () => {
		// The pinned gossipsub emits gossipsub:graft for REJECTED grafts too (backoff,
		// negative score, full mesh) and never requires a prior SUBSCRIBE, so a GRAFT is
		// not a claim of membership at all — let alone an accepted one.
		const { mgr } = makeManager([], 2);
		const net = Object.create(Network.prototype) as Network;
		(net as any).peerAnnounce = mgr;

		expect((net as any).noteMeshGraft).toBeUndefined();
		(net as any).noteSubscriptionChange({ peerId: { toString: () => 'peer-graft' }, subscriptions: [] });

		expect(mgr.getRecentMembers(TOPIC)).toEqual([]);
	});

	it('ignores a subscription to a topic that is not a lishnet', () => {
		const { mgr } = makeManager([], 2);
		const net = Object.create(Network.prototype) as Network;
		(net as any).peerAnnounce = mgr;

		(net as any).noteSubscriptionChange({ peerId: { toString: () => 'peer-x' }, subscriptions: [{ topic: 'other/topic', subscribe: true }] });

		expect(mgr.getRecentMembers('other/topic')).toEqual([]);
	});

	it('drops membership for a topic we are no longer subscribed to', async () => {
		const { mgr } = makeManager(['peer-b'], 2);
		await tick(mgr);
		expect(mgr.getRecentMembers(TOPIC)).toEqual(['peer-b']);
		const gone = makeManager(['peer-b'], 2, []);
		await tick(gone.mgr);
		expect(gone.mgr.getRecentMembers(TOPIC)).toEqual([]);
	});

	it('reports nothing for an unknown topic', () => {
		const { mgr } = makeManager(['peer-b'], 2);
		expect(mgr.getRecentMembers(lishTopic('never-joined'))).toEqual([]);
	});
});
