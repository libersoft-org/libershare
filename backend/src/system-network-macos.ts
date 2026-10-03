import { applyNativeDarwinIPv4, darwinNetworkReader } from './native/darwin/network-mutation.ts';
import { requireNativeMutationContext } from './native/mutation-context.ts';
import { NativeMutationUnknown } from './native/mutation-host.ts';
import { associateMacWifi, disconnectCoreWlanWifi, readCoreWlanWifi, scanCoreWlanWifi, type MacWifiInterface } from './system-network-corewlan.ts';
import { isIPv4, isIPv6, validateIPv4Config, type NetAddress, type NetInterfaceInfo, type NetIPv4Config, type NetLink, type NetMedium, type NetWifiNetwork } from '@shared';

/** SCPreferences owns policy; SCDynamicStore and BSD expose the live state. */
/** `<redacted>` is what macOS substitutes for a network name when Location access was not granted. */
const REDACTED = '<redacted>';

/** The documents a macOS read is built from. */
export interface MacNetworkSources {
	/** `networksetup -listallhardwareports` */
	hardwarePorts: string;
	/** `networksetup -listnetworkserviceorder` */
	serviceOrder: string;
	/** `ifconfig -a` */
	ifconfig: string;
	/** `route -n get default` */
	route: string;
	/** `route -n get -inet6 default`. Names the interface the host reaches the internet through when there is no IPv4 default route. */
	route6?: string;
	/** `netstat -rn -f inet`, used to detect every IPv4 default route. */
	routes?: string;
	/** `netstat -rn -f inet6`, read only when neither `route get` names a default interface. */
	routes6?: string | undefined;
	/** Per-service `networksetup -getinfo <service>`, keyed by DEVICE. */
	serviceInfo?: Map<string, string>;
	/** Per-service `networksetup -getdnsservers <service>`, keyed by DEVICE. */
	serviceDns?: Map<string, string>;
	/** Per-device `ipconfig getpacket <device>`, keyed by DEVICE. Supplies the DHCP-handed resolvers. */
	dhcpPacket?: Map<string, string>;
	/** `scutil --dns`. The resolvers macOS actually uses per interface, whatever family delivered them. */
	resolvers?: string;
	/** `system_profiler SPAirPortDataType`, when a Wi-Fi port exists. */
	airport?: string;
	/** Native per-interface Wi-Fi data takes precedence over optional legacy reports. */
	nativeWifi?: MacWifiInterface[];
}

/**
 * Convert a raw signal level in dBm to a 0-100 quality percentage.
 *
 * Same linear -100 dBm -> 0 %, -50 dBm -> 100 % mapping the Linux reader uses, so
 * the two platforms cannot disagree about what "60 %" means. Kept local rather
 * than shared because it is a three-line convention, not a dependency.
 */
export function macDbmToQuality(dbm: number): number {
	return Math.min(100, Math.max(0, Math.round(2 * (dbm + 100))));
}

/** Map DEVICE -> hardware port name from `networksetup -listallhardwareports`. */
export function parseHardwarePorts(text: string): Map<string, string> {
	const result = new Map<string, string>();
	let port: string | null = null;
	for (const line of text.split('\n')) {
		const portMatch = line.match(/^Hardware Port:\s*(.+?)\s*$/);
		if (portMatch) {
			port = portMatch[1] ?? null;
			continue;
		}
		const deviceMatch = line.match(/^Device:\s*(\S+)\s*$/);
		if (deviceMatch && port && deviceMatch[1]) result.set(deviceMatch[1], port);
	}
	return result;
}

/**
 * Map DEVICE -> SERVICE name from `networksetup -listnetworkserviceorder`.
 *
 * The service name is what every `networksetup` write takes, and it is NOT the
 * hardware port name: a user can rename a service, and two services can share one
 * device. A service prefixed with `*` is disabled and is skipped, because writing
 * to it silently does nothing.
 */
export function parseServiceBindings(text: string): Map<string, string[]> {
	const result = new Map<string, string[]>();
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const header = lines[i]?.match(/^\(\s*(\*?)\d+\)\s*(.+?)\s*$/);
		if (!header) continue;
		if (header[1] === '*') continue;
		const device = lines[i + 1]?.match(/Device:\s*(\S+?)\s*\)/);
		if (device && device[1] && header[2]) {
			const services = result.get(device[1]) ?? [];
			services.push(header[2]);
			result.set(device[1], services);
		}
	}
	return result;
}

