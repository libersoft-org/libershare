import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ptr, type Pointer } from 'bun:ffi';
import { parseWindowsNetworkState, readConnectionAttributes, WINDOWS_STATE_COMMAND } from '../../src/system-network-windows.ts';
import { dbmToQuality, parseIwLink, parseLinuxNetworkState } from '../../src/system-network-linux.ts';
import { assertReadProducedSomething, assertWifiConfigurableInterface, NetworkStateCache, prefixFromNetmask, readGenericInterfaces, readNetworkState, resolvePrimaryID, resetNetworkStateCache, runNetworkMutation, type NetworkSnapshot } from '../../src/system-network.ts';
import { ErrorCodes, type NetInterfaceInfo } from '@shared';

/**
 * Fixtures are the verbatim shape of real command output captured on a Windows
 * 11 workstation and a Linux container, with every address, MAC and GUID
 * rewritten to documentation ranges before entering the repository.
 */
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const windowsFixture = (): string => {
	const doc = JSON.parse(fixture('network-windows.json')) as Record<string, any[]>;
	const dhcpIndexes = new Set(doc['interfaces']!.filter(row => row.Family === 2 && row.Dhcp === 1).map(row => row.ifIndex));
	doc['addresses'] = doc['addresses']!.map(row => ({ Type: 1, SkipAsSource: false, Infinite: true, ...row }));
	doc['persistentAddresses'] = doc['addresses']!.filter(row => row.Family === 2 && !dhcpIndexes.has(row.ifIndex)).map(row => ({ ...row, State: 0 }));
	doc['routes'] = doc['routes']!.map(row => ({ Protocol: 3, Publish: 0, Infinite: true, ...row }));
	doc['persistentRoutes'] = doc['routes']!.filter(row => !dhcpIndexes.has(row.ifIndex)).map(row => ({ ...row }));
	return JSON.stringify(doc);
};
const simpleWindowsStaticDoc = (): Record<string, unknown> => ({
	adapters: { ifIndex: 5, Name: 'Ethernet', InterfaceGuid: '{11111111-2222-3333-4444-555555555555}', MacAddress: '02-00-5E-30-00-01', Media: 14, State: 1 },
	addresses: { ifIndex: 5, Family: 2, IPAddress: '198.51.100.5', PrefixLength: 24, State: 4, PrefixOrigin: 1, SuffixOrigin: 1, Type: 1, SkipAsSource: false, Infinite: true },
	persistentAddresses: { ifIndex: 5, Family: 2, IPAddress: '198.51.100.5', PrefixLength: 24, State: 0, PrefixOrigin: 1, SuffixOrigin: 1, Type: 1, SkipAsSource: false, Infinite: true },
	interfaces: { ifIndex: 5, Family: 2, Dhcp: 0 },
	routes: { ifIndex: 5, NextHop: '198.51.100.1', RouteMetric: 25, Protocol: 3, Publish: 0, Infinite: true },
	persistentRoutes: { ifIndex: 5, NextHop: '198.51.100.1', RouteMetric: 25, Protocol: 3, Publish: 0, Infinite: true },
	dns: { InterfaceIndex: 5, Servers: '198.51.100.1' },
});
const byID = (list: NetInterfaceInfo[], id: string): NetInterfaceInfo => {
	const found = list.find(i => i.id === id);
	if (!found) throw new Error(`interface ${id} missing from parse result`);
	return found;
};

describe('WINDOWS_STATE_COMMAND', () => {
	it('wraps every collection so a single-row result stays an array', () => {
		for (const name of ['adapters', 'addresses', 'persistentAddresses', 'interfaces', 'routes', 'persistentRoutes', 'dns']) {
			expect(WINDOWS_STATE_COMMAND).toContain(`$${name} = @(`);
		}
	});

	it('fails the whole read when any required Windows query fails', () => {
		expect(WINDOWS_STATE_COMMAND).toContain('$ErrorActionPreference = "Stop"');
		for (const cmdlet of ['Get-NetAdapter', 'Get-NetIPAddress', 'Get-NetIPInterface', 'Get-NetRoute', 'Get-DnsClientServerAddress']) {
			expect(WINDOWS_STATE_COMMAND).toMatch(new RegExp(`${cmdlet}[^;]+-ErrorAction Stop`));
		}
		expect(WINDOWS_STATE_COMMAND).not.toContain('SilentlyContinue');
	});

	it('allows a successful route query to return no default route', () => {
		expect(WINDOWS_STATE_COMMAND).toContain("Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop | Where-Object DestinationPrefix -eq '0.0.0.0/0'");
		expect(WINDOWS_STATE_COMMAND).not.toContain("Get-NetRoute -DestinationPrefix '0.0.0.0/0'");
	});

	it('projects the enums it parses to integers so the OS display language cannot matter', () => {
		expect(WINDOWS_STATE_COMMAND).toContain('[int]$_.NdisPhysicalMedium');
		expect(WINDOWS_STATE_COMMAND).toContain('[int]$_.MediaConnectionState');
		expect(WINDOWS_STATE_COMMAND).toContain('[int]$_.Dhcp');
		expect(WINDOWS_STATE_COMMAND).toContain('[int]$_.AddressState');
		expect(WINDOWS_STATE_COMMAND).toContain('[int]$_.PrefixOrigin');
		expect(WINDOWS_STATE_COMMAND).toContain('[int]$_.SuffixOrigin');
	});

	it('only queries — it contains no cmdlet that could change configuration', () => {
		expect(WINDOWS_STATE_COMMAND).not.toMatch(/\b(Set|New|Remove|Disable|Enable|Restart)-Net/);
	});
});

