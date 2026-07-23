import { describe, it, expect } from 'bun:test';
import { classifyBootstrapError, extractActualPeerID } from '../../../src/protocol/network.ts';
import { BootstrapStatusTracker } from '../../../src/protocol/bootstrap-status.ts';

// Deterministic unit tests for the bootstrap-peer dial classification — the pure
// logic that decides whether a failed bootstrap dial is an identity-mismatch (stale
// /p2p/<id>), a timeout (unreachable), or a generic error. This replaces the old
// scripts/simulate-stale-bootstrap.mjs manual helper, which exercised the same three
// outcomes against a live backend (flaky, needed a real reachable peer for "connected").
//
// PeerIDs below are deliberate fake placeholders — never real production nodes.

const ACTUAL_ID = '12D3KooWActuaLActuaLActuaLActuaLActuaLActuaLActuaLAA';
const EXPECTED_ID = '12D3KooWExpecTExpecTExpecTExpecTExpecTExpecTExpecTEE';
// libp2p Noise plaintext shape: "Payload identity key <ACTUAL> does not match expected remote identity key <EXPECTED>"
const MISMATCH_MSG = `Payload identity key ${ACTUAL_ID} does not match expected remote identity key ${EXPECTED_ID}`;

describe('classifyBootstrapError', () => {
	it('classifies a Noise identity-key mismatch as identity-mismatch', () => {
		expect(classifyBootstrapError(MISMATCH_MSG)).toBe('identity-mismatch');
	});

	it('classifies every libp2p timeout phrasing as timeout', () => {
		expect(classifyBootstrapError('The operation timed out')).toBe('timeout');
		expect(classifyBootstrapError('The operation was aborted')).toBe('timeout');
		expect(classifyBootstrapError('TimeoutError: dial aborted after 30000ms')).toBe('timeout');
	});

	it('classifies any other failure as a generic error', () => {
		expect(classifyBootstrapError('connection refused')).toBe('error');
		expect(classifyBootstrapError('no transport available for address')).toBe('error');
		expect(classifyBootstrapError('protocol negotiation failed')).toBe('error');
	});

	it('treats an empty message as error', () => {
		expect(classifyBootstrapError('')).toBe('error');
	});

	it('prefers identity-mismatch over timeout when both phrases co-occur', () => {
		// Precedence guard: an identity-mismatch that also mentions a timeout must stay
		// a mismatch — the configured peerID is stale regardless of the slow dial.
		expect(classifyBootstrapError(`${MISMATCH_MSG} (the dial timed out once first)`)).toBe('identity-mismatch');
	});
});

describe('extractActualPeerID', () => {
	it('pulls the actual peerID out of a mismatch message', () => {
		expect(extractActualPeerID(MISMATCH_MSG)).toBe(ACTUAL_ID);
	});

	it('returns null when the message is not a Noise identity mismatch', () => {
		expect(extractActualPeerID('connection refused')).toBe(null);
		expect(extractActualPeerID('')).toBe(null);
	});

	it('returns null when the mismatch message lacks the Payload-identity-key prefix', () => {
		// Shape guard: a different phrasing must not yield a confident (wrong) replacement peerID.
		expect(extractActualPeerID('does not match expected remote identity key only')).toBe(null);
	});
});