/** Devices with exactly one enabled service are safe to address by device id. */
export function parseServiceOrder(text: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const [device, services] of parseServiceBindings(text)) if (services.length === 1 && services[0]) result.set(device, services[0]);
	return result;
}

/** One interface as `ifconfig -a` reports it. */
interface IfconfigEntry {
	addresses: NetAddress[];
	mac: string | null;
	/** `status: active` / `inactive`. Absent on devices that do not report one. */
	status: string | null;
	loopback: boolean;
}

/**
 * Parse `ifconfig -a`.
 *
 * The IPv4 netmask is printed as a hex word (`netmask 0xffffff00`), unlike the
 * IPv6 form which already gives `prefixlen`. A scope suffix on a link-local IPv6
 * address (`fe80::1%en0`) is an addressing artifact and is stripped.
 */
export function parseIfconfig(text: string): Map<string, IfconfigEntry> {
	const result = new Map<string, IfconfigEntry>();
	let current: IfconfigEntry | null = null;
	for (const line of text.split('\n')) {
		const head = line.match(/^([a-zA-Z0-9._-]+):\s*flags=(\d+)</);
		if (head && head[1]) {
			current = { addresses: [], mac: null, status: null, loopback: /\bLOOPBACK\b/.test(line) };
			result.set(head[1], current);
			continue;
		}
		if (!current) continue;
		const ether = line.match(/^\s*ether\s+([0-9a-f:]{17})/i);
		if (ether && ether[1]) current.mac = ether[1];
		const inet4 = line.match(/^\s*inet\s+(\d+\.\d+\.\d+\.\d+)\s+netmask\s+(0x[0-9a-f]+)/i);
		if (inet4 && inet4[1] && inet4[2]) current.addresses.push({ family: 'ipv4', address: inet4[1], prefixLength: prefixFromHexMask(inet4[2]) });
		const inet6 = line.match(/^\s*inet6\s+([0-9a-f:]+)(?:%\w+)?\s+prefixlen\s+(\d+)/i);
		if (inet6 && inet6[1] && inet6[2]) current.addresses.push({ family: 'ipv6', address: inet6[1], prefixLength: parseInt(inet6[2], 10) });
		const status = line.match(/^\s*status:\s*(\S+)/);
		if (status && status[1]) current.status = status[1];
	}
	return result;
}

/** Count the set bits of an ifconfig hex netmask (`0xffffff00` -> 24). */
export function prefixFromHexMask(hex: string): number {
	const value = parseInt(hex, 16);
	if (!Number.isFinite(value)) return 0;
	let bits = 0;
	for (let bit = 31; bit >= 0; bit--) if (value & (1 << bit)) bits++;
	return bits;
}

/** Device and gateway of the IPv4 default route, from `route -n get default`. */
export function parseDefaultRoute(text: string): { device: string | null; gateway: string | null } {
	return {
		device: text.match(/^\s*interface:\s*(\S+)/m)?.[1] ?? null,
		gateway: text.match(/^\s*gateway:\s*(\S+)/m)?.[1] ?? null,
	};
}

/** Every IPv4 default route from macOS' routing table. */
export function parseDefaultRoutes(text: string): Array<{ device: string; gateway: string }> {
	const result: Array<{ device: string; gateway: string }> = [];
	for (const line of text.split('\n')) {
		const fields = line.trim().split(/\s+/);
		if (fields[0] !== 'default' || !fields[1] || !fields[3]) continue;
		result.push({ gateway: fields[1], device: fields[3] });
	}
	return result;
}

/** An IPv6 default route from `netstat -rn -f inet6`; `scoped` is the interface-scope flag `I`. */
export interface IPv6DefaultRoute {
	device: string;
	scoped: boolean;
}

