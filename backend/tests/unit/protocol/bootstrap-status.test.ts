import { describe, it, expect } from 'bun:test';
import { classifyBootstrapError, extractActualPeerID } from '../../../src/protocol/network.ts';

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