describe('parseWindowsNetworkState', () => {
	const result = parseWindowsNetworkState(windowsFixture());

	it('follows the IPv6 default route when the host has no IPv4 one', () => {
		const doc = JSON.parse(windowsFixture()) as Record<string, unknown>;
		const ethernetIndex = (doc['routes'] as Array<{ ifIndex: number }>)[0]!.ifIndex;
		const noIPv4 = parseWindowsNetworkState(JSON.stringify({ ...doc, routes: [] }));
		expect(noIPv4.some(item => item.defaultRoute)).toBe(false);
		const viaIPv6 = parseWindowsNetworkState(JSON.stringify({ ...doc, routes: [], routes6: [{ ifIndex: ethernetIndex, RouteMetric: 256, InterfaceMetric: 25 }] }));
		expect(viaIPv6.find(item => item.defaultRoute)?.id).toBe(ID.ethernet);
		// The gateway on screen stays the IPv4 one, so an IPv6-only host shows none.
		expect(viaIPv6.find(item => item.defaultRoute)?.gateway).toBeNull();
		// Where both exist the IPv4 route decides.
		const both = parseWindowsNetworkState(JSON.stringify({ ...doc, routes6: [{ ifIndex: 999, RouteMetric: 0, InterfaceMetric: 0 }] }));
		expect(both.find(item => item.defaultRoute)?.id).toBe(ID.ethernet);
	});
	// Public ids are the adapters' persistent GUIDs (ifIndex is not stable across
	// reboots and the id is persisted as the user's primary-interface preference).
	const ID = {
		tunnel: '{FC01FCD5-2B9D-2FD8-78D8-CB78B313E2B2}',
		bluetooth: '{F46752A1-9B1B-43B2-8BBB-EEAAC5AEB2AD}',
		ethernet: '{901F20ED-4B31-4803-B655-ED47D47AD070}',
		wifiDirect: '{83A903DA-2D0F-40A4-AEAE-8504AE7BDEB0}',
		ethernet4: '{3E0713DD-C5DB-4F8C-B105-6A804AD4AA33}',
		wifi: '{1227A929-7D30-456E-B9C1-DBD0899A8950}',
	};

	it('rejects a document missing any required query result', () => {
		const complete = JSON.parse(windowsFixture()) as Record<string, unknown>;
		for (const key of ['adapters', 'addresses', 'persistentAddresses', 'interfaces', 'routes', 'persistentRoutes', 'dns']) {
			const partial = { ...complete };
			delete partial[key];
			expect(() => parseWindowsNetworkState(JSON.stringify(partial))).toThrow(`missing ${key}`);
		}
	});

	it('keys interfaces by their persistent GUID, not by the volatile ifIndex', () => {
		expect(result.map(i => i.id)).toContain(ID.ethernet);
		expect(result.some(i => i.id === '20')).toBe(false);
	});

	it('reads the cabled adapter as wired, up, DHCP with its gateway and DNS', () => {
		const eth = byID(result, ID.ethernet);
		expect(eth.medium).toBe('wired');
		expect(eth.link).toBe('up');
		expect(eth.ipv4Mode).toBe('dhcp');
		expect(eth.defaultRoute).toBe(true);
		expect(eth.gateway).toBe('192.0.2.1');
		expect(eth.dns).toEqual(['192.0.2.1', '192.0.2.2']);
		expect(eth.addresses).toContainEqual({ family: 'ipv4', address: '192.0.2.10', prefixLength: 24 });
		expect(eth.ipv4Configurable).toBe(true);
	});

	it('reads the Wi-Fi adapter as wireless and disconnected', () => {
		const wifi = byID(result, ID.wifi);
		expect(wifi.medium).toBe('wireless');
		expect(wifi.link).toBe('down');
	});

	it('does not confuse Dhcp with MediaConnectionState — both use 1 for opposite meanings', () => {
		// This adapter is Dhcp=1 (enabled) but MediaConnectionState=2 (disconnected).
		const eth4 = byID(result, ID.ethernet4);
		expect(eth4.ipv4Mode).toBe('dhcp');
		expect(eth4.link).toBe('down');
	});

	it('classifies media it cannot map with confidence as other', () => {
		expect(byID(result, ID.tunnel).medium).toBe('other'); // NdisPhysicalMedium 0
		expect(byID(result, ID.bluetooth).medium).toBe('other'); // Bluetooth PAN, 10
	});

	it('keeps an addressed stack that has no adapter row (RAS/VPN wintun)', () => {
		const ras = byID(result, 'ifIndex:69');
		expect(ras.medium).toBe('other');
		expect(ras.link).toBe('unknown');
		expect(ras.addresses).toContainEqual({ family: 'ipv4', address: '203.0.113.200', prefixLength: 32 });
		expect(ras.ipv4Configurable).toBe(false);
	});

	it('drops tentative APIPA, deprecated link-local and loopback addresses', () => {
		const every = result.flatMap(i => i.addresses.map(a => a.address));
		expect(every.some(a => a.startsWith('169.254.'))).toBe(false);
		expect(every).not.toContain('fe80::c193:5eba:4ec9:d3a5'); // AddressState 3 = Deprecated
		expect(every).not.toContain('127.0.0.1');
		expect(every).not.toContain('::1');
		// The loopback pseudo-interface owns nothing else, so it disappears entirely.
		expect(result.some(i => i.id === 'ifIndex:1')).toBe(false);
	});

	it('strips the scope suffix from link-local addresses', () => {
		expect(byID(result, ID.ethernet).addresses).toContainEqual({ family: 'ipv6', address: 'fe80::c16a:d2b4:e506:e773', prefixLength: 64 });
	});

	it('parses a one-NIC document where ConvertTo-Json emitted bare objects', () => {
		const single = JSON.stringify(simpleWindowsStaticDoc());
		const parsed = parseWindowsNetworkState(single);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({ id: '{11111111-2222-3333-4444-555555555555}', medium: 'wired', link: 'up', ipv4Mode: 'static', ipv4Configurable: true, defaultRoute: true, gateway: '198.51.100.1', dns: ['198.51.100.1'] });
	});

	it('keeps active-only or advanced static policy read-only', () => {
		const cases = [(doc: Record<string, any>) => (doc['persistentAddresses'] = []), (doc: Record<string, any>) => (doc['persistentRoutes'] = []), (doc: Record<string, any>) => (doc['addresses'].SkipAsSource = true), (doc: Record<string, any>) => (doc['addresses'].Infinite = false), (doc: Record<string, any>) => (doc['addresses'].Type = 2), (doc: Record<string, any>) => (doc['routes'].Infinite = false), (doc: Record<string, any>) => (doc['routes'].Protocol = 2)];
		for (const mutate of cases) {
			const doc = simpleWindowsStaticDoc();
			mutate(doc);
			expect(parseWindowsNetworkState(JSON.stringify(doc))[0]?.ipv4Configurable).toBe(false);
		}
	});

	it('keeps a static /32 address with an off-link gateway read-only', () => {
		const doc = simpleWindowsStaticDoc() as Record<string, any>;
		doc['addresses'].PrefixLength = 32;
		doc['persistentAddresses'].PrefixLength = 32;
		expect(parseWindowsNetworkState(JSON.stringify(doc))[0]?.ipv4Configurable).toBe(false);
	});

	it('attaches Wi-Fi data only to the wireless adapter whose GUID matches', () => {
		const wifi = new Map([[ID.wifi, { ssid: null, signal: null, radio: 'off' as const }]]);
		const withWifi = parseWindowsNetworkState(windowsFixture(), wifi);
		expect(byID(withWifi, ID.wifi).wifi).toEqual({ ssid: null, signal: null, radio: 'off' });
		// A Wi-Fi Direct virtual adapter also reports medium 9 but has no WLAN interface.
		expect(byID(withWifi, ID.wifiDirect).wifi).toBeUndefined();
		expect(byID(withWifi, ID.ethernet).wifi).toBeUndefined();
	});

	it('ranks default routes by route metric PLUS interface metric, as Windows does', () => {
		const doc = JSON.parse(windowsFixture()) as Record<string, unknown>;
		// A VPN tunnel with RouteMetric 0 / InterfaceMetric 5 beats a NIC on 0 / 25,
		// which comparing RouteMetric alone would have got backwards.
		doc['routes'] = [
			{ ifIndex: 20, NextHop: '192.0.2.1', RouteMetric: 0, InterfaceMetric: 25 },
			{ ifIndex: 63, NextHop: '198.51.100.1', RouteMetric: 0, InterfaceMetric: 5 },
		];
		const parsed = parseWindowsNetworkState(JSON.stringify(doc));
		expect(byID(parsed, ID.tunnel).defaultRoute).toBe(true);
		expect(byID(parsed, ID.ethernet).defaultRoute).toBe(false);
		expect(byID(parsed, ID.tunnel).gateway).toBe('198.51.100.1');
	});

	it('keeps each interface own gateway while only the best route is primary', () => {
		const doc = JSON.parse(windowsFixture()) as Record<string, unknown>;
		doc['routes'] = [
			{ ifIndex: 20, NextHop: '192.0.2.1', RouteMetric: 10, InterfaceMetric: 20 },
			{ ifIndex: 63, NextHop: '198.51.100.1', RouteMetric: 100, InterfaceMetric: 20 },
		];
		const parsed = parseWindowsNetworkState(JSON.stringify(doc));
		expect(byID(parsed, ID.ethernet)).toMatchObject({ defaultRoute: true, gateway: '192.0.2.1' });
		expect(byID(parsed, ID.tunnel)).toMatchObject({ defaultRoute: false, gateway: '198.51.100.1' });
	});

	it('makes a multi-address or multi-route adapter read-only', () => {
		const doc = JSON.parse(windowsFixture()) as Record<string, any[]>;
		doc['addresses']!.push({ ifIndex: 20, Family: 2, IPAddress: '192.0.2.11', PrefixLength: 24, State: 4 });
		doc['routes']!.push({ ifIndex: 20, NextHop: '192.0.2.254', RouteMetric: 200, InterfaceMetric: 20 });
		expect(byID(parseWindowsNetworkState(JSON.stringify(doc)), ID.ethernet).ipv4Configurable).toBe(false);
	});

	it('makes an adapter with a hidden non-preferred IPv4 address read-only', () => {
		const doc = JSON.parse(windowsFixture()) as Record<string, any[]>;
		doc['addresses']!.push({ ifIndex: 20, Family: 2, IPAddress: '192.0.2.11', PrefixLength: 24, State: 3 });
		const ethernet = byID(parseWindowsNetworkState(JSON.stringify(doc)), ID.ethernet);
		expect(ethernet.addresses).not.toContainEqual({ family: 'ipv4', address: '192.0.2.11', prefixLength: 24 });
		expect(ethernet.ipv4Configurable).toBe(false);
	});

	it('allows DHCP recovery from a proven automatic APIPA address', () => {
		const doc = JSON.parse(windowsFixture()) as Record<string, any[]>;
		const apipa = doc['addresses']!.find(row => row.ifIndex === 12 && row.IPAddress === '169.254.86.18');
		apipa.PrefixOrigin = 2;
		apipa.SuffixOrigin = 4;
		expect(byID(parseWindowsNetworkState(JSON.stringify(doc)), ID.ethernet4).ipv4Configurable).toBe(true);
	});

	it('keeps an APIPA address read-only when Windows does not prove automatic origin', () => {
		expect(byID(result, ID.ethernet4).ipv4Configurable).toBe(false);
	});

	it('makes an adapter with unknown addressing mode and Wi-Fi Direct read-only', () => {
		const doc = JSON.parse(windowsFixture()) as Record<string, any[]>;
		doc['interfaces'] = doc['interfaces']!.filter(row => row.ifIndex !== 20);
		const parsed = parseWindowsNetworkState(JSON.stringify(doc));
		expect(byID(parsed, ID.ethernet).ipv4Configurable).toBe(false);
		expect(byID(parsed, ID.wifiDirect).ipv4Configurable).toBe(false);
	});

	it('merges IPv4 and IPv6 DNS rows for one interface', () => {
		const doc = JSON.parse(windowsFixture()) as Record<string, any[]>;
		doc['dns']!.push({ InterfaceIndex: 20, Servers: '2001:db8::53,127.0.0.1' });
		expect(byID(parseWindowsNetworkState(JSON.stringify(doc)), ID.ethernet).dns).toEqual(['192.0.2.1', '192.0.2.2', '2001:db8::53', '127.0.0.1']);
	});

	it('drops Windows automatic-DNS placeholders', () => {
		const doc = JSON.parse(windowsFixture()) as Record<string, any[]>;
		doc['dns'] = [{ InterfaceIndex: 20, Servers: 'fec0:0:0:ffff::1,fec0:0:0:ffff::2,fec0:0:0:ffff::3' }];
		expect(byID(parseWindowsNetworkState(JSON.stringify(doc)), ID.ethernet).dns).toEqual([]);
	});

	it('still ranks by route metric when the interface metric is absent', () => {
		const doc = JSON.parse(windowsFixture()) as Record<string, unknown>;
		doc['routes'] = [
			{ ifIndex: 63, NextHop: '198.51.100.1', RouteMetric: 5 },
			{ ifIndex: 20, NextHop: '192.0.2.1', RouteMetric: 0 },
		];
		const parsed = parseWindowsNetworkState(JSON.stringify(doc));
		expect(byID(parsed, ID.ethernet).defaultRoute).toBe(true);
		expect(byID(parsed, ID.tunnel).defaultRoute).toBe(false);
	});
});

