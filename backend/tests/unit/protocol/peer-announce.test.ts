import { describe, it, expect } from 'bun:test';
import { multiaddr as Multiaddr } from '@multiformats/multiaddr';
import { AnnounceRateLimiter, PeerAnnounceManager, type PeerAnnounceMessage } from '../../../src/protocol/peer-announce.ts';
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

// Inbound-intake guards. Every address that survives handle() costs a dial, a status
// row and a snapshot downstream, so the two things that bound that cost — collapsing
// addresses that mean the same thing, and capping what one announcing peer can spend —
// are asserted here rather than left to the receivers further down the chain.

const SRC_ID = '12D3KooWSourceSourceSourceSourceSourceSourceSourceSS';
const OTHER_SRC_ID = '12D3KooWOtherOtherOtherOtherOtherOtherOtherOtherOO';
/** Identity every intake fixture terminates in — intake refuses addresses without one. */
const ANNOUNCED_ID = '12D3KooWH3uVF6wv47WnArKHk5p6cvgCJEb74UTmxztmQDc298L3';

/** Append the announced identity, which inbound intake requires. */
function withID(address: string, id: string = ANNOUNCED_ID): string {
	return `${address}/p2p/${id}`;
}

/** A manager wired only for handle(): captures the address lists it forwards. */
function intakeManager() {
	const forwarded: string[][] = [];
	const mgr = new PeerAnnounceManager({
		getNode: () => null,
		getPubsub: () => null,
		broadcast: async () => {},
		addBootstrapPeers: async multiaddrs => {
			forwarded.push(multiaddrs);
		},
	});
	return { mgr, forwarded };
}

/** N distinct routable addresses in RFC5737 TEST-NET-3. */
function distinctAddrs(count: number): string[] {
	return Array.from({ length: count }, (_v, i) => withID(`/ip4/203.0.113.${i % 254}/tcp/${9000 + i}`));
}

describe('PeerAnnounceManager.handle address dedup', () => {
	it('collapses one address repeated many times into a single entry', async () => {
		const { mgr, forwarded } = intakeManager();
		const addr = withID('/ip4/198.51.100.7/tcp/9090');

		await mgr.handle({ type: 'peer-announce', multiaddrs: Array(300).fill(addr) }, 'netAAAA', SRC_ID);

		expect(forwarded).toEqual([[addr]]);
	});

	it('collapses two spellings of one address (DNS case, expanded vs compressed IPv6)', async () => {
		const { mgr, forwarded } = intakeManager();
		const multiaddrs = [`/dns4/Peer.Example.COM/tcp/9090/p2p/${SELF_ID}`, `/dns4/peer.example.com/tcp/9090/p2p/${SELF_ID}`, withID('/ip6/2001:0db8:0000:0000:0000:0000:0000:0001/tcp/9090'), withID('/ip6/2001:db8::1/tcp/9090')];

		await mgr.handle({ type: 'peer-announce', multiaddrs }, 'netAAAA', SRC_ID);

		// One DNS entry + one IPv6 entry, each keeping the spelling it arrived in.
		expect(forwarded[0]).toEqual([multiaddrs[0]!, multiaddrs[2]!]);
	});

	it('counts UNIQUE addresses against the total cap, not raw entries', async () => {
		// 300 copies of one address plus 5 distinct ones is 6 unique — the duplicates
		// must not consume the 128-address budget the distinct ones need.
		const { mgr, forwarded } = intakeManager();
		const dup = withID('/ip4/198.51.100.7/tcp/9090');
		const rest = distinctAddrs(5);

		await mgr.handle({ type: 'peer-announce', multiaddrs: [...Array(300).fill(dup), ...rest] }, 'netAAAA', SRC_ID);

		expect(forwarded[0]).toEqual([dup, ...rest]);
	});

	it('still caps a flood of genuinely distinct addresses at 128', async () => {
		const { mgr, forwarded } = intakeManager();

		await mgr.handle({ type: 'peer-announce', multiaddrs: distinctAddrs(200) }, 'netAAAA', SRC_ID);

		expect(forwarded[0]!.length).toBe(128);
	});

	it('drops non-routable addresses before deduping', async () => {
		const { mgr, forwarded } = intakeManager();

		await mgr.handle({ type: 'peer-announce', multiaddrs: [withID('/ip4/127.0.0.1/tcp/9090'), withID('/ip4/127.0.0.1/tcp/9090'), 'not-a-multiaddr'] }, 'netAAAA', SRC_ID);

		expect(forwarded).toEqual([]);
	});

	it('refuses an announced address that carries no /p2p identity', async () => {
		// Without an identity the address is unreachable by every per-peer control
		// downstream — backoff, quarantine, leave-suppression, purge — while one
		// successful dial parks it on the recovery list for good.
		const { mgr, forwarded } = intakeManager();
		const named = withID('/ip4/203.0.113.5/tcp/9090');

		await mgr.handle({ type: 'peer-announce', multiaddrs: ['/ip4/203.0.113.4/tcp/9090', named] }, 'netAAAA', SRC_ID);

		expect(forwarded).toEqual([[named]]);
	});

	it('keeps the relay-circuit target identity, not the relay hop', async () => {
		const { mgr, forwarded } = intakeManager();
		const relayed = `/ip4/203.0.113.6/tcp/9090/p2p/${SELF_ID}/p2p-circuit/p2p/${ANNOUNCED_ID}`;

		await mgr.handle({ type: 'peer-announce', multiaddrs: [relayed] }, 'netAAAA', SRC_ID);

		expect(forwarded).toEqual([[relayed]]);
	});
});

