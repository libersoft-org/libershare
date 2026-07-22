import { describe, it, expect } from 'bun:test';
import { serveGateBlocks } from '../../../src/protocol/lish-protocol.ts';

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