/** The fixture's eth0 address, rewritten as a permanent one the kernel did not lease. */
function withPermanentIPv4(addr: string): string {
	const entries = JSON.parse(addr) as Array<{ ifname: string; addr_info?: Array<{ family: string; dynamic?: boolean; valid_life_time?: number }> }>;
	for (const address of entries.find(entry => entry.ifname === 'eth0')?.addr_info?.filter(address => address.family === 'inet') ?? []) {
		delete address.dynamic;
		address.valid_life_time = 4294967295;
	}
	return JSON.stringify(entries);
}

describe('parseLinuxNetworkState', () => {
	const sources = { addr: fixture('network-linux-addr.json'), link: fixture('network-linux-link.json'), route: '[{"dst":"default","gateway":"192.0.2.1","dev":"eth0","flags":[]}]', resolvers: ['192.0.2.1'], activeConnections: new Map([['eth0', 'Wired connection 1']]), ipv4Profiles: new Map([['eth0', { method: 'auto', gateway: null, address: null, prefixLength: null, safe: true }]]) };
	const result = parseLinuxNetworkState(sources);

	it('reads DHCP from the kernel dynamic flag and static from a permanent lifetime', () => {
		expect(byID(result, 'eth0').ipv4Mode).toBe('dhcp');
		expect(byID(result, 'docker0').ipv4Mode).toBe('static');
	});

	it('keeps an active DHCP profile editable before it receives a lease', () => {
		const v6Only = JSON.parse(sources.addr) as Array<{ ifname: string; addr_info?: Array<{ family: string }> }>;
		for (const entry of v6Only) entry.addr_info = (entry.addr_info ?? []).filter(a => a.family === 'inet6');
		const parsed = parseLinuxNetworkState({ ...sources, addr: JSON.stringify(v6Only) });
		expect(byID(parsed, 'eth0')).toMatchObject({ ipv4Mode: 'dhcp', ipv4Configurable: true });
	});

	it('reports a NO-CARRIER bridge as down even though it is administratively UP', () => {
		expect(byID(result, 'br-9487b97d884c').link).toBe('down');
	});

	it('keeps the veth-kinded uplink that carries the default route', () => {
		const eth0 = byID(result, 'eth0');
		expect(eth0.defaultRoute).toBe(true);
		expect(eth0.gateway).toBe('192.0.2.1');
		expect(eth0.dns).toEqual(['192.0.2.1']);
	});

	it('keeps a secondary interface own default gateway without calling it primary', () => {
		const routes = JSON.stringify([
			{ dst: 'default', gateway: '192.0.2.1', dev: 'eth0', metric: 10 },
			{ dst: 'default', gateway: '198.51.100.1', dev: 'docker0', metric: 200 },
		]);
		const parsed = parseLinuxNetworkState({
			...sources,
			route: routes,
			activeConnections: new Map([
				['eth0', 'a'],
				['docker0', 'b'],
			]),
			ipv4Profiles: new Map([
				['eth0', { method: 'auto', gateway: null, address: null, prefixLength: null, safe: true }],
				['docker0', { method: 'manual', gateway: '198.51.100.1', address: '172.17.0.1', prefixLength: 16, safe: true }],
			]),
		});
		expect(byID(parsed, 'eth0')).toMatchObject({ defaultRoute: true, gateway: '192.0.2.1' });
		expect(byID(parsed, 'docker0')).toMatchObject({ defaultRoute: false, gateway: '198.51.100.1' });
	});

	it('makes multi-address, multi-route and unknown-mode interfaces read-only', () => {
		const addresses = JSON.parse(sources.addr) as Array<{ ifname: string; addr_info?: any[] }>;
		addresses.find(entry => entry.ifname === 'eth0')!.addr_info!.push({ family: 'inet', local: '192.0.2.10', prefixlen: 23, valid_life_time: 4294967295 });
		const multiAddress = parseLinuxNetworkState({ ...sources, addr: JSON.stringify(addresses) });
		expect(byID(multiAddress, 'eth0').ipv4Configurable).toBe(false);

		const multiRoute = parseLinuxNetworkState({
			...sources,
			route: JSON.stringify([
				{ dev: 'eth0', gateway: '192.0.2.1' },
				{ dev: 'eth0', gateway: '192.0.2.254', metric: 50 },
			]),
		});
		expect(byID(multiRoute, 'eth0').ipv4Configurable).toBe(false);

		const v6Only = JSON.parse(sources.addr) as Array<{ ifname: string; addr_info?: Array<{ family: string }> }>;
		for (const entry of v6Only) entry.addr_info = (entry.addr_info ?? []).filter(address => address.family !== 'inet');
		const unknown = parseLinuxNetworkState({ ...sources, addr: JSON.stringify(v6Only), ipv4Profiles: new Map([['eth0', { method: 'shared', gateway: null, address: null, prefixLength: null, safe: false }]]) });
		expect(byID(unknown, 'eth0').ipv4Configurable).toBe(false);
	});

	it('keeps an interface read-only while its saved profile and the kernel disagree', () => {
		// `nmcli connection modify` without a reapply leaves the profile holding the
		// next address and the kernel the previous one. The screen shows the kernel's,
		// so saving the form would write it back and undo the pending change.
		const live = { method: 'manual', gateway: '192.0.2.1', address: '192.0.2.9', prefixLength: 23, safe: true } as const;
		// The fixture's address is a DHCP lease, so a manual profile over it is the
		// same divergence read the other way round: the switch to static is saved but
		// not activated, and the numbers matching proves nothing. Only a permanent
		// address is one the profile actually owns.
		const staticSources = { ...sources, addr: withPermanentIPv4(sources.addr) };
		expect(byID(parseLinuxNetworkState({ ...sources, ipv4Profiles: new Map([['eth0', live]]) }), 'eth0').ipv4Configurable).toBe(false);
		const matching = parseLinuxNetworkState({ ...staticSources, ipv4Profiles: new Map([['eth0', live]]) });
		expect(byID(matching, 'eth0').ipv4Configurable).toBe(true);

		const movedAddress = parseLinuxNetworkState({ ...staticSources, ipv4Profiles: new Map([['eth0', { ...live, address: '192.0.2.20' }]]) });
		expect(byID(movedAddress, 'eth0').ipv4Configurable).toBe(false);

		const movedPrefix = parseLinuxNetworkState({ ...staticSources, ipv4Profiles: new Map([['eth0', { ...live, prefixLength: 24 }]]) });
		expect(byID(movedPrefix, 'eth0').ipv4Configurable).toBe(false);

		const movedGateway = parseLinuxNetworkState({ ...staticSources, ipv4Profiles: new Map([['eth0', { ...live, gateway: '192.0.2.254' }]]) });
		expect(byID(movedGateway, 'eth0').ipv4Configurable).toBe(false);

		// A DHCP profile is just as able to diverge, in the other direction: the switch
		// to DHCP is saved but not activated, so the kernel still holds the static
		// address. Editing then would let a DNS-only save reapply the profile and move
		// the address the user never touched.
		expect(byID(parseLinuxNetworkState(sources), 'eth0').ipv4Configurable).toBe(true);
		expect(byID(parseLinuxNetworkState(staticSources), 'eth0').ipv4Configurable).toBe(false);

		// Nothing to disagree with yet: the cable is out, or no server answered.
		const noAddress = JSON.parse(sources.addr) as Array<{ ifname: string; addr_info?: Array<{ family: string }> }>;
		const eth0 = noAddress.find(entry => entry.ifname === 'eth0')!;
		eth0.addr_info = (eth0.addr_info ?? []).filter(address => address.family !== 'inet');
		expect(byID(parseLinuxNetworkState({ ...sources, addr: JSON.stringify(noAddress) }), 'eth0').ipv4Configurable).toBe(true);

		// The link-local fallback is the kernel saying it has nothing, not a static address.
		const linkLocal = JSON.parse(sources.addr) as Array<{ ifname: string; addr_info?: Array<{ family: string; local?: string; prefixlen?: number; dynamic?: boolean; valid_life_time?: number }> }>;
		const withFallback = linkLocal.find(entry => entry.ifname === 'eth0')!;
		withFallback.addr_info = [{ family: 'inet', local: '169.254.10.2', prefixlen: 16, valid_life_time: 4294967295 }, ...(withFallback.addr_info ?? []).filter(address => address.family !== 'inet')];
		expect(byID(parseLinuxNetworkState({ ...sources, addr: JSON.stringify(linkLocal) }), 'eth0').ipv4Configurable).toBe(true);
	});

	it('follows the IPv6 default route when the host has no IPv4 one', () => {
		// Captured from `ip -j -6 route show default` on a dual-stacked host: the shape
		// is the IPv4 one, so the same lowest-metric rule applies.
		const route6 = '[{"dst":"default","gateway":"fe80::d2ea:11ff:fe29:ecfd","dev":"eth0","protocol":"ra","metric":1024,"flags":[],"pref":"medium"}]';
		// Without an IPv4 default route nothing was primary, so the footer said
		// "disconnected" for a host that is plainly connected.
		expect(byID(parseLinuxNetworkState({ ...sources, route: '[]' }), 'eth0').defaultRoute).toBe(false);
		expect(byID(parseLinuxNetworkState({ ...sources, route: '[]', route6 }), 'eth0').defaultRoute).toBe(true);
		// The IPv4 route still wins where both exist.
		const both = parseLinuxNetworkState({ ...sources, route6: '[{"dst":"default","gateway":"fe80::1","dev":"docker0","metric":1024}]' });
		expect(byID(both, 'eth0').defaultRoute).toBe(true);
		expect(byID(both, 'docker0').defaultRoute).toBe(false);
		// An IPv6 default route must not be mistaken for an IPv4 one anywhere else:
		// the interface keeps its IPv4 gateway and stays editable on its own terms.
		const v6Only = parseLinuxNetworkState({ ...sources, route: '[]', route6 });
		expect(byID(v6Only, 'eth0').gateway).toBeNull();
		expect(byID(v6Only, 'eth0').ipv4Configurable).toBe(true);
	});

	it('calls software devices other and only a bare ethernet link wired', () => {
		expect(byID(result, 'eth0').medium).toBe('other'); // linkinfo.info_kind = veth
		expect(byID(result, 'docker0').medium).toBe('other'); // bridge
		const physical = JSON.parse(fixture('network-linux-link.json')) as Array<{ ifname: string; linkinfo?: unknown }>;
		for (const entry of physical) if (entry.ifname === 'eth0') delete entry.linkinfo;
		expect(byID(parseLinuxNetworkState({ ...sources, link: JSON.stringify(physical) }), 'eth0').medium).toBe('wired');
	});

	it('drops loopback', () => {
		expect(result.some(i => i.id === 'lo')).toBe(false);
	});

	it('attributes resolvers to the default-route interface only', () => {
		expect(byID(result, 'docker0').dns).toEqual([]);
	});

	it('does not assign system-wide resolvers to a device missing from NetworkManager DNS', () => {
		const parsed = parseLinuxNetworkState({ ...sources, nmDns: new Map([['docker0', ['198.51.100.53']]]) });
		expect(byID(parsed, 'eth0').dns).toEqual([]);
		expect(byID(parsed, 'docker0').dns).toEqual(['198.51.100.53']);
	});

	it('marks only devices with an active NetworkManager profile configurable', () => {
		expect(byID(result, 'eth0').ipv4Configurable).toBe(true);
		expect(byID(result, 'docker0').ipv4Configurable).toBe(false);
	});

	it('marks wireless interfaces and carries their iw reading through', () => {
		const wireless = new Set(['eth0']);
		const iwLinks = new Map([['eth0', 'Connected to 02:00:5e:40:00:01 (on eth0)\n\tSSID: Example Net\n\tfreq: 5180\n\tsignal: -55 dBm\n\ttx bitrate: 780.0 MBit/s\n']]);
		const parsed = parseLinuxNetworkState({ ...sources, wireless, iwLinks, managedDevices: new Set(['eth0']) });
		expect(byID(parsed, 'eth0').medium).toBe('wireless');
		expect(byID(parsed, 'eth0').wifiConfigurable).toBe(true);
		expect(byID(parsed, 'eth0').wifi).toEqual({ ssid: 'Example Net', signal: 90, radio: 'unknown' });
	});

	it('keeps a wireless device read-only when NetworkManager reports it unmanaged', () => {
		const parsed = parseLinuxNetworkState({ ...sources, wireless: new Set(['eth0']), managedDevices: new Set() });
		expect(byID(parsed, 'eth0')).toMatchObject({ medium: 'wireless', wifiConfigurable: false });
	});

	it('leaves a wireless interface with no iw output at unknown rather than guessing', () => {
		const parsed = parseLinuxNetworkState({ ...sources, wireless: new Set(['eth0']) });
		expect(byID(parsed, 'eth0').wifi).toEqual({ ssid: null, signal: null, radio: 'unknown' });
	});

	it('throws on empty stdout instead of silently reporting nothing', () => {
		expect(() => parseLinuxNetworkState({ ...sources, addr: '' })).toThrow();
	});
});

