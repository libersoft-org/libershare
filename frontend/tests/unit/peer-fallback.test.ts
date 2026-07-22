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
import { withPeerFallback, isRetryablePeerError, type PeerRef, type PeerAttemptStatus } from '../../src/scripts/peerFallback.ts';

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
	// A spoofed oversized manifest must not block later honest peers; a genuine
	// over-limit LISH still surfaces the same code as the loop's last error.
	expect(isRetryablePeerError(codedError('LISH_CHUNK_SIZE_TOO_LARGE'))).toBe(true);
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

test('reports per-peer statuses across the fallback', async () => {
	const seen: Array<[number, PeerAttemptStatus | null]> = [];
	await withPeerFallback(
		PEERS,
		async peerID => {
			if (peerID === PEERS[0]!.peerID) throw codedError('PEER_UNREACHABLE');
			return 'ok';
		},
		(index, status) => seen.push([index, status])
	);
	expect(seen).toEqual([
		[0, 'downloading'],
		[0, 'unavailable'],
		[1, 'downloading'],
		[1, 'downloaded'],
	]);
});

test('rejects immediately on an empty peer list', async () => {
	await expect(withPeerFallback([], async () => 'never')).rejects.toThrow('no peers');
});

test('marks every peer unavailable when all fail', async () => {
	const seen: Array<[number, PeerAttemptStatus | null]> = [];
	await expect(
		withPeerFallback(
			PEERS,
			async () => {
				throw codedError('PEER_UNREACHABLE');
			},
			(index, status) => seen.push([index, status])
		)
	).rejects.toThrow('PEER_UNREACHABLE');
	expect(seen).toEqual([
		[0, 'downloading'],
		[0, 'unavailable'],
		[1, 'downloading'],
		[1, 'unavailable'],
	]);
});

test('clears the in-flight status on a local error', async () => {
	const seen: Array<[number, PeerAttemptStatus | null]> = [];
	await expect(
		withPeerFallback(
			PEERS,
			async () => {
				throw codedError('LISH_ALREADY_EXISTS');
			},
			(index, status) => seen.push([index, status])
		)
	).rejects.toThrow('LISH_ALREADY_EXISTS');
	expect(seen).toEqual([
		[0, 'downloading'],
		[0, null],
	]);
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
