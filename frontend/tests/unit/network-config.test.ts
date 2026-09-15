import { describe, expect, it } from 'bun:test';
import { canOpenNetworkConfig, networkConfigFormFrom, networkConfigFromForm, networkFormMessage, networkFormUpdate, validateNetworkConfigForm, visiblePrimaryInterface, type NetworkConfigForm } from '../../src/scripts/networkConfig.ts';
import type { NetInterfaceInfo, NetIPv4Baseline } from '@shared';

const iface: NetInterfaceInfo = {
	id: 'lan0',
	name: 'LAN',
	medium: 'wired',
	link: 'up',
	defaultRoute: true,
	mac: null,
	addresses: [{ family: 'ipv4', address: '192.0.2.10', prefixLength: 24 }],
	ipv4Mode: 'dhcp',
	ipv4Configurable: true,
	wifiConfigurable: false,
	gateway: '192.0.2.1',
	dns: ['192.0.2.53', '2001:db8::53', '127.0.0.1'],
};

describe('network configuration form', () => {
	it('preserves DNS by default, including IPv6 and loopback resolvers', () => {
		const form = networkConfigFormFrom(iface);
		expect(form.dns).toBe('192.0.2.53, 2001:db8::53, 127.0.0.1');
		expect(networkConfigFromForm(form)).toEqual({ mode: 'dhcp' });
	});

	it('distinguishes automatic DNS from a custom list', () => {
		const base = networkConfigFormFrom(iface);
		expect(networkConfigFromForm({ ...base, dnsMode: 'automatic' })).toEqual({ mode: 'dhcp', dns: [] });
		expect(networkConfigFromForm({ ...base, dnsMode: 'custom' })).toEqual({ mode: 'dhcp', dns: ['192.0.2.53', '2001:db8::53', '127.0.0.1'] });
	});

	it('deduplicates custom DNS before sending it to the backend', () => {
		const config = networkConfigFromForm({ mode: 'dhcp', address: '', prefix: '24', gateway: '', dnsMode: 'custom', dns: '192.0.2.53, 192.0.2.53, 2001:DB8::53, 2001:db8::53' });
		expect(config?.dns).toEqual(['192.0.2.53', '2001:db8::53']);
	});

	it('rejects custom DNS without at least one server', () => {
		const base = networkConfigFormFrom(iface);
		for (const dns of ['', '   ', ' ,  , ']) {
			const form = { ...base, dnsMode: 'custom' as const, dns };
			expect(validateNetworkConfigForm(form)).toBe('dns');
			expect(networkConfigFromForm(form)).toBeNull();
		}
	});

	it('builds a static address without forcing a DNS change', () => {
		const form: NetworkConfigForm = { mode: 'static', address: ' 198.51.100.10 ', prefix: '24', gateway: ' 198.51.100.1 ', dnsMode: 'unchanged', dns: '' };
		expect(networkConfigFromForm(form)).toEqual({ mode: 'static', address: '198.51.100.10', prefixLength: 24, gateway: '198.51.100.1' });
	});

	it('never turns an unknown addressing mode into DHCP', () => {
		const form = networkConfigFormFrom({ ...iface, ipv4Mode: 'unknown' });
		expect(form.mode).toBe('unknown');
		expect(networkConfigFromForm(form)).toBeNull();
	});

	it('opens disconnected Wi-Fi controls independently of IPv4 editing', () => {
		const disconnectedWifi = { ...iface, medium: 'wireless' as const, link: 'down' as const, ipv4Mode: 'unknown' as const, ipv4Configurable: false, wifiConfigurable: true };
		expect(canOpenNetworkConfig(disconnectedWifi, { ipv4: true, wifi: true, staticGatewayRequired: false }, 'full', true)).toBe(true);
		expect(canOpenNetworkConfig(disconnectedWifi, { ipv4: true, wifi: false, staticGatewayRequired: false }, 'full', true)).toBe(false);
		expect(canOpenNetworkConfig(disconnectedWifi, { ipv4: true, wifi: true, staticGatewayRequired: false }, 'addressesOnly', true)).toBe(false);
		expect(canOpenNetworkConfig(disconnectedWifi, { ipv4: true, wifi: true, staticGatewayRequired: false }, 'full', false)).toBe(false);
		expect(canOpenNetworkConfig({ ...disconnectedWifi, wifiConfigurable: false }, { ipv4: true, wifi: true, staticGatewayRequired: false }, 'full', true)).toBe(false);
	});

	it('shows Automatic when the saved primary interface no longer exists', () => {
		expect(visiblePrimaryInterface('missing', [iface])).toBe('');
		expect(visiblePrimaryInterface('lan0', [iface])).toBe('lan0');
	});

	it('re-seeds a static Wi-Fi form with the DHCP state of the newly joined network', () => {
		const oldForm = networkConfigFormFrom({ ...iface, medium: 'wireless', ipv4Mode: 'static', addresses: [{ family: 'ipv4', address: '192.0.2.50', prefixLength: 24 }] });
		const newForm = networkConfigFormFrom({ ...iface, medium: 'wireless', ipv4Mode: 'dhcp', addresses: [{ family: 'ipv4', address: '198.51.100.20', prefixLength: 24 }], gateway: '198.51.100.1', dns: ['198.51.100.53'] });
		expect(oldForm).toMatchObject({ mode: 'static', address: '192.0.2.50' });
		expect(newForm).toMatchObject({ mode: 'dhcp', address: '198.51.100.20', gateway: '198.51.100.1', dns: '198.51.100.53' });
	});
});

