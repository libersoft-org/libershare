import { describe, it, expect } from 'bun:test';
import { BootstrapStatusTracker } from '../../../src/protocol/bootstrap-status.ts';

const NET = 'net-edges';
const PEER = '12D3KooWAnfqA6Wap96ixVfxhHeGUDMriBG4Nncp5tqu8q71EVv2';
const OTHER = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
const ADDR = `/ip4/203.0.113.11/tcp/9090/p2p/${PEER}`;
const TTL = 30 * 60_000;
const shown = (t: BootstrapStatusTracker): string[] => (t.getStatus(NET)?.peers ?? []).map(p => p.multiaddr);
const stored = (t: BootstrapStatusTracker): number => ((t as any).stats.get(NET) as Map<string, unknown> | undefined)?.size ?? 0;

/**
 * The edges of "published only once it answered" — each one a way the rule could be read
 * too strictly (a real participant vanishes) or too loosely (a dead one lingers).
 */
describe('bootstrap status — edges of the publish rule', () => {
	it('keeps a configured row visible even while it has never answered', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, ADDR, PEER, 'error', 'address is not routable from this host', null, 'configured');
		expect(shown(tracker)).toEqual([ADDR]);
	});

	it('publishes an address that was only ever announced once its dial answers', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.markPending(NET, ADDR, PEER, 'discovered');
		expect(shown(tracker)).toEqual([]);
		tracker.recordOutcome(NET, ADDR, PEER, 'connected', null, PEER, 'discovered');
		expect(shown(tracker)).toEqual([ADDR]);
	});

	it('takes a verified row back off the list when the address turns out to be somebody else', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, ADDR, PEER, 'connected', null, PEER, 'discovered');
		expect(shown(tracker)).toEqual([ADDR]);
		tracker.deletePeer(NET, ADDR);
		expect(shown(tracker)).toEqual([]);
	});

	it('records a mismatch as the identity that actually answered', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, ADDR, PEER, 'connected', null, PEER, 'discovered');
		tracker.recordOutcome(NET, ADDR, PEER, 'identity-mismatch', 'expected one, got another', OTHER, 'discovered');
		const row = ((tracker as any).stats.get(NET) as Map<string, { actualPeerID: string }>).values().next().value;
		expect(row?.actualPeerID).toBe(OTHER);
	});

	it('does not let a hidden flood push a live participant off the list', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.setMembersProvider(() => new Set([PEER]));
		tracker.recordOutcome(NET, ADDR, PEER, 'connected', null, PEER, 'discovered');
		for (let i = 0; i < 400; i++) tracker.markPending(NET, `/ip4/198.51.100.${i % 250}/tcp/${9000 + i}/p2p/${OTHER}`, OTHER, 'discovered');
		expect(shown(tracker)).toEqual([ADDR]);
		expect(stored(tracker)).toBeLessThanOrEqual(257);
	});

	it('forgets everything about a network that was left', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, ADDR, PEER, 'connected', null, PEER, 'discovered');
		tracker.resetNetwork(NET);
		expect(tracker.getStatus(NET)).toBe(null);
		expect(stored(tracker)).toBe(0);
	});

	it('lets a peer that answers again after expiry come straight back', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, ADDR, PEER, 'connected', null, PEER, 'discovered');
		tracker.sweepStale(TTL, () => false, Date.now() + TTL + 60_000);
		expect(shown(tracker)).toEqual([]);
		tracker.recordOutcome(NET, ADDR, PEER, 'connected', null, PEER, 'discovered');
		expect(shown(tracker)).toEqual([ADDR]);
	});

	it('starts the clock again for the peer that came back, so it does not vanish next tick', () => {
		const tracker = new BootstrapStatusTracker();
		const answeredAt = Date.now();
		tracker.recordOutcome(NET, ADDR, PEER, 'connected', null, PEER, 'discovered');
		tracker.sweepStale(TTL, () => false, answeredAt + TTL + 60_000);
		tracker.recordOutcome(NET, ADDR, PEER, 'connected', null, PEER, 'discovered');
		// Measured from the answer that brought it back, not from the first one — the row is
		// only as good as its NEW clock, and a sweep a moment later must not undo the return.
		tracker.sweepStale(TTL, () => false, Date.now() + TTL - 60_000);
		expect(shown(tracker)).toEqual([ADDR]);
	});

	it('stops calling a configured peer connected once the recovery dial is refused', () => {
		// Found live: the node went to zero connections, dialled its configured bootstrap
		// every 30 s, got ECONNREFUSED every time — and the participant list kept the row
		// green, because that loop walks addresses and had nowhere to report to.
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, ADDR, PEER, 'connected', null, PEER, 'configured');
		expect(tracker.getStatus(NET)!.peers[0]!.status).toBe('connected');

		tracker.recordAddressUnreachable(ADDR, 'connect ECONNREFUSED');

		const row = tracker.getStatus(NET)!.peers[0]!;
		expect(row.status).toBe('timeout');
		expect(row.lastError).toBe('connect ECONNREFUSED');
	});

	it('leaves the staleness clock alone when a recovery dial fails', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, ADDR, PEER, 'connected', null, PEER, 'configured');
		const clockBefore = (((tracker as any).stats.get(NET) as Map<string, { staleSince: number }>).values().next().value as { staleSince: number }).staleSince;
		tracker.recordAddressUnreachable(ADDR, 'connect ECONNREFUSED');
		const clockAfter = (((tracker as any).stats.get(NET) as Map<string, { staleSince: number }>).values().next().value as { staleSince: number }).staleSince;
		expect(clockAfter).toBe(clockBefore);
	});

	it('says nothing about a discovered row, which this loop does not speak for', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, ADDR, PEER, 'connected', null, PEER, 'discovered');
		tracker.recordAddressUnreachable(ADDR, 'connect ECONNREFUSED');
		expect(tracker.getStatus(NET)!.peers[0]!.status).toBe('connected');
	});
});
