import { describe, expect, it } from 'bun:test';
import { ByteBudget } from '../../../src/protocol/inflight-budget.ts';
import { ErrorCodes } from '@shared';

/** Whether `promise` has settled after the microtasks queued so far ran. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
	let done = false;
	promise.then(
		() => (done = true),
		() => (done = true)
	);
	await Bun.sleep(0);
	return done;
}

/** The release of a reservation that must be granted at once; fails instead of hanging. */
async function granted(promise: Promise<() => void>): Promise<() => void> {
	if (!(await settled(promise))) throw new Error('reservation was not granted');
	return promise;
}

describe('ByteBudget', () => {
	it('grants reservations that fit and queues the rest until bytes are released', async () => {
		const budget = new ByteBudget(() => 10);
		const first = await granted(budget.reserve(6));
		const second = budget.reserve(5);
		expect(await settled(second)).toBe(false);
		first();
		expect(await settled(second)).toBe(true);
		expect(budget.reservedBytes).toBe(5);
	});

	it('refuses a reservation larger than the whole budget at once, also when nothing is reserved', async () => {
		const budget = new ByteBudget(() => 64);
		await expect(budget.reserve(100)).rejects.toMatchObject({ code: ErrorCodes.DOWNLOAD_CHUNK_EXCEEDS_BUDGET });
		expect(budget.reservedBytes).toBe(0);
		// Exactly the whole budget still fits.
		await granted(budget.reserve(64));
		expect(budget.reservedBytes).toBe(64);
	});

	it('refuses a too large reservation without waiting behind the queue', async () => {
		const budget = new ByteBudget(() => 64);
		await granted(budget.reserve(64));
		const waiting = budget.reserve(1);
		const huge = budget.reserve(65);
		await expect(huge).rejects.toMatchObject({ code: ErrorCodes.DOWNLOAD_CHUNK_EXCEEDS_BUDGET });
		expect(await settled(waiting)).toBe(false);
	});

	it('never reserves more than the capacity, whatever the sizes', async () => {
		const budget = new ByteBudget(() => 64);
		const first = await granted(budget.reserve(50));
		// A second 50 fits only once the first one is released.
		const second = budget.reserve(50);
		expect(await settled(second)).toBe(false);
		expect(budget.reservedBytes).toBe(50);
		first();
		expect(await settled(second)).toBe(true);
		// 14 more fill the budget exactly, beside the 50.
		await granted(budget.reserve(14));
		expect(budget.reservedBytes).toBe(64);
		expect(await settled(budget.reserve(1))).toBe(false);
	});

	it('makes two reservations larger than half the budget take turns', async () => {
		const budget = new ByteBudget(() => 64);
		const first = await granted(budget.reserve(64));
		const second = budget.reserve(64);
		expect(await settled(second)).toBe(false);
		expect(budget.reservedBytes).toBe(64);
		first();
		expect(await settled(second)).toBe(true);
		expect(budget.reservedBytes).toBe(64);
	});

	it('refuses a waiter that no longer fits a lowered capacity instead of blocking those behind it', async () => {
		let capacity = 10;
		const budget = new ByteBudget(() => capacity);
		const held = await granted(budget.reserve(9));
		const large = budget.reserve(8);
		const small = budget.reserve(1);
		capacity = 5;
		budget.refresh();
		await expect(large).rejects.toMatchObject({ code: ErrorCodes.DOWNLOAD_CHUNK_EXCEEDS_BUDGET });
		expect(await settled(small)).toBe(false);
		held();
		expect(await settled(small)).toBe(true);
		expect(budget.reservedBytes).toBe(1);
	});

	it('keeps first-come order: a waiting large reservation holds back smaller later ones', async () => {
		const budget = new ByteBudget(() => 10);
		const held = await granted(budget.reserve(9));
		const large = budget.reserve(8);
		const small = budget.reserve(1);
		expect(await settled(large)).toBe(false);
		expect(await settled(small)).toBe(false);
		held();
		expect(await settled(large)).toBe(true);
		expect(await settled(small)).toBe(true);
	});

	it('removes a cancelled head waiter and lets the next one in at once', async () => {
		const budget = new ByteBudget(() => 10);
		await granted(budget.reserve(9));
		const abort = new AbortController();
		const large = budget.reserve(8, abort.signal);
		const small = budget.reserve(1);
		abort.abort(new Error('stopped'));
		await expect(large).rejects.toThrow('stopped');
		expect(await settled(small)).toBe(true);
		expect(budget.reservedBytes).toBe(10);
	});

	it('refuses an already aborted signal without reserving anything', async () => {
		const budget = new ByteBudget(() => 10);
		const abort = new AbortController();
		abort.abort(new Error('gone'));
		await expect(budget.reserve(1, abort.signal)).rejects.toThrow('gone');
		expect(budget.reservedBytes).toBe(0);
	});

	it('releases a reservation only once however often its release runs', async () => {
		const budget = new ByteBudget(() => 10);
		const first = await granted(budget.reserve(5));
		await granted(budget.reserve(5));
		first();
		first();
		expect(budget.reservedBytes).toBe(5);
	});

	it('reads the capacity on every decision', async () => {
		let capacity = 4;
		const budget = new ByteBudget(() => capacity);
		const first = await granted(budget.reserve(4));
		capacity = 100;
		const second = budget.reserve(50);
		expect(await settled(second)).toBe(true);
		first();
	});
});
