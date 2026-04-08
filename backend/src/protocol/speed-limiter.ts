/**
 * Global speed limiter using token bucket with debt tracking.
 * Shared across all concurrent streams/instances to enforce a total bandwidth cap.
 *
 * Unlike a sliding-window approach, this properly handles concurrent callers:
 * tokens refill at the target rate, and debt (negative tokens) forces callers
 * to wait proportionally before requesting the next chunk.
 */
export class SpeedLimiter {
	private maxBytesPerSec = 0;
	private availableBytes = 0;
	private lastRefillTime = 0;

	setLimit(kbPerSec: number): void {
		this.maxBytesPerSec = Math.max(0, kbPerSec) * 1024;
		this.availableBytes = this.maxBytesPerSec; // start with full bucket (1s burst)
		this.lastRefillTime = Date.now();
	}

	getLimit(): number { return this.maxBytesPerSec; }

	async throttle(bytes: number): Promise<void> {
		if (this.maxBytesPerSec <= 0) return;

		// Refill tokens based on elapsed wall-clock time
		const now = Date.now();
		const elapsed = (now - this.lastRefillTime) / 1000;
		this.availableBytes = Math.min(
			this.maxBytesPerSec, // cap burst at 1 second worth
			this.availableBytes + elapsed * this.maxBytesPerSec,
		);
		this.lastRefillTime = now;

		// Consume tokens (can go negative = debt)
		this.availableBytes -= bytes;

		// If in debt, wait until tokens would refill to zero
		if (this.availableBytes < 0) {
			const waitMs = (-this.availableBytes / this.maxBytesPerSec) * 1000;
			if (waitMs > 5) await new Promise(r => setTimeout(r, waitMs));
		}
	}

	reset(): void {
		this.availableBytes = this.maxBytesPerSec;
		this.lastRefillTime = Date.now();
	}
}

// Singleton instances for global upload and download limits
export const uploadLimiter = new SpeedLimiter();
export const downloadLimiter = new SpeedLimiter();
