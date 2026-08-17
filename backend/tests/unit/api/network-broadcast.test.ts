import { describe, expect, it } from 'bun:test';
import type { NetworkStateInfo } from '@shared';
import { applyAndPublish, publishNetworkState } from '../../../src/api/system.ts';
import { hostMutationInProgress, mutateAndReadBack, readSettledNetworkState, runHostMutation, type MutationOutcome } from '../../../src/system-network.ts';

/** A state that is recognisable in an assertion without standing for anything real. */
function fakeState(marker: string): NetworkStateInfo {
	return { interfaces: [{ id: marker, name: marker, medium: 'wired', link: 'up', defaultRoute: false, mac: null, addresses: [], ipv4Mode: 'dhcp', gateway: null, dns: [], ipv4Configurable: true, wifiScannable: true, wifiConnectable: true }], primaryID: marker, detail: 'full', known: true, capabilities: { ipv4: true, wifi: false, staticGatewayRequired: false } };
}

/**
 * The poll tick, which reads the host on its own schedule while an apply may be
 * halfway through several non-atomic commands.
 *
 * The cache generation only discards a read that started BEFORE the mutation; one
 * that starts during it is accepted as current and broadcast as the truth — an
 * interface with its old address removed and its new one not yet written.
 */
describe('publishNetworkState', () => {
	it('broadcasts the state when nothing is being reconfigured', async () => {
		const sent: unknown[] = [];
		await publishNetworkState(
			async () => fakeState('settled'),
			(_event, data) => sent.push(data),
			() => false
		);
		expect((sent[0] as NetworkStateInfo).primaryID).toBe('settled');
	});

	it('does not even read the host while a reconfiguration is running', async () => {
		let reads = 0;
		const sent: unknown[] = [];
		await publishNetworkState(
			async () => {
				reads++;
				return fakeState('mid-apply');
			},
			(_event, data) => sent.push(data),
			() => true
		);
		expect(reads).toBe(0);
		expect(sent).toEqual([]);
	});

	// A Windows read takes 1.4-1.8 s, so an apply that begins after the tick has
	// asked still turns the answer into a mid-apply reading before it arrives.
	it('drops a reading that a reconfiguration overtook while it was in flight', async () => {
		const sent: unknown[] = [];
		let mutating = false;
		await publishNetworkState(
			async () => {
				mutating = true;
				return fakeState('overtaken');
			},
			(_event, data) => sent.push(data),
			() => mutating
		);
		expect(sent).toEqual([]);
	});

	it('reads the real lock by default', async () => {
		const sent: unknown[] = [];
		await runHostMutation(async () => {
			expect(hostMutationInProgress()).toBe(true);
			await publishNetworkState(
				async () => fakeState('mid-apply'),
				(_event, data) => sent.push(data)
			);
		});
		expect(sent).toEqual([]);
		expect(hostMutationInProgress()).toBe(false);
	});

	// An ordinary read takes the same lock — that is how it waits for a
	// reconfiguration to finish — so asking the LOCK whether one is running answered
	// yes throughout every read, and the publisher dropped its tick because another
	// read held it. Harmless but pointless: the footer sat a poll interval behind.
	it('does not call an ordinary settled read a reconfiguration', async () => {
		const sent: unknown[] = [];
		const reading = readSettledNetworkState();
		// Long enough for the mutex to have handed the lock to that read, far too
		// short for the platform reader it then spawns to have answered.
		await Promise.resolve();
		await Promise.resolve();
		expect(hostMutationInProgress()).toBe(false);
		await publishNetworkState(
			async () => fakeState('settled'),
			(_event, data) => sent.push(data)
		);
		expect(sent).toHaveLength(1);
		await reading;
	});
});

describe('applyAndPublish', () => {
	/** What `mutateAndReadBack` hands back — the state, and either failure or neither. */
	const outcome = (marker: string | null, failure: unknown = null, readError: unknown = null): MutationOutcome => ({ state: marker === null ? null : fakeState(marker), failure, readError });

	it('publishes the resulting state and answers with it on success', async () => {
		const sent: Array<{ event: string; data: unknown }> = [];
		const state = await applyAndPublish(
			async () => outcome('after'),
			(event, data) => sent.push({ event, data })
		);
		expect(state.primaryID).toBe('after');
		expect(sent).toEqual([{ event: 'system:network', data: state }]);
	});

	it('still broadcasts the real state when the mutation failed', async () => {
		// The whole point: a half-applied change leaves the machine in a state the
		// error does not describe, and every connected client used to hear nothing.
		const sent: Array<{ event: string; data: unknown }> = [];
		await expect(
			applyAndPublish(
				async () => outcome('half-applied', new Error('access is denied')),
				(event, data) => sent.push({ event, data })
			)
		).rejects.toThrow('access is denied');
		expect(sent).toHaveLength(1);
		expect((sent[0]?.data as NetworkStateInfo).primaryID).toBe('half-applied');
	});

	it('keeps the mutation error when the follow-up read failed too', async () => {
		// Reporting the read failure instead would hide the reason the user needs.
		await expect(
			applyAndPublish(
				async () => outcome(null, new Error('access is denied'), new Error('the reader is unavailable')),
				() => {}
			)
		).rejects.toThrow('access is denied');
	});

	it('reports a read failure when the mutation itself succeeded', async () => {
		await expect(
			applyAndPublish(
				async () => outcome(null, null, new Error('the reader is unavailable')),
				() => {}
			)
		).rejects.toThrow('the reader is unavailable');
	});
});

/**
 * Whose outcome each request gets back.
 *
 * The mutation and the read used to be two separate critical sections, and
 * `runExclusive` hands the mutex to the longest-waiting owner the instant it is
 * released — so a second apply already queued behind the first started before the
 * first had read anything, and the first then waited for it and answered with its
 * state.
 */
describe('mutateAndReadBack', () => {
	// The reading reports whatever the last change wrote, which is the only way a
	// swapped answer is visible at all.
	const applied: string[] = [];
	const readLast = async (): Promise<NetworkStateInfo> => fakeState(applied[applied.length - 1] ?? 'none');

	it('answers each request with the state its own change left behind', async () => {
		applied.length = 0;
		let releaseFirst = () => {};
		const held = new Promise<void>(resolve => {
			releaseFirst = resolve;
		});
		const first = mutateAndReadBack(
			async () => {
				applied.push('a');
				await held;
			},
			'',
			readLast
		);
		// Queued behind the first, and dispatched the instant the first lets go.
		await new Promise(resolve => setTimeout(resolve, 10));
		const second = mutateAndReadBack(async () => void applied.push('b'), '', readLast);
		releaseFirst();
		expect((await first).state?.primaryID).toBe('a');
		expect((await second).state?.primaryID).toBe('b');
	});

	it('carries a mutation failure out rather than throwing it', async () => {
		applied.length = 0;
		const failed = await mutateAndReadBack(
			async () => {
				throw new Error('access is denied');
			},
			'',
			readLast
		);
		expect((failed.failure as Error).message).toBe('access is denied');
		// And the host is still read, because the failure says nothing about how much
		// of the change went through.
		expect(failed.state?.primaryID).toBe('none');
		expect(failed.readError).toBeNull();
	});
});
