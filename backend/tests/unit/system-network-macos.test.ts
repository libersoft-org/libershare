import { describe, expect, it } from 'bun:test';
import { assertMacIPv4Applied, macSummarySsidVisible, assertMacWifiConnected, hasMacWritePrivilege, macApplyArgs, macRestoreRequiresLease, macWifiNamesVisible, withMacRollback, macDbmToQuality, netmaskFromPrefix, parseAirport, parseAirportScan, parseDefaultRoute, parseDefaultRoutes, parseDhcpDns, parseScopedDns, parseHardwarePorts, parseIfconfig, parseMacNetworkState, parseServiceBindings, parseServiceDns, parseServiceGateway, parseServiceIPv4, parseServiceInfo, parseServiceOrder, prefixFromHexMask } from '../../src/system-network-macos.ts';

/**
 * Every fixture below is real output captured from a macOS 15.7.4 host, with the
 * addresses rewritten into the RFC5737 documentation ranges. The shapes — including
 * the hex netmask, the `<redacted>` network name and the "aren't any" DNS sentence —
 * are verbatim.
 */

const HARDWARE_PORTS = `
Hardware Port: Ethernet Adapter (en4)
Device: en4
Ethernet Address: f6:c9:50:19:52:16

Hardware Port: Thunderbolt Bridge
Device: bridge0
Ethernet Address: 36:1e:e7:ae:1b:00

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: f8:4d:89:7a:34:de

VLAN Configurations
===================
`;

const SERVICE_ORDER = `An asterisk (*) denotes that a network service is disabled.
(1) USB JTAG/serial debug unit 13
(Hardware Port: USB JTAG/serial debug unit, Device: usbmodem1122201)

(2) Wi-Fi
(Hardware Port: Wi-Fi, Device: en0)

(*3) Old Ethernet
(Hardware Port: Ethernet Adapter (en4), Device: en4)

(4) Thunderbolt Bridge
(Hardware Port: Thunderbolt Bridge, Device: bridge0)
`;

const IFCONFIG = `lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
	inet 127.0.0.1 netmask 0xff000000
	inet6 ::1 prefixlen 128
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	options=6460<TSO4,TSO6,CHANNEL_IO,PARTIAL_CSUM,ZEROINVERT_CSUM>
	ether 92:f7:c2:70:5b:9e
	inet6 fe80::14:5426:edae:3802%en0 prefixlen 64 secured scopeid 0x11
	inet 192.0.2.232 netmask 0xffffff00 broadcast 192.0.2.255
	nd6 options=201<PERFORMNUD,DAD>
	media: autoselect
	status: active
bridge0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	ether 36:1e:e7:ae:1b:00
	media: <unknown type>
	status: inactive
`;

const ROUTE = `   route to: default
destination: default
       mask: default
    gateway: 192.0.2.1
  interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
`;

const ROUTES = `Routing tables
Internet:
Destination        Gateway            Flags               Netif Expire
default            192.0.2.1          UGScg                 en0
`;

const AIRPORT = `Wi-Fi:

      Interfaces:
        en0:
          Card Type: Wi-Fi  (0x14E4, 0x4387)
          Country Code: CZ
          Status: Connected
          Current Network Information:
            <redacted>:
              PHY Mode: 802.11ax
              Channel: 128 (5GHz, 80MHz)
              Security: WPA2/WPA3 Personal
              Signal / Noise: -70 dBm / -90 dBm
              Transmit Rate: 144
          Other Local Wi-Fi Networks:
            <redacted>:
              PHY Mode: 802.11a/n/ac/ax
`;

describe('parseHardwarePorts', () => {
	it('maps every device to its hardware port', () => {
		const ports = parseHardwarePorts(HARDWARE_PORTS);
		expect(ports.get('en0')).toBe('Wi-Fi');
		expect(ports.get('bridge0')).toBe('Thunderbolt Bridge');
		expect(ports.get('en4')).toBe('Ethernet Adapter (en4)');
	});

	it('ignores the trailing VLAN section', () => {
		expect(parseHardwarePorts(HARDWARE_PORTS).size).toBe(3);
	});
});

describe('parseServiceOrder', () => {
	it('maps a device to the service name networksetup writes take', () => {
		const services = parseServiceOrder(SERVICE_ORDER);
		expect(services.get('en0')).toBe('Wi-Fi');
		expect(services.get('bridge0')).toBe('Thunderbolt Bridge');
	});

	it('skips a disabled service, because writing to it silently does nothing', () => {
		expect(parseServiceOrder(SERVICE_ORDER).has('en4')).toBe(false);
	});

	it('keeps a device with multiple enabled services read-only', () => {
		const duplicate = `${SERVICE_ORDER}\n(5) Backup Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)\n`;
		expect(parseServiceBindings(duplicate).get('en0')).toEqual(['Wi-Fi', 'Backup Wi-Fi']);
		expect(parseServiceOrder(duplicate).has('en0')).toBe(false);
	});
});

