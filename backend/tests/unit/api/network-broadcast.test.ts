import { describe, expect, it } from 'bun:test';
import type { NetworkStateInfo } from '@shared';
import { applyAndPublish } from '../../../src/api/system.ts';

/** A state that is recognisable in an assertion without standing for anything real. */
function fakeState(marker: string): NetworkStateInfo {
	return { interfaces: [{ id: marker, name: marker, medium: 'wired', link: 'up', defaultRoute: false, mac: null, addresses: [], ipv4Mode: 'dhcp', gateway: null, dns: [], configurable: true }], primaryID: marker, detail: 'full', known: true, capabilities: { ipv4: true, wifi: false, staticGatewayRequired: false } };
}

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
