import { describe, it, expect } from 'bun:test';
import { multiaddr as Multiaddr } from '@multiformats/multiaddr';
import { PeerAnnounceManager, type PeerAnnounceMessage } from '../../../src/protocol/peer-announce.ts';
import { LISH_TOPIC_PREFIX } from '../../../src/protocol/constants.ts';

// Topic-scoping guard for peer-announce emit(): the transitive peer list broadcast
// on a topic must contain ONLY peers subscribed to THAT topic, never peers of a
// different network. Self multiaddrs are advertised on every topic (we are a member
// of each one we publish on). PeerIDs below are fake placeholders and the multiaddrs
// use RFC5737 TEST-NET-1 (192.0.2.0/24), which shouldDenyDial treats as routable.

const SELF_ID = '12D3KooWSelfSelfSelfSelfSelfSelfSelfSelfSelfSelfAA';
const SELF_ADDR = '/ip4/192.0.2.1/tcp/9090';
const PA_ID = 'PeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PA_ADDR = '/ip4/192.0.2.10/tcp/9090';
const PB_ID = 'PeerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const PB_ADDR = '/ip4/192.0.2.20/tcp/9090';

const TOPIC_A = `${LISH_TOPIC_PREFIX}netAAAA`;
const TOPIC_B = `${LISH_TOPIC_PREFIX}netBBBB`;

/** A peerStore entry: id.toString() + a single routable multiaddr. */
function fakePeer(id: string, addr: string) {
	return { id: { toString: () => id }, addresses: [{ multiaddr: Multiaddr(addr) }] };
}

/** A pubsub subscriber handle whose toString() is the peerID (matches gossipsub). */
function fakeSubscriber(id: string) {
	return { toString: () => id };
}

describe('PeerAnnounceManager.emit topic scoping', () => {
	it('broadcasts only same-topic subscribers transitively, self on every topic', async () => {
		// P_A subscribes to topic A only, P_B to topic B only. Three filler peers pad
		// the peerStore past PEER_ANNOUNCE_MIN_PEER_STORE (5) and, being subscribers of
		// neither topic, must be excluded from both announces.
		const allPeers = [fakePeer(PA_ID, PA_ADDR), fakePeer(PB_ID, PB_ADDR), fakePeer('Filler1111111111111111111111111111111111111111111', '/ip4/192.0.2.101/tcp/9090'), fakePeer('Filler2222222222222222222222222222222222222222222', '/ip4/192.0.2.102/tcp/9090'), fakePeer('Filler3333333333333333333333333333333333333333333', '/ip4/192.0.2.103/tcp/9090')];
		const subscribers: Record<string, ReturnType<typeof fakeSubscriber>[]> = {
			[TOPIC_A]: [fakeSubscriber(PA_ID)],
			[TOPIC_B]: [fakeSubscriber(PB_ID)],
		};
		const node = {
			peerId: { toString: () => SELF_ID },
			getMultiaddrs: () => [Multiaddr(SELF_ADDR)],
			peerStore: { all: async () => allPeers },
		};
		const pubsub = {
			getTopics: () => [TOPIC_A, TOPIC_B],
			getSubscribers: (topic: string) => subscribers[topic] ?? [],
		};
		const broadcasts: Array<{ topic: string; msg: PeerAnnounceMessage }> = [];
		const mgr = new PeerAnnounceManager({
			getNode: () => node as any,
			getPubsub: () => pubsub as any,
			broadcast: async (topic, msg) => {
				broadcasts.push({ topic, msg: msg as unknown as PeerAnnounceMessage });
			},
			addBootstrapPeers: async () => {},
		});

		await (mgr as any).emit();

		const a = broadcasts.find(b => b.topic === TOPIC_A);
		const b = broadcasts.find(b => b.topic === TOPIC_B);
		expect(a).toBeDefined();
		expect(b).toBeDefined();

		const aAddrs = a!.msg.multiaddrs.join(' ');
		expect(aAddrs).toContain('192.0.2.1/'); // self
		expect(aAddrs).toContain('192.0.2.10/'); // P_A (subscriber of A)
		expect(aAddrs).not.toContain('192.0.2.20/'); // P_B leaked in from network B
		expect(aAddrs).not.toContain('192.0.2.101/'); // non-subscriber filler

		const bAddrs = b!.msg.multiaddrs.join(' ');
		expect(bAddrs).toContain('192.0.2.1/'); // self
		expect(bAddrs).toContain('192.0.2.20/'); // P_B (subscriber of B)
		expect(bAddrs).not.toContain('192.0.2.10/'); // P_A leaked in from network A
	});

	it('skips a topic whose only content would be self (no scoped subscribers)', async () => {
		const allPeers = [fakePeer(PA_ID, PA_ADDR), fakePeer('Filler1111111111111111111111111111111111111111111', '/ip4/192.0.2.101/tcp/9090'), fakePeer('Filler2222222222222222222222222222222222222222222', '/ip4/192.0.2.102/tcp/9090'), fakePeer('Filler3333333333333333333333333333333333333333333', '/ip4/192.0.2.103/tcp/9090'), fakePeer('Filler4444444444444444444444444444444444444444444', '/ip4/192.0.2.104/tcp/9090')];
		const node = {
			peerId: { toString: () => SELF_ID },
			getMultiaddrs: () => [Multiaddr(SELF_ADDR)],
			peerStore: { all: async () => allPeers },
		};
		// Topic A has P_A subscribed (→ sent); topic B has no subscribers (→ skipped).
		const pubsub = {
			getTopics: () => [TOPIC_A, TOPIC_B],
			getSubscribers: (topic: string) => (topic === TOPIC_A ? [fakeSubscriber(PA_ID)] : []),
		};
		const broadcasts: string[] = [];
		const mgr = new PeerAnnounceManager({
			getNode: () => node as any,
			getPubsub: () => pubsub as any,
			broadcast: async topic => {
				broadcasts.push(topic);
			},
			addBootstrapPeers: async () => {},
		});

		await (mgr as any).emit();

		expect(broadcasts).toEqual([TOPIC_A]);
	});
});