describe('parseIwLink', () => {
	it('reads SSID and signal from an associated adapter', () => {
		const text = 'Connected to 02:00:5e:40:00:01 (on wlan0)\n\tSSID: Example Net\n\tfreq: 2437\n\tRX: 1 bytes (1 packets)\n\tsignal: -42 dBm\n\ttx bitrate: 130.0 MBit/s\n';
		expect(parseIwLink(text)).toEqual({ ssid: 'Example Net', signal: 100 });
	});

	it('reads an idle adapter as associated with nothing', () => {
		expect(parseIwLink('Not connected.\n')).toEqual({ ssid: null, signal: null });
	});

	it('reports an unknown signal when the driver prints no signal line', () => {
		expect(parseIwLink('Connected to 02:00:5e:40:00:01 (on wlan0)\n\tSSID: Example Net\n\tfreq: 2437\n')).toEqual({ ssid: 'Example Net', signal: null });
	});
});

describe('dbmToQuality', () => {
	it('maps the documented endpoints and clamps outside them', () => {
		expect(dbmToQuality(-100)).toBe(0);
		expect(dbmToQuality(-50)).toBe(100);
		expect(dbmToQuality(-75)).toBe(50);
		expect(dbmToQuality(-120)).toBe(0);
		expect(dbmToQuality(-10)).toBe(100);
	});
});