describe('PeerAnnounceManager.handle per-source rate limit', () => {
	it('lets a burst through, then throttles the same source', async () => {
		// Budget is 384 addresses (3 × the 128 cap); a fourth full announce from the
		// same source within the same second has nothing left to spend.
		const { mgr, forwarded } = intakeManager();
		const addrs = distinctAddrs(128);

		for (let i = 0; i < 4; i++) await mgr.handle({ type: 'peer-announce', multiaddrs: addrs }, 'netAAAA', SRC_ID);

		expect(forwarded.map(f => f.length)).toEqual([128, 128, 128]); // 4th announce dropped entirely
	});

	it('throttles one source without starving another', async () => {
		const { mgr, forwarded } = intakeManager();
		const addrs = distinctAddrs(128);

		for (let i = 0; i < 4; i++) await mgr.handle({ type: 'peer-announce', multiaddrs: addrs }, 'netAAAA', SRC_ID);
		forwarded.length = 0;
		await mgr.handle({ type: 'peer-announce', multiaddrs: addrs }, 'netAAAA', OTHER_SRC_ID);

		expect(forwarded.map(f => f.length)).toEqual([128]);
	});
});

describe('AnnounceRateLimiter', () => {
	it('grants a full burst to an unseen source and nothing more', () => {
		const limiter = new AnnounceRateLimiter(384, 256, 1024);
		expect(limiter.take('a', 384, 0)).toBe(384);
		expect(limiter.take('a', 1, 0)).toBe(0);
	});

	it('grants partially rather than refusing outright when over budget', () => {
		const limiter = new AnnounceRateLimiter(384, 256, 1024);
		expect(limiter.take('a', 500, 0)).toBe(384);
	});

	it('recovers over time at the configured rate', () => {
		const limiter = new AnnounceRateLimiter(384, 256, 1024);
		limiter.take('a', 384, 0);
		expect(limiter.take('a', 200, 30_000)).toBe(128); // half a minute → half the per-minute rate
		expect(limiter.take('a', 200, 60_000)).toBe(128); // another 30s worth
	});

	it('never refills past the burst ceiling', () => {
		const limiter = new AnnounceRateLimiter(384, 256, 1024);
		limiter.take('a', 384, 0);
		expect(limiter.take('a', 1000, 600_000)).toBe(384); // ten idle minutes still caps at burst
	});

	it('keeps one source spending from starving another', () => {
		const limiter = new AnnounceRateLimiter(384, 256, 1024);
		limiter.take('a', 384, 0);
		expect(limiter.take('b', 384, 0)).toBe(384);
	});

	it('bounds the bucket table, evicting the least recently heard-from source', () => {
		const limiter = new AnnounceRateLimiter(10, 10, 2);
		limiter.take('a', 10, 0); // 'a' exhausted, then pushed out by 'c'
		limiter.take('b', 10, 0);
		limiter.take('c', 10, 0);

		expect(limiter.take('a', 10, 0)).toBe(10); // evicted → fresh bucket
		expect(limiter.take('c', 1, 0)).toBe(0); // recently used → still exhausted
	});
});

