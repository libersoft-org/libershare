/**
 * The failed-read path of `initNetworkState()`.
 *
 * Kept in a file of its own because it has to replace `src/scripts/api.ts`
 * before the store module is imported, and that replacement must not leak into
 * the other network-state cases.
 *
 * What is being pinned: a read that throws must leave the store with NO
 * interfaces and NO capabilities. Turning `known` off while keeping the previous
 * snapshot left the Settings screen gating its Configure buttons on a host state
 * that nobody could still vouch for.
 */
import { test, expect, mock } from 'bun:test';
import { get } from 'svelte/store';
import type { NetworkStateInfo } from '@shared';

const calls: string[] = [];
let failNext = false;

mock.module('../../src/scripts/api.ts', () => ({
	api: {
		on: () => {},
		subscribe: (event: string) => calls.push(`subscribe:${event}`),
		call: async () => {
			if (failNext) throw new Error('backend went away');
			return live;
		},
	},
}));

const live: NetworkStateInfo = {
	interfaces: [{ id: 'eth0', name: 'eth0', medium: 'wired', link: 'up', defaultRoute: true, mac: null, addresses: [], ipv4Mode: 'static', gateway: '192.0.2.1', dns: [], configurable: true }],
	primaryID: 'eth0',
	detail: 'full',
	known: true,
	capabilities: { ipv4: true, wifi: true, staticGatewayRequired: false },
};

const { initNetworkState, networkState } = await import('../../src/scripts/networkState.ts');

test('a successful read populates the store', async () => {
	failNext = false;
	await initNetworkState();
	expect(get(networkState).known).toBe(true);
	expect(get(networkState).capabilities.ipv4).toBe(true);
});

test('a failed read clears the interfaces and the capabilities it can no longer vouch for', async () => {
	failNext = false;
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
