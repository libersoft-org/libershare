import { describe, expect, it } from 'bun:test';
import { CodedError, ErrorCodes } from '@shared';
import { macApplyArgs, macDbmToQuality, macRestoreArgs, parseMacServiceSnapshot, netmaskFromPrefix, parseAirport, parseDefaultRoute, parseDhcpDns, parseHardwarePorts, parseIfconfig, parseMacNetworkState, parseServiceDns, parseServiceInfo, parseServiceOrder, parseServiceRouter, prefixFromHexMask } from '../../src/system-network-macos.ts';

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
});

describe('parseServiceRouter', () => {
	it('reads the router of the service, so a secondary one keeps its gateway', () => {
		expect(parseServiceRouter('Manual Configuration\nIP address: 198.51.100.2\nRouter: 198.51.100.1\n')).toBe('198.51.100.1');
	});

	it('treats the literal "none" as no router', () => {
		// macOS prints this for a service with no gateway configured; taking it
		// verbatim would put the word into the edit form gateway field.
		expect(parseServiceRouter('Manual Configuration\nRouter: none\n')).toBeNull();
	});

	it('reports nothing when the output carries no router at all', () => {
		expect(parseServiceRouter('** Error: The parameters were not valid.')).toBeNull();
	});
});

describe('parseServiceInfo', () => {
	it('distinguishes the addressing modes', () => {
		expect(parseServiceInfo('DHCP Configuration\nIP address: 192.0.2.2\n')).toBe('dhcp');
		expect(parseServiceInfo('Manual Configuration\nIP address: 192.0.2.2\n')).toBe('static');
		expect(parseServiceInfo('BOOTP Configuration\n')).toBe('dhcp');
	});

	it('does not guess when networksetup does not recognise the service', () => {
		expect(parseServiceInfo('** Error: The parameters were not valid.')).toBe('unknown');
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
			gateway: '192.0.2.1',
			dns: ['192.0.2.1'],
		});
		expect(en0?.wifi).toEqual({ ssid: null, signal: 60, radio: 'unknown' });
	});

	it('drops loopback', () => {
		expect(parseMacNetworkState(sources).some(i => i.id === 'lo0')).toBe(false);
	});

	it('attributes the gateway only to the default-route interface', () => {
		expect(parseMacNetworkState(sources).find(i => i.id === 'bridge0')?.gateway).toBeNull();
	});

	it('leaves wifi undefined on a wired interface', () => {
		expect(parseMacNetworkState(sources).find(i => i.id === 'bridge0')?.wifi).toBeUndefined();
	});

	it('marks a device no enabled service covers as unconfigurable', () => {
		// en4 is present in the service order but DISABLED (the `*3` entry), so
		// parseServiceOrder skips it and every networksetup write for that device
		// would fail in serviceForDevice. A record is still created for it, because
		// the kernel reports the interface — it just must not be offered for editing.
		const withDisabled = { ...sources, ifconfig: `${IFCONFIG}en4: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500\n\tether 02:00:5e:30:00:04\n\tstatus: inactive\n` };
		const parsed = parseMacNetworkState(withDisabled);
		expect(parsed.find(i => i.id === 'en4')?.configurable).toBe(false);
		expect(parsed.find(i => i.id === 'en0')?.configurable).toBe(true);
	});
});

