/**
 * Peer fallback loop shared by the search-result actions (add to sharing, load detail).
 * Pure module — no Svelte imports — so the retry classification is unit-testable.
 */

/** A single peer offering a LISH, as listed in a search result. */
export interface PeerRef {
	peerID: string;
	networkID: string;
}

/** Per-peer attempt outcome shown in the peer table row; null clears an in-flight state. */
export type PeerAttemptStatus = 'downloading' | 'downloaded' | 'unavailable';

/**
 * Overall cap on the fallback loop — with many dead peers each attempt can take
 * ~10s dial + up to 30s manifest timeout, so stop starting new attempts after this long.
 */
export const FALLBACK_DEADLINE_MS = 5 * 60 * 1000;

/**
 * True for errors where trying the next peer can help: any peer-side protocol error
 * (`PEER_*` code — unreachable, stopped sharing, busy, I/O trouble) or an error the
 * caller explicitly flagged `tryNextPeer`. Local errors (e.g. LISH already added)
 * are not retryable — they would fail identically on every peer.
 *
 * `LISH_CHUNK_SIZE_TOO_LARGE` is retryable on purpose: a single malicious peer could
 * spoof an oversized manifest to block the row, so later peers get their chance. When
 * the LISH genuinely exceeds the local limit every peer throws the same code, the loop
 * exhausts and the user still sees the specific limit error (the last one thrown).
 */
export function isRetryablePeerError(error: unknown): boolean {
	if ((error as { tryNextPeer?: boolean } | null)?.tryNextPeer) return true;
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code !== 'string') return false;
	return code.startsWith('PEER_') || code === 'LISH_CHUNK_SIZE_TOO_LARGE';
}

/**
 * Try each peer offering a LISH in turn until one answers, returning its result.
 * Realises the card's "take it from the first peer; if it times out, the next, and so on"
 * fallback: `getPeerLish` / `addPeerLish` target a single peer, so the loop provides the
 * resilience. Only retryable failures (see {@link isRetryablePeerError}) move on to the
 * next peer — local errors surface immediately. Throws the last error if every peer failed;
 * an empty peer list rejects immediately, so callers should guard it with their own UX.
 *
 * `onStatus` reports per-peer progress for the peer table rows: `downloading` when an
 * attempt starts, then `downloaded` or `unavailable` with its outcome. Statuses are not
 * cleared when the loop ends — the outcome stays visible — except after a non-retryable
 * error, where the in-flight peer gets `null`: the failure is local, so branding the peer
 * unavailable would be wrong. Callers reset all statuses when they start a new run.
 */
export async function withPeerFallback<T>(peers: readonly PeerRef[], op: (peerID: string, networkID: string) => Promise<T>, onStatus?: (index: number, status: PeerAttemptStatus | null) => void, deadlineMs: number = FALLBACK_DEADLINE_MS): Promise<T> {
	let lastErr: unknown = new Error('no peers');
	const deadline = performance.now() + deadlineMs;
	for (let i = 0; i < peers.length; i++) {
		if (i > 0 && performance.now() >= deadline) break;
		const p = peers[i]!;
		onStatus?.(i, 'downloading');
		try {
			const result = await op(p.peerID, p.networkID);
			onStatus?.(i, 'downloaded');
			return result;
		} catch (e) {
			if (!isRetryablePeerError(e)) {
				onStatus?.(i, null);
				throw e;
			}
			onStatus?.(i, 'unavailable');
			lastErr = e;
		}
	}
	throw lastErr;
}
