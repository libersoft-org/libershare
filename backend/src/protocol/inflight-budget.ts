import { DEFAULT_CHUNK_INFLIGHT_BUDGET_BYTES, networkSetting } from '../settings.ts';

interface Waiter {
	readonly bytes: number;
	readonly grant: (release: () => void) => void;
}

/**
 * A FIFO budget of bytes shared by concurrent work. A reservation is granted when it fits under
 * the capacity, or when nothing else is reserved — one item larger than the whole budget still
 * gets through alone instead of waiting forever. A reservation that does not fit holds every
 * later one behind it, so a large item cannot be starved by a stream of small ones.
 *
 * Not `async-mutex`'s Semaphore: its release walks every unit of free capacity, which for a
 * budget counted in bytes is tens of millions of steps per release, and a queued acquire there
 * cannot be cancelled on its own.
 */
export class ByteBudget {
	private used = 0;
	private readonly waiters: Waiter[] = [];
	private readonly capacity: () => number;

	/** `capacity` is read on every decision, so a settings change applies to the next grant. */
	constructor(capacity: () => number) {
		this.capacity = capacity;
	}

	/** Bytes currently reserved. */
	get reservedBytes(): number {
		return this.used;
	}

	/**
	 * Reserve `bytes`. Resolves with the release function — safe to call more than once — or
	 * rejects with `signal.reason` if the signal aborts first, in which case nothing is reserved.
	 */
	reserve(bytes: number, signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(signal.reason);
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
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			this.waiters.push(waiter);
			this.pump();
		});
	}

	/** Drop every reservation and waiter. For tests only. */
	reset(): void {
		this.used = 0;
		this.waiters.length = 0;
	}

	private fits(bytes: number): boolean {
		return this.used === 0 || this.used + bytes <= this.capacity();
	}

	private pump(): void {
		while (this.waiters.length > 0 && this.fits(this.waiters[0]!.bytes)) {
			const waiter = this.waiters.shift()!;
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

/** Bytes of chunk requests in flight across every download in this process. */
export const chunkInflightBudget: ByteBudget = new ByteBudget(() => {
	const configured = networkSetting('chunkInflightBudgetBytes');
	return typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CHUNK_INFLIGHT_BUDGET_BYTES;
});
