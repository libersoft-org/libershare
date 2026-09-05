/**
 * The failed-read path of `syncNetworkState()`.
 *
 * What is being pinned: a read that throws must take the store out of the state
 * anything may be WRITTEN from. The rows stay as last-known data — blanking the
 * screen tells the user less than showing what was there — but `known` goes off
 * and every write capability with it, so the Settings screen cannot gate a
 * Configure button on a host state nobody can still vouch for.
 *
 * Both dependencies are injected rather than mocked at the module level:
 * `mock.module()` writes to a registry with no per-file scope, so a fake
 * registered here would decide which transport OTHER files see, based on load
 * order alone.
 */
import { test, expect } from 'bun:test';
import { get } from 'svelte/store';
import type { NetworkStateInfo } from '@shared';
import { networkState, syncNetworkState } from '../../src/scripts/networkState.ts';

const live: NetworkStateInfo = {
	interfaces: [{ id: 'eth0', name: 'eth0', medium: 'wired', link: 'up', defaultRoute: true, mac: null, addresses: [], ipv4Mode: 'static', gateway: '192.0.2.1', dns: [], ipv4Configurable: true, wifiConfigurable: false }],
	primaryID: 'eth0',
	detail: 'full',
	known: true,
	capabilities: { ipv4: true, ipv4Elevation: true, wifi: true, staticGatewayRequired: false },
};

const subscribed = () => Promise.resolve(true);

test('a successful read populates the store', async () => {
	await syncNetworkState(subscribed, async () => live);
	expect(get(networkState).known).toBe(true);
	expect(get(networkState).capabilities.ipv4).toBe(true);
});

test('a failed read drops every capability it can no longer vouch for', async () => {
	await syncNetworkState(subscribed, async () => live);
	expect(get(networkState).interfaces).toHaveLength(1);
	// Now the backend restarts, or the read fails.
	await syncNetworkState(subscribed, () => Promise.reject(new Error('backend went away')));
	const after = get(networkState);
	expect(after.known).toBe(false);
	// Still on screen, but as history: nothing here can be edited any more.
	expect(after.interfaces).toHaveLength(1);
	expect(after.capabilities.ipv4).toBe(false);
	expect(after.capabilities.ipv4Elevation).toBe(false);
	expect(after.capabilities.wifi).toBe(false);
});