describe('parseIfconfig', () => {
	it('reads addresses, MAC and carrier state', () => {
		const entry = parseIfconfig(IFCONFIG).get('en0');
		expect(entry?.mac).toBe('92:f7:c2:70:5b:9e');
		expect(entry?.status).toBe('active');
		expect(entry?.addresses).toEqual([
			{ family: 'ipv6', address: 'fe80::14:5426:edae:3802', prefixLength: 64 },
			{ family: 'ipv4', address: '192.0.2.232', prefixLength: 24 },
		]);
	});

	it('converts the hex netmask macOS prints instead of a prefix', () => {
		expect(prefixFromHexMask('0xffffff00')).toBe(24);
		expect(prefixFromHexMask('0xffff0000')).toBe(16);
		expect(prefixFromHexMask('0xfffffffe')).toBe(31);
		expect(prefixFromHexMask('nonsense')).toBe(0);
	});

	it('flags loopback so the caller can drop it', () => {
		expect(parseIfconfig(IFCONFIG).get('lo0')?.loopback).toBe(true);
		expect(parseIfconfig(IFCONFIG).get('en0')?.loopback).toBe(false);
	});

	it('reports an inactive interface as such', () => {
		expect(parseIfconfig(IFCONFIG).get('bridge0')?.status).toBe('inactive');
	});
});

describe('parseDefaultRoute', () => {
	it('reads the device and gateway', () => {
		expect(parseDefaultRoute(ROUTE)).toEqual({ device: 'en0', gateway: '192.0.2.1' });
	});

	it('yields nulls when there is no default route', () => {
		expect(parseDefaultRoute('route: writing to routing socket: not in table')).toEqual({ device: null, gateway: null });
	});

	it('reads every default route from the routing table', () => {
		const routes = `${ROUTES}default            198.51.100.1       UGScIg                en0\ndefault            203.0.113.1        UGScIg                en4\n`;
		expect(parseDefaultRoutes(routes)).toEqual([
			{ device: 'en0', gateway: '192.0.2.1' },
			{ device: 'en0', gateway: '198.51.100.1' },
			{ device: 'en4', gateway: '203.0.113.1' },
		]);
	});
});

describe('parseServiceInfo', () => {
	it('distinguishes the addressing modes', () => {
		expect(parseServiceInfo('DHCP Configuration\nIP address: 192.0.2.2\n')).toBe('dhcp');
		expect(parseServiceInfo('Manual Configuration\nIP address: 192.0.2.2\n')).toBe('static');
		expect(parseServiceInfo('BOOTP Configuration\n')).toBe('unknown');
	});

	it('does not guess when networksetup does not recognise the service', () => {
		expect(parseServiceInfo('** Error: The parameters were not valid.')).toBe('unknown');
	});
});

describe('parseServiceGateway', () => {
	it('reads a router from each service own configuration', () => {
		expect(parseServiceGateway('Manual Configuration\nRouter: 198.51.100.1\n')).toBe('198.51.100.1');
		expect(parseServiceGateway('DHCP Configuration\nRouter: none\n')).toBeNull();
	});
});

describe('parseServiceIPv4', () => {
	it('reads a manual address stored for an inactive service', () => {
		expect(parseServiceIPv4('Manual Configuration\nIP address: 192.0.2.10\nSubnet mask: 255.255.255.0\nRouter: 192.0.2.1\n')).toEqual({ family: 'ipv4', address: '192.0.2.10', prefixLength: 24 });
	});

	it('does not invent an address from DHCP or a malformed mask', () => {
		expect(parseServiceIPv4('DHCP Configuration\nIP address: 192.0.2.10\nSubnet mask: 255.255.255.0\n')).toBeNull();
		expect(parseServiceIPv4('Manual Configuration\nIP address: 192.0.2.10\nSubnet mask: 255.0.255.0\n')).toBeNull();
	});
});

const SCUTIL = 'DNS configuration\n\nresolver #1\n  nameserver[0] : 2001:db8::53\n  if_index : 17 (en0)\n  flags    : Request AAAA records\n  reach    : 0x00000002 (Reachable)\n\nresolver #2\n  domain   : local\n  options  : mdns\n  timeout  : 5\n\nDNS configuration (for scoped queries)\n\nresolver #1\n  nameserver[0] : 2001:db8::53\n  nameserver[1] : 2001:db8::54\n  if_index : 17 (en0)\n  flags    : Scoped, Request AAAA records\n  reach    : 0x00000002 (Reachable)\n\nresolver #2\n  nameserver[0] : 192.0.2.1\n  if_index : 21 (en4)\n  flags    : Scoped, Request A records\n';

describe('DNS', () => {
	it('reads servers the user set', () => {
		expect(parseServiceDns('192.0.2.1\n198.51.100.1\n')).toEqual(['192.0.2.1', '198.51.100.1']);
	});

	it('treats the "aren\'t any" sentence as none set rather than as data', () => {
		expect(parseServiceDns("There aren't any DNS Servers set on Wi-Fi.")).toEqual([]);
	});

	it('falls back to the servers the DHCP lease handed out', () => {
		// A DHCP link answers "aren't any" from networksetup while resolving fine —
		// reporting an empty list there would tell the user they have no resolvers.
		expect(parseDhcpDns('domain_name_server (ip_mult): {192.0.2.1, 198.51.100.1}')).toEqual(['192.0.2.1', '198.51.100.1']);
		expect(parseDhcpDns('subnet_mask (ip): 255.255.255.0')).toEqual([]);
	});

	it('keeps a link-local resolver together with the zone macOS prints', () => {
		// A router advertisement usually names a link-local server, and scutil spells
		// it with the zone. The shared IPv6 validator rejects `%` on purpose, so
		// without the reader accounting for it the only resolver a host has is lost.
		const withZone = SCUTIL.replaceAll('2001:db8::53', 'fe80::1%en0');
		expect(parseScopedDns(withZone, 'en0')).toEqual(['fe80::1%en0', '2001:db8::54']);
		expect(parseServiceDns('fe80::1%en0\n192.0.2.1\n')).toEqual(['fe80::1%en0', '192.0.2.1']);
		// A zone is an IPv6 thing, there is only ever one, and it names an interface.
		expect(parseServiceDns('192.0.2.1%en0\nfe80::1%\nfe80::1%en0%en1\nfe80::1%en 0\n')).toEqual([]);
	});

	it('reads the resolvers scoped to one device, whichever family delivered them', () => {
		// `ipconfig getpacket` only ever describes an IPv4 lease, so a host whose
		// resolvers arrive over IPv6 is invisible to it. The scoped section of
		// `scutil --dns` names one resolver per interface and carries both families.
		const scutil = SCUTIL;
		expect(parseScopedDns(scutil, 'en0')).toEqual(['2001:db8::53', '2001:db8::54']);
		expect(parseScopedDns(scutil, 'en4')).toEqual(['192.0.2.1']);
		expect(parseScopedDns(scutil, 'en5')).toEqual([]);
		// The unscoped section above it describes the host, not an interface, and
		// must not answer for a device that has no scoped resolver of its own.
		expect(parseScopedDns(scutil.split('DNS configuration (for scoped queries)')[0] as string, 'en0')).toEqual([]);
	});
});

