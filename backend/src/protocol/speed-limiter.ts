/**
 * Global speed limiter using sliding-window token bucket.
 * Shared across all concurrent streams/instances to enforce a total bandwidth cap.
 */
export class SpeedLimiter {
	private maxBytesPerSec = 0;
	private samples: { time: number; bytes: number }[] = [];
	private static readonly WINDOW_MS = 1000;

	setLimit(kbPerSec: number): void {
		this.maxBytesPerSec = Math.max(0, kbPerSec) * 1024;
		if (this.maxBytesPerSec === 0) this.samples = [];
	}

	getLimit(): number { return this.maxBytesPerSec; }

	async throttle(bytes: number): Promise<void> {
		if (this.maxBytesPerSec <= 0) return;
		const now = Date.now();
		this.samples.push({ time: now, bytes });
		// Prune samples older than window
		const cutoff = now - SpeedLimiter.WINDOW_MS;
		this.samples = this.samples.filter(s => s.time > cutoff);
		// Calculate bytes in current window
		const windowBytes = this.samples.reduce((sum, s) => sum + s.bytes, 0);
		if (windowBytes > this.maxBytesPerSec) {
			// How long to wait until we're under budget
			const excessBytes = windowBytes - this.maxBytesPerSec;
			const waitMs = (excessBytes / this.maxBytesPerSec) * 1000;
			if (waitMs > 5) await new Promise(r => setTimeout(r, waitMs));
		}
	}

	reset(): void {
		this.samples = [];
	}
}

// Singleton instances for global upload and download limits
export const uploadLimiter = new SpeedLimiter();
export const downloadLimiter = new SpeedLimiter();
