import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ptr, type Pointer } from 'bun:ffi';
import { parseWindowsNetworkState, readConnectionAttributes, WINDOWS_STATE_COMMAND } from '../../src/system-network-windows.ts';
import { dbmToQuality, parseIwLink, parseLinuxNetworkState } from '../../src/system-network-linux.ts';
import { assertReadProducedSomething, prefixFromNetmask, readGenericInterfaces, readNetworkState, resolvePrimaryID, resetNetworkStateCache } from '../../src/system-network.ts';
import type { NetInterfaceInfo } from '@shared';

/**
 * Fixtures are the verbatim shape of real command output captured on a Windows
 * 11 workstation and a Linux container, with every address, MAC and GUID
 * rewritten to documentation ranges before entering the repository.
 */
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const byID = (list: NetInterfaceInfo[], id: string): NetInterfaceInfo => {
	const found = list.find(i => i.id === id);
	if (!found) throw new Error(`interface ${id} missing from parse result`);
	return found;
};

describe('WINDOWS_STATE_COMMAND', () => {
	it('wraps every collection so a single-row result stays an array', () => {
		for (const name of ['adapters', 'addresses', 'interfaces', 'routes', 'dns']) {
			expect(WINDOWS_STATE_COMMAND).toContain(`$${name} = @(`);
		}
	});

	it('projects the enums it parses to integers so the OS display language cannot matter', () => {
		expect(WINDOWS_STATE_COMMAND).toContain('[int]$_.NdisPhysicalMedium');
		expect(WINDOWS_STATE_COMMAND).toContain('[int]$_.MediaConnectionState');
		expect(WINDOWS_STATE_COMMAND).toContain('[int]$_.Dhcp');
		expect(WINDOWS_STATE_COMMAND).toContain('[int]$_.AddressState');
	});

	it('only queries — it contains no cmdlet that could change configuration', () => {
		expect(WINDOWS_STATE_COMMAND).not.toMatch(/\b(Set|New|Remove|Disable|Enable|Restart)-Net/);
	});
});

