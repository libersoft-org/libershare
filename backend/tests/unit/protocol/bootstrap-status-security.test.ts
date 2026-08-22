import { describe, it, expect } from 'bun:test';
import { BootstrapStatusTracker } from '../../../src/protocol/bootstrap-status.ts';

const NET = 'net-sec';
const MEMBER = '12D3KooWAnfqA6Wap96ixVfxhHeGUDMriBG4Nncp5tqu8q71EVv2';
const ATTACKER = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
const MEMBER_ADDR = `/ip4/203.0.113.5/tcp/9090/p2p/${MEMBER}`;
const TTL = 30 * 60_000;
const shown = (t: BootstrapStatusTracker): string[] => (t.getStatus(NET)?.peers ?? []).map(p => p.multiaddr);
const stored = (t: BootstrapStatusTracker): number => ((t as any).stats.get(NET) as Map<string, unknown> | undefined)?.size ?? 0;

/**
 * What a hostile announcer can and cannot buy. Everything the list grants — being shown,
 * surviving the sweep, outranking others at the cap — has to rest on the identity a dial
 * PROVED, never on the one an address claims, because the claim is free to make.
 */
describe('bootstrap status — what an announcer cannot claim', () => {
	it('cannot get an address listed by naming a live member in it', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.setMembersProvider(() => new Set([MEMBER]));
		// The address is invented; only its /p2p/ suffix names somebody real.
		const invented = `/ip4/198.51.100.66/tcp/9090/p2p/${MEMBER}`;
		tracker.markPending(NET, invented, MEMBER, 'discovered');
		tracker.recordOutcome(NET, invented, MEMBER, 'timeout', 'no answer', null, 'discovered');
		expect(shown(tracker)).toEqual([]);
	});

	it('cannot make an invented address outlive the sweep by naming a member', () => {
		const tracker = new BootstrapStatusTracker();
		const invented = `/ip4/198.51.100.67/tcp/9090/p2p/${MEMBER}`;
		tracker.recordOutcome(NET, invented, MEMBER, 'timeout', 'no answer', null, 'discovered');
		tracker.sweepStale(TTL, (_net, pid) => pid === MEMBER, Date.now() + TTL + 60_000);
		expect(shown(tracker)).toEqual([]);
	});

	it('cannot push a verified member off the list with a flood of claims', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.setMembersProvider(() => new Set([MEMBER]));
		tracker.recordOutcome(NET, MEMBER_ADDR, MEMBER, 'connected', null, MEMBER, 'discovered');
		for (let i = 0; i < 600; i++) {
			const a = `/ip4/198.51.100.${i % 250}/tcp/${9000 + i}/p2p/${MEMBER}`;
			tracker.markPending(NET, a, MEMBER, 'discovered');
			tracker.recordOutcome(NET, a, MEMBER, 'timeout', 'no answer', null, 'discovered');
		}
		expect(shown(tracker)).toEqual([MEMBER_ADDR]);
		expect(stored(tracker)).toBeLessThanOrEqual(257);
	});

	it('cannot outrank a member at the cap by claiming to be one', () => {
		// The rows that reach the cap's ranking are the ones that ANSWERED, so this is the
		// case where the claim could still buy something: a peer that is real but not a
		// member of this network, against one that is. Only the proven identity counts.
		const tracker = new BootstrapStatusTracker();
		tracker.setMembersProvider(() => new Set([MEMBER]));
		tracker.recordOutcome(NET, MEMBER_ADDR, MEMBER, 'connected', null, MEMBER, 'discovered');
		// 300 endpoints that really do answer — as the attacker — while claiming the member.
		for (let i = 0; i < 300; i++) {
			const a = `/ip4/198.51.100.${i % 250}/tcp/${7000 + i}/p2p/${MEMBER}`;
			tracker.recordOutcome(NET, a, MEMBER, 'connected', null, ATTACKER, 'discovered');
		}
		expect(shown(tracker)).toContain(MEMBER_ADDR);
	});

	it('cannot rewrite whose address it is without a dial that proves it', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, MEMBER_ADDR, MEMBER, 'connected', null, MEMBER, 'discovered');
		// Somebody re-announces the same endpoint claiming it belongs to them.
		tracker.markPending(NET, MEMBER_ADDR, ATTACKER, 'discovered');
		tracker.recordOutcome(NET, MEMBER_ADDR, ATTACKER, 'timeout', 'no answer', null, 'discovered');
		const row = ((tracker as any).stats.get(NET) as Map<string, { actualPeerID: string | null }>).values().next().value;
		expect(row?.actualPeerID).toBe(MEMBER);
	});

	it('cannot dress a gossip-learned address up as the user’s own configuration', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.markPending(NET, MEMBER_ADDR, MEMBER, 'discovered');
		const row = ((tracker as any).stats.get(NET) as Map<string, { origin: string }>).values().next().value;
		expect(row?.origin).toBe('discovered');
	});

	it('cannot keep a peer listed after it stopped taking part, however loudly it is named', () => {
		const tracker = new BootstrapStatusTracker();
		let isMember = true;
		tracker.setMembersProvider(() => (isMember ? new Set([MEMBER]) : new Set<string>()));
		tracker.recordOutcome(NET, MEMBER_ADDR, MEMBER, 'connected', null, MEMBER, 'discovered');
		const answeredAt = Date.now();
		isMember = false;
		for (let i = 0; i < 20; i++) tracker.markPending(NET, MEMBER_ADDR, MEMBER, 'discovered');
		tracker.sweepStale(TTL, () => false, answeredAt + TTL + 60_000);
		expect(shown(tracker)).toEqual([]);
	});
});
