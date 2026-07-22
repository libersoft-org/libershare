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
 * canListSharesTo is the softer LISTING gate: allow any peer while we hold a joined
 * lishnet topic (so unicast search works before SUBSCRIBE syncs), except peers we
 * deliberately left (still redial-suppressed) and except when we hold no lishnet.
 */
describe('Network.canListSharesTo', () => {
	function bareNetwork(suppressed: string[], topics: string[]) {
		const network = Object.create(Network.prototype) as Network;
		(network as any).redialSuppressedByNet = new Map([['net-x', new Set<string>(suppressed)]]);
		(network as any).pubsub = { getTopics: () => topics };
		return network;
	}

	it('allows a fresh peer while we hold a joined lishnet topic (subscribe may lag)', () => {
		const net = bareNetwork([], [lishTopic('net-a')]);
		expect((net as any).canListSharesTo('peer-a')).toBe(true);
	});

	it('refuses a peer we deliberately left (still suppressed)', () => {
		const net = bareNetwork(['peer-left'], [lishTopic('net-a')]);
		expect((net as any).canListSharesTo('peer-left')).toBe(false);
	});

	it('refuses when we hold no lishnet topic', () => {
		const net = bareNetwork([], []);
		expect((net as any).canListSharesTo('peer-a')).toBe(false);
	});
});
