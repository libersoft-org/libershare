import { describe, expect, it } from 'bun:test';
import { deriveConnectionStatus, type NetInterfaceInfo, type NetworkStateInfo } from '@shared';

/** An interface with only the fields a case cares about spelled out. */
function iface(overrides: Partial<NetInterfaceInfo> & { id: string }): NetInterfaceInfo {
	return { name: overrides.id, medium: 'wired', link: 'up', defaultRoute: false, mac: null, addresses: [], ipv4Mode: 'unknown', ipv4Configurable: false, wifiConfigurable: false, gateway: null, dns: [], ...overrides };
}

function state(interfaces: NetInterfaceInfo[], overrides: Partial<NetworkStateInfo> = {}): NetworkStateInfo {
	return { interfaces, primaryID: interfaces.find(i => i.defaultRoute)?.id ?? null, detail: 'full', known: true, capabilities: { ipv4: false, wifi: false, staticGatewayRequired: false }, ...overrides };
}

describe('deriveConnectionStatus', () => {
	it('reports a live cable as wired and connected', () => {
		const result = deriveConnectionStatus(state([iface({ id: '1', name: 'Ethernet', link: 'up', defaultRoute: true })]));
		expect(result).toEqual({ kind: 'wired', connected: true, signal: null, ssid: null, interfaceName: 'Ethernet' });
	});

	it('reports an unplugged cable as wired and disconnected', () => {
		const result = deriveConnectionStatus(state([iface({ id: '1', name: 'Ethernet', link: 'down', defaultRoute: true })]));
		expect(result).toMatchObject({ kind: 'wired', connected: false });
	});

	it('passes a real Wi-Fi signal through untouched', () => {
		const result = deriveConnectionStatus(state([iface({ id: '1', name: 'Wi-Fi', medium: 'wireless', link: 'up', defaultRoute: true, wifi: { ssid: 'Example Net', signal: 64, radio: 'on' } })]));
		expect(result).toEqual({ kind: 'wifi', connected: true, signal: 64, ssid: 'Example Net', interfaceName: 'Wi-Fi' });
	});

	it('reports an associated adapter with no signal reading as unknown rather than a number', () => {
		const result = deriveConnectionStatus(state([iface({ id: '1', name: 'Wi-Fi', medium: 'wireless', link: 'up', defaultRoute: true, wifi: { ssid: 'Example Net', signal: null, radio: 'on' } })]));
		expect(result).toMatchObject({ kind: 'wifi', connected: true, signal: null, ssid: 'Example Net' });
	});

	it('distinguishes a killed radio from being merely disconnected', () => {
		const result = deriveConnectionStatus(state([iface({ id: '1', name: 'Wi-Fi', medium: 'wireless', link: 'down', defaultRoute: true, wifi: { ssid: null, signal: null, radio: 'off' } })]));
		expect(result).toMatchObject({ kind: 'wifiOff', connected: false, signal: null });
	});

	it('never carries a stale signal into a disconnected adapter', () => {
		const result = deriveConnectionStatus(state([iface({ id: '1', medium: 'wireless', link: 'down', defaultRoute: true, wifi: { ssid: 'Example Net', signal: 88, radio: 'on' } })]));
		expect(result).toMatchObject({ kind: 'wifi', connected: false, signal: null, ssid: null });
	});

	it('does not turn an unknown Wi-Fi link state into disconnected', () => {
		const result = deriveConnectionStatus(state([iface({ id: '1', medium: 'wireless', link: 'unknown', defaultRoute: true, wifi: { ssid: null, signal: null, radio: 'unknown' } })]));
		expect(result).toEqual({ kind: 'unknown', connected: false, signal: null, ssid: null, interfaceName: '1' });
	});

	it('falls back to the default route when the user pick no longer exists', () => {
		const interfaces = [iface({ id: 'wan', name: 'Ethernet', defaultRoute: true })];
		const result = deriveConnectionStatus(state(interfaces, { primaryID: 'wan' }));
		expect(result).toMatchObject({ kind: 'wired', interfaceName: 'Ethernet' });
	});

	it('reports nothing when no interface is primary', () => {
		const result = deriveConnectionStatus(state([iface({ id: '1' })], { primaryID: null }));
		expect(result).toEqual({ kind: 'none', connected: false, signal: null, ssid: null, interfaceName: null });
	});

	it('reports unknown before the first read settles', () => {
		const result = deriveConnectionStatus(state([], { known: false }));
		expect(result).toEqual({ kind: 'unknown', connected: false, signal: null, ssid: null, interfaceName: null });
	});

	it('reports unknown on a platform that only knows addresses', () => {
		const interfaces = [iface({ id: 'en0', name: 'en0', medium: 'other', link: 'unknown' })];
		const result = deriveConnectionStatus(state(interfaces, { primaryID: 'en0', detail: 'addressesOnly' }));
		expect(result).toMatchObject({ kind: 'unknown', connected: false, interfaceName: 'en0' });
	});

	it('does not claim a host with addresses but no route data is disconnected', () => {
		// macOS and the degraded fallback report no default route at all, so `none`
		// would render a perfectly connected machine as "Disconnected".
		const interfaces = [iface({ id: 'en0', name: 'en0', medium: 'other', link: 'unknown', addresses: [{ family: 'ipv4', address: '192.0.2.2', prefixLength: 24 }] })];
		const result = deriveConnectionStatus(state(interfaces, { primaryID: null, detail: 'addressesOnly' }));
		expect(result.kind).toBe('unknown');
	});

	it('reports a live tunnel as unknown-but-connected rather than claiming a cable', () => {
		const interfaces = [iface({ id: 'tun0', name: 'VPN', medium: 'other', link: 'up', defaultRoute: true })];
		const result = deriveConnectionStatus(state(interfaces));
		expect(result).toMatchObject({ kind: 'unknown', connected: true, interfaceName: 'VPN' });
	});
});