describe('readConnectionAttributes sanity gate', () => {
	// The struct offsets are documentation-derived (see the reader's JSDoc), so
	// these cases pin down the behaviour that makes that acceptable: anything
	// implausible degrades to "unknown", never to a wrong-looking percentage.
	const buffers: Uint8Array[] = [];

	/** Build a WLAN_CONNECTION_ATTRIBUTES-shaped buffer with the given SSID length and signal. */
	function buffer(ssidLength: number, signal: number, ssid = 'Example Net', state = 1): { pointer: Pointer; size: number } {
		const bytes = new Uint8Array(640);
		const view = new DataView(bytes.buffer);
		// isState is the first member: 1 = wlan_interface_state_connected.
		view.setUint32(0, state, true);
		view.setUint32(520, ssidLength, true);
		new Uint8Array(bytes.buffer, 524, 32).set(new TextEncoder().encode(ssid).subarray(0, 32));
		view.setUint32(576, signal, true);
		// Hold a reference so the buffer cannot be collected while the pointer is live.
		buffers.push(bytes);
		return { pointer: ptr(bytes), size: bytes.length };
	}

	it('accepts a plausible reading', () => {
		const b = buffer(11, 73);
		expect(readConnectionAttributes(b.pointer, b.size)).toEqual({ ssid: 'Example Net', signal: 73, connected: true });
	});

	it('reports an associated adapter with a hidden SSID as signal-only', () => {
		const b = buffer(0, 42);
		expect(readConnectionAttributes(b.pointer, b.size)).toEqual({ ssid: null, signal: 42, connected: true });
	});

	it('rejects an out-of-range signal rather than reporting a wrong percentage', () => {
		const b = buffer(11, 4294967295);
		expect(readConnectionAttributes(b.pointer, b.size)).toEqual({ ssid: null, signal: null, connected: true });
	});

	it('does not call an adapter that is still associating connected', () => {
		// The SSID is filled in while the association is still being negotiated, so a
		// join that watches the name alone reports success before there is one. Every
		// state but wlan_interface_state_connected is on the way to or from it.
		const b = buffer(11, 73, 'Example Net', 6);
		expect(readConnectionAttributes(b.pointer, b.size)).toEqual({ ssid: 'Example Net', signal: 73, connected: false });
	});

	it('rejects an impossible SSID length', () => {
		const b = buffer(99, 50);
		expect(readConnectionAttributes(b.pointer, b.size)).toEqual({ ssid: null, signal: null, connected: true });
	});

	it('rejects a buffer too small to hold the fields it would read', () => {
		const b = buffer(11, 73);
		expect(readConnectionAttributes(b.pointer, 64)).toEqual({ ssid: null, signal: null, connected: false });
	});
});