describe('open form against a moving host', () => {
	const opened: NetIPv4Baseline = { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.53'] };
	const moved: NetIPv4Baseline = { ...opened, address: '192.0.2.11' };

	it('leaves a form alone while the host still matches what it was seeded from', () => {
		expect(networkFormUpdate(opened, opened, true)).toBe('keep');
		expect(networkFormUpdate(opened, opened, false)).toBe('keep');
	});

	it('blocks a typed-in form once the host moved under it', () => {
		// The sequence that must not end in a silent overwrite: a save fails, the
		// interface is changed from somewhere else, and Save is pressed again.
		expect(networkFormUpdate(moved, opened, true)).toBe('stale');
	});

	it('re-seeds an untouched form from the host instead of blocking it', () => {
		expect(networkFormUpdate(moved, opened, false)).toBe('reseed');
	});

	it('seeds the first reading, which has no baseline to compare against', () => {
		expect(networkFormUpdate(opened, null, false)).toBe('seed');
		expect(networkFormUpdate(opened, null, true)).toBe('seed');
	});
});

describe('networkFormMessage', () => {
	it('announces a re-seed when nothing else is on screen', () => {
		expect(networkFormMessage('reseed', false)).toBe('reseedAnnounce');
	});

	it('keeps quiet through EVERY re-seed a finished operation causes', () => {
		// A failed join drops the association it started from, so the address goes
		// and comes back: one attempt arrives as several re-seeds. Announcing on any
		// of them replaces "check the password" with "the form was reloaded".
		let reported = true;
		expect(networkFormMessage('reseed', reported)).toBe('reseedSilent');
		expect(networkFormMessage('reseed', reported)).toBe('reseedSilent');
		expect(networkFormMessage('reseed', reported)).toBe('reseedSilent');
		// The protection ends where the message does: at the next operation.
		reported = false;
		expect(networkFormMessage('reseed', reported)).toBe('reseedAnnounce');
	});

	it('goes stale either way, but keeps a result the operation just reported', () => {
		// The change under a half-typed form is very often this form's own failed
		// attempt: a wrong password drops the association and takes the address with
		// it. Saying "changed outside" there hid the reason the user needed and
		// blamed somebody else for it. Save still greys out and the reload button
		// still appears, because that is the state, not the wording.
		expect(networkFormMessage('stale', true)).toBe('staleSilent');
		expect(networkFormMessage('stale', false)).toBe('stale');
	});

	it('does nothing when the host still matches the form', () => {
		expect(networkFormMessage('keep', true)).toBe('keep');
		expect(networkFormMessage('keep', false)).toBe('keep');
	});
});

describe('networkFormMessage on the first fill', () => {
	it('does not tell someone who just opened the screen that the form was reloaded', () => {
		// 'seed' is the initial fill, not a re-seed. Folding it in with 'reseed'
		// announced a reload that never happened.
		expect(networkFormMessage('seed', false)).toBe('reseedSilent');
		expect(networkFormMessage('seed', true)).toBe('reseedSilent');
	});
});

describe('networkFormMessage through a failed join on a half-typed form', () => {
	it('keeps the reason across the stale reading and every re-seed after it', () => {
		// The exact sequence: the user is editing DNS, a join fails, the interface
		// moves because of that failure, and the readings arrive one after another.
		let reported = true;
		expect(networkFormMessage('stale', reported)).toBe('staleSilent');
		expect(networkFormMessage('reseed', reported)).toBe('reseedSilent');
		expect(networkFormMessage('reseed', reported)).toBe('reseedSilent');
		// Reloading the form drops the message, so the protection drops with it.
		reported = false;
		expect(networkFormMessage('stale', reported)).toBe('stale');
	});
});
