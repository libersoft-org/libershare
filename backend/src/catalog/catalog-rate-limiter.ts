/** Hard limits for catalog ingestion — ops throughput and per-network size quotas. */
export const RATE_LIMITS = {
	maxOpsPerPeerPerMinute: 30,
	// Circuit breaker only. Sized so it cannot be exhausted by a handful of
	// Sybil peers each staying under the per-peer limit (shared-fate DoS) —
	// per-peer throttling is the primary defence.
	maxOpsGlobalPerMinute: 1000,
	maxEntriesPerPublisher: 1000,
	maxCatalogSize: 50_000,
} as const;

/** How often stale per-peer windows are swept out of the map. */
const SWEEP_INTERVAL_MS = 60_000;

/** Sliding-window rate limiter for inbound catalog ops (per-peer and global 1-minute windows). */
export class CatalogRateLimiter {
	private windows: Map<string, number[]> = new Map();
	private globalWindow: number[] = [];
	private lastSweep = 0;

	check(peerID: string): 'allow' | 'reject' {
		const now = Date.now();
		const cutoff = now - 60_000;
		this.sweep(now, cutoff);

		// Per-peer check
		let peerOps = this.windows.get(peerID);
		if (peerOps) {
			peerOps = peerOps.filter(t => t > cutoff);
			if (peerOps.length >= RATE_LIMITS.maxOpsPerPeerPerMinute) {
				this.windows.set(peerID, peerOps);
				return 'reject';
			}
		} else {
			peerOps = [];
		}

		// Global check
		this.globalWindow = this.globalWindow.filter(t => t > cutoff);
		if (this.globalWindow.length >= RATE_LIMITS.maxOpsGlobalPerMinute) return 'reject';

		// Record
		peerOps.push(now);
		this.windows.set(peerID, peerOps);
		this.globalWindow.push(now);
		return 'allow';
	}

	/** Drop peers whose window is empty — rotating Sybil peer IDs must not grow the map without bound. */
	private sweep(now: number, cutoff: number): void {
		if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
		this.lastSweep = now;
		for (const [peerID, times] of this.windows) {
			const alive = times.filter(t => t > cutoff);
			if (alive.length === 0) this.windows.delete(peerID);
			else this.windows.set(peerID, alive);
		}
	}

	reset(): void {
		this.windows.clear();
		this.globalWindow = [];
		this.lastSweep = 0;
	}
}