describe('BootstrapStatusTracker.deleteDiscoveredByPeerID', () => {
	const NET_A = 'netAAAA';
	const NET_B = 'netBBBB';
	const DEAD_ID = '12D3KooWDeadDeadDeadDeadDeadDeadDeadDeadDeadDeadDD';
	const LIVE_ID = '12D3KooWLiveLiveLiveLiveLiveLiveLiveLiveLiveLiveLL';
	const DEAD_ADDR_1 = `/ip4/192.0.2.10/tcp/9090/p2p/${DEAD_ID}`;
	const DEAD_ADDR_2 = `/ip4/192.0.2.11/tcp/9090/p2p/${DEAD_ID}`;
	const LIVE_ADDR = `/ip4/192.0.2.20/tcp/9090/p2p/${LIVE_ID}`;

	it('removes discovered rows for the peer across all networks, keeps other peers', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET_A, DEAD_ADDR_1, DEAD_ID, 'timeout', 'The operation timed out', null, 'discovered');
		tracker.recordOutcome(NET_A, LIVE_ADDR, LIVE_ID, 'connected', null, null, 'discovered');
		tracker.recordOutcome(NET_B, DEAD_ADDR_2, DEAD_ID, 'timeout', 'The operation timed out', null, 'discovered');

		tracker.deleteDiscoveredByPeerID(DEAD_ID);

		expect(tracker.getStatus(NET_A)?.peers.map(p => p.multiaddr)).toEqual([LIVE_ADDR]);
		expect(tracker.getStatus(NET_B)).toBe(null); // network map emptied entirely
	});

	it('keeps configured rows for the same peer identity', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET_A, DEAD_ADDR_1, DEAD_ID, 'timeout', 'The operation timed out', null, 'configured');
		tracker.recordOutcome(NET_A, DEAD_ADDR_2, DEAD_ID, 'timeout', 'The operation timed out', null, 'discovered');

		tracker.deleteDiscoveredByPeerID(DEAD_ID);

		expect(tracker.getStatus(NET_A)?.peers.map(p => p.multiaddr)).toEqual([DEAD_ADDR_1]);
	});

	it('matches rows by actualPeerID as well and fires onStatusChange per changed network', () => {
		const tracker = new BootstrapStatusTracker();
		const events: string[] = [];
		tracker.setOnChange(networkID => events.push(networkID));
		// Row whose expectedPeerID is null but whose dial revealed the dead identity.
		tracker.recordOutcome(NET_A, '/ip4/192.0.2.30/tcp/9090', null, 'identity-mismatch', 'mismatch', DEAD_ID, 'discovered');
		tracker.recordOutcome(NET_B, LIVE_ADDR, LIVE_ID, 'connected', null, null, 'discovered');
		events.length = 0;

		tracker.deleteDiscoveredByPeerID(DEAD_ID);

		expect(tracker.getStatus(NET_A)).toBe(null);
		expect(events).toEqual([NET_A]); // untouched NET_B emits nothing
	});
});

describe('BootstrapStatusTracker.sweepStale', () => {
	const NET = 'netAAAA';
	const TTL = 30 * 60_000;
	const DEAD_ID = '12D3KooWDeadDeadDeadDeadDeadDeadDeadDeadDeadDeadDD';
	const LIVE_ID = '12D3KooWLiveLiveLiveLiveLiveLiveLiveLiveLiveLiveLL';
	const DEAD_ADDR = `/ip4/192.0.2.10/tcp/9090/p2p/${DEAD_ID}`;
	const LIVE_ADDR = `/ip4/192.0.2.20/tcp/9090/p2p/${LIVE_ID}`;
	const CONF_ADDR = `/ip4/192.0.2.30/tcp/9090/p2p/${DEAD_ID}`;

	it('drops stale discovered rows, keeps fresh, connected and configured ones', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, DEAD_ADDR, DEAD_ID, 'timeout', 'The operation timed out', null, 'discovered');
		tracker.recordOutcome(NET, LIVE_ADDR, LIVE_ID, 'connected', null, null, 'discovered');
		tracker.recordOutcome(NET, CONF_ADDR, DEAD_ID, 'timeout', 'The operation timed out', null, 'configured');
		const past = Date.now() + TTL + 60_000; // both rows are then older than TTL

		tracker.sweepStale(TTL, pid => pid === LIVE_ID, past);

		const addrs = tracker
			.getStatus(NET)
			?.peers.map(p => p.multiaddr)
			.sort();
		// DEAD discovered row expired; LIVE row survives via connection; configured row untouchable.
		expect(addrs).toEqual([CONF_ADDR, LIVE_ADDR].sort());
	});

	it('drops a row frozen at connected once the peer has no live connection', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, DEAD_ADDR, DEAD_ID, 'connected', null, null, 'discovered');

		tracker.sweepStale(TTL, () => false, Date.now() + TTL + 60_000);

		expect(tracker.getStatus(NET)).toBe(null);
	});

	it('keeps rows within the TTL even without a connection', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, DEAD_ADDR, DEAD_ID, 'timeout', 'The operation timed out', null, 'discovered');

		tracker.sweepStale(TTL, () => false); // real clock — row was written moments ago

		expect(tracker.getStatus(NET)?.peers.length).toBe(1);
	});
});
