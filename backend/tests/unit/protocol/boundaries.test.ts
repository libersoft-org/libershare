import { describe, it, expect } from 'bun:test';
import { AnnounceRateLimiter, PeerAnnounceManager } from '../../../src/protocol/peer-announce.ts';
import { BootstrapStatusTracker } from '../../../src/protocol/bootstrap-status.ts';
import { canonicalMultiaddr, destinationPeerIDOf } from '../../../src/protocol/multiaddr-utils.ts';

const PEER = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
const OTHER = '12D3KooWAnfqA6Wap96ixVfxhHeGUDMriBG4Nncp5tqu8q71EVv2';
const NET = 'net-bounds';
const TOPIC = 'lish/net-bounds';

/** Capture what intake admitted, so a limit can be checked at the limit and one past it. */
function intake() {
	const admitted: string[][] = [];
	const mgr = new PeerAnnounceManager({
		getNode: () => ({ peerId: { toString: () => 'self' }, getMultiaddrs: () => [], peerStore: { all: async () => [] } }) as never,
		getPubsub: () => ({ getTopics: () => [TOPIC], getSubscribers: () => [] }) as never,
		broadcast: async () => {},
		addBootstrapPeers: async (addrs: string[]) => {
			admitted.push(addrs);
		},
	});
	return { mgr, admitted };
}

const addrN = (n: number, id = PEER): string => `/ip4/198.51.100.${n % 250}/tcp/${1024 + (n % 60000)}/p2p/${id}`;

/**
 * Every bound this code puts on what one peer can make it do, checked AT the limit and one
 * past it. They exist because the other side of the wire chooses the input: the numbers are
 * the difference between "a peer told us something" and "a peer decided how much work we do".
 */
describe('limits — at the boundary and one past it', () => {
	it('rate limiter: a burst is granted in full, and nothing beyond it', () => {
		const limiter = new AnnounceRateLimiter(384, 256, 1024);
		expect(limiter.take('a', 384, 0)).toBe(384);
		expect(limiter.take('a', 1, 0)).toBe(0);
	});

	it('rate limiter: refills at the sustained rate, not faster', () => {
		const limiter = new AnnounceRateLimiter(384, 256, 1024);
		limiter.take('a', 384, 0);
		expect(limiter.take('a', 999, 30_000)).toBe(128); // half a minute buys half the rate
		expect(limiter.take('a', 999, 60_000)).toBe(128); // and never past the ceiling in one go
	});

	it('rate limiter: never refills past the burst ceiling however long it waits', () => {
		const limiter = new AnnounceRateLimiter(384, 256, 1024);
		limiter.take('a', 384, 0);
		expect(limiter.take('a', 9999, 60 * 60_000)).toBe(384);
	});

	it('rate limiter: one source cannot spend another’s budget', () => {
		const limiter = new AnnounceRateLimiter(384, 256, 1024);
		limiter.take('greedy', 384, 0);
		expect(limiter.take('quiet', 384, 0)).toBe(384);
	});

	it('rate limiter: the source table is bounded, dropping the least recently heard from', () => {
		const limiter = new AnnounceRateLimiter(384, 256, 4);
		for (let i = 0; i < 4; i++) limiter.take(`s${i}`, 1, i);
		limiter.take('s4', 1, 100); // one too many — the oldest is forgotten
		expect((limiter as any).buckets.size).toBeLessThanOrEqual(4);
		expect((limiter as any).buckets.has('s0')).toBe(false);
	});

	it('intake: admits 128 unique addresses from one message and no more', async () => {
		const { mgr, admitted } = intake();
		await mgr.handle({ multiaddrs: Array.from({ length: 200 }, (_, i) => addrN(i)) } as never, NET, 'src');
		expect(admitted[0]).toHaveLength(128);
	});

	it('intake: a message of nothing but duplicates costs one address, not 128', async () => {
		const { mgr, admitted } = intake();
		await mgr.handle({ multiaddrs: Array.from({ length: 300 }, () => addrN(1)) } as never, NET, 'src');
		expect(admitted[0]).toHaveLength(1);
	});

	it('intake: stops parsing long before the end of an oversized list', async () => {
		const { mgr, admitted } = intake();
		// 5000 raw entries, all junk that never parses: the raw cap is what bounds the work.
		await mgr.handle({ multiaddrs: Array.from({ length: 5000 }, (_, i) => `nonsense-${i}`) } as never, NET, 'src');
		expect(admitted).toHaveLength(0);
	});

	it('intake: an address one character over the length bound is not parsed', async () => {
		const { mgr, admitted } = intake();
		const padded = (len: number): string => `/ip4/198.51.100.9/tcp/9090/p2p/${PEER}`.padEnd(len, 'x');
		await mgr.handle({ multiaddrs: [padded(513)] } as never, NET, 'src');
		expect(admitted).toHaveLength(0);
	});

	it('intake: refuses an address that carries no identity at all', async () => {
		const { mgr, admitted } = intake();
		await mgr.handle({ multiaddrs: ['/ip4/198.51.100.9/tcp/9090'] } as never, NET, 'src');
		expect(admitted).toHaveLength(0);
	});

	it('rows: a network holds 256 discovered rows, and the flood past that is trimmed', () => {
		const tracker = new BootstrapStatusTracker();
		for (let i = 0; i < 400; i++) tracker.recordOutcome(NET, addrN(i, OTHER), OTHER, 'connected', null, OTHER, 'discovered');
		expect(((tracker as any).stats.get(NET) as Map<string, unknown>).size).toBeLessThanOrEqual(256);
	});

	it('expiry: a row survives the last millisecond of the window and not the first past it', () => {
		const inside = new BootstrapStatusTracker();
		const outside = new BootstrapStatusTracker();
		const TTL = 30 * 60_000;
		const addr = addrN(7);
		for (const t of [inside, outside]) t.recordOutcome(NET, addr, PEER, 'connected', null, PEER, 'discovered');
		const answeredAt = Date.now();
		inside.sweepStale(TTL, () => false, answeredAt + TTL - 1);
		outside.sweepStale(TTL, () => false, answeredAt + TTL + 1);
		expect(inside.getStatus(NET)?.peers ?? []).toHaveLength(1);
		expect(outside.getStatus(NET)).toBe(null);
	});

	it('relay: the destination is the peer at the end, never the hop it passes through', () => {
		const HOP = OTHER;
		expect(destinationPeerIDOf(`/ip4/198.51.100.1/tcp/9090/p2p/${HOP}/p2p-circuit/p2p/${PEER}`)).toBe(PEER);
		expect(destinationPeerIDOf(`/ip4/198.51.100.1/tcp/9090/p2p/${HOP}`)).toBe(HOP);
	});

	it('canonical: spellings of one address collapse, different addresses do not', () => {
		expect(canonicalMultiaddr(`/dns4/EXAMPLE.test./tcp/9090/p2p/${PEER}`)).toBe(canonicalMultiaddr(`/dns4/example.test/tcp/9090/p2p/${PEER}`));
		expect(canonicalMultiaddr(addrN(1))).not.toBe(canonicalMultiaddr(addrN(2)));
	});
});
