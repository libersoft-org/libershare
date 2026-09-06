import { describe, expect, it } from 'bun:test';
import { isAlreadyJoined, readNetworkState, readNetworkStateUnlocked, runNetworkMutation } from '../../src/system-network.ts';

/**
 * The ordering guarantees the whole write path rests on.
 *
 * A host reconfiguration is several platform commands, and between two of them
 * the machine is in a state nobody asked for — the old address gone and the new
 * one not yet there. Every read that can be observed has to be kept out of that
 * window, and every mutation has to be kept out of another one's. The lock is
 * what does both; these pin down that it is actually taken on each path.
 */
describe('network mutation serialisation', () => {
	/** Resolve after the current macrotask queue, so an interleaving has room to happen. */
	function tick(): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, 5));
	}

	it('serializes two mutations rather than interleaving their steps', async () => {
		const order: string[] = [];
		const first = runNetworkMutation(async () => {
			order.push('first:start');
			await tick();
			order.push('first:end');
		});
		const second = runNetworkMutation(async () => {
			order.push('second:start');
			await tick();
			order.push('second:end');
		});
		await Promise.all([first, second]);
		expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
	});

	it('makes a read wait for a reconfiguration instead of reading through it', async () => {
		const order: string[] = [];
		const mutation = runNetworkMutation(async () => {
			order.push('apply:start');
			await tick();
			order.push('apply:end');
		});
		const read = readNetworkState().then(() => order.push('read'));
		await Promise.all([mutation, read]);
		expect(order).toEqual(['apply:start', 'apply:end', 'read']);
	});

	it('keeps the unlocked read off the lock, which would deadlock a mutation', async () => {
		// This is the read the mutation itself performs to answer with the state it
		// left behind. Taking the lock there would make it wait for the mutation it
		// is already inside of, and the request would hang until the test timeout.
		const state = await runNetworkMutation(() => readNetworkStateUnlocked());
		expect(state.known).toBe(true);
	});
});

/**
 * The guard that keeps a join off the network the interface is already on.
 *
 * Its whole reason to exist is that the association cannot then be told apart
 * from the one a new attempt would produce: the first poll sees the still-live
 * old connection and reports success, so a wrong password is never noticed and
 * no rollback runs.
 */
describe('already-joined guard', () => {
	// The DECISION is pinned here. Its call site sits behind a live scan, so only a
	// real adapter exercises it — verified on Windows: a second join of the network
	// the interface was already on came back "already connected to that network".
	it('reads the scan row, which is the freshest statement about this interface', () => {
		expect(isAlreadyJoined({ active: true })).toBe(true);
		expect(isAlreadyJoined({ active: false })).toBe(false);
	});
});