/**
 * Usable IPv6 default routes from `netstat -rn -f inet6`. Columns are located by the header
 * (`Destination`, `Gateway`, `Flags`, `Netif`); without one nothing is returned rather than a
 * column guessed. Only `default`/`::/0`, marked up (`U`) and neither reject (`R`) nor blackhole
 * (`B`). A VPN typically installs one scoped route per tunnel (`UGcIg`, gateway `fe80::%utun0`),
 * which `route get -inet6 default` does not report when there is no global default.
 */
export function parseIPv6DefaultRoutes(text: string): IPv6DefaultRoute[] {
	const result: IPv6DefaultRoute[] = [];
	let columns: { destination: number; flags: number; netif: number } | null = null;
	for (const line of text.split('\n')) {
		const fields = line.trim().split(/\s+/);
		if (fields[0] === 'Destination') {
			const flags = fields.indexOf('Flags');
			const netif = fields.indexOf('Netif');
			columns = fields.includes('Gateway') && flags > 0 && netif > 0 ? { destination: 0, flags, netif } : null;
			continue;
		}
		if (!columns || (fields[columns.destination] !== 'default' && fields[columns.destination] !== '::/0')) continue;
		const flags = fields[columns.flags] ?? '';
		const device = fields[columns.netif] ?? '';
		if (!device || !flags.includes('U') || flags.includes('R') || flags.includes('B')) continue;
		result.push({ device, scoped: flags.includes('I') });
	}
	return result;
}

/**
 * The interface to report as the default route when only the IPv6 table names one: a global
 * route before a scoped one, never a missing, loopback or inactive interface, and among equals
 * the first name in lexicographic order. With several scoped routes the kernel picks per
 * socket; this is a stable representative for the one `primaryID` the model has, not a claim
 * about which route any given connection uses.
 */
function tableDefaultDevice(routes: IPv6DefaultRoute[], interfaces: Map<string, IfconfigEntry>): string | null {
	const usable = routes.filter(route => {
		const entry = interfaces.get(route.device);
		return entry !== undefined && !entry.loopback && entry.status !== 'inactive';
	});
	for (const scoped of [false, true]) {
		const devices = [...new Set(usable.filter(route => route.scoped === scoped).map(route => route.device))].sort();
		if (devices[0]) return devices[0];
	}
	return null;
}

/**
 * Addressing mode from `networksetup -getinfo <service>`.
 *
 * The first line is the verdict: "DHCP Configuration", "Manual Configuration",
 * "BOOTP Configuration" or "Automatic Configuration". Anything else — including
 * the "not a recognized network service" error — is honestly unknown rather than
 * guessed.
 */
export function parseServiceInfo(text: string): NetInterfaceInfo['ipv4Mode'] {
	if (/^\s*Manual Configuration/m.test(text)) return 'static';
	if (/^\s*DHCP Configuration/m.test(text)) return 'dhcp';
	return 'unknown';
}

/** IPv4 router reported for one network service. */
export function parseServiceGateway(text: string): string | null {
	const value = text.match(/^\s*Router:\s*(\S+)/im)?.[1];
	return value && value.toLowerCase() !== 'none' ? value : null;
}

/** Static IPv4 stored in a service even while its device has no carrier. */
export function parseServiceIPv4(text: string): NetAddress | null {
	if (parseServiceInfo(text) !== 'static') return null;
	return parseServiceCurrentIPv4(text);
}

/** Current IPv4 reported for either a manual service or an acquired DHCP lease. */
export function parseServiceCurrentIPv4(text: string): NetAddress | null {
	const address = text.match(/^\s*IP address:\s*(\S+)/im)?.[1];
	const mask = text.match(/^\s*Subnet mask:\s*(\S+)/im)?.[1];
	if (!address || !mask || !isIPv4(address) || !isIPv4(mask)) return null;
	let prefixLength = 0;
	let zeroSeen = false;
	for (const octet of mask.split('.').map(Number)) {
		for (let bit = 7; bit >= 0; bit--) {
			const set = (octet & (1 << bit)) !== 0;
			if (set && zeroSeen) return null;
			if (set) prefixLength++;
			else zeroSeen = true;
		}
	}
	return { family: 'ipv4', address, prefixLength };
}

/**
 * Accept a resolver spelled the way macOS prints it.
 *
 * `scutil` appends the zone to a link-local server (`fe80::1%en0`), which is the
 * usual shape of a resolver learned from a router advertisement - exactly the
 * case the scoped source exists for. The shared validators reject `%` on purpose,
 * because the values they guard reach an elevated writer, so the zone is
 * accounted for here instead of widening them.
 */
