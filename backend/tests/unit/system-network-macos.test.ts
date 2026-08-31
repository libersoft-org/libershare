import { describe, expect, it } from 'bun:test';
import { hasMacWritePrivilege, macApplyArgs, macDbmToQuality, netmaskFromPrefix, parseAirport, parseDefaultRoute, parseDefaultRoutes, parseDhcpDns, parseHardwarePorts, parseIfconfig, parseMacNetworkState, parseServiceBindings, parseServiceDns, parseServiceGateway, parseServiceIPv4, parseServiceInfo, parseServiceOrder, prefixFromHexMask } from '../../src/system-network-macos.ts';

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

describe('netmaskFromPrefix', () => {
	it('converts the prefix lengths networksetup needs spelled out', () => {
		expect(netmaskFromPrefix(24)).toBe('255.255.255.0');
		expect(netmaskFromPrefix(16)).toBe('255.255.0.0');
		expect(netmaskFromPrefix(8)).toBe('255.0.0.0');
		expect(netmaskFromPrefix(23)).toBe('255.255.254.0');
		expect(netmaskFromPrefix(32)).toBe('255.255.255.255');
	});
});
