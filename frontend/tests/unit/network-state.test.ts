import { describe, expect, it } from 'bun:test';
import { get } from 'svelte/store';
import { networkState, networkSubscriptionActive, subscribeNetworkState, syncNetworkState } from '../../src/scripts/networkState.ts';

const freshState = {
	interfaces: [],
	primaryID: null,
	detail: 'full' as const,
	known: true,
	capabilities: { ipv4: true, wifi: true, staticGatewayRequired: false },
};

describe('network state subscription', () => {
	it('settles failed subscriptions so reconnect initialization can retry', async () => {
		const originalError = console.error;
		console.error = () => {};
		try {
			expect(await subscribeNetworkState(() => Promise.reject(new Error('temporary failure')))).toBe(false);
			expect(await subscribeNetworkState(() => Promise.resolve(true))).toBe(true);
		} finally {
			console.error = originalError;
		}
	});

	it('leaves a snapshot unknown and read-only when live subscription fails', async () => {
		// The snapshot is true only at the moment it was taken. Without live
		// updates, a form opened on it could write stale configuration back over a
		// change made outside the app.
		const originalError = console.error;
		console.error = () => {};
		try {
			await syncNetworkState(
				() => Promise.reject(new Error('temporary failure')),
				() => Promise.resolve({ ...freshState, interfaces: [{ id: 'lan0', name: 'LAN', medium: 'wired' as const, link: 'up' as const, defaultRoute: true, mac: null, addresses: [], ipv4Mode: 'dhcp' as const, ipv4Configurable: true, wifiConfigurable: false, gateway: null, dns: [] }] })
			);
			const state = get(networkState);
			expect(state.known).toBe(false);
			expect(state.interfaces).toHaveLength(1);
			expect(state.capabilities).toEqual({ ipv4: false, ipv4Elevation: false, wifi: false, staticGatewayRequired: false });
			expect(get(networkSubscriptionActive)).toBe(false);
		} finally {
			console.error = originalError;
		}
	});

	it('keeps a snapshot known and writable once live updates are flowing', async () => {
		await syncNetworkState(
			() => Promise.resolve(true),
			() => Promise.resolve(freshState)
		);
		expect(get(networkState)).toEqual(freshState);
		expect(get(networkSubscriptionActive)).toBe(true);
	});

	it('keeps stale rows visible but removes write capabilities after a failed refresh', async () => {
		networkState.set({ ...freshState, interfaces: [{ id: 'lan0', name: 'LAN', medium: 'wired', link: 'up', defaultRoute: true, mac: null, addresses: [], ipv4Mode: 'dhcp', ipv4Configurable: true, wifiConfigurable: false, gateway: null, dns: [] }] });
		const originalError = console.error;
		console.error = () => {};
		try {
			await syncNetworkState(
				() => Promise.resolve(true),
				() => Promise.reject(new Error('read failed'))
			);
			const state = get(networkState);
			expect(state.known).toBe(false);
			expect(state.interfaces).toHaveLength(1);
			expect(state.capabilities).toEqual({ ipv4: false, ipv4Elevation: false, wifi: false, staticGatewayRequired: false });
			expect(get(networkSubscriptionActive)).toBe(true);
		} finally {
			console.error = originalError;
		}
	});
});
