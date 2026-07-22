/**
 * Global speed limiter using a queued timestamp scheduler (virtual clock / gap buffer).
 *
 * How it works:
 *   `nextAllowedTime` is a shared cursor that advances by (bytes / rate) seconds
 *   when each queued caller starts. Only the head caller owns a timer; later
 *   callers remain in a FIFO queue so a failed head request can safely return its
 *   slot and reschedule the next caller without overlapping an already-reserved
 *   slot.
 *
 * Why the old token-bucket was broken with concurrency:
 *   Two async callers both read `availableBytes` in the synchronous section before
 *   either hits an `await`. Both see the same (or stale) balance, both deduct the
 *   full chunk size, both compute the same debt, and both sleep the same duration —
 *   producing a synchronized burst pattern instead of smooth distribution.
 *
 * Queued scheduler properties:
 *   - 2 peers at 200 KB/s limit → each gets ~100 KB/s (slots interleave)
 *   - No multi-caller burst: the first caller starts immediately; later callers
 *     are separated by the duration of the slot ahead of them
 *   - Limit changes take effect on the next throttle call (cursor is reset)
 *   - Zero / negative limit means disabled (no throttling)
 */
export interface SpeedLimiterReservation {
	readonly id: number;
	readonly generation: number;
	readonly startedAt: number;
	readonly durationMs: number;
}

interface PendingThrottle {
	bytes: number;
	resolve: (reservation: SpeedLimiterReservation | undefined) => void;
}

export class SpeedLimiter {
	private maxBytesPerSec = 0;

	/** Virtual clock: earliest time (ms) the next caller may proceed. */
	private nextAllowedTime = 0;
	private pending: PendingThrottle[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private generation = 0;
	private nextReservationId = 0;
	private lastStarted: { reservation: SpeedLimiterReservation; refunded: boolean } | undefined;

	readonly name: string;

	constructor(name: string) {
		this.name = name;
	}

	setLimit(kbPerSec: number): void {
		const maxBytesPerSec = Math.max(0, kbPerSec) * 1024;
		// No-op on unchanged rate: callers re-push all limits on any network
		// settings write, and an unchanged rate must not reset the throttle cursor.
		if (maxBytesPerSec === this.maxBytesPerSec) return;
		this.maxBytesPerSec = maxBytesPerSec;
		// Reset cursor to now so the new rate takes effect immediately
		// without inheriting a stale future slot from the old rate.
		this.generation++;
		this.nextAllowedTime = Date.now();
		this.lastStarted = undefined;
		this.clearTimer();
		this.scheduleNext();
		console.log(`[LIMITER:${this.name}] setLimit ${kbPerSec} KB/s → ${this.maxBytesPerSec} B/s`);
	}

	getLimit(): number {
		return this.maxBytesPerSec;
	}

	async throttle(bytes: number): Promise<SpeedLimiterReservation | undefined> {
		if (this.maxBytesPerSec <= 0 || bytes <= 0) return undefined;
		return new Promise(resolve => {
			this.pending.push({ bytes, resolve });
			this.scheduleNext();
		});
	}

	/**
	 * Return the most recently started slot to the schedule. Used when a throttled
	 * request turns out to transfer no payload (e.g. the peer answers
	 * chunk-not-found) — without the refund, failed probes accumulate phantom
	 * debt that delays real transfers on the shared limiter. Later callers are
	 * still queued, so their single shared timer can be moved forward safely.
	 * A stale reservation cannot rewind a newer started slot.
	 */
	refund(reservation: SpeedLimiterReservation | undefined): void {
		if (!reservation || reservation.generation !== this.generation) return;
		if (!this.lastStarted || this.lastStarted.refunded || this.lastStarted.reservation.id !== reservation.id) return;

		this.lastStarted.refunded = true;
		this.nextAllowedTime = Math.max(Date.now(), reservation.startedAt);
		this.clearTimer();
		this.scheduleNext();
	}

	/** Reset the cursor to now (used on disconnect / test teardown). */
	reset(): void {
		this.generation++;
		this.nextAllowedTime = Date.now();
		this.lastStarted = undefined;
		this.clearTimer();
		this.scheduleNext();
	}

	private scheduleNext(): void {
		if (this.timer || this.pending.length === 0) return;
		if (this.maxBytesPerSec <= 0) {
			const pending = this.pending.splice(0);
			for (const request of pending) request.resolve(undefined);
			return;
		}

		const now = Date.now();
		const slotStart = Math.max(now, this.nextAllowedTime);
		const waitMs = slotStart - now;
		if (waitMs <= 1) {
			this.startNext(slotStart);
			return;
		}

		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.startNext(Math.max(slotStart, Date.now()));
		}, waitMs);
	}

	private startNext(startedAt: number): void {
		const request = this.pending.shift();
		if (!request) return;
		if (this.maxBytesPerSec <= 0) {
			request.resolve(undefined);
			this.scheduleNext();
			return;
		}

		const reservation: SpeedLimiterReservation = {
			id: ++this.nextReservationId,
			generation: this.generation,
			startedAt,
			durationMs: (request.bytes / this.maxBytesPerSec) * 1000,
		};
		this.nextAllowedTime = startedAt + reservation.durationMs;
		this.lastStarted = { reservation, refunded: false };
		request.resolve(reservation);
		this.scheduleNext();
	}

	private clearTimer(): void {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}

// Singleton instances — shared across all peers and all LISHes.
export const uploadLimiter: SpeedLimiter = new SpeedLimiter('UL');
export const downloadLimiter: SpeedLimiter = new SpeedLimiter('DL');
