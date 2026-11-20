import { CodedError, ErrorCodes, formatSizeOverLimit } from '@shared';
import { DEFAULT_CHUNK_INFLIGHT_BUDGET_BYTES, networkSetting } from '../settings.ts';

interface Waiter {
	readonly bytes: number;
	readonly grant: (release: () => void) => void;
	readonly refuse: (error: CodedError) => void;
}

/**
 * A FIFO budget of bytes shared by concurrent work. A reservation is granted only while the
 * bytes already reserved plus its own stay within the capacity, so the reserved total passes it
 * only when the capacity is lowered under reservations already granted; nothing is granted then
 * until enough of them are released. A reservation that does not fit yet holds every later one
 * behind it, so a large item cannot be starved by a stream of small ones. One larger than the
 * whole capacity can never fit: it is refused with `DOWNLOAD_CHUNK_EXCEEDS_BUDGET` instead of
 * waiting forever.
 *
 * Not `async-mutex`'s Semaphore: its release walks every unit of free capacity, which for a
 * budget counted in bytes is tens of millions of steps per release, and a queued acquire there
 * cannot be cancelled on its own.
 */
export class ByteBudget {
	private used = 0;
	private readonly waiters: Waiter[] = [];
	private readonly capacity: () => number;
	private lowered = new AbortController();

	/** `capacity` is read on every decision, so a settings change applies to the next grant. */
	constructor(capacity: () => number) {
		this.capacity = capacity;
	}

	/** Bytes currently reserved. */
	get reservedBytes(): number {
		return this.used;
	}

	/** False while the capacity sits below the bytes already reserved, as after it was lowered. */
	get withinCapacity(): boolean {
		return this.used <= this.capacity();
	}

	/**
	 * Reserve `bytes`. Resolves with the release function — safe to call more than once. Rejects
	 * with `signal.reason` if the signal aborts first, or with `DOWNLOAD_CHUNK_EXCEEDS_BUDGET` when
	 * `bytes` is more than the whole capacity; nothing is reserved in either case.
	 */
	reserve(bytes: number, signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		// Refused before queueing, so the answer does not wait behind reservations that do fit.
		const tooLarge = this.tooLarge(bytes);
		if (tooLarge) return Promise.reject(tooLarge);
		return new Promise((resolve, reject) => {
			const onAbort = (): void => {
				const index = this.waiters.indexOf(waiter);
				if (index === -1) return;
				this.waiters.splice(index, 1);
				reject(signal!.reason);
				// The cancelled waiter may have been the head holding everyone else back.
				this.pump();
			};
			const waiter: Waiter = {
				bytes,
				grant: release => {
					signal?.removeEventListener('abort', onAbort);
					resolve(release);
				},
				refuse: error => {
					signal?.removeEventListener('abort', onAbort);
					reject(error);
				},
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			this.waiters.push(waiter);
			this.pump();
		});
	}

	/**
	 * Aborts when the capacity is lowered below the bytes already reserved. A holder that has not
	 * used its reservation yet — it still waits for something else — can then give it back at
	 * once, instead of keeping everyone else out until its own wait ends. A new signal after
	 * every such change.
	 */
	get loweredSignal(): AbortSignal {
		return this.lowered.signal;
	}

	/**
	 * Apply a changed capacity: refuse every waiting reservation that can no longer fit, wherever
	 * it stands in the queue, tell the holders when the capacity is now below what is reserved,
	 * and grant what fits.
	 */
	refresh(): void {
		for (const waiter of [...this.waiters]) {
			const tooLarge = this.tooLarge(waiter.bytes);
			if (!tooLarge) continue;
			this.waiters.splice(this.waiters.indexOf(waiter), 1);
			waiter.refuse(tooLarge);
		}
		if (!this.withinCapacity) {
			const lowered = this.lowered;
			this.lowered = new AbortController();
			lowered.abort();
		}
		this.pump();
	}

	/** Drop every reservation and waiter. For tests only. */
	reset(): void {
		this.used = 0;
		this.waiters.length = 0;
	}

	private tooLarge(bytes: number): CodedError | undefined {
		const capacity = this.capacity();
		return bytes > capacity ? new CodedError(ErrorCodes.DOWNLOAD_CHUNK_EXCEEDS_BUDGET, formatSizeOverLimit(bytes, capacity)) : undefined;
	}

	private pump(): void {
		while (this.waiters.length > 0) {
			const waiter = this.waiters[0]!;
			// The capacity dropped under a waiter with no refresh() since: it would hold the queue forever.
			const tooLarge = this.tooLarge(waiter.bytes);
			if (tooLarge) {
				this.waiters.shift();
				waiter.refuse(tooLarge);
				continue;
			}
			if (this.used + waiter.bytes > this.capacity()) return;
			this.waiters.shift();
			this.used += waiter.bytes;
			let released = false;
			waiter.grant(() => {
				if (released) return;
				released = true;
				this.used -= waiter.bytes;
				this.pump();
			});
		}
	}
}

/** Bytes of chunks requested and not yet written, across every download in this process. */
export const chunkInflightBudget: ByteBudget = new ByteBudget(() => {
	const configured = networkSetting('chunkInflightBudgetBytes');
	return typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CHUNK_INFLIGHT_BUDGET_BYTES;
});
