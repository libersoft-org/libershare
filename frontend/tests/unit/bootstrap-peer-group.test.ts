/**
 * The bootstrap table summarises all addresses of one peer identity. It used to show the
 * healthiest one, so a peer reachable on one address stayed green while its other configured
 * addresses were broken.
 */
import { describe, expect, test } from 'bun:test';
import type { BootstrapPeerStatus } from '@shared';
import { bootstrapGroupKey, summarizeBootstrapGroup } from '../../src/scripts/bootstrapPeerGroup.ts';

const PEER = '12D3KooWExamplePeer';

function entry(status: BootstrapPeerStatus['status'], address = '/ip4/192.0.2.1/tcp/9090'): BootstrapPeerStatus {
	return { multiaddr: `${address}/p2p/${PEER}`, expectedPeerID: PEER, actualPeerID: null, status, origin: 'configured', lastError: null, updatedAt: 0 } as unknown as BootstrapPeerStatus;
}

describe('bootstrap group summary', () => {
	test('a working address does not hide a broken one', () => {
		expect(summarizeBootstrapGroup([entry('connected'), entry('timeout', '/ip4/192.0.2.2/tcp/9090')])).toEqual({ summary: 'partial', counts: { connected: 1, failing: 1, pending: 0 } });
		expect(summarizeBootstrapGroup([entry('connected'), entry('pending', '/ip4/192.0.2.2/tcp/9090')]).summary).toBe('partial');
	});

	test('every address working is healthy', () => {
		expect(summarizeBootstrapGroup([entry('connected'), entry('connected', '/ip4/192.0.2.2/tcp/9090')]).summary).toBe('healthy');
	});

	test('no working address with a failure is a problem, whatever the failure', () => {
		for (const status of ['identity-mismatch', 'timeout', 'error'] as const) expect(summarizeBootstrapGroup([entry(status), entry('pending', '/ip4/192.0.2.2/tcp/9090')]).summary).toBe('problem');
	});

	test('only pending, or nothing yet, is pending', () => {
		expect(summarizeBootstrapGroup([entry('pending')]).summary).toBe('pending');
		expect(summarizeBootstrapGroup([]).summary).toBe('pending');
	});

	test('a mismatched identity stays in the group it was expected in', () => {
		const mismatch = { ...entry('identity-mismatch'), actualPeerID: '12D3KooWSomebodyElse' } as BootstrapPeerStatus;
		expect(bootstrapGroupKey(mismatch)).toBe(PEER);
	});
});
