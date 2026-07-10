/**
 * Peer fallback loop shared by the search-result actions (add to sharing, load detail).
 * Pure module — no Svelte imports — so the retry classification is unit-testable.
 */

/** A single peer offering a LISH, as listed in a search result. */
export interface PeerRef {
	peerID: string;
	networkID: string;
}

/** Progress info for the "trying peer X (n/m)" indicator; null clears it. */
export interface TryingPeerInfo {
	tail: string;
	current: number;
	total: number;
}

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
 */
export function isRetryablePeerError(error: unknown): boolean {
	if ((error as { tryNextPeer?: boolean } | null)?.tryNextPeer) return true;
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string' && code.startsWith('PEER_');
}

/**
 * Try each peer offering a LISH in turn until one answers, returning its result.
 * Realises the card's "take it from the first peer; if it times out, the next, and so on"
 * fallback: `getPeerLish` / `addPeerLish` target a single peer, so the loop provides the
 * resilience. Only retryable failures (see {@link isRetryablePeerError}) move on to the
 * next peer — local errors surface immediately. Throws the last error if every peer failed;
 * an empty peer list rejects immediately, so callers should guard it with their own UX.
 */
export async function withPeerFallback<T>(peers: readonly PeerRef[], op: (peerID: string, networkID: string) => Promise<T>, onTrying?: (info: TryingPeerInfo | null) => void, deadlineMs: number = FALLBACK_DEADLINE_MS): Promise<T> {
	let lastErr: unknown = new Error('no peers');
	const deadline = performance.now() + deadlineMs;
	try {
		for (let i = 0; i < peers.length; i++) {
			if (i > 0 && performance.now() >= deadline) break;
			const p = peers[i]!;
			onTrying?.({ tail: '…' + p.peerID.slice(-6), current: i + 1, total: peers.length });
			try {
				return await op(p.peerID, p.networkID);
			} catch (e) {
				if (!isRetryablePeerError(e)) throw e;
				lastErr = e;
			}
		}
		throw lastErr;
	} finally {
		onTrying?.(null);
	}
}