describe('parseAirport', () => {
	it('reports signal and connection state', () => {
		const wifi = parseAirport(AIRPORT);
		expect(wifi.connected).toBe(true);
		expect(wifi.signal).toBe(60);
	});

	it('never reports the literal redaction placeholder as an SSID', () => {
		// macOS withholds the name from a process without Location access; putting
		// "<redacted>" in the UI would be worse than admitting we do not know.
		expect(parseAirport(AIRPORT).ssid).toBeNull();
	});

	it('reports a real name when one is available', () => {
		expect(parseAirport(AIRPORT.replace('            <redacted>:\n              PHY Mode: 802.11ax', '            office-wifi:\n              PHY Mode: 802.11ax')).ssid).toBe('office-wifi');
	});

	it('maps dBm to the same quality scale the other platforms use', () => {
		expect(macDbmToQuality(-50)).toBe(100);
		expect(macDbmToQuality(-70)).toBe(60);
		expect(macDbmToQuality(-100)).toBe(0);
		expect(macDbmToQuality(-120)).toBe(0);
	});
});

describe('parseMacNetworkState', () => {
	const sources = {
		hardwarePorts: HARDWARE_PORTS,
		serviceOrder: SERVICE_ORDER,
		ifconfig: IFCONFIG,
		route: ROUTE,
		routes: ROUTES,
		serviceInfo: new Map([['en0', 'DHCP Configuration\n']]),
		serviceDns: new Map([['en0', "There aren't any DNS Servers set on Wi-Fi."]]),
		dhcpPacket: new Map([['en0', 'domain_name_server (ip_mult): {192.0.2.1}']]),
		airport: AIRPORT,
	};

	it('follows the IPv6 default route when the host has no IPv4 one', () => {
		// `route -n get -inet6 default` prints the same key-value block as the IPv4
		// call, so the existing parser reads it unchanged.
		const route6 = '   route to: default\ndestination: default\n  interface: en0\n      flags: <UP,GATEWAY,DONE>\n';
		const noIPv4 = parseMacNetworkState({ ...sources, route: '', routes: '' });
		expect(noIPv4.some(item => item.defaultRoute)).toBe(false);
		const viaIPv6 = parseMacNetworkState({ ...sources, route: '', routes: '', route6 });
		expect(viaIPv6.find(item => item.defaultRoute)?.id).toBe('en0');
		// The gateway shown stays the IPv4 one, which an IPv6-only host does not have.
		expect(viaIPv6.find(item => item.defaultRoute)?.gateway).toBeNull();
		// A host with no IPv6 default route prints an error instead of a block, and
		// the parser finds no interface in it.
		expect(parseMacNetworkState({ ...sources, route: '', routes: '', route6: 'route: writing to routing socket: not in table' }).some(item => item.defaultRoute)).toBe(false);
	});

	it('builds the Wi-Fi interface from every source at once', () => {
		const en0 = parseMacNetworkState(sources).find(i => i.id === 'en0');
		expect(en0).toMatchObject({
			name: 'Wi-Fi',
			medium: 'wireless',
			link: 'up',
			defaultRoute: true,
			ipv4Mode: 'dhcp',
			ipv4Configurable: true,
			gateway: '192.0.2.1',
			dns: ['192.0.2.1'],
		});
		expect(en0?.wifi).toEqual({ ssid: null, signal: 60, radio: 'unknown' });
	});

	it('offers Wi-Fi only while macOS is naming the networks', () => {
		// The picker is addressed by name, so a report full of `<redacted>` is an
		// interface that cannot be configured even though the radio works.
		expect(parseMacNetworkState(sources).find(i => i.id === 'en0')?.wifiConfigurable).toBe(false);
		expect(parseMacNetworkState({ ...sources, airport: AIRPORT_NAMED }).find(i => i.id === 'en0')?.wifiConfigurable).toBe(true);
		// A radio macOS did not describe at all cannot be scanned, so it is not offered.
		expect(parseMacNetworkState({ ...sources, airport: AIRPORT_NAMED.replace('        en0:', '        en5:') }).find(i => i.id === 'en0')?.wifiConfigurable).toBe(false);
		// Wired interfaces are never offered, whatever the report says.
		expect(
			parseMacNetworkState({ ...sources, airport: AIRPORT_NAMED })
				.filter(i => i.medium !== 'wireless')
				.every(i => !i.wifiConfigurable)
		).toBe(true);
		// A neighbour whose own name contains the marker is not a withheld name and
		// must not take the screen's Wi-Fi section away from a host that can read it.
		expect(parseMacNetworkState({ ...sources, airport: AIRPORT_NAMED.replace('            guest-open:', '            Guest-<redacted>:') }).find(i => i.id === 'en0')?.wifiConfigurable).toBe(true);
	});

	it('shows the resolvers an IPv6-only host was handed', () => {
		// No manual servers and no IPv4 lease to read them from: without the scoped
		// source the screen would claim the machine has no resolvers at all.
		const noLease = { ...sources, dhcpPacket: new Map<string, string>(), resolvers: SCUTIL };
		expect(parseMacNetworkState(noLease).find(i => i.id === 'en0')?.dns).toEqual(['2001:db8::53', '2001:db8::54']);
		// The servers the user set stay ahead of what the network offered.
		const manual = new Map(sources.serviceDns).set('en0', '198.51.100.1\n');
		expect(parseMacNetworkState({ ...noLease, serviceDns: manual }).find(i => i.id === 'en0')?.dns).toEqual(['198.51.100.1']);
	});

	it('shows a zoned resolver as the whole answer when there is no IPv4 lease behind it', () => {
		const withZone = SCUTIL.replace('nameserver[0] : 2001:db8::53\n  nameserver[1] : 2001:db8::54', 'nameserver[0] : fe80::1%en0');
		const zoned = { ...sources, dhcpPacket: new Map<string, string>(), resolvers: withZone };
		expect(parseMacNetworkState(zoned).find(i => i.id === 'en0')?.dns).toEqual(['fe80::1%en0']);
	});

	it('drops loopback', () => {
		expect(parseMacNetworkState(sources).some(i => i.id === 'lo0')).toBe(false);
	});

	it('reads a gateway for a secondary service without calling it the default route', () => {
		const withBridgeAddress = IFCONFIG.replace('\tstatus: inactive\n', '\tinet 198.51.100.10 netmask 0xffffff00 broadcast 198.51.100.255\n\tstatus: inactive\n');
		const serviceInfo = new Map(sources.serviceInfo).set('bridge0', 'Manual Configuration\nRouter: 198.51.100.1\n');
		const bridge = parseMacNetworkState({ ...sources, ifconfig: withBridgeAddress, serviceInfo }).find(i => i.id === 'bridge0');
		expect(bridge).toMatchObject({ defaultRoute: false, gateway: '198.51.100.1', ipv4Configurable: true });
	});

	it('keeps a configured manual address visible while the link is inactive', () => {
		const serviceInfo = new Map(sources.serviceInfo).set('bridge0', 'Manual Configuration\nIP address: 198.51.100.10\nSubnet mask: 255.255.255.0\nRouter: 198.51.100.1\n');
		const bridge = parseMacNetworkState({ ...sources, serviceInfo }).find(i => i.id === 'bridge0');
		expect(bridge?.addresses).toContainEqual({ family: 'ipv4', address: '198.51.100.10', prefixLength: 24 });
		expect(bridge?.ipv4Configurable).toBe(true);
	});

	it('keeps a manual service without a router read-only', () => {
		const serviceInfo = new Map(sources.serviceInfo).set('bridge0', 'Manual Configuration\nIP address: 198.51.100.10\nSubnet mask: 255.255.255.0\nRouter: none\n');
		const bridge = parseMacNetworkState({ ...sources, serviceInfo }).find(i => i.id === 'bridge0');
		expect(bridge).toMatchObject({ ipv4Mode: 'static', gateway: null, ipv4Configurable: false });
		const defaultService = parseMacNetworkState({ ...sources, serviceInfo: new Map([['en0', 'Manual Configuration\nIP address: 192.0.2.232\nSubnet mask: 255.255.255.0\nRouter: none\n']]) }).find(i => i.id === 'en0');
		expect(defaultService).toMatchObject({ ipv4Mode: 'static', gateway: '192.0.2.1', ipv4Configurable: false });
	});

	it('keeps a manual /32 service with an off-link router read-only', () => {
		const serviceInfo = new Map(sources.serviceInfo).set('bridge0', 'Manual Configuration\nIP address: 198.51.100.10\nSubnet mask: 255.255.255.255\nRouter: 198.51.100.1\n');
		expect(parseMacNetworkState({ ...sources, serviceInfo }).find(i => i.id === 'bridge0')?.ipv4Configurable).toBe(false);
	});

	it('leaves wifi undefined on a wired interface', () => {
		expect(parseMacNetworkState(sources).find(i => i.id === 'bridge0')?.wifi).toBeUndefined();
	});

	it('marks a device without an enabled network service read-only', () => {
		expect(parseMacNetworkState({ ...sources, serviceOrder: '' }).find(i => i.id === 'en0')?.ipv4Configurable).toBe(false);
	});

	it('marks unknown-mode and multi-address services read-only', () => {
		const unknown = parseMacNetworkState({ ...sources, serviceInfo: new Map([['en0', 'unrecognised']]) }).find(i => i.id === 'en0');
		expect(unknown?.ipv4Configurable).toBe(false);
		const multi = parseMacNetworkState({ ...sources, ifconfig: IFCONFIG.replace('\tinet 192.0.2.232 netmask 0xffffff00', '\tinet 192.0.2.231 netmask 0xffffff00\n\tinet 192.0.2.232 netmask 0xffffff00') }).find(i => i.id === 'en0');
		expect(multi?.ipv4Configurable).toBe(false);
	});

	it('marks duplicate services and multiple default routes read-only', () => {
		const duplicateService = `${SERVICE_ORDER}\n(5) Backup Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)\n`;
		expect(parseMacNetworkState({ ...sources, serviceOrder: duplicateService }).find(i => i.id === 'en0')?.ipv4Configurable).toBe(false);
		const duplicateRoute = `${ROUTES}default            198.51.100.1       UGScIg                en0\n`;
		expect(parseMacNetworkState({ ...sources, routes: duplicateRoute }).find(i => i.id === 'en0')?.ipv4Configurable).toBe(false);
	});

	it('does not copy one Wi-Fi reading to multiple wireless devices', () => {
		const extraPort = HARDWARE_PORTS.replace('VLAN Configurations', 'Hardware Port: Wi-Fi\nDevice: en1\nEthernet Address: f6:c9:50:19:52:16\n\nVLAN Configurations');
		const extraIfconfig = `${IFCONFIG}\nen1: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500\n\tether f6:c9:50:19:52:16\n\tstatus: active\n`;
		const parsed = parseMacNetworkState({ ...sources, hardwarePorts: extraPort, ifconfig: extraIfconfig });
		expect(parsed.find(i => i.id === 'en0')?.wifi).toBeUndefined();
		expect(parsed.find(i => i.id === 'en1')?.wifi).toBeUndefined();
	});
});

