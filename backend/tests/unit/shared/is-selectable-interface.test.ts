import { describe, expect, it } from 'bun:test';
import { isSelectableInterface, type NetInterfaceInfo } from '@shared';

/** An interface with only the fields a case cares about spelled out. */
function iface(overrides: Partial<NetInterfaceInfo> & { id: string }): NetInterfaceInfo {
	return { name: overrides.id, medium: 'other', link: 'up', defaultRoute: false, mac: null, addresses: [], ipv4Mode: 'unknown', gateway: null, dns: [], ipv4Configurable: false, wifiScannable: false, wifiConnectable: false, ...overrides };
}

const address = (a: string, family: 'ipv4' | 'ipv6' = 'ipv4'): NetInterfaceInfo['addresses'][number] => ({ family, address: a, prefixLength: 24 });

describe('isSelectableInterface', () => {
	it('always offers real hardware, even unplugged and unaddressed', () => {
		expect(isSelectableInterface(iface({ id: 'eth', medium: 'wired', link: 'down' }))).toBe(true);
		expect(isSelectableInterface(iface({ id: 'wlan', medium: 'wireless', link: 'down' }))).toBe(true);
	});

	it('offers a virtual device that holds a routable address', () => {
		expect(isSelectableInterface(iface({ id: 'tun0', addresses: [address('198.51.100.7')] }))).toBe(true);
	});

	it('offers a virtual device that carries the default route even with no address', () => {
		expect(isSelectableInterface(iface({ id: 'tun0', defaultRoute: true }))).toBe(true);
	});

	it('hides a container veth whose only address is IPv6 link-local', () => {
		// The reason this predicate exists: 111 of 137 interfaces on a container
		// host look exactly like this, and listing them buries the real ones.
		expect(isSelectableInterface(iface({ id: 'veth42085d7', addresses: [address('fe80::c0d5:4bff:fe21:5c66', 'ipv6')] }))).toBe(false);
	});

	it('hides an adapter that only ever got an APIPA address', () => {
		expect(isSelectableInterface(iface({ id: 'tap0', addresses: [address('169.254.13.4')] }))).toBe(false);
	});

	it('hides an addressless virtual device', () => {
		expect(isSelectableInterface(iface({ id: 'br0' }))).toBe(false);
	});
});
