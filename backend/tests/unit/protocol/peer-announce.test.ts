import { describe, it, expect } from 'bun:test';
import { multiaddr as Multiaddr } from '@multiformats/multiaddr';
import { PeerAnnounceManager, type PeerAnnounceMessage } from '../../../src/protocol/peer-announce.ts';
import { LISH_TOPIC_PREFIX } from '../../../src/protocol/constants.ts';

// Topic-scoping guard for peer-announce emit(): the transitive peer list broadcast
// on a topic must contain ONLY peers subscribed to THAT topic, never peers of a
// different network. Self multiaddrs are advertised on every topic (we are a member
// of each one we publish on). PeerIDs below are fake placeholders and the multiaddrs
// use RFC5737 TEST-NET-1 (192.0.2.0/24), which shouldDenyDial treats as routable.

const SELF_ID = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
const SELF_ADDR = '/ip4/192.0.2.1/tcp/9090';
const PA_ID = 'PeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PA_ADDR = '/ip4/192.0.2.10/tcp/9090';
const PB_ID = 'PeerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const PB_ADDR = '/ip4/192.0.2.20/tcp/9090';
const PC_ID = 'PeerCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const PC_ADDR = '/ip4/192.0.2.30/tcp/9090';

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

/** Wire a manager to a fake node + pubsub and capture every broadcast. */
function buildManager(node: any, pubsub: any) {
	const broadcasts: Array<{ topic: string; msg: PeerAnnounceMessage }> = [];
	const mgr = new PeerAnnounceManager({
		getNode: () => node,
		getPubsub: () => pubsub,
		broadcast: async (topic, msg) => {
			broadcasts.push({ topic, msg: msg as unknown as PeerAnnounceMessage });
		},
		addBootstrapPeers: async () => {},
	});
	return { mgr, broadcasts };
}