function isMacResolver(value: string): boolean {
	const zone = value.indexOf('%');
	if (zone < 0) return isIPv4(value) || isIPv6(value);
	// Only IPv6 carries a zone, and only one, and an interface name is alphanumeric.
	return zone === value.lastIndexOf('%') && /^[0-9a-z]{1,15}$/i.test(value.slice(zone + 1)) && isIPv6(value.slice(0, zone));
}

/**
 * Resolvers from `networksetup -getdnsservers <service>`.
 *
 * This reports only servers the USER set. When addressing is left on DHCP macOS
 * answers "There aren't any DNS Servers set", even though the link is resolving
 * perfectly well through the ones the lease handed out — hence the DHCP fallback
 * in {@link parseDhcpDns}. Reporting an empty list here would tell the user their
 * machine has no resolvers, which is never true of a working connection.
 */
export function parseServiceDns(text: string): string[] {
	if (/There aren't any DNS Servers set/i.test(text)) return [];
	return text
		.split('\n')
		.map(line => line.trim())
		.filter(line => isMacResolver(line));
}

/**
 * DHCP-supplied resolvers from `ipconfig getpacket <device>`.
 *
 * The option is printed as `domain_name_server (ip_mult): {192.0.2.1, 192.0.2.2}`.
 * `ipconfig` ships with macOS, so this needs nothing installed.
 */
export function parseDhcpDns(text: string): string[] {
	const line = text.match(/^\s*domain_name_server[^:]*:\s*\{(.+?)\}/m);
	if (!line || !line[1]) return [];
	return line[1]
		.split(',')
		.map(server => server.trim())
		.filter(server => isMacResolver(server));
}

/**
 * Wi-Fi association state from `system_profiler SPAirPortDataType`.
 *
 * Only the signal and the connected flag are trusted: the network name is
 * `<redacted>` unless the caller holds Location access, and reporting that string
 * as an SSID would put a literal "&lt;redacted&gt;" in the user interface.
 */
export function parseAirport(text: string): { connected: boolean; ssid: string | null; signal: number | null } {
	const connected = /^\s*Status:\s*Connected\s*$/m.test(text);
	const signalMatch = text.match(/^\s*Signal \/ Noise:\s*(-?\d+)\s*dBm/m);
	const nameMatch = text.match(/^\s*Current Network Information:\s*\n\s*(.+?):\s*$/m);
	const name = nameMatch?.[1]?.trim() ?? null;
	return {
		connected,
		ssid: !name || name === REDACTED ? null : name,
		signal: signalMatch?.[1] ? macDbmToQuality(parseInt(signalMatch[1], 10)) : null,
	};
}

/**
 * Effective resolvers for one device from `scutil --dns`.
 *
 * The "for scoped queries" section lists one resolver per interface, so this
 * answers for interfaces that are not the primary one too. Unlike
 * {@link parseDhcpDns} it does not care which family carried the servers: a host
 * that learns its resolvers from IPv6 router advertisements or DHCPv6 is
 * described here and by no other command macOS ships.
 *
 * macOS lists only the resolvers it considers usable on that link, which is the
 * honest answer for a status screen - a configured but unreachable server is not
 * the one answering queries.
 */
export function parseScopedDns(text: string, device: string): string[] {
	const scoped = text.split(/^DNS configuration \(for scoped queries\)$/m)[1];
	if (!scoped) return [];
	for (const block of scoped.split(/^resolver #\d+$/m)) {
		const owner = block.match(/^\s*if_index\s*:\s*\d+\s*\((.+?)\)\s*$/m);
		if (owner?.[1] !== device) continue;
		const servers = [...block.matchAll(/^\s*nameserver\[\d+\]\s*:\s*(\S+)\s*$/gm)].map(match => match[1] as string).filter(server => isMacResolver(server));
		if (servers.length > 0) return servers;
	}
	return [];
}

/**
 * Resolvers for one device: the user's own choice first, then the ones the
 * network handed out. The DHCP packet stays as the last resort because macOS
 * drops a resolver from `scutil` once it judges the link unusable, and the
 * lease still describes what the interface was given.
 */
function pickDns(sources: MacNetworkSources, device: string): string[] {
	const manual = sources.serviceDns?.has(device) ? parseServiceDns(sources.serviceDns.get(device) as string) : [];
	if (manual.length > 0) return manual;
	const scoped = sources.resolvers ? parseScopedDns(sources.resolvers, device) : [];
	if (scoped.length > 0) return scoped;
	return sources.dhcpPacket?.has(device) ? parseDhcpDns(sources.dhcpPacket.get(device) as string) : [];
}

/** Classify a device from its hardware port name. */
function mapMedium(port: string | undefined): NetMedium {
	if (!port) return 'other';
	if (/^Wi-Fi$/i.test(port) || /AirPort/i.test(port)) return 'wireless';
	if (/Ethernet/i.test(port)) return 'wired';
	return 'other';
}

/** Carrier state from the ifconfig `status:` line. Devices that report none are honestly unknown. */
function mapLink(status: string | null): NetLink {
	if (status === 'active') return 'up';
	if (status === 'inactive') return 'down';
	return 'unknown';
}

/**
 * Build the interface list from the collected documents.
 *
 * Loopback is dropped for the same reason as on the other platforms: it is never
 * a choice a user makes and never a connection to report.
 */
export function parseMacNetworkState(sources: MacNetworkSources): NetInterfaceInfo[] {
	const ports = parseHardwarePorts(sources.hardwarePorts);
	const serviceBindings = parseServiceBindings(sources.serviceOrder);
	const services = parseServiceOrder(sources.serviceOrder);
	const interfaces = parseIfconfig(sources.ifconfig);
	const route = parseDefaultRoute(sources.route);
	// Only the interface name is taken from the IPv6 side: a host reachable solely
	// over IPv6 still has a default route, and without it the footer would call a
	// working connection "disconnected". The IPv4 route stays first, and the
	// gateway shown on the screen is still the IPv4 one.
	const route6Device = sources.route6 ? parseDefaultRoute(sources.route6).device : null;
	// Third and last: the IPv6 table, for a host whose only default routes are interface-scoped
	// (a VPN without a global route). It only marks which interface carries the default; the
	// gateway on the IPv4 form never comes from here.
	const defaultDevice = route.device ?? route6Device ?? (sources.routes6 ? tableDefaultDevice(parseIPv6DefaultRoutes(sources.routes6), interfaces) : null);
	const routeDetailKnown = sources.routes === undefined || sources.routes.trim() !== '';
	const routes = sources.routes === undefined ? (route.device && route.gateway ? [{ device: route.device, gateway: route.gateway }] : []) : parseDefaultRoutes(sources.routes);
	const airport = sources.airport ? parseAirport(sources.airport) : null;
	const wirelessDevices = [...ports].filter(([, port]) => mapMedium(port) === 'wireless').map(([device]) => device);

	const result: NetInterfaceInfo[] = [];
	for (const [device, entry] of interfaces) {
		if (entry.loopback) continue;
		const port = ports.get(device);
		const medium = mapMedium(port);
		const nativeWifi = sources.nativeWifi?.find(wifi => wifi.device === device);
		const defaultRoute = device === defaultDevice;
		const deviceRoutes = routes.filter(entry => entry.device === device);
		const serviceInfo = sources.serviceInfo?.get(device) ?? '';
		const ipv4Mode = serviceInfo ? parseServiceInfo(serviceInfo) : 'unknown';
		const liveIPv4Addresses = entry.addresses.filter(address => address.family === 'ipv4');
		const storedIPv4 = liveIPv4Addresses.length === 0 ? parseServiceIPv4(serviceInfo) : null;
		const addresses = storedIPv4 ? [...entry.addresses, storedIPv4] : entry.addresses;
		const ipv4Addresses = addresses.filter(address => address.family === 'ipv4');
		const serviceGateway = parseServiceGateway(serviceInfo);
		const gateway = serviceGateway ?? (defaultRoute ? route.gateway : null);
		const staticShapeSafe = ipv4Mode !== 'static' || (ipv4Addresses.length === 1 && validateIPv4Config({ mode: 'static', address: ipv4Addresses[0]!.address, prefixLength: ipv4Addresses[0]!.prefixLength, gateway: serviceGateway ?? '' }, { staticGatewayRequired: true }) === null);
		const info: NetInterfaceInfo = {
			id: device,
			// The service name is what the user sees in System Settings, so it is the
			// better label; the device name is the fallback for anything unmanaged.
			name: serviceBindings.get(device)?.[0] ?? port ?? device,
			medium,
			link: mapLink(entry.status),
			defaultRoute,
			mac: entry.mac,
			addresses,
			ipv4Mode,
			ipv4Configurable: routeDetailKnown && services.has(device) && ipv4Mode !== 'unknown' && staticShapeSafe && ipv4Addresses.length <= 1 && deviceRoutes.length <= 1,
			wifiConfigurable: medium === 'wireless' && !!nativeWifi?.configurable,
			gateway,
			// Manually set servers win; otherwise fall back to what the DHCP lease
			// handed out, so a DHCP link reports the resolvers it actually uses.
			dns: pickDns(sources, device),
		};
		if (medium === 'wireless' && sources.nativeWifi !== undefined) {
			if (nativeWifi) info.wifi = nativeWifi.wifi;
		} else if (medium === 'wireless' && airport && wirelessDevices.length === 1 && wirelessDevices[0] === device) {
			info.wifi = {
				ssid: airport.connected ? airport.ssid : null,
				signal: airport.connected ? airport.signal : null,
				// macOS reports "Status: Connected" or nothing at all; a powered-off
				// radio is not distinguishable from an idle one here, so it is not claimed.
				radio: 'unknown',
			};
		}
		result.push(info);
	}
	return result;
}

/** Native reads keep blocking framework calls off the main event loop. */
export async function readMacNetworkState(): Promise<NetInterfaceInfo[]> {
	const interfaces = await darwinNetworkReader.call<NetInterfaceInfo[]>({ method: 'darwin.network.read' }, 15000);
	const wifi = interfaces.some(iface => iface.medium === 'wireless') ? await readCoreWlanWifi().catch(() => []) : [];
	return interfaces.map(iface => {
		const native = wifi.find(wifi => wifi.device === iface.id);
		return native && iface.medium === 'wireless' ? { ...iface, wifi: native.wifi, wifiConfigurable: native.configurable } : iface;
	});
}

/** The unprivileged process uses the helper; root still needs available frameworks. */
export async function isMacWritable(): Promise<boolean> {
	if (!hasMacWritePrivilege(process.getuid?.())) return false;
	try {
		await darwinNetworkReader.call({ method: 'darwin.network.read' }, 15000);
		return true;
	} catch {
		return false;
	}
}

/** Root is the only privilege level that is safe under every macOS policy. */
export function hasMacWritePrivilege(effectiveUID: number | undefined): boolean {
	return effectiveUID === 0;
}

/** Query native name access in the same bundle context used to scan and associate. */
export async function isMacWifiConfigurable(): Promise<boolean> {
	try {
		return (await readCoreWlanWifi()).some(wifi => wifi.configurable);
	} catch {
		return false;
	}
}

/** Scan for the Wi-Fi networks one interface can see. */
export async function scanMacWifi(device: string): Promise<NetWifiNetwork[]> {
	return scanCoreWlanWifi(device);
}

/** Associate and verify the native raw SSID and selected access point. */
export function connectMacWifi(device: string, ssid: string, password: string, security: string, bssid: string | null = null, ssidHex: string | null = null): Promise<void> {
	return associateMacWifi(device, ssid, password, security, bssid, ssidHex);
}

export function disconnectMacWifi(device: string): Promise<void> {
	return disconnectCoreWlanWifi(device);
}

/** Dotted-quad netmask for a prefix length, which is the only form `networksetup -setmanual` accepts. */
export function netmaskFromPrefix(prefixLength: number): string {
	const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
	return [(mask >>> 24) & 0xff, (mask >>> 16) & 0xff, (mask >>> 8) & 0xff, mask & 0xff].join('.');
}

/**
 * Build the `networksetup` argument lists that apply one IPv4 configuration.
 *
 * Two calls, not one: the address and the resolvers are separate settings, and
 * `-setdhcp` deliberately does NOT reset the resolvers — a manual DNS entry
 * survives a switch back to DHCP unless it is cleared with the `Empty` sentinel.
 */
export function macApplyArgs(service: string, config: NetIPv4Config, addressingChanged: boolean = true): string[][] {
	const dnsArgs = config.dns === undefined ? [] : [['-setdnsservers', service, ...(config.dns.length > 0 ? config.dns : ['Empty'])]];
	if (!addressingChanged) return dnsArgs;
	if (config.mode === 'dhcp') return [['-setdhcp', service], ...dnsArgs];
	// Unlike the Windows and NetworkManager paths, networksetup documents the
	// router as a required positional argument and has no documented no-router
	// sentinel. Reject only this platform-specific shape instead of emitting a
	// command that networksetup cannot parse.
	if (!config.gateway) throw new Error('macOS manual IPv4 configuration requires a router');
	const address = ['-setmanual', service, config.address as string, netmaskFromPrefix(config.prefixLength as number), config.gateway];
	return [address, ...dnsArgs];
}

function sameAddressSet(left: string[], right: string[]): boolean {
	const actual = [...new Set(left.map(value => value.toLowerCase()))].sort();
	const expected = [...new Set(right.map(value => value.toLowerCase()))].sort();
	return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function macAddressingApplied(config: NetIPv4Config, info: string, requireLease: boolean = true): boolean {
	if (parseServiceInfo(info) !== config.mode) return false;
	const current = parseServiceCurrentIPv4(info);
	// With the link down the mode is what gets saved; the lease follows the cable.
	if (config.mode === 'dhcp') return !requireLease || (!!current && current.address !== '0.0.0.0' && !current.address.startsWith('169.254.'));
	return !!current && current.address === config.address && current.prefixLength === config.prefixLength && parseServiceGateway(info) === (config.gateway || null);
}

/**
 * Whether restoring a configuration may be held to producing a DHCP lease.
 *
 * A restore cannot be asked for a better state than the one it restores. A
 * service that was on DHCP without an address before the change — the link is up
 * but nothing answered — will not have one after it either, and demanding one
 * would report a failed restore for a service that is exactly back where it
 * started. What it does have to prove either way is that it is on DHCP again.
 */
export function macRestoreRequiresLease(previous: NetIPv4Config, previousInfo: string, requireLease: boolean): boolean {
	if (!requireLease || previous.mode !== 'dhcp') return requireLease;
	return macAddressingApplied(previous, previousInfo, true);
}

export function assertMacIPv4Applied(config: NetIPv4Config, info: string, dnsText: string, addressingChanged: boolean, requireLease: boolean = true): void {
	if (addressingChanged && !macAddressingApplied(config, info, requireLease)) throw new Error(config.mode === 'dhcp' ? 'macOS did not obtain a usable DHCP lease' : 'macOS did not apply the requested IPv4 configuration');
	if (config.dns !== undefined && !sameAddressSet(parseServiceDns(dnsText), config.dns)) throw new Error('macOS did not apply the requested DNS policy');
}

/** Persistent policy and its rollback use one locked SCPreferences transaction. */
export function applyMacIPv4(device: string, config: NetIPv4Config, addressingChanged: boolean = true, requireLease: boolean = true): Promise<void> {
	return applyNativeDarwinIPv4(requireNativeMutationContext(), device, config, { addressingChanged, requireLease });
}

/**
 * Run a change that must leave the service either changed or as it was.
 *
 * The restore is verified like the change is, and a restore that cannot be
 * verified is reported alongside the failure that triggered it — those are two
 * different situations for whoever has to get the machine back on the network.
 */
export async function withMacRollback<T>(mutate: () => Promise<T>, rollback: () => Promise<void>): Promise<T> {
	try {
		return await mutate();
	} catch (applyError) {
		if (applyError instanceof NativeMutationUnknown) throw applyError;
		try {
			await rollback();
		} catch (rollbackError) {
			if (rollbackError instanceof NativeMutationUnknown) throw rollbackError;
			throw new Error(`network apply failed: ${String(applyError)}; rollback failed: ${String(rollbackError)}`);
		}
		throw applyError;
	}
}