/**
 * Both maps belong to the run that filled them. Membership is recorded against the libp2p
 * node that was up at the time and is what leave-network reads to decide who to hang up;
 * the rate-limiter buckets are per-source budgets. Carrying either into the next start()
 * makes the new run act on the old one's state.
 */
describe('PeerAnnounceManager.stop clears per-run state', () => {
	const TOPIC = `${LISH_TOPIC_PREFIX}netAAAA`;

	it('forgets topic membership', () => {
		const { mgr } = intakeManager();
		mgr.noteMember(TOPIC, PA_ID);
		expect(mgr.getRecentMembers(TOPIC)).toEqual([PA_ID]);

		mgr.stop();

		expect(mgr.getRecentMembers(TOPIC)).toEqual([]);
	});

	it('gives a throttled source its full budget back after a restart', async () => {
		const { mgr, forwarded } = intakeManager();
		const addrs = distinctAddrs(128);
		for (let i = 0; i < 4; i++) await mgr.handle({ type: 'peer-announce', multiaddrs: addrs }, 'netAAAA', SRC_ID);
		expect(forwarded).toHaveLength(3); // the fourth was over budget

		mgr.stop();
		mgr.start();
		await mgr.handle({ type: 'peer-announce', multiaddrs: addrs }, 'netAAAA', SRC_ID);

		expect(forwarded).toHaveLength(4);
		mgr.stop();
	});
});

/**
 * The unique cap bounds what intake ADMITS, not what the walk costs. Every raw entry is
 * parsed, canonicalised and routability-tested before dedup can discard it, so a message
 * of thousands of duplicates or junk values bought that work unbounded.
 */
describe('PeerAnnounceManager.handle raw input bound', () => {
	it('stops examining a flood of duplicates long before the end of the list', async () => {
		// The unique address sits past the raw budget, so reaching it would mean the walk
		// went all the way through the padding.
		const { mgr, forwarded } = intakeManager();
		const dup = withID('/ip4/198.51.100.7/tcp/9090');
		const beyond = withID('/ip4/203.0.113.200/tcp/9099');

		await mgr.handle({ type: 'peer-announce', multiaddrs: [...Array(5000).fill(dup), beyond] }, 'netAAAA', SRC_ID);

		expect(forwarded).toEqual([[dup]]);
	});

	it('still admits a legitimate full-size announce', async () => {
		const { mgr, forwarded } = intakeManager();

		await mgr.handle({ type: 'peer-announce', multiaddrs: distinctAddrs(128) }, 'netAAAA', SRC_ID);

		expect(forwarded[0]!.length).toBe(128);
	});

	it('drops an over-long value without parsing it', async () => {
		const { mgr, forwarded } = intakeManager();
		const bloated = `/dns4/${'a'.repeat(600)}.example.com/tcp/9090/p2p/${ANNOUNCED_ID}`;
		const named = withID('/ip4/203.0.113.5/tcp/9090');

		await mgr.handle({ type: 'peer-announce', multiaddrs: [bloated, named] }, 'netAAAA', SRC_ID);

		expect(forwarded).toEqual([[named]]);
	});
});
