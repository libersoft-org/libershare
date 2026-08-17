import { describe, expect, it } from 'bun:test';
import type { NetworkStateInfo } from '@shared';
import { applyAndPublish, publishNetworkState } from '../../../src/api/system.ts';
import { hostMutationInProgress, runHostMutation } from '../../../src/system-network.ts';

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
});

describe('applyAndPublish', () => {
	it('publishes the resulting state and answers with it on success', async () => {
		const sent: Array<{ event: string; data: unknown }> = [];
		const state = await applyAndPublish(
			async () => {},
			async () => fakeState('after'),
			(event, data) => sent.push({ event, data })
		);
		expect(state.primaryID).toBe('after');
		expect(sent).toEqual([{ event: 'system:network', data: state }]);
	});

	it('still reads and broadcasts the real state when the mutation fails', async () => {
		// The whole point: a half-applied change leaves the machine in a state the
		// error does not describe, and every connected client used to hear nothing.
		const sent: Array<{ event: string; data: unknown }> = [];
		await expect(
			applyAndPublish(
				async () => {
					throw new Error('access is denied');
				},
				async () => fakeState('half-applied'),
				(event, data) => sent.push({ event, data })
			)
		).rejects.toThrow('access is denied');
		expect(sent).toHaveLength(1);
		expect((sent[0]?.data as NetworkStateInfo).primaryID).toBe('half-applied');
	});

	it('keeps the mutation error when the follow-up read fails too', async () => {
		// Reporting the read failure instead would hide the reason the user needs.
		await expect(
			applyAndPublish(
				async () => {
					throw new Error('access is denied');
				},
				async () => {
					throw new Error('the reader is unavailable');
				},
				() => {}
			)
		).rejects.toThrow('access is denied');
	});

	it('reports a read failure when the mutation itself succeeded', async () => {
		await expect(
			applyAndPublish(
				async () => {},
				async () => {
					throw new Error('the reader is unavailable');
				},
				() => {}
			)
		).rejects.toThrow('the reader is unavailable');
	});
});
