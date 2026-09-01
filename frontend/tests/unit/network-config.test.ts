import { describe, expect, it } from 'bun:test';
import { canOpenNetworkConfig, networkConfigFormFrom, networkConfigFromForm, validateNetworkConfigForm, visiblePrimaryInterface, type NetworkConfigForm } from '../../src/scripts/networkConfig.ts';
import type { NetInterfaceInfo } from '@shared';

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
		expect(config?.dns).toEqual(['192.0.2.53', '2001:DB8::53']);
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
		expect(canOpenNetworkConfig(disconnectedWifi, { ipv4: true, wifi: true, staticGatewayRequired: false }, 'full')).toBe(true);
		expect(canOpenNetworkConfig(disconnectedWifi, { ipv4: true, wifi: false, staticGatewayRequired: false }, 'full')).toBe(false);
		expect(canOpenNetworkConfig(disconnectedWifi, { ipv4: true, wifi: true, staticGatewayRequired: false }, 'addressesOnly')).toBe(false);
		expect(canOpenNetworkConfig({ ...disconnectedWifi, wifiConfigurable: false }, { ipv4: true, wifi: true, staticGatewayRequired: false }, 'full')).toBe(false);
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
