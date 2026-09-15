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
 * canListSharesTo is the softer LISTING gate: a peer sharing a joined topic is always
 * served; a peer that is not may still be served, but only inside the SUBSCRIBE
 * propagation window measured from when its connection opened (so unicast search works
 * before SUBSCRIBE syncs). Excluded regardless: peers we deliberately left (still
 * redial-suppressed), infrastructure peers off our topics, and holding no lishnet.
 *
 * `connectionAgeSec` models how long ago the peer's connection opened; null means no
 * connection at all (not undefined — that would just re-select the default).
 */
describe('Network.canListSharesTo', () => {
	function bareNetwork(suppressed: string[], topics: string[], infra: string[] = [], subscribers: string[] = [], connectionAgeSec: number | null = 0) {
		const network = Object.create(Network.prototype) as Network;
		(network as any).redialSuppressedByNet = new Map([['net-x', new Set<string>(suppressed)]]);
		(network as any).pubsub = {
			getTopics: () => topics,
			getSubscribers: () => subscribers.map(p => ({ toString: () => p })),
		};
		(network as any).isBootstrapOrRelayPeer = (pid: string) => infra.includes(pid);
		(network as any).node = {
			getConnections: () => (connectionAgeSec === null ? [] : [{ remotePeer: { toString: () => 'peer-a' }, timeline: { open: Date.now() - connectionAgeSec * 1000 } }]),
		};
		return network;
	}

	it('allows a fresh peer while we hold a joined lishnet topic (subscribe may lag)', () => {
		const net = bareNetwork([], [lishTopic('net-a')]);
		expect((net as any).canListSharesTo('peer-a')).toBe(true);
	});

	it('refuses a long-connected peer that shares no joined topic', () => {
		// The leave-network hole: we stay in another lishnet, the leave-time disconnect
		// missed this peer, so nothing but the grace window stops it listing our shares.
		const net = bareNetwork([], [lishTopic('net-a')], [], [], 600);
		expect((net as any).canListSharesTo('peer-a')).toBe(false);
	});

	it('allows a long-connected peer that does share a joined topic', () => {
		const net = bareNetwork([], [lishTopic('net-a')], [], ['peer-a'], 600);
		expect((net as any).canListSharesTo('peer-a')).toBe(true);
	});

	it('refuses a peer with no open connection', () => {
		const net = bareNetwork([], [lishTopic('net-a')], [], [], null);
		expect((net as any).canListSharesTo('peer-a')).toBe(false);
	});

	it('refuses a peer whose oldest connection carries no open timestamp', () => {
		// An undated connection is not evidence of freshness, and it must stay that way
		// however many dated connections the peer opens alongside it — the grace window
		// is bought by the OLDEST connection, so a second dial cannot renew it.
		const network = Object.create(Network.prototype) as Network;
		(network as any).redialSuppressedByNet = new Map<string, Set<string>>();
		(network as any).pubsub = { getTopics: () => [lishTopic('net-a')], getSubscribers: () => [] };
		(network as any).isBootstrapOrRelayPeer = (): boolean => false;
		(network as any).node = {
			getConnections: () => [
				{ remotePeer: { toString: () => 'peer-a' }, timeline: {} },
				{ remotePeer: { toString: () => 'peer-a' }, timeline: { open: Date.now() } },
			],
		};

		expect((network as any).connectionAgeMs('peer-a')).toBe(Infinity);
		expect((network as any).canListSharesTo('peer-a')).toBe(false);
	});

	it('refuses a peer we deliberately left (still suppressed)', () => {
		const net = bareNetwork(['peer-left'], [lishTopic('net-a')]);
		expect((net as any).canListSharesTo('peer-left')).toBe(false);
	});

	it('refuses when we hold no lishnet topic', () => {
		const net = bareNetwork([], []);
		expect((net as any).canListSharesTo('peer-a')).toBe(false);
	});

	it('refuses a kept infrastructure peer that no longer shares a joined topic', () => {
		// A relay/bootstrap of a left network is kept connected but must not browse our
		// shares unless it currently shares a joined topic.
		const net = bareNetwork([], [lishTopic('net-a')], ['relay-x'], []);
		expect((net as any).canListSharesTo('relay-x')).toBe(false);
	});

	it('allows an infrastructure peer that still shares a joined topic', () => {
		const net = bareNetwork([], [lishTopic('net-a')], ['relay-x'], ['relay-x']);
		expect((net as any).canListSharesTo('relay-x')).toBe(true);
	});
});
