/**
 * The failed-read path of `initNetworkState()`.
 *
 * What is being pinned: a read that throws must leave the store with NO
 * interfaces and NO capabilities. Turning `known` off while keeping the previous
 * snapshot left the Settings screen gating its Configure buttons on a host state
 * that nobody could still vouch for.
 *
 * The transport comes from the suite-wide fake, armed here and put back in
 * `beforeEach`. Registering a `mock.module()` of its own — which this file used to
 * do — writes to a global registry `mock.restore()` cannot undo, so which fake was
 * in force depended on file load order.
 */
import { beforeEach, test, expect } from 'bun:test';
import { get } from 'svelte/store';
import type { NetworkStateInfo } from '@shared';
import { apiHandlers, resetAPIMock } from '../api-mock.ts';

let failNext = false;

beforeEach(() => {
	resetAPIMock();
	failNext = false;
	apiHandlers.call = async () => {
		if (failNext) throw new Error('backend went away');
		return live;
	};
});

const live: NetworkStateInfo = {
	interfaces: [{ id: 'eth0', name: 'eth0', medium: 'wired', link: 'up', defaultRoute: true, mac: null, addresses: [], ipv4Mode: 'static', gateway: '192.0.2.1', dns: [], ipv4Configurable: true, wifiScannable: true, wifiConnectable: true }],
	primaryID: 'eth0',
	detail: 'full',
	known: true,
	capabilities: { ipv4: true, wifi: true, staticGatewayRequired: false },
};

const { initNetworkState, networkState } = await import('../../src/scripts/networkState.ts');

test('a successful read populates the store', async () => {
	await initNetworkState();
	expect(get(networkState).known).toBe(true);
	expect(get(networkState).capabilities.ipv4).toBe(true);
});

test('a failed read clears the interfaces and the capabilities it can no longer vouch for', async () => {
	await initNetworkState();
	expect(get(networkState).interfaces).toHaveLength(1);
	// Now the backend restarts, or the read fails.
	failNext = true;
	await initNetworkState();
	const after = get(networkState);
	expect(after.known).toBe(false);
	expect(after.interfaces).toEqual([]);
	expect(after.capabilities).toEqual({ ipv4: false, wifi: false, staticGatewayRequired: false });
	expect(after.primaryID).toBeNull();
});