/** peerStore.all() fixture padded past PEER_ANNOUNCE_MIN_PEER_STORE (5) with non-subscriber fillers. */
function peersWithFillers(...peers: ReturnType<typeof fakePeer>[]) {
	const fillers = ['Filler1111111111111111111111111111111111111111111', 'Filler2222222222222222222222222222222222222222222', 'Filler3333333333333333333333333333333333333333333', 'Filler4444444444444444444444444444444444444444444'];
	const out = [...peers];
	for (let i = 0; out.length < 5; i++) out.push(fakePeer(fillers[i]!, `/ip4/192.0.2.${101 + i}/tcp/9090`));
	return out;
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

	it('skips a topic with no subscribers (announce would reach nobody)', async () => {
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

	it('still announces self when a subscriber contributes no routable addr (circuit-only)', async () => {
		// P_A subscribes to topic A but is reachable only via /p2p-circuit — it adds
		// no transitive addr, yet still needs our self addrs to reconnect, so the
		// announce must go out with self.
		const circuitPeer = { id: { toString: () => PA_ID }, addresses: [{ multiaddr: Multiaddr(`/p2p-circuit/p2p/${SELF_ID}`) }] };
		const allPeers = [circuitPeer, fakePeer('Filler1111111111111111111111111111111111111111111', '/ip4/192.0.2.101/tcp/9090'), fakePeer('Filler2222222222222222222222222222222222222222222', '/ip4/192.0.2.102/tcp/9090'), fakePeer('Filler3333333333333333333333333333333333333333333', '/ip4/192.0.2.103/tcp/9090'), fakePeer('Filler4444444444444444444444444444444444444444444', '/ip4/192.0.2.104/tcp/9090')];
		const node = {
			peerId: { toString: () => SELF_ID },
			getMultiaddrs: () => [Multiaddr(SELF_ADDR)],
			peerStore: { all: async () => allPeers },
		};
		const pubsub = {
			getTopics: () => [TOPIC_A],
			getSubscribers: (topic: string) => (topic === TOPIC_A ? [fakeSubscriber(PA_ID)] : []),
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

		expect(broadcasts.length).toBe(1);
		expect(broadcasts[0]!.topic).toBe(TOPIC_A);
		expect(broadcasts[0]!.msg.multiaddrs.join(' ')).toContain('192.0.2.1/'); // self present
		expect(broadcasts[0]!.msg.multiaddrs.some(a => a.includes('/p2p-circuit'))).toBe(false);
	});
});

describe('PeerAnnounceManager.emit recently-seen membership', () => {
	it('keeps advertising a same-network peer that just dropped from getSubscribers', async () => {
		// P_A and P_C both subscribe to topic A; peerStore always holds both. After P_A
		// drops from the live subscriber list it must still be advertised to P_C (who is
		// still listening) so P_C can re-dial it — that is the reconnect path.
		const allPeers = peersWithFillers(fakePeer(PA_ID, PA_ADDR), fakePeer(PC_ID, PC_ADDR));
		let aSubs = [PA_ID, PC_ID];
		const node = { peerId: { toString: () => SELF_ID }, getMultiaddrs: () => [Multiaddr(SELF_ADDR)], peerStore: { all: async () => allPeers } };
		const pubsub = { getTopics: () => [TOPIC_A], getSubscribers: (t: string) => (t === TOPIC_A ? aSubs.map(fakeSubscriber) : []) };
		const { mgr, broadcasts } = buildManager(node, pubsub);

		await (mgr as any).emit(); // records P_A + P_C as recently-seen members of A
		aSubs = [PC_ID]; // P_A drops from the live snapshot but stays in peerStore + TTL
		broadcasts.length = 0;
		await (mgr as any).emit();

		const a = broadcasts.find(b => b.topic === TOPIC_A);
		expect(a).toBeDefined();
		const addrs = a!.msg.multiaddrs.join(' ');
		expect(addrs).toContain('192.0.2.10/'); // dropped P_A still advertised for reconnect
		expect(addrs).toContain('192.0.2.30/'); // P_C still current
		expect(addrs).toContain('192.0.2.1/'); // self
	});

	it('never advertises a peer of another network, even across repeated emits', async () => {
		// P_A only ever subscribes to A, P_B only to B. The recently-seen cache must
		// never let P_B into A's announce, no matter how many cycles run.
		const allPeers = peersWithFillers(fakePeer(PA_ID, PA_ADDR), fakePeer(PB_ID, PB_ADDR));
		const node = { peerId: { toString: () => SELF_ID }, getMultiaddrs: () => [Multiaddr(SELF_ADDR)], peerStore: { all: async () => allPeers } };
		const pubsub = { getTopics: () => [TOPIC_A, TOPIC_B], getSubscribers: (t: string) => (t === TOPIC_A ? [fakeSubscriber(PA_ID)] : t === TOPIC_B ? [fakeSubscriber(PB_ID)] : []) };
		const { mgr, broadcasts } = buildManager(node, pubsub);

		await (mgr as any).emit();
		await (mgr as any).emit();

		const aBroadcasts = broadcasts.filter(b => b.topic === TOPIC_A);
		expect(aBroadcasts.length).toBeGreaterThan(0);
		for (const bc of aBroadcasts) expect(bc.msg.multiaddrs.join(' ')).not.toContain('192.0.2.20/'); // P_B never leaks into A
	});

	it('prunes a member whose last-seen exceeds the TTL', async () => {
		const realNow = Date.now;
		try {
			let clock = 1_000_000;
			Date.now = () => clock;
			const allPeers = peersWithFillers(fakePeer(PA_ID, PA_ADDR), fakePeer(PC_ID, PC_ADDR));
			let aSubs = [PA_ID, PC_ID];
			const node = { peerId: { toString: () => SELF_ID }, getMultiaddrs: () => [Multiaddr(SELF_ADDR)], peerStore: { all: async () => allPeers } };
			const pubsub = { getTopics: () => [TOPIC_A], getSubscribers: (t: string) => (t === TOPIC_A ? aSubs.map(fakeSubscriber) : []) };
			const { mgr, broadcasts } = buildManager(node, pubsub);

			await (mgr as any).emit(); // t=clock, records P_A + P_C
			clock += 600_000; // advance past PEER_ANNOUNCE_MEMBER_TTL_MS (180s * 3 = 540s)
			aSubs = [PC_ID]; // P_A no longer live; its last-seen is now stale
			broadcasts.length = 0;
			await (mgr as any).emit();

			const a = broadcasts.find(b => b.topic === TOPIC_A);
			expect(a).toBeDefined();
			const addrs = a!.msg.multiaddrs.join(' ');
			expect(addrs).not.toContain('192.0.2.10/'); // P_A pruned (last-seen > TTL)
			expect(addrs).toContain('192.0.2.30/'); // P_C refreshed this cycle
		} finally {
			Date.now = realNow;
		}
	});
});