describe('macOS write privilege', () => {
	it('offers network changes only to an effective root process', () => {
		expect(hasMacWritePrivilege(0)).toBe(true);
		expect(hasMacWritePrivilege(501)).toBe(false);
		expect(hasMacWritePrivilege(undefined)).toBe(false);
	});
});

describe('macApplyArgs', () => {
	it('builds a manual configuration with a dotted-quad mask', () => {
		expect(macApplyArgs('Wi-Fi', { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.1'] })).toEqual([
			['-setmanual', 'Wi-Fi', '192.0.2.10', '255.255.255.0', '192.0.2.1'],
			['-setdnsservers', 'Wi-Fi', '192.0.2.1'],
		]);
	});

	it("rejects a manual configuration without networksetup's required router", () => {
		expect(() => macApplyArgs('Wi-Fi', { mode: 'static', address: '192.0.2.10', prefixLength: 24 })).toThrow('requires a router');
	});

	it('leaves DNS untouched unless the user explicitly changes it', () => {
		expect(macApplyArgs('Wi-Fi', { mode: 'dhcp' })).toEqual([['-setdhcp', 'Wi-Fi']]);
		expect(macApplyArgs('Wi-Fi', { mode: 'dhcp', dns: [] })).toEqual([
			['-setdhcp', 'Wi-Fi'],
			['-setdnsservers', 'Wi-Fi', 'Empty'],
		]);
		expect(macApplyArgs('Wi-Fi', { mode: 'dhcp', dns: ['2001:db8::53', '127.0.0.1'] })).toEqual([
			['-setdhcp', 'Wi-Fi'],
			['-setdnsservers', 'Wi-Fi', '2001:db8::53', '127.0.0.1'],
		]);
	});

	it('changes only DNS when addressing is unchanged', () => {
		expect(macApplyArgs('Wi-Fi', { mode: 'dhcp', dns: ['192.0.2.53'] }, false)).toEqual([['-setdnsservers', 'Wi-Fi', '192.0.2.53']]);
		expect(macApplyArgs('Wi-Fi', { mode: 'dhcp' }, false)).toEqual([]);
	});

	it('passes a service name with spaces as one argument', () => {
		expect(macApplyArgs('Thunderbolt Bridge', { mode: 'dhcp' })[0]).toEqual(['-setdhcp', 'Thunderbolt Bridge']);
	});
});

describe('macOS apply verification', () => {
	it('requires a live DHCP lease before reporting success', () => {
		expect(() => assertMacIPv4Applied({ mode: 'dhcp' }, 'DHCP Configuration\nIP address: 192.0.2.10\nSubnet mask: 255.255.255.0\nRouter: 192.0.2.1\n', "There aren't any DNS Servers set on Wi-Fi.\n", true)).not.toThrow();
		expect(() => assertMacIPv4Applied({ mode: 'dhcp' }, 'DHCP Configuration\nIP address: none\n', "There aren't any DNS Servers set on Wi-Fi.\n", true)).toThrow('lease');
		// With the link down only the saved mode can be verified; the lease follows the cable.
		expect(() => assertMacIPv4Applied({ mode: 'dhcp' }, 'DHCP Configuration\nIP address: none\n', "There aren't any DNS Servers set on Wi-Fi.\n", true, false)).not.toThrow();
		expect(() => assertMacIPv4Applied({ mode: 'dhcp' }, 'Manually using DHCP Router\nIP address: none\n', "There aren't any DNS Servers set on Wi-Fi.\n", true, false)).toThrow();
	});

	it('checks static addressing and explicit DNS exactly', () => {
		const info = 'Manual Configuration\nIP address: 192.0.2.10\nSubnet mask: 255.255.255.0\nRouter: 192.0.2.1\n';
		expect(() => assertMacIPv4Applied({ mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.53', '2001:db8::53'] }, info, '192.0.2.53\n2001:db8::53\n', true)).not.toThrow();
		expect(() => assertMacIPv4Applied({ mode: 'static', address: '192.0.2.11', prefixLength: 24, gateway: '192.0.2.1' }, info, '', true)).toThrow('IPv4');
		expect(() => assertMacIPv4Applied({ mode: 'dhcp', dns: [] }, info, '192.0.2.53\n', false)).toThrow('DNS');
	});
});

describe('netmaskFromPrefix', () => {
	it('converts the prefix lengths networksetup needs spelled out', () => {
		expect(netmaskFromPrefix(24)).toBe('255.255.255.0');
		expect(netmaskFromPrefix(16)).toBe('255.255.0.0');
		expect(netmaskFromPrefix(8)).toBe('255.0.0.0');
		expect(netmaskFromPrefix(23)).toBe('255.255.254.0');
		expect(netmaskFromPrefix(32)).toBe('255.255.255.255');
	});
});

describe('withMacRollback', () => {
	it('keeps the change when it verifies', async () => {
		let rolledBack = false;
		expect(
			await withMacRollback(
				async () => 'applied',
				async () => {
					rolledBack = true;
				}
			)
		).toBe('applied');
		expect(rolledBack).toBe(false);
	});

	it('reports the original failure when the restore verifies', async () => {
		// The user needs to know why the change did not take; the machine is back the
		// way it was, so that failure is the whole story.
		const applyFailed = new Error('address did not become usable');
		let rolledBack = false;
		await expect(
			withMacRollback(
				async () => {
					throw applyFailed;
				},
				async () => {
					rolledBack = true;
				}
			)
		).rejects.toBe(applyFailed);
		expect(rolledBack).toBe(true);
	});

	it('reports both failures when the restore cannot be verified', async () => {
		// `networksetup` exiting zero is not the service being back. A restore whose
		// read-back disagrees leaves the machine somewhere neither the user nor the
		// app asked for, and saying only "apply failed" would hide that.
		const failure = await withMacRollback(
			async () => {
				throw new Error('address did not become usable');
			},
			async () => {
				throw new Error('DHCP restore obtained no address');
			}
		).catch((error: Error) => error);
		expect(failure.message).toContain('address did not become usable');
		expect(failure.message).toContain('DHCP restore obtained no address');
	});
});

describe('macRestoreRequiresLease', () => {
	const leased = 'DHCP Configuration\nIP address: 192.0.2.10\nSubnet mask: 255.255.255.0\nRouter: 192.0.2.1\n';
	const noLease = 'DHCP Configuration\n';
	const linkLocal = 'DHCP Configuration\nIP address: 169.254.10.2\nSubnet mask: 255.255.0.0\n';
	const manual = 'Manual Configuration\nIP address: 192.0.2.10\nSubnet mask: 255.255.255.0\nRouter: 192.0.2.1\n';

	it('asks the restore for a lease only when the service had one before', () => {
		expect(macRestoreRequiresLease({ mode: 'dhcp' }, leased, true)).toBe(true);
		// The link was up and nothing answered, so the restore will not get an
		// address either. Demanding one would report a failed restore for a service
		// that is exactly back where it started.
		expect(macRestoreRequiresLease({ mode: 'dhcp' }, noLease, true)).toBe(false);
		expect(macRestoreRequiresLease({ mode: 'dhcp' }, linkLocal, true)).toBe(false);
	});

	it('leaves every other case as the change itself was judged', () => {
		expect(macRestoreRequiresLease({ mode: 'dhcp' }, leased, false)).toBe(false);
		expect(macRestoreRequiresLease({ mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' }, manual, true)).toBe(true);
		expect(macRestoreRequiresLease({ mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' }, manual, false)).toBe(false);
	});
});

/**
 * The same report a host that HAS been granted Location Services access prints.
 *
 * Captured from macOS 15.7.4 and then de-redacted; the wrapped `Firmware Version`
 * value, whose second line starts in column zero, is verbatim and is the reason
 * the interface block cannot be cut on indentation alone.
 */
const AIRPORT_NAMED = `Wi-Fi:

      Interfaces:
        en0:
          Card Type: Wi-Fi  (0x14E4, 0x4387)
          Firmware Version: wl0: Mar 23 2025 19:56:28 version 20.130.17.0.8.7.197 FWID 01-764e34b7
IO80211_driverkit-1485.13 "IO80211_driverkit-1485.13" Jan 30 2026 21:54:12
          Country Code: CZ
          Status: Connected
          Current Network Information:
            office-wifi:
              PHY Mode: 802.11ax
              Channel: 128 (5GHz, 80MHz)
              Security: WPA2/WPA3 Personal
              Signal / Noise: -70 dBm / -90 dBm
          Other Local Wi-Fi Networks:
            guest-open:
              PHY Mode: 802.11n
              Security: None
              Signal / Noise: -60 dBm / -92 dBm
            corp-8021x:
              PHY Mode: 802.11ax
              Security: WPA2 Enterprise
              Signal / Noise: -55 dBm / -92 dBm
            museum-wep:
              PHY Mode: 802.11g
              Security: WEP
              Signal / Noise: -50 dBm / -92 dBm
            office-wifi:
              PHY Mode: 802.11ax
              Security: WPA2/WPA3 Personal
              Signal / Noise: -80 dBm / -92 dBm
        en1:
          Card Type: Wi-Fi  (0x14E4, 0x4388)
          Status: Connected
          Other Local Wi-Fi Networks:
            other-radio-only:
              Security: WPA2 Personal
              Signal / Noise: -65 dBm / -92 dBm
`;

describe('parseAirportScan', () => {
	it('reads both lists and marks only the joined network active', () => {
		const networks = parseAirportScan(AIRPORT_NAMED, 'en0');
		expect(networks.map(item => item.ssid)).toEqual(['museum-wep', 'corp-8021x', 'guest-open', 'office-wifi']);
		expect(networks.filter(item => item.active).map(item => item.ssid)).toEqual(['office-wifi']);
	});

	it('keeps the strongest access point of a repeated name without losing the association', () => {
		// The joined entry is reported at -70 dBm and a second one at -80 dBm; the
		// row must carry the better signal AND stay the one shown as connected.
		const office = parseAirportScan(AIRPORT_NAMED, 'en0').find(item => item.ssid === 'office-wifi');
		expect(office).toMatchObject({ signal: macDbmToQuality(-70), active: true, secured: true, security: 'WPA2/WPA3 Personal', supported: true });
	});

	it('reports an open network as unsecured with no security label', () => {
		expect(parseAirportScan(AIRPORT_NAMED, 'en0').find(item => item.ssid === 'guest-open')).toMatchObject({ secured: false, security: '', supported: true });
	});

	it('shows enterprise and WEP networks but refuses to offer them', () => {
		const networks = parseAirportScan(AIRPORT_NAMED, 'en0');
		expect(networks.find(item => item.ssid === 'corp-8021x')).toMatchObject({ secured: true, supported: false });
		expect(networks.find(item => item.ssid === 'museum-wep')).toMatchObject({ secured: true, supported: false });
	});

	it('never reports a BSSID, because system_profiler does not print one', () => {
		expect(parseAirportScan(AIRPORT_NAMED, 'en0').every(item => item.bssid === null)).toBe(true);
	});

	it('attributes networks to the radio that saw them', () => {
		expect(parseAirportScan(AIRPORT_NAMED, 'en1').map(item => item.ssid)).toEqual(['other-radio-only']);
		expect(parseAirportScan(AIRPORT_NAMED, 'en0').some(item => item.ssid === 'other-radio-only')).toBe(false);
		expect(parseAirportScan(AIRPORT_NAMED, 'en9')).toEqual([]);
	});

	it('drops the networks macOS refused to name', () => {
		// Every row of the real report is `<redacted>` without Location access, and
		// networksetup is addressed by name, so none of them can be offered.
		expect(parseAirportScan(AIRPORT, 'en0')).toEqual([]);
	});
});

describe('macWifiNamesVisible', () => {
	it('treats a single redaction as proof the permission is missing', () => {
		expect(macWifiNamesVisible(AIRPORT)).toBe(false);
		expect(macWifiNamesVisible(AIRPORT_NAMED)).toBe(true);
	});

	it('does not mistake a neighbour NAMED after the marker for a withheld name', () => {
		// macOS hides a name by printing a row that is only the marker. A network
		// legitimately called "Guest-<redacted>" is a name we can read, and searching
		// the whole report for the marker turned that neighbour into a reason to
		// disable Wi-Fi configuration on a host naming every network perfectly well.
		const neighbour = AIRPORT_NAMED.replace('            guest-open:', '            Guest-<redacted>:');
		expect(macWifiNamesVisible(neighbour)).toBe(true);
		expect(parseAirportScan(neighbour, 'en0').map(item => item.ssid)).toContain('Guest-<redacted>');
	});

	it('does not read an empty report as an answer', () => {
		// system_profiler was never run, or failed; that is not a grant.
		expect(macWifiNamesVisible('')).toBe(false);
		expect(macWifiNamesVisible('   \n')).toBe(false);
	});
});

describe('assertMacWifiConnected', () => {
	const joined = parseAirportScan(AIRPORT_NAMED, 'en0');

	it('accepts the network the scan reports as active', () => {
		expect(() => assertMacWifiConnected(joined, 'office-wifi')).not.toThrow();
	});

	it('rejects a network that is merely in range', () => {
		expect(() => assertMacWifiConnected(joined, 'guest-open')).toThrow('did not connect');
	});

	it('rejects an empty scan', () => {
		expect(() => assertMacWifiConnected([], 'office-wifi')).toThrow('did not connect');
	});
});

describe('parseAirportScan on names that look like structure', () => {
	const block = (rows: string) => ['Wi-Fi:', '', '      Interfaces:', '        en0:', '          Status: Connected', rows].join('\n');

	it('keeps a name that begins with a space, and the network after it', () => {
		// The leading space is part of the SSID; trimming it would offer a network
		// that does not exist. Reading the column from the first row instead of the
		// shallowest one also swallowed the next entry as a field of this one.
		const networks = parseAirportScan(block(['          Other Local Wi-Fi Networks:', '             Office:', '              Security: WPA2 Personal', '              Signal / Noise: -50 dBm / -90 dBm', '            Guest:', '              Security: None', '              Signal / Noise: -60 dBm / -90 dBm'].join('\n')), 'en0');
		expect(networks.map(item => item.ssid)).toEqual([' Office', 'Guest']);
		expect(networks.find(item => item.ssid === 'Guest')).toMatchObject({ secured: false, signal: macDbmToQuality(-60) });
	});

	it('treats a network named after a list heading as a network', () => {
		// A heading only counts at the depth headings sit at; deeper is an SSID.
		const networks = parseAirportScan(block(['          Other Local Wi-Fi Networks:', '            Current Network Information:', '              Security: WPA2 Personal', '              Signal / Noise: -55 dBm / -90 dBm', '            Guest:', '              Security: None', '              Signal / Noise: -65 dBm / -90 dBm'].join('\n')), 'en0');
		expect(networks.map(item => item.ssid)).toEqual(['Current Network Information', 'Guest']);
		// It is in the "other" list, so it must not be reported as the joined one.
		expect(networks.every(item => !item.active)).toBe(true);
	});

	it('still tells the joined list from the other one', () => {
		const networks = parseAirportScan(block(['          Current Network Information:', '            Home:', '              Signal / Noise: -40 dBm / -90 dBm', '          Other Local Wi-Fi Networks:', '            Guest:', '              Signal / Noise: -70 dBm / -90 dBm'].join('\n')), 'en0');
		expect(networks.filter(item => item.active).map(item => item.ssid)).toEqual(['Home']);
	});
});

describe('parseAirportScan when a name is the only entry in its list', () => {
	const block = (rows: string[]) => ['Wi-Fi:', '', '      Interfaces:', '        en0:', '          Card Type: Wi-Fi', '          Status: Connected', ...rows].join('\n');

	it('keeps a leading space when nothing else in the list can reveal the column', () => {
		// The column comes from the report's nesting, not from the names: measuring it
		// from the shallowest name would take this SSID's own space for indentation.
		const networks = parseAirportScan(block(['          Other Local Wi-Fi Networks:', '             Office:', '              Signal / Noise: -50 dBm / -90 dBm']), 'en0');
		expect(networks.map(item => item.ssid)).toEqual([' Office']);
	});

	it('keeps it for the joined network too, which is always alone in its list', () => {
		// This one matters most: the join is confirmed by matching the name exactly,
		// so losing the space reports a successful connection as a failure.
		const networks = parseAirportScan(block(['          Current Network Information:', '             Office:', '              Signal / Noise: -40 dBm / -90 dBm']), 'en0');
		expect(networks.map(item => [item.ssid, item.active])).toEqual([[' Office', true]]);
		expect(() => assertMacWifiConnected(networks, ' Office')).not.toThrow();
	});
});

describe('macSummarySsidVisible', () => {
	it('reads a withheld name as the permission being missing', () => {
		expect(macSummarySsidVisible('  BSSID : <redacted>\n  SSID : <redacted>\n')).toBe(false);
	});

	it('reads a real name as the permission being granted', () => {
		expect(macSummarySsidVisible('  SSID : office-wifi\n  BSSID : 0:1:2:3:4:5\n')).toBe(true);
	});

	it('answers nothing for a radio that is not associated', () => {
		// No name is reported either way, so this proves nothing about the permission
		// and the caller has to fall back to the slower report.
		expect(macSummarySsidVisible('  BSSID : 0\n')).toBeNull();
		expect(macSummarySsidVisible('')).toBeNull();
	});
});

describe('parseAirportScan when a network is named after an adapter', () => {
	// A device id is a legal SSID. This report has a neighbour called "en1" sitting
	// in en0's list, above the real en1 heading.
	const TWO_RADIOS = ['Wi-Fi:', '', '      Interfaces:', '        en0:', '          Card Type: Wi-Fi', '          Status: Connected', '          Other Local Wi-Fi Networks:', '            en1:', '              Signal / Noise: -50 dBm / -90 dBm', '            Office:', '              Signal / Noise: -55 dBm / -90 dBm', '        en1:', '          Card Type: Wi-Fi', '          Status: Connected', '          Other Local Wi-Fi Networks:', '            SecondRadio:', '              Signal / Noise: -60 dBm / -90 dBm'].join('\n');

	it('gives the second radio its own networks, not the neighbour with its name', () => {
		// Matching the name anywhere in the report handed back that network's rows as
		// if they were the adapter's, and the real adapter then scanned as empty.
		expect(parseAirportScan(TWO_RADIOS, 'en1').map(item => item.ssid)).toEqual(['SecondRadio']);
	});

	it('still lists the neighbour under the radio that saw it', () => {
		expect(parseAirportScan(TWO_RADIOS, 'en0').map(item => item.ssid)).toEqual(['en1', 'Office']);
	});

	it('reports nothing for a device the report has no heading for', () => {
		expect(parseAirportScan(TWO_RADIOS, 'en9')).toEqual([]);
	});
});

describe('parseAirportScan with one name on differently secured access points', () => {
	// The joined network is the open one; an unrelated stronger WPA2 network shares
	// its name. macOS lists the joined one in its own section, so the two arrive
	// from different lists and used to be folded together by name alone.
	const MIXED = ['Wi-Fi:', '', '      Interfaces:', '        en0:', '          Card Type: Wi-Fi', '          Status: Connected', '          Current Network Information:', '            Guests:', '              Security: None', '              Signal / Noise: -80 dBm / -90 dBm', '          Other Local Wi-Fi Networks:', '            Guests:', '              Security: WPA2 Personal', '              Signal / Noise: -60 dBm / -90 dBm'].join('\n');

	it('never reports the association of one network with the security of another', () => {
		const joined = parseAirportScan(MIXED, 'en0').filter(item => item.active);
		expect(joined).toHaveLength(1);
		expect(joined[0]).toMatchObject({ ssid: 'Guests', secured: false, security: '' });
	});

	it('keeps both, because they are not the same network', () => {
		expect(parseAirportScan(MIXED, 'en0').map(item => [item.security, item.active])).toEqual([
			['WPA2 Personal', false],
			['', true],
		]);
	});

	it('still collapses access points that agree on security', () => {
		const same = MIXED.replace('              Security: None', '              Security: WPA2 Personal');
		const networks = parseAirportScan(same, 'en0');
		expect(networks).toHaveLength(1);
		expect(networks[0]).toMatchObject({ signal: macDbmToQuality(-60), active: true });
	});
});
