/**
 * Unit tests for the search-result peer fallback loop in
 * `src/scripts/peerFallback.ts`.
 *
 * The retry classification decides whether an error from one peer should
 * abort the whole operation (local errors — the next peer would fail the
 * same way) or move on to the next peer (peer-side `PEER_*` protocol errors
 * and `tryNextPeer`-flagged errors). The module is pure, so it runs under
 * `bun test` without the Svelte runtime.
 */
import { test, expect } from 'bun:test';
import { withPeerFallback, isRetryablePeerError, type PeerRef, type TryingPeerInfo } from '../../src/scripts/peerFallback.ts';

const PEERS: PeerRef[] = [
	{ peerID: 'peer-one-aaaaaa', networkID: 'net-1' },
	{ peerID: 'peer-two-bbbbbb', networkID: 'net-1' },
];

function codedError(code: string): Error {
	return Object.assign(new Error(code), { code });
}

test('isRetryablePeerError classifies peer-side, flagged and local errors', () => {
	expect(isRetryablePeerError(codedError('PEER_UNREACHABLE'))).toBe(true);
	expect(isRetryablePeerError(codedError('PEER_LISH_NOT_SHARED'))).toBe(true);
	expect(isRetryablePeerError(codedError('PEER_BUSY'))).toBe(true);
	expect(isRetryablePeerError(Object.assign(new Error('declined'), { tryNextPeer: true }))).toBe(true);
	expect(isRetryablePeerError(codedError('LISH_ALREADY_EXISTS'))).toBe(false);
	expect(isRetryablePeerError(new Error('plain'))).toBe(false);
	expect(isRetryablePeerError(null)).toBe(false);
	expect(isRetryablePeerError({ code: 42 })).toBe(false);
});

test('tries the next peer when the first no longer shares the LISH', async () => {
	const tried: string[] = [];
	const result = await withPeerFallback(PEERS, async peerID => {
		tried.push(peerID);
		if (peerID === PEERS[0]!.peerID) throw codedError('PEER_LISH_NOT_SHARED');
		return 'detail';
	});
	expect(result).toBe('detail');
	expect(tried).toEqual([PEERS[0]!.peerID, PEERS[1]!.peerID]);
});

test('stops at the first peer on a local error', async () => {
	const tried: string[] = [];
	await expect(
		withPeerFallback(PEERS, async peerID => {
			tried.push(peerID);
			throw codedError('LISH_ALREADY_EXISTS');
		})
	).rejects.toThrow('LISH_ALREADY_EXISTS');
	expect(tried).toEqual([PEERS[0]!.peerID]);
});

test('tries the next peer on a tryNextPeer-flagged error', async () => {
	const tried: string[] = [];
	const result = await withPeerFallback(PEERS, async peerID => {
		tried.push(peerID);
		if (tried.length === 1) throw Object.assign(new Error('declined'), { tryNextPeer: true });
		return 'ok';
	});
	expect(result).toBe('ok');
	expect(tried.length).toBe(2);
});

test('throws the last peer error when every peer fails', async () => {
	await expect(
		withPeerFallback(PEERS, async peerID => {
			throw codedError(peerID === PEERS[0]!.peerID ? 'PEER_UNREACHABLE' : 'PEER_BUSY');
		})
	).rejects.toThrow('PEER_BUSY');
});

test('reports each tried peer and clears the indicator at the end', async () => {
	const seen: Array<TryingPeerInfo | null> = [];
	await withPeerFallback(
		PEERS,
		async peerID => {
			if (peerID === PEERS[0]!.peerID) throw codedError('PEER_UNREACHABLE');
			return 'ok';
		},
		info => seen.push(info)
	);
	expect(seen).toEqual([{ tail: '…aaaaaa', current: 1, total: 2 }, { tail: '…bbbbbb', current: 2, total: 2 }, null]);
});

test('rejects immediately on an empty peer list', async () => {
	await expect(withPeerFallback([], async () => 'never')).rejects.toThrow('no peers');
});

test('clears the indicator even when every peer fails', async () => {
	const seen: Array<TryingPeerInfo | null> = [];
	await expect(
		withPeerFallback(
			PEERS,
			async () => {
				throw codedError('PEER_UNREACHABLE');
			},
			info => seen.push(info)
		)
	).rejects.toThrow('PEER_UNREACHABLE');
	expect(seen[seen.length - 1]).toBeNull();
});

test('stops starting new attempts once the deadline has passed', async () => {
	const tried: string[] = [];
	await expect(
		withPeerFallback(
			PEERS,
			async peerID => {
				tried.push(peerID);
				throw codedError('PEER_UNREACHABLE');
			},
			undefined,
			-1
		)
	).rejects.toThrow('PEER_UNREACHABLE');
	// Deadline already expired — only the first peer gets an attempt.
	expect(tried).toEqual([PEERS[0]!.peerID]);
});