describe('prefixFromNetmask', () => {
	it('counts set bits of an IPv4 dotted-quad mask', () => {
		expect(prefixFromNetmask('255.255.255.0', true)).toBe(24);
		expect(prefixFromNetmask('255.255.254.0', true)).toBe(23);
		expect(prefixFromNetmask('0.0.0.0', true)).toBe(0);
	});

	it('counts set bits of an IPv6 mask', () => {
		expect(prefixFromNetmask('ffff:ffff:ffff:ffff::', false)).toBe(64);
	});

	it('returns 0 for anything unparseable rather than throwing', () => {
		expect(prefixFromNetmask('', true)).toBe(0);
		expect(prefixFromNetmask('not-a-mask', true)).toBe(0);
	});
});

describe('resolvePrimaryID', () => {
	const list: NetInterfaceInfo[] = [
		{ id: 'a', name: 'a', medium: 'wired', link: 'up', defaultRoute: false, mac: null, addresses: [], ipv4Mode: 'unknown', ipv4Configurable: false, wifiConfigurable: false, gateway: null, dns: [] },
		{ id: 'b', name: 'b', medium: 'wired', link: 'up', defaultRoute: true, mac: null, addresses: [], ipv4Mode: 'unknown', ipv4Configurable: false, wifiConfigurable: false, gateway: null, dns: [] },
	];

	it('honours a pick that still exists', () => {
		expect(resolvePrimaryID(list, 'a')).toBe('a');
	});

	it('falls back to the default route when the pick is gone', () => {
		expect(resolvePrimaryID(list, 'removed')).toBe('b');
	});

	it('falls back when the saved virtual interface is no longer selectable', () => {
		const hidden: NetInterfaceInfo = { id: 'hidden', name: 'hidden', medium: 'other', link: 'unknown', defaultRoute: false, mac: null, addresses: [], ipv4Mode: 'unknown', ipv4Configurable: false, wifiConfigurable: false, gateway: null, dns: [] };
		expect(resolvePrimaryID([...list, hidden], hidden.id)).toBe('b');
	});

	it('falls back to the default route when nothing is picked', () => {
		expect(resolvePrimaryID(list, '')).toBe('b');
	});

	it('reports nothing when there is no default route either', () => {
		expect(resolvePrimaryID([list[0]!], '')).toBeNull();
	});
});

