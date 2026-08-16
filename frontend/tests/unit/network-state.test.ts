/**
 * Unit tests for the host network-state store in `src/scripts/networkState.ts`.
 *
 * The store feeds the Settings > Network screen, which gates its Configure and
 * Wi-Fi buttons on `capabilities` and on the per-interface `configurable` flag.
 * A failed read therefore has to clear those, not merely flag the snapshot
 * unknown: buttons left enabled from a stale snapshot refer to a host state
 * nobody can still vouch for, and pressing one starts a destructive operation.
 *
 * The module is a plain store, so it runs under `bun test` without the Svelte
 * runtime.
 */
import { test, expect } from 'bun:test';
import { get } from 'svelte/store';
import { networkState, unknownNetworkState } from '../../src/scripts/networkState.ts';
import type { NetworkStateInfo } from '@shared';

/** A settled snapshot of a host that can be reconfigured. */
function liveState(): NetworkStateInfo {
	return {
		interfaces: [{ id: 'eth0', name: 'eth0', medium: 'wired', link: 'up', defaultRoute: true, mac: null, addresses: [{ family: 'ipv4', address: '192.0.2.10', prefixLength: 24 }], ipv4Mode: 'static', gateway: '192.0.2.1', dns: [], configurable: true }],
		primaryID: 'eth0',
		detail: 'full',
		known: true,
		capabilities: { ipv4: true, wifi: true },
	};
}

test('the unknown state claims no interfaces and no capabilities', () => {
	const blank = unknownNetworkState();
	expect(blank.known).toBe(false);
	expect(blank.interfaces).toEqual([]);
	expect(blank.primaryID).toBeNull();
	expect(blank.capabilities).toEqual({ ipv4: false, wifi: false });
});

test('a fresh unknown state is returned each time, not one shared object', () => {
	// The store mutates nothing, but a shared literal would let one caller's edit
	// leak into every later reset.
	const first = unknownNetworkState();
	first.interfaces.push(liveState().interfaces[0]!);
	expect(unknownNetworkState().interfaces).toEqual([]);
});

test('resetting to unknown drops the capabilities a failed read can no longer vouch for', () => {
	networkState.set(liveState());
	expect(get(networkState).capabilities.ipv4).toBe(true);
	// What initNetworkState does in its catch: replace the whole snapshot rather
	// than turn one flag off on top of the stale one.
	networkState.set(unknownNetworkState());
	const after = get(networkState);
	expect(after.capabilities).toEqual({ ipv4: false, wifi: false });
	expect(after.interfaces).toEqual([]);
	expect(after.known).toBe(false);
});

test('merely clearing known would have left the stale list and capabilities behind', () => {
	// The shape of the old bug, kept as a negative control: this is what the
	// screen used to be handed after a backend restart.
	networkState.set(liveState());
	networkState.update(state => ({ ...state, known: false }));
	const stale = get(networkState);
	expect(stale.interfaces).toHaveLength(1);
	expect(stale.capabilities.ipv4).toBe(true);
	// ...and this is what it is handed now.
	networkState.set(unknownNetworkState());
	expect(get(networkState).interfaces).toHaveLength(0);
});