describe('macApplyArgs', () => {
	it('builds a manual configuration with a dotted-quad mask', () => {
		expect(macApplyArgs('Wi-Fi', { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.1'] })).toEqual([
			['-setmanual', 'Wi-Fi', '192.0.2.10', '255.255.255.0', '192.0.2.1'],
			['-setdnsservers', 'Wi-Fi', '192.0.2.1'],
		]);
	});

	it('refuses a static configuration with no gateway rather than building a short command', () => {
		// `-setmanual` is documented as taking four mandatory values: service,
		// address, subnet mask and router. Emitting only three produced a command
		// networksetup rejects, and it did so only after the user had been told the
		// configuration was valid. A gateway-less static address is legitimate on an
		// isolated segment — macOS simply has no networksetup spelling for it, so the
		// refusal is explicit and carries the code the UI can translate.
		let thrown: CodedError | null = null;
		try {
			macApplyArgs('Wi-Fi', { mode: 'static', address: '192.0.2.10', prefixLength: 24 });
		} catch (err) {
			thrown = err as CodedError;
		}
		expect(thrown).toBeInstanceOf(CodedError);
		expect(thrown?.code).toBe(ErrorCodes.NETCONFIG_UNSUPPORTED);
	});

	it('places the router as the fourth mandatory value, never as an optional extra', () => {
		expect(macApplyArgs('Wi-Fi', { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' })[0]).toHaveLength(5);
	});

	it('clears the resolvers with the Empty sentinel when switching to DHCP', () => {
		// -setdhcp on its own leaves a manual DNS entry in place, so a user who set
		// one would keep it after asking for full automatic configuration.
		expect(macApplyArgs('Wi-Fi', { mode: 'dhcp' })).toEqual([
			['-setdhcp', 'Wi-Fi'],
			['-setdnsservers', 'Wi-Fi', 'Empty'],
		]);
	});

	it('passes a service name with spaces as one argument', () => {
		expect(macApplyArgs('Thunderbolt Bridge', { mode: 'dhcp' })[0]).toEqual(['-setdhcp', 'Thunderbolt Bridge']);
	});

	// `-setdnsservers` replaces the whole resolver list, both families at once,
	// while the editor only ever holds IPv4 servers. Writing the form's list
	// verbatim deleted every manually configured IPv6 resolver — even when the
	// user had changed nothing but an address.
	it('keeps the IPv6 resolvers the editor cannot express', () => {
		const args = macApplyArgs('Wi-Fi', { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.1'] }, ['198.51.100.1', '2001:db8::1', '2001:db8::2']);
		expect(args[1]).toEqual(['-setdnsservers', 'Wi-Fi', '192.0.2.1', '2001:db8::1', '2001:db8::2']);
	});

	it('drops the IPv4 resolvers it is replacing, keeping only the IPv6 ones', () => {
		const args = macApplyArgs('Wi-Fi', { mode: 'dhcp' }, ['198.51.100.1', '2001:db8::1']);
		expect(args[1]).toEqual(['-setdnsservers', 'Wi-Fi', '2001:db8::1']);
	});

	it('still clears the list entirely when there is nothing at all to keep', () => {
		expect(macApplyArgs('Wi-Fi', { mode: 'dhcp' }, ['198.51.100.1'])[1]).toEqual(['-setdnsservers', 'Wi-Fi', 'Empty']);
	});
});

/**
 * The address and the resolvers are two separate `networksetup` commands with
 * nothing joining them, so the second failing leaves the first already applied.
 */
describe('parseMacServiceSnapshot', () => {
	const MANUAL = 'Manual Configuration\nIP address: 192.0.2.10\nSubnet mask: 255.255.255.0\nRouter: 192.0.2.1\nEthernet Address: 00:11:22:33:44:55\n';
	const DHCP = 'DHCP Configuration\nIP address: 198.51.100.24\nSubnet mask: 255.255.255.0\nRouter: 198.51.100.1\n';

	it('captures the whole manual configuration, mask and router included', () => {
		const snapshot = parseMacServiceSnapshot(MANUAL, '192.0.2.1\n2001:db8::1\n');
		expect(snapshot).toEqual({ mode: 'static', address: '192.0.2.10', mask: '255.255.255.0', router: '192.0.2.1', dns: ['192.0.2.1', '2001:db8::1'] });
	});

	it('captures a DHCP service as DHCP rather than as its current lease', () => {
		expect(parseMacServiceSnapshot(DHCP, "There aren't any DNS Servers set.\n")).toEqual({ mode: 'dhcp', address: '198.51.100.24', mask: '255.255.255.0', router: '198.51.100.1', dns: [] });
	});

	it('reads the literal "none" as absent rather than as a value', () => {
		const snapshot = parseMacServiceSnapshot('Manual Configuration\nIP address: none\nSubnet mask: none\nRouter: none\n', '');
		expect([snapshot.address, snapshot.mask, snapshot.router]).toEqual([null, null, null]);
	});
});

describe('macRestoreArgs', () => {
	it('puts a manual configuration back exactly, resolvers of both families included', () => {
		const snapshot = parseMacServiceSnapshot('Manual Configuration\nIP address: 192.0.2.10\nSubnet mask: 255.255.255.0\nRouter: 192.0.2.1\n', '192.0.2.1\n2001:db8::1\n');
		expect(macRestoreArgs('Wi-Fi', snapshot)).toEqual([
			['-setmanual', 'Wi-Fi', '192.0.2.10', '255.255.255.0', '192.0.2.1'],
			['-setdnsservers', 'Wi-Fi', '192.0.2.1', '2001:db8::1'],
		]);
	});

	it('puts a DHCP service back as DHCP, not as the address it happened to hold', () => {
		const snapshot = parseMacServiceSnapshot('DHCP Configuration\nIP address: 198.51.100.24\nRouter: 198.51.100.1\n', '');
		expect(macRestoreArgs('Wi-Fi', snapshot)?.[0]).toEqual(['-setdhcp', 'Wi-Fi']);
		expect(macRestoreArgs('Wi-Fi', snapshot)?.[1]).toEqual(['-setdnsservers', 'Wi-Fi', 'Empty']);
	});

	// Null is a real answer: `-setmanual` takes a router as a mandatory value, so
	// a static service without one cannot be written back at all. Saying so lets
	// the caller report an un-undone change rather than guess at one.
	it('reports that a configuration with no networksetup form cannot be restored', () => {
		expect(macRestoreArgs('Wi-Fi', parseMacServiceSnapshot('Manual Configuration\nIP address: 192.0.2.10\nSubnet mask: 255.255.255.0\nRouter: none\n', ''))).toBeNull();
		expect(macRestoreArgs('Wi-Fi', parseMacServiceSnapshot('Automatic Configuration\n', ''))).toBeNull();
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
