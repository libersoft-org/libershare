/**
 * Unit tests for the host network-state store in `src/scripts/networkState.ts`.
 *
 * The store feeds the Settings > Network screen, which gates its Configure and
 * Wi-Fi buttons on `capabilities` and on the per-interface capability flags.
 * A failed read therefore has to clear those, not merely flag the snapshot
 * unknown: buttons left enabled from a stale snapshot refer to a host state
 * nobody can still vouch for, and pressing one starts a destructive operation.
 *
 * The module is a plain store, so it runs under `bun test` without the Svelte
 * runtime.
 */
import { test, expect } from 'bun:test';
import { get } from 'svelte/store';
import { canApplyMode, canEditInterfaceIPv4, canEditInterfaceWifi, isJoinable, networkState, unknownNetworkState } from '../../src/scripts/networkState.ts';
import type { NetInterfaceInfo, NetworkStateInfo, NetWifiNetwork } from '@shared';

/** One interface of a settled, writable host. */
function iface(overrides: Partial<NetInterfaceInfo> = {}): NetInterfaceInfo {
	return { id: 'eth0', name: 'eth0', medium: 'wired', link: 'up', defaultRoute: true, mac: null, addresses: [{ family: 'ipv4', address: '192.0.2.10', prefixLength: 24 }], ipv4Mode: 'static', gateway: '192.0.2.1', dns: [], ipv4Configurable: true, wifiScannable: true, wifiConnectable: true, ...overrides };
}

/** A settled snapshot whose host can be reconfigured. */
function snapshot(overrides: Partial<NetworkStateInfo> = {}): NetworkStateInfo {
	return { interfaces: [], primaryID: null, detail: 'full', known: true, capabilities: { ipv4: true, wifi: true, staticGatewayRequired: false }, ...overrides };
}

/** One row of a Wi-Fi scan result. */
function wifi(overrides: Partial<NetWifiNetwork> = {}): NetWifiNetwork {
	return { ssid: 'Example Net', signal: 70, secured: true, active: false, ...overrides };
}

/** A settled snapshot of a host that can be reconfigured. */
function liveState(): NetworkStateInfo {
	return {
		interfaces: [{ id: 'eth0', name: 'eth0', medium: 'wired', link: 'up', defaultRoute: true, mac: null, addresses: [{ family: 'ipv4', address: '192.0.2.10', prefixLength: 24 }], ipv4Mode: 'static', gateway: '192.0.2.1', dns: [], ipv4Configurable: true, wifiScannable: true, wifiConnectable: true }],
		primaryID: 'eth0',
		detail: 'full',
		known: true,
		capabilities: { ipv4: true, wifi: true, staticGatewayRequired: false },
	};
}

test('the unknown state claims no interfaces and no capabilities', () => {
	const blank = unknownNetworkState();
	expect(blank.known).toBe(false);
	expect(blank.interfaces).toEqual([]);
	expect(blank.primaryID).toBeNull();
	expect(blank.capabilities).toEqual({ ipv4: false, wifi: false, staticGatewayRequired: false });
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
	expect(after.capabilities).toEqual({ ipv4: false, wifi: false, staticGatewayRequired: false });
	expect(after.interfaces).toEqual([]);
	expect(after.known).toBe(false);
});

test('a scanned network is joinable when nothing else is running', () => {
	expect(isJoinable(wifi(), { busy: false, scanning: false })).toBe(true);
});

test('a scanned network is not joinable while a scan is running', () => {
	// The scan button was disabled during a sweep but the result rows were not, so
	// a join could be started on the radio that was mid-scan — and the backend
	// does not serialise the two either, the scan being outside the apply lock.
	expect(isJoinable(wifi(), { busy: false, scanning: true })).toBe(false);
});

test('a scanned network is not joinable while an apply or join is in flight', () => {
	expect(isJoinable(wifi(), { busy: true, scanning: false })).toBe(false);
});

test('the network already in use is not joinable again', () => {
	// A join rewrites the stored profile before it associates, so re-selecting the
	// row that already carries the check mark would replace a working saved
	// network's configuration to end up exactly where it started.
	expect(isJoinable(wifi({ active: true }), { busy: false, scanning: false })).toBe(false);
});

test('addressing is editable on a settled, writable, single-address interface', () => {
	expect(canEditInterfaceIPv4(iface(), snapshot())).toBe(true);
});

test('addressing is not editable when the host cannot write it', () => {
	expect(canEditInterfaceIPv4(iface(), snapshot({ capabilities: { ipv4: false, wifi: true, staticGatewayRequired: false } }))).toBe(false);
});

test('addressing is not editable from an address-only read', () => {
	// That fallback reports device names where the apply path expects adapter
	// GUIDs, so every save from it is rejected by the backend.
	expect(canEditInterfaceIPv4(iface(), snapshot({ detail: 'addressesOnly' }))).toBe(false);
});

test('addressing is not editable on an interface the tooling cannot reach', () => {
	expect(canEditInterfaceIPv4(iface({ ipv4Configurable: false }), snapshot())).toBe(false);
});

test('addressing is not editable on an interface carrying IPv4 aliases', () => {
	// The form holds one address and applying it replaces every address there was.
	const aliased = iface({
		addresses: [
			{ family: 'ipv4', address: '192.0.2.10', prefixLength: 24 },
			{ family: 'ipv4', address: '192.0.2.11', prefixLength: 24 },
		],
	});
	expect(canEditInterfaceIPv4(aliased, snapshot())).toBe(false);
});

test('a missing interface is never editable', () => {
	expect(canEditInterfaceIPv4(undefined, snapshot())).toBe(false);
	expect(canEditInterfaceWifi(undefined, snapshot())).toBe(false);
});

test('wi-fi is driveable only on an interface with a real radio', () => {
	expect(canEditInterfaceWifi(iface(), snapshot())).toBe(false);
	expect(canEditInterfaceWifi(iface({ medium: 'wireless', wifi: { ssid: null, signal: null, radio: 'on' } }), snapshot())).toBe(true);
});

test('wi-fi is not driveable on an interface the tooling cannot reach', () => {
	const radio = iface({ medium: 'wireless', wifiScannable: false, wifi: { ssid: null, signal: null, radio: 'on' } });
	expect(canEditInterfaceWifi(radio, snapshot())).toBe(false);
});

// The regression the split exists for. On Linux `ipv4Configurable` requires an
// ACTIVE connection profile, which a disconnected adapter has not got — and while
// Wi-Fi read the same flag, the one adapter a user most needs to scan with was
// the one adapter they could not.
test('wi-fi stays driveable on a radio whose addressing is not editable', () => {
	const disconnected = iface({ medium: 'wireless', ipv4Configurable: false, wifiScannable: true, wifiConnectable: true, wifi: { ssid: null, signal: null, radio: 'on' } });
	expect(canEditInterfaceIPv4(disconnected, snapshot())).toBe(false);
	expect(canEditInterfaceWifi(disconnected, snapshot())).toBe(true);
});

test('an addressing mode the host could not name is not applicable', () => {
	// The editor used to seed `unknown` as DHCP, so opening a partially-read
	// interface and pressing Save converted it to DHCP without the user ever
	// choosing that. Save now waits for an explicit pick.
	expect(canApplyMode('unknown')).toBe(false);
});

test('the two modes the user can actually choose are applicable', () => {
	expect(canApplyMode('dhcp')).toBe(true);
	expect(canApplyMode('static')).toBe(true);
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
