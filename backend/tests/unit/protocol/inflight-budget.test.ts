import { describe, expect, it } from 'bun:test';
import { ByteBudget } from '../../../src/protocol/inflight-budget.ts';

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

	it('lets one reservation larger than the whole budget through when nothing else is reserved', async () => {
		const budget = new ByteBudget(() => 10);
		const huge = await granted(budget.reserve(25));
		expect(budget.reservedBytes).toBe(25);
		const small = budget.reserve(1);
		expect(await settled(small)).toBe(false);
		huge();
		expect(await settled(small)).toBe(true);
	});

	it('lets two reservations larger than half the budget run together, but not a third', async () => {
		const budget = new ByteBudget(() => 64);
		const first = await granted(budget.reserve(64));
		await granted(budget.reserve(64));
		const third = budget.reserve(64);
		expect(await settled(third)).toBe(false);
		expect(budget.reservedBytes).toBe(128);
		first();
		expect(await settled(third)).toBe(true);
		expect(budget.reservedBytes).toBe(128);
	});

	it('grants a large reservation beside small ones without waiting for an empty budget', async () => {
		const budget = new ByteBudget(() => 64);
		for (let i = 0; i < 60; i++) await granted(budget.reserve(1));
		await granted(budget.reserve(64));
		expect(budget.reservedBytes).toBe(124);
	});

	it('leaves reservations up to half the budget bounded by the capacity', async () => {
		const budget = new ByteBudget(() => 64);
		await granted(budget.reserve(32));
		await granted(budget.reserve(32));
		expect(await settled(budget.reserve(32))).toBe(false);
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
