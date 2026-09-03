import { describe, it, expect } from 'bun:test';
import { serveGateBlocks } from '../../../src/protocol/lish-protocol.ts';
import { Network } from '../../../src/protocol/network.ts';
import { lishTopic } from '../../../src/protocol/constants.ts';

/**
 * The unicast LISH serve-gate must fail CLOSED: a stream that could not be mapped
 * to a peer id (remotePeerID absent) is refused exactly like a not-shared peer,
 * never served. Only when no gate is configured (sharesNetworkWith undefined) is
 * everything allowed.
 */
describe('serveGateBlocks', () => {
	it('does not block when no gate is configured', () => {
		expect(serveGateBlocks(undefined, 'peer-a')).toBe(false);
		expect(serveGateBlocks(undefined, undefined)).toBe(false);
	});

	it('does not block a peer we share a joined lishnet with', () => {
		expect(serveGateBlocks(() => true, 'peer-a')).toBe(false);
	});

	it('blocks a peer we do not share a joined lishnet with', () => {
		expect(serveGateBlocks(() => false, 'peer-a')).toBe(true);
	});

	it('blocks (fail closed) when the remote peer id is unknown', () => {
		expect(serveGateBlocks(() => true, undefined)).toBe(true);
		expect(serveGateBlocks(() => true, '')).toBe(true);
	});
});

/**
 * canListSharesTo is the softer LISTING gate. Soft means it accepts wider evidence of
 * lishnet membership than the strict data gate — the live gossipsub subscriber snapshot
 * OR peer-announce's recently-seen member union — not that it drops the membership
 * requirement. A peer with no membership evidence learns nothing about what we share,
 * whether it is a stranger on a bare transport connection or one we deliberately left
 * whose in-memory redial suppression a restart has since dropped.
 */
describe('Network.canListSharesTo', () => {
	function bareNetwork(opts: { suppressed?: string[]; topics?: string[]; infra?: string[]; subscribers?: string[]; recentMembers?: Record<string, string[]> }) {
		const network = Object.create(Network.prototype) as Network;
		(network as any).redialSuppressedByNet = new Map([['net-x', new Set<string>(opts.suppressed ?? [])]]);
		(network as any).pubsub = {
			getTopics: () => opts.topics ?? [],
			getSubscribers: () => (opts.subscribers ?? []).map(p => ({ toString: () => p })),
		};
		(network as any).isBootstrapOrRelayPeer = (pid: string) => (opts.infra ?? []).includes(pid);
		(network as any).peerAnnounce = { getRecentMembers: (topic: string) => opts.recentMembers?.[topic] ?? [] };
		return network;
	}

	it('allows a peer subscribed to a lishnet we are in', () => {
		const net = bareNetwork({ topics: [lishTopic('net-a')], subscribers: ['peer-a'] });
		expect((net as any).canListSharesTo('peer-a')).toBe(true);
	});

	it('allows a member whose subscription is missing from the live snapshot', () => {
		// The exact window the unicast search fallback targets: peer-announce still
		// remembers it as a subscriber of our topic, gossipsub does not list it yet.
		const net = bareNetwork({ topics: [lishTopic('net-a')], subscribers: [], recentMembers: { [lishTopic('net-a')]: ['peer-a'] } });
		expect((net as any).canListSharesTo('peer-a')).toBe(true);
	});

	it('refuses a connected peer with no membership in any lishnet we are in', () => {
		const net = bareNetwork({ topics: [lishTopic('net-a')], subscribers: ['peer-member'] });
		expect((net as any).canListSharesTo('peer-stranger')).toBe(false);
	});

	it('refuses a peer remembered only under a lishnet we are no longer in', () => {
		// Recent membership is read per joined topic, so a left lishnet grants nothing
		// even before peer-announce prunes its member map.
		const net = bareNetwork({ topics: [lishTopic('net-a')], recentMembers: { [lishTopic('net-left')]: ['peer-left'] } });
		expect((net as any).canListSharesTo('peer-left')).toBe(false);
	});

	it('refuses a peer we deliberately left (still suppressed)', () => {
		const net = bareNetwork({ suppressed: ['peer-left'], topics: [lishTopic('net-a')], subscribers: ['peer-left'] });
		expect((net as any).canListSharesTo('peer-left')).toBe(false);
	});

	it('refuses when we hold no lishnet topic', () => {
		const net = bareNetwork({});
		expect((net as any).canListSharesTo('peer-a')).toBe(false);
	});

	it('refuses a kept infrastructure peer that no longer shares a joined topic', () => {
		// A relay/bootstrap of a left network is kept connected but must not browse our
		// shares unless it currently shares a joined topic — recent membership alone
		// does not lift it.
		const net = bareNetwork({ topics: [lishTopic('net-a')], infra: ['relay-x'], recentMembers: { [lishTopic('net-a')]: ['relay-x'] } });
		expect((net as any).canListSharesTo('relay-x')).toBe(false);
	});

	it('allows an infrastructure peer that still shares a joined topic', () => {
		const net = bareNetwork({ topics: [lishTopic('net-a')], infra: ['relay-x'], subscribers: ['relay-x'] });
		expect((net as any).canListSharesTo('relay-x')).toBe(true);
	});
});
