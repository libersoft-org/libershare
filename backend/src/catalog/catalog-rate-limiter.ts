export const RATE_LIMITS = {
	maxOpsPerPeerPerMinute: 10,
	maxOpsGlobalPerMinute: 100,
	maxEntriesPerPublisher: 1000,
	maxCatalogSize: 50_000,
} as const;

export class CatalogRateLimiter {
	private windows: Map<string, number[]> = new Map();
	private globalWindow: number[] = [];

	check(peerID: string): 'allow' | 'reject' {
		const now = Date.now();
		const cutoff = now - 60_000;

		// Per-peer check
		let peerOps = this.windows.get(peerID);
		if (peerOps) {
			peerOps = peerOps.filter(t => t > cutoff);
			if (peerOps.length >= RATE_LIMITS.maxOpsPerPeerPerMinute) return 'reject';
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

	reset(): void {
		this.windows.clear();
		this.globalWindow = [];
	}
}