describe('assertWifiConfigurableInterface', () => {
	const unmanaged: NetInterfaceInfo = { id: 'wlan0', name: 'wlan0', medium: 'wireless', link: 'down', defaultRoute: false, mac: null, addresses: [], ipv4Mode: 'unknown', ipv4Configurable: false, wifiConfigurable: false, gateway: null, dns: [] };

	it('rejects an unmanaged wireless device with the API unsupported code', () => {
		try {
			assertWifiConfigurableInterface([unmanaged], unmanaged.id);
			expect.unreachable();
		} catch (error) {
			expect((error as { code?: string }).code).toBe(ErrorCodes.NETCONFIG_UNSUPPORTED);
		}
	});

	it('accepts a managed device even while it is disconnected', () => {
		expect(() => assertWifiConfigurableInterface([{ ...unmanaged, wifiConfigurable: true }], unmanaged.id)).not.toThrow();
	});
});

describe('assertReadProducedSomething', () => {
	const list: NetInterfaceInfo[] = [{ id: 'a', name: 'a', medium: 'wired', link: 'up', defaultRoute: true, mac: null, addresses: [], ipv4Mode: 'unknown', ipv4Configurable: false, wifiConfigurable: false, gateway: null, dns: [] }];

	it('passes a non-empty read straight through', () => {
		expect(assertReadProducedSomething(list)).toBe(list);
	});

	it('rejects an empty read so it degrades to addresses-only instead of claiming "disconnected"', () => {
		// PowerShell emits a well-formed document with empty collections when a
		// Get-Net* cmdlet fails non-terminatingly, which would otherwise be reported
		// as full detail with no interfaces — and render as a confident Disconnected.
		expect(() => assertReadProducedSomething([])).toThrow();
	});
});

