import { describe, expect, it } from 'bun:test';
import { networkStateGeneration, resetNetworkStateCache, runHostMutation } from '../../src/system-network.ts';

/**
 * A host reconfiguration is several platform commands and is not atomic, while
 * the state poll reads the machine on its own schedule. These cover the two
 * halves that keep the two from publishing fiction at each other: the cache is
 * invalidated on BOTH sides of the platform action, and the state the machine
 * was actually left in is read and broadcast whatever the outcome was.
 */
describe('runHostMutation', () => {
	it('invalidates the cache before the platform action runs', async () => {
		// The leading invalidation is what discards a read that starts mid-apply.
		// Without it that read carries the pre-apply generation, is accepted when it
		// finishes, and publishes an intermediate state as the truth.
		const before = networkStateGeneration();
		let duringAction = -1;
		await runHostMutation(async () => {
			duringAction = networkStateGeneration();
		});
		expect(duringAction).toBeGreaterThan(before);
	});

	it('invalidates the cache again after the action fails', async () => {
		let duringAction = -1;
		await expect(
			runHostMutation(async () => {
				duringAction = networkStateGeneration();
				throw new Error('the route could not be rewritten');
			})
		).rejects.toThrow('the route could not be rewritten');
		// A failed apply is exactly when the cached reading is fiction: the error
		// says the request did not complete, not that nothing changed.
		expect(networkStateGeneration()).toBeGreaterThan(duringAction);
	});

	it('invalidates the cache again after the action succeeds', async () => {
		let duringAction = -1;
		await runHostMutation(async () => {
			duringAction = networkStateGeneration();
		});
		expect(networkStateGeneration()).toBeGreaterThan(duringAction);
	});

	it('serializes two mutations rather than interleaving their steps', async () => {
		const order: string[] = [];
		const slow = runHostMutation(async () => {
			order.push('a:start');
			await new Promise(resolve => setTimeout(resolve, 20));
			order.push('a:end');
		});
		const fast = runHostMutation(async () => {
			order.push('b:start');
		});
		await Promise.all([slow, fast]);
		expect(order).toEqual(['a:start', 'a:end', 'b:start']);
		resetNetworkStateCache();
	});
});
