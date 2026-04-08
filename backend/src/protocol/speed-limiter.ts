/**
 * Global speed limiter using a timestamp scheduler (virtual clock / gap buffer).
 *
 * How it works:
 *   `nextAllowedTime` is a shared cursor that advances by (bytes / rate) seconds
 *   for each caller. Each caller atomically claims a time slot, then sleeps until
 *   that slot arrives. This serializes bandwidth across all concurrent callers
 *   without bursting: no shared balance that can be double-consumed.
 *
 * Why the old token-bucket was broken with concurrency:
 *   Two async callers both read `availableBytes` in the synchronous section before
 *   either hits an `await`. Both see the same (or stale) balance, both deduct the
 *   full chunk size, both compute the same debt, and both sleep the same duration —
 *   producing a synchronized burst pattern instead of smooth distribution.
 *
 * Timestamp scheduler properties:
 *   - 2 peers at 200 KB/s limit → each gets ~100 KB/s (slots interleave)
 *   - No initial burst: cursor starts at `now`, first slot is already in the future
 *     by one time-slice, so the first caller waits proportionally
 *   - Limit changes take effect on the next throttle call (cursor is reset)
 *   - Zero / negative limit means disabled (no throttling)
 */
export class SpeedLimiter {
	private maxBytesPerSec = 0;

	/** Virtual clock: earliest time (ms) the next caller may proceed. */
	private nextAllowedTime = 0;

	readonly name: string;

	constructor(name: string) {
		this.name = name;
	}

	setLimit(kbPerSec: number): void {
		this.maxBytesPerSec = Math.max(0, kbPerSec) * 1024;
		// Reset cursor to now so the new rate takes effect immediately
		// without inheriting a stale future slot from the old rate.
		this.nextAllowedTime = Date.now();
		console.log(`[LIMITER:${this.name}] setLimit ${kbPerSec} KB/s → ${this.maxBytesPerSec} B/s`);
	}

	getLimit(): number {
		return this.maxBytesPerSec;
	}

	async throttle(bytes: number): Promise<void> {
		if (this.maxBytesPerSec <= 0) return;

		const now = Date.now();

		// Claim a time slot atomically (sync, no await between read and write).
		// If the cursor has drifted into the past (e.g. no activity for a while),
		// clamp it to now so we don't carry forward a stale head-start.
		const slotStart = Math.max(now, this.nextAllowedTime);
		const slotDurationMs = (bytes / this.maxBytesPerSec) * 1000;
		this.nextAllowedTime = slotStart + slotDurationMs;

		// Sleep until our slot begins.
		const waitMs = slotStart - now;
		if (waitMs > 1) await new Promise<void>(r => setTimeout(r, waitMs));
	}

	/** Reset the cursor to now (used on disconnect / test teardown). */
	reset(): void {
		this.nextAllowedTime = Date.now();
	}
}

// Singleton instances — shared across all peers and all LISHes.
export const uploadLimiter = new SpeedLimiter('UL');
export const downloadLimiter = new SpeedLimiter('DL');