describe('NetworkStateCache invalidation', () => {
	it('retries after a reader failure instead of caching the rejection', async () => {
		const snapshot = { interfaces: [], detail: 'addressesOnly' } as NetworkSnapshot;
		let reads = 0;
		const cache = new NetworkStateCache(async () => {
			if (++reads === 1) throw new Error('temporary read failure');
			return snapshot;
		}, 60_000);

		await expect(cache.read()).rejects.toThrow('temporary read failure');
		expect(await cache.read()).toBe(snapshot);
		expect(reads).toBe(2);
	});

	it('does not return or cache an old in-flight read after a mutation', async () => {
		let resolveOld!: (snapshot: NetworkSnapshot) => void;
		let resolveFresh!: (snapshot: NetworkSnapshot) => void;
		const oldRead = new Promise<NetworkSnapshot>(resolve => (resolveOld = resolve));
		const freshRead = new Promise<NetworkSnapshot>(resolve => (resolveFresh = resolve));
		let reads = 0;
		const cache = new NetworkStateCache(() => (++reads === 1 ? oldRead : freshRead), 60_000);
		const oldSnapshot = { interfaces: [{ id: 'old', name: 'old', medium: 'wired', link: 'up', defaultRoute: true, mac: null, addresses: [], ipv4Mode: 'dhcp', ipv4Configurable: true, wifiConfigurable: false, gateway: null, dns: [] }], detail: 'full' } as NetworkSnapshot;
		const freshSnapshot = { interfaces: [{ id: 'fresh', name: 'fresh', medium: 'wired', link: 'up', defaultRoute: true, mac: null, addresses: [], ipv4Mode: 'static', ipv4Configurable: true, wifiConfigurable: false, gateway: null, dns: [] }], detail: 'full' } as NetworkSnapshot;

		const staleCaller = cache.read();
		cache.reset();
		const postMutationCaller = cache.read();
		resolveFresh(freshSnapshot);
		expect(await postMutationCaller).toBe(freshSnapshot);
		resolveOld(oldSnapshot);
		expect(await staleCaller).toBe(freshSnapshot);

		expect(await cache.read()).toEqual(freshSnapshot);
		expect(reads).toBe(2);
	});
});

describe('readGenericInterfaces (every platform, including macOS)', () => {
	const result = readGenericInterfaces();

	it('reports only real, externally visible interfaces', () => {
		for (const iface of result) {
			expect(iface.id.length).toBeGreaterThan(0);
			expect(iface.addresses.length).toBeGreaterThan(0);
			for (const address of iface.addresses) expect(address.address.length).toBeGreaterThan(0);
		}
	});

	it('never invents detail it cannot know from the runtime alone', () => {
		for (const iface of result) {
			expect(iface.medium).toBe('other');
			expect(iface.link).toBe('unknown');
			expect(iface.ipv4Mode).toBe('unknown');
			expect(iface.gateway).toBeNull();
			expect(iface.dns).toEqual([]);
			expect(iface.wifi).toBeUndefined();
		}
	});
});

// Live shape-only smoke test. It asserts the document is well formed, never a
// specific address, so it is stable on any machine and leaks nothing. Read-only:
// readNetworkState has no code path that changes configuration.
describe.skipIf(process.platform !== 'win32' && process.platform !== 'linux')('readNetworkState (live)', () => {
	it('returns a valid, internally consistent document', async () => {
		resetNetworkStateCache();
		const state = await readNetworkState('');
		expect(state.known).toBe(true);
		expect(['full', 'addressesOnly']).toContain(state.detail);
		const ids = state.interfaces.map(i => i.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const iface of state.interfaces) {
			expect(iface.id.length).toBeGreaterThan(0);
			expect(['wired', 'wireless', 'other']).toContain(iface.medium);
			expect(['up', 'down', 'unknown']).toContain(iface.link);
			expect(['dhcp', 'static', 'unknown']).toContain(iface.ipv4Mode);
			for (const address of iface.addresses) {
				expect(address.address.length).toBeGreaterThan(0);
				expect(address.prefixLength).toBeGreaterThanOrEqual(0);
			}
			if (iface.wifi?.signal !== null && iface.wifi?.signal !== undefined) {
				expect(iface.wifi.signal).toBeGreaterThanOrEqual(0);
				expect(iface.wifi.signal).toBeLessThanOrEqual(100);
			}
			if (iface.wifi) expect(['on', 'off', 'unknown']).toContain(iface.wifi.radio);
		}
		expect(state.primaryID === null || ids.includes(state.primaryID)).toBe(true);
	});

	it('serves a second read from cache instead of spawning again', async () => {
		resetNetworkStateCache();
		await readNetworkState('');
		const started = Date.now();
		await readNetworkState('');
		expect(Date.now() - started).toBeLessThan(100);
	});

	it('waits for a change in progress instead of reading through it', async () => {
		// A read that overlapped a multi-step apply could capture the gap between
		// the old address being removed and the new one being created.
		let release: () => void = () => {};
		const held = new Promise<void>(resolve => (release = resolve));
		let mutationDone = false;
		const mutation = runNetworkMutation(async () => {
			await held;
			mutationDone = true;
		});
		const read = readNetworkState('').then(() => mutationDone);
		await new Promise(resolve => setTimeout(resolve, 50));
		release();
		expect(await read).toBe(true);
		await mutation;
	});
});