describe('parseWindowsNetworkState', () => {
	const result = parseWindowsNetworkState(fixture('network-windows.json'));

	it('keeps a secondary interface own gateway, not just the default route one', () => {
		// Two default routes: Ethernet wins on effective metric, the VPN tunnel keeps a
		// gateway of its own. Reporting the loser's as null would seed the edit form
		// empty and clear its real gateway on the next save.
		const doc = JSON.parse(fixture('network-windows.json'));
		doc.routes = [
			{ ifIndex: 20, NextHop: '192.0.2.1', RouteMetric: 0, InterfaceMetric: 25 },
			{ ifIndex: 63, NextHop: '198.51.100.1', RouteMetric: 0, InterfaceMetric: 5 },
		];
		const parsed = parseWindowsNetworkState(JSON.stringify(doc));
		const tunnel = byID(parsed, '{FC01FCD5-2B9D-2FD8-78D8-CB78B313E2B2}');
		const ethernet = byID(parsed, '{901F20ED-4B31-4803-B655-ED47D47AD070}');
		expect(tunnel.defaultRoute).toBe(true);
		expect(tunnel.gateway).toBe('198.51.100.1');
		expect(ethernet.defaultRoute).toBe(false);
		expect(ethernet.gateway).toBe('192.0.2.1');
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
	});

	it('marks an adapterless stack unconfigurable, since the apply resolves by GUID', () => {
		// `ifIndex:69` is not a GUID, so assertWindowsGuid rejects it on every save.
		// Offering Configure for it puts a button in front of the user that cannot
		// do anything but fail.
		expect(byID(result, 'ifIndex:69').ipv4Configurable).toBe(false);
		expect(byID(result, ID.ethernet).ipv4Configurable).toBe(true);
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
		const single = JSON.stringify({
			adapters: { ifIndex: 5, Name: 'Ethernet', InterfaceGuid: '{11111111-2222-3333-4444-555555555555}', MacAddress: '02-00-5E-30-00-01', Media: 14, State: 1 },
			addresses: { ifIndex: 5, Family: 2, IPAddress: '198.51.100.5', PrefixLength: 24, State: 4 },
			interfaces: { ifIndex: 5, Family: 2, Dhcp: 0 },
			routes: { ifIndex: 5, NextHop: '198.51.100.1', RouteMetric: 25 },
			dns: { InterfaceIndex: 5, Servers: '198.51.100.1' },
		});
		const parsed = parseWindowsNetworkState(single);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({ id: '{11111111-2222-3333-4444-555555555555}', medium: 'wired', link: 'up', ipv4Mode: 'static', defaultRoute: true, gateway: '198.51.100.1', dns: ['198.51.100.1'] });
	});

	it('attaches Wi-Fi data only to the wireless adapter whose GUID matches', () => {
		const wifi = new Map([[ID.wifi, { ssid: null, signal: null, radio: 'off' as const }]]);
		const withWifi = parseWindowsNetworkState(fixture('network-windows.json'), wifi);
		expect(byID(withWifi, ID.wifi).wifi).toEqual({ ssid: null, signal: null, radio: 'off' });
		// A Wi-Fi Direct virtual adapter also reports medium 9 but has no WLAN interface.
		expect(byID(withWifi, ID.wifiDirect).wifi).toBeUndefined();
		expect(byID(withWifi, ID.ethernet).wifi).toBeUndefined();
	});

	it('ranks default routes by route metric PLUS interface metric, as Windows does', () => {
		const doc = JSON.parse(fixture('network-windows.json')) as Record<string, unknown>;
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

	it('still ranks by route metric when the interface metric is absent', () => {
		const doc = JSON.parse(fixture('network-windows.json')) as Record<string, unknown>;
		doc['routes'] = [
			{ ifIndex: 63, NextHop: '198.51.100.1', RouteMetric: 5 },
			{ ifIndex: 20, NextHop: '192.0.2.1', RouteMetric: 0 },
		];
		const parsed = parseWindowsNetworkState(JSON.stringify(doc));
		expect(byID(parsed, ID.ethernet).defaultRoute).toBe(true);
		expect(byID(parsed, ID.tunnel).defaultRoute).toBe(false);
	});
});

describe('parseLinuxNetworkState', () => {
	it('marks a device NetworkManager does not own as not configurable', () => {
		// The interface list comes from the kernel, so it holds devices another stack
		// manages. Offering Configure for those shows an action that can only fail.
		const parsed = parseLinuxNetworkState({ ...sources, managed: new Set(['eth0', 'docker0']), activeProfiles: new Set(['eth0']) });
		expect(byID(parsed, 'eth0').ipv4Configurable).toBe(true);
	});

	it('withholds configurability when NetworkManager could not be asked', () => {
		// An unavailable answer is not a permission. Leaving the flag absent made the
		// frontend fall back to "probably allow" for a destructive operation; the
		// apply needs an active NetworkManager profile, and a host that cannot even
		// be asked has already reported itself read-only through isLinuxWritable.
		const parsed = parseLinuxNetworkState(sources);
		expect(byID(parsed, 'eth0').ipv4Configurable).toBe(false);
	});

	// Being managed is not enough. `applyLinuxIPv4` edits the profile ACTIVE on the
	// device, and "managed" happily includes disconnected and unavailable devices —
	// which showed a working Save that failed every time with "no NetworkManager
	// profile is active".
	it('refuses to offer an edit on a managed device with no active profile', () => {
		const managed = new Set(['eth0', 'docker0']);
		const parsed = parseLinuxNetworkState({ ...sources, managed, activeProfiles: new Set(['eth0']) });
		expect(byID(parsed, 'eth0').ipv4Configurable).toBe(true);
		expect(byID(parsed, 'docker0').ipv4Configurable).toBe(false);
		// ...and an active profile on a device NetworkManager does not own is not
		// permission either. Both conditions, or neither.
		expect(byID(parseLinuxNetworkState({ ...sources, managed: new Set(['eth0']), activeProfiles: managed }), 'docker0').ipv4Configurable).toBe(false);
	});

	// The active-profile rule above is right for ADDRESSING and was briefly applied
	// to Wi-Fi as well, through a single shared flag. A disconnected adapter has no
	// active profile by definition — and is exactly the adapter a user opens the
	// screen to scan with — so the user could no longer scan or join at all.
	// `nmcli device wifi list` drives the radio, and `connect` finds or creates a
	// profile; neither needs one to be active already.
	it('lets a managed wireless device scan and join with no active profile', () => {
		// The fixture has no radio of its own; the flag is driven by the `wireless`
		// set the reader passes in, not by the device's name.
		const parsed = parseLinuxNetworkState({ ...sources, wireless: new Set(['eth0']), managed: new Set(['eth0']), activeProfiles: new Set() });
		const radio = byID(parsed, 'eth0');
		expect(radio.ipv4Configurable).toBe(false);
		expect(radio.wifiScannable).toBe(true);
		expect(radio.wifiConnectable).toBe(true);
	});

	it('still refuses Wi-Fi on a device NetworkManager does not own', () => {
		const parsed = parseLinuxNetworkState({ ...sources, wireless: new Set(['eth0']), managed: new Set(), activeProfiles: new Set() });
		expect(byID(parsed, 'eth0').wifiScannable).toBe(false);
	});

	it('never offers Wi-Fi on a device that is not a radio', () => {
		const parsed = parseLinuxNetworkState({ ...sources, managed: new Set(['eth0']), activeProfiles: new Set(['eth0']) });
		expect(byID(parsed, 'eth0').wifiScannable).toBe(false);
		expect(byID(parsed, 'eth0').wifiConnectable).toBe(false);
	});

	it('keeps a secondary interface own gateway, not just the default route one', () => {
		// A multi-homed host: eth0 wins the default route, docker0 has a router of its
		// own. Reporting docker0 gateway as null would seed the edit form empty, and
		// saving any change there would clear the gateway the interface really has.
		const twoRoutes = '[{"dst":"default","gateway":"192.0.2.1","dev":"eth0","metric":100,"flags":[]},{"dst":"default","gateway":"198.51.100.1","dev":"docker0","metric":200,"flags":[]}]';
		const parsed = parseLinuxNetworkState({ ...sources, route: twoRoutes });
		expect(byID(parsed, 'eth0').gateway).toBe('192.0.2.1');
		expect(byID(parsed, 'eth0').defaultRoute).toBe(true);
		expect(byID(parsed, 'docker0').gateway).toBe('198.51.100.1');
		expect(byID(parsed, 'docker0').defaultRoute).toBe(false);
	});

	const sources = { addr: fixture('network-linux-addr.json'), link: fixture('network-linux-link.json'), route: '[{"dst":"default","gateway":"192.0.2.1","dev":"eth0","flags":[]}]', resolvers: ['192.0.2.1'] };
	const result = parseLinuxNetworkState(sources);

	it('reads DHCP from the kernel dynamic flag and static from a permanent lifetime', () => {
		// Only where there is no active profile to ask — see the two cases below.
		expect(byID(result, 'eth0').ipv4Mode).toBe('dhcp');
		expect(byID(result, 'docker0').ipv4Mode).toBe('static');
	});

	// The kernel describes the address currently ON the interface; the profile
	// describes what the editor changes and what survives a reboot. A DHCP profile
	// with a manual secondary address, or one whose lease has momentarily lapsed,
	// reads as static from the kernel — and saving then switched the profile to a
	// mode the user had not chosen.
	it('prefers the active profile method over what the kernel addresses suggest', () => {
		const parsed = parseLinuxNetworkState({ ...sources, ipv4Methods: new Map([['docker0', 'dhcp' as const]]) });
		expect(byID(parsed, 'docker0').ipv4Mode).toBe('dhcp');
		// eth0 has no profile in this map, so the kernel reading stands for it.
		expect(byID(parsed, 'eth0').ipv4Mode).toBe('dhcp');
	});

	it('reports a profile method the model cannot name as unknown, not as the kernel guess', () => {
		// `link-local`, `shared` and `disabled` have no counterpart. Letting the
		// kernel answer instead would offer an editable mode for a profile that is
		// not in one.
		const parsed = parseLinuxNetworkState({ ...sources, ipv4Methods: new Map([['eth0', 'unknown' as const]]) });
		expect(byID(parsed, 'eth0').ipv4Mode).toBe('unknown');
	});

	it('ignores IPv6 dynamic — SLAAC is not DHCP', () => {
		// docker0 has no IPv4 dynamic flag; its only dynamic-looking addresses on
		// eth0 are IPv6, so a v6-only document must not be reported as DHCP.
		const v6Only = JSON.parse(sources.addr) as Array<{ ifname: string; addr_info?: Array<{ family: string }> }>;
		for (const entry of v6Only) entry.addr_info = (entry.addr_info ?? []).filter(a => a.family === 'inet6');
		const parsed = parseLinuxNetworkState({ ...sources, addr: JSON.stringify(v6Only) });
		expect(byID(parsed, 'eth0').ipv4Mode).toBe('unknown');
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

	it('marks wireless interfaces and carries their iw reading through', () => {
		const wireless = new Set(['eth0']);
		const iwLinks = new Map([['eth0', 'Connected to 02:00:5e:40:00:01 (on eth0)\n\tSSID: Example Net\n\tfreq: 5180\n\tsignal: -55 dBm\n\ttx bitrate: 780.0 MBit/s\n']]);
		const parsed = parseLinuxNetworkState({ ...sources, wireless, iwLinks });
		expect(byID(parsed, 'eth0').medium).toBe('wireless');
		expect(byID(parsed, 'eth0').wifi).toEqual({ ssid: 'Example Net', signal: 90, radio: 'unknown' });
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
	function buffer(ssidLength: number, signal: number, ssid = 'Example Net', state = 0): { pointer: Pointer; size: number } {
		const bytes = new Uint8Array(640);
		const view = new DataView(bytes.buffer);
		view.setUint32(0, state, true); // WLAN_CONNECTION_ATTRIBUTES.isState
		view.setUint32(520, ssidLength, true);
		new Uint8Array(bytes.buffer, 524, 32).set(new TextEncoder().encode(ssid).subarray(0, 32));
		view.setUint32(576, signal, true);
		// Hold a reference so the buffer cannot be collected while the pointer is live.
		buffers.push(bytes);
		return { pointer: ptr(bytes), size: bytes.length };
	}

	it('reports an adapter still associating as not connected, SSID and all', () => {
		// Windows fills the SSID in while the adapter is only ATTEMPTING the network,
		// so a join confirmed on the name alone would report a connection that never
		// happened. State 5 is wlan_interface_state_associating.
		const b = buffer(11, 73, 'Example Net', 5);
		expect(readConnectionAttributes(b.pointer, b.size)).toEqual({ ssid: 'Example Net', signal: 73, connected: false });
	});

	it('reports an adapter that really is on the network as connected', () => {
		const b = buffer(11, 73, 'Example Net', 1);
		expect(readConnectionAttributes(b.pointer, b.size)).toEqual({ ssid: 'Example Net', signal: 73, connected: true });
	});

	it('accepts a plausible reading', () => {
		const b = buffer(11, 73);
		expect(readConnectionAttributes(b.pointer, b.size)).toEqual({ ssid: 'Example Net', signal: 73, connected: false });
	});

	it('reports an associated adapter with a hidden SSID as signal-only', () => {
		const b = buffer(0, 42);
		expect(readConnectionAttributes(b.pointer, b.size)).toEqual({ ssid: null, signal: 42, connected: false });
	});

	it('rejects an out-of-range signal rather than reporting a wrong percentage', () => {
		const b = buffer(11, 4294967295);
		expect(readConnectionAttributes(b.pointer, b.size)).toEqual({ ssid: null, signal: null, connected: false });
	});

	it('rejects an impossible SSID length', () => {
		const b = buffer(99, 50);
		expect(readConnectionAttributes(b.pointer, b.size)).toEqual({ ssid: null, signal: null, connected: false });
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
		{ id: 'a', name: 'a', medium: 'wired', link: 'up', defaultRoute: false, mac: null, addresses: [], ipv4Mode: 'unknown', gateway: null, dns: [], ipv4Configurable: false, wifiScannable: false, wifiConnectable: false },
		{ id: 'b', name: 'b', medium: 'wired', link: 'up', defaultRoute: true, mac: null, addresses: [], ipv4Mode: 'unknown', gateway: null, dns: [], ipv4Configurable: false, wifiScannable: false, wifiConnectable: false },
	];

	it('honours a pick that still exists', () => {
		expect(resolvePrimaryID(list, 'a')).toBe('a');
	});

	it('falls back to the default route when the pick is gone', () => {
		expect(resolvePrimaryID(list, 'removed')).toBe('b');
	});

	it('falls back to the default route when nothing is picked', () => {
		expect(resolvePrimaryID(list, '')).toBe('b');
	});

	it('reports nothing when there is no default route either', () => {
		expect(resolvePrimaryID([list[0]!], '')).toBeNull();
	});
});

describe('assertReadProducedSomething', () => {
	const list: NetInterfaceInfo[] = [{ id: 'a', name: 'a', medium: 'wired', link: 'up', defaultRoute: true, mac: null, addresses: [], ipv4Mode: 'unknown', gateway: null, dns: [], ipv4Configurable: false, wifiScannable: false, wifiConnectable: false }];

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
//
// A cold read on Windows spawns PowerShell twice — the state document and the
// elevation probe — and the code allows each of them 15 s. The default per-test
// budget of 5 s would fail the test for a spawn the code is still legitimately
// waiting on, so these two cases carry their own, wider than what they wait for.
const LIVE_READ_TIMEOUT_MS = 40_000;

describe.skipIf(process.platform !== 'win32' && process.platform !== 'linux')('readNetworkState (live)', () => {
	it(
		'returns a valid, internally consistent document',
		async () => {
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
		},
		LIVE_READ_TIMEOUT_MS
	);

	it(
		'serves a second read from cache instead of spawning again',
		async () => {
			resetNetworkStateCache();
			await readNetworkState('');
			const started = Date.now();
			await readNetworkState('');
			expect(Date.now() - started).toBeLessThan(100);
		},
		LIVE_READ_TIMEOUT_MS
	);
});
