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
	readonly name: string;
	constructor(name: string) { this.name = name; }

	setLimit(kbPerSec: number): void {
		this.maxBytesPerSec = Math.max(0, kbPerSec) * 1024;
		this.availableBytes = 0; // no initial burst
		this.lastRefillTime = Date.now();
		console.log(`[LIMITER:${this.name}] setLimit ${kbPerSec} KB/s → ${this.maxBytesPerSec} B/s`);
	}

	getLimit(): number { return this.maxBytesPerSec; }

	async throttle(bytes: number): Promise<void> {
		if (this.maxBytesPerSec <= 0) return;

		// Refill tokens based on elapsed time
		const now = Date.now();
		const elapsed = (now - this.lastRefillTime) / 1000;
		this.availableBytes = Math.min(
			this.maxBytesPerSec,
			this.availableBytes + elapsed * this.maxBytesPerSec,
		);
		this.lastRefillTime = now;

		// Consume tokens
		this.availableBytes -= bytes;

		// Wait for debt to clear (single sleep, recalculated)
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
export const uploadLimiter = new SpeedLimiter('UL');
export const downloadLimiter = new SpeedLimiter('DL');
