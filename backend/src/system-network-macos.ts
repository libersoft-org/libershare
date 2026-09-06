import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { isIPv4, isIPv6, validateIPv4Config, type NetAddress, type NetInterfaceInfo, type NetIPv4Config, type NetLink, type NetMedium, type NetWifiNetwork } from '@shared';

const execFileAsync = promisify(execFile);
const C_LOCALE_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

/**
 * macOS host network state.
 *
 * Everything comes from the BSD/Apple command-line tools rather than one API:
 * `networksetup` owns the persistent configuration (and is the only supported way
 * to change it), while `ifconfig` and `route` report what the kernel is doing
 * right now. The two are joined by the service-to-device map, because
 * `networksetup` is addressed by SERVICE name ("Wi-Fi", "Thunderbolt Bridge")
 * while everything else speaks DEVICE names (en0, bridge0).
 *
 * Wi-Fi is scanned and joined through the same two tools, but only when macOS
 * lets this process read network names. Since macOS 14 the SSID is withheld from
 * any process that has not been granted Location Services access, and both
 * `ipconfig getsummary` and `system_profiler` substitute the literal string
 * `<redacted>` — measured on macOS 15.7.4 even when running as root. Joining does
 * NOT need that access, but choosing what to join does, so the capability follows
 * the names: see {@link isMacWifiConfigurable}. Signal strength, security and
 * connection state are never redacted and are always reported.
 */

/** Hard cap on any single tool invocation. These are local BSD utilities; a slow one is a hung one. */
const EXEC_TIMEOUT_MS = 5000;
/** Reconfiguring a service renegotiates DHCP, which is far slower than a read. */
const APPLY_TIMEOUT_MS = 45000;
/** `system_profiler SPAirPortDataType` drives a real radio scan and measures ~3 s on an idle host. */
const WIFI_SCAN_TIMEOUT_MS = 20000;
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

/** Leading-space count, which is the only structure `system_profiler` gives its output. */
function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

/**
 * The lines `system_profiler SPAirPortDataType` prints about one interface.
 *
 * The report nests every interface under `Interfaces:` and separates them by
 * indentation alone, so a host with two radios describes both in one document and
 * the block has to be cut out before anything in it can be attributed to a device.
 *
 * Indentation alone does not end the block, because a value may wrap: the
 * firmware version of a real adapter carries an embedded newline whose second
 * line starts in column zero. Only a key — a line ending in a colon — at or above
 * the interface's own depth begins something new. Measured on macOS 15.7.4.
 *
 * The nesting step is reported alongside the lines, measured from the interface
 * heading to its own first row. Both are structure the report chooses, never text
 * a user picked, which is what makes the step trustworthy for locating the column
 * network names start in.
 */
function airportInterfaceBlock(text: string, device: string): { lines: string[]; depth: number; step: number } {
	const lines = text.split('\n');
	const start = lines.findIndex(line => line.trim() === `${device}:`);
	if (start < 0) return { lines: [], depth: 0, step: 0 };
	const depth = indentOf(lines[start]!);
	const block: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trim().endsWith(':') && indentOf(line) <= depth) break;
		block.push(line);
	}
	const first = block.find(line => line.trim() && indentOf(line) > depth);
	return { lines: block, depth, step: first ? indentOf(first) - depth : 2 };
}

/** Turn one parsed `system_profiler` network entry into the shape the picker renders. */
function airportNetwork(ssid: string, fields: Map<string, string>, active: boolean): NetWifiNetwork {
	const security = fields.get('Security') ?? '';
	const open = security === '' || /^(?:none|open)$/i.test(security);
	const dbm = fields.get('Signal / Noise')?.match(/(-?\d+)\s*dBm/);
	return {
		ssid,
		// system_profiler never prints a BSSID, and networksetup takes no BSSID
		// either, so two access points sharing a name cannot be told apart here.
		bssid: null,
		signal: dbm?.[1] ? macDbmToQuality(parseInt(dbm[1], 10)) : null,
		secured: !open,
		security: open ? '' : security,
		supported: open || (/\bWPA\d*\b/i.test(security) && !/(?:Enterprise|802\.1X|EAP)/i.test(security) && !/\bWEP\b/i.test(security)),
		active,
	};
}

/**
 * Parse the networks one interface can see out of `system_profiler SPAirPortDataType`.
 *
 * The report has two lists — the network currently joined, and everything else in
 * range — and both carry the same fields, so they are read by one pass that only
 * changes what it calls "active". Entries macOS refused to name are dropped
 * rather than shown: `networksetup` is addressed by name, so an unnamed row would
 * be an offer that cannot be honoured.
 *
 * A network name is whatever the report prints, and that includes names an
 * ordinary parser would mistake for structure. The two defences are depth: a list
 * heading only counts at the depth headings sit at, so a network CALLED "Current
 * Network Information" stays a network; and the name is cut at a fixed column
 * rather than trimmed, so a name that begins with a space keeps it and is still
 * told apart from the fields underneath it. Getting either wrong renames a
 * network, which then cannot be joined, or swallows the one after it.
 */
export function parseAirportScan(text: string, device: string): NetWifiNetwork[] {
	const networks = new Map<string, NetWifiNetwork>();
	const block = airportInterfaceBlock(text, device);
	for (const list of airportLists(block)) {
		// The column names start in comes from the report's own nesting — one step in
		// from the list heading — and NEVER from the names themselves. Measuring it
		// from the shallowest name breaks on a list whose only entry begins with a
		// space: that space is part of the SSID, and taking it for indentation
		// silently renames the network into one that cannot be joined.
		const nameDepth = list.depth + block.step;
		let ssid: string | null = null;
		let fields = new Map<string, string>();
		const flush = (): void => {
			if (ssid !== null && ssid !== REDACTED) {
				const entry = airportNetwork(ssid, fields, list.joined);
				const previous = networks.get(ssid);
				// One name can appear on several access points; keep the strongest of
				// them, but never lose the fact that one of them is the joined one.
				const stronger = !previous || (entry.signal ?? -1) > (previous.signal ?? -1) ? entry : previous;
				networks.set(ssid, { ...stronger, active: (previous?.active ?? false) || entry.active });
			}
			ssid = null;
			fields = new Map();
		};
		for (const line of list.body) {
			const label = line.trim();
			// Only a name ends in a colon with nothing after it; every field line in
			// the measured report is `Key: value`. Cutting at the fixed column keeps a
			// leading space that belongs to the name, which trimming would delete —
			// renaming the network into one that cannot be joined.
			if (label.endsWith(':')) {
				flush();
				ssid = line.slice(nameDepth).trimEnd().replace(/:$/, '');
				continue;
			}
			const separator = label.indexOf(':');
			if (ssid !== null && separator > 0) fields.set(label.slice(0, separator).trim(), label.slice(separator + 1).trim());
		}
		flush();
	}
	return [...networks.values()].sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1));
}

/**
 * Split one interface block into its two network lists.
 *
 * Both headings sit at the same depth, so the first one seen fixes it. A later
 * line carrying the same text but deeper is a network NAMED after a heading, not
 * a heading — without that check such a network renames itself and swallows the
 * rows beneath it.
 */
function airportLists(block: { lines: string[]; depth: number; step: number }): { joined: boolean; depth: number; body: string[] }[] {
	const lists: { joined: boolean; depth: number; body: string[] }[] = [];
	// Both headings sit one step in from the interface, so the depth is known from
	// the structure before any of them is seen — a network named after a heading
	// cannot pass itself off as the first one.
	const headingDepth = block.depth + block.step;
	let current: { joined: boolean; depth: number; body: string[] } | null = null;
	for (const line of block.lines) {
		if (!line.trim()) continue;
		const depth = indentOf(line);
		const label = line.trim();
		if ((label === 'Current Network Information:' || label === 'Other Local Wi-Fi Networks:') && depth === headingDepth) {
			current = { joined: label.startsWith('Current'), depth, body: [] };
			lists.push(current);
			continue;
		}
		if (!current) continue;
		if (depth <= headingDepth) {
			current = null;
			continue;
		}
		current.body.push(line);
	}
	return lists;
}

/**
 * True when macOS is printing real network names to this process.
 *
 * A single `<redacted>` anywhere in the report proves Location Services access
 * was not granted, because macOS redacts every name or none. An empty report
 * proves nothing was asked, so it is not taken as an answer either.
 */
export function macWifiNamesVisible(airport: string): boolean {
	return airport.trim() !== '' && !airport.includes(REDACTED);
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
	const routeDetailKnown = sources.routes === undefined || sources.routes.trim() !== '';
	const routes = sources.routes === undefined ? (route.device && route.gateway ? [{ device: route.device, gateway: route.gateway }] : []) : parseDefaultRoutes(sources.routes);
	const airport = sources.airport ? parseAirport(sources.airport) : null;
	const namesVisible = macWifiNamesVisible(sources.airport ?? '');
	const wirelessDevices = [...ports].filter(([, port]) => mapMedium(port) === 'wireless').map(([device]) => device);

	const result: NetInterfaceInfo[] = [];
	for (const [device, entry] of interfaces) {
		if (entry.loopback) continue;
		const port = ports.get(device);
		const medium = mapMedium(port);
		const defaultRoute = device === (route.device ?? route6Device);
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
			// Per device, not per host: a second radio macOS did not describe in the
			// report cannot be scanned, so it is not offered either.
			wifiConfigurable: medium === 'wireless' && namesVisible && airportInterfaceBlock(sources.airport ?? '', device).lines.length > 0,
			gateway,
			// Manually set servers win; otherwise fall back to what the DHCP lease
			// handed out, so a DHCP link reports the resolvers it actually uses.
			dns: pickDns(sources, device),
		};
		if (medium === 'wireless' && airport && wirelessDevices.length === 1 && wirelessDevices[0] === device) {
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

/** Run a tool, returning stdout. Throws when it is missing or exits non-zero. */
async function run(bin: string, args: string[], timeoutMs: number = EXEC_TIMEOUT_MS): Promise<string> {
	const { stdout } = await execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: C_LOCALE_ENV });
	return stdout;
}

/** Same call, but a failure yields an empty string — used for the optional per-service detail. */
async function runOptional(bin: string, args: string[]): Promise<string> {
	try {
		return await run(bin, args);
	} catch {
		return '';
	}
}

const NETWORKSETUP = '/usr/sbin/networksetup';

/** Read the live macOS network state. Throws when the core tools are unavailable, so the caller degrades to addresses only. */
export async function readMacNetworkState(): Promise<NetInterfaceInfo[]> {
	const [hardwarePorts, serviceOrder, ifconfig, route, route6, routes, resolvers] = await Promise.all([run(NETWORKSETUP, ['-listallhardwareports']), run(NETWORKSETUP, ['-listnetworkserviceorder']), run('/sbin/ifconfig', ['-a']), runOptional('/sbin/route', ['-n', 'get', 'default']), runOptional('/sbin/route', ['-n', 'get', '-inet6', 'default']), runOptional('/usr/sbin/netstat', ['-rn', '-f', 'inet']), runOptional('/usr/sbin/scutil', ['--dns'])]);

	const services = parseServiceOrder(serviceOrder);
	const present = parseIfconfig(ifconfig);
	const serviceInfo = new Map<string, string>();
	const serviceDns = new Map<string, string>();
	const dhcpPacket = new Map<string, string>();
	// Only ask about devices that actually exist right now. A Mac carries a service
	// per USB serial gadget it has ever seen, and querying all of them would cost
	// dozens of spawns to describe interfaces that are not there.
	for (const [device, service] of services) {
		if (!present.has(device)) continue;
		const [info, dns, packet] = await Promise.all([runOptional(NETWORKSETUP, ['-getinfo', service]), runOptional(NETWORKSETUP, ['-getdnsservers', service]), runOptional('/usr/sbin/ipconfig', ['getpacket', device])]);
		if (info) serviceInfo.set(device, info);
		if (dns) serviceDns.set(device, dns);
		if (packet) dhcpPacket.set(device, packet);
	}

	const hasWifi = [...parseHardwarePorts(hardwarePorts).values()].some(port => /^Wi-Fi$/i.test(port));
	const airport = hasWifi ? await runOptional('/usr/sbin/system_profiler', ['SPAirPortDataType']) : '';
	return parseMacNetworkState({ hardwarePorts, serviceOrder, ifconfig, route, route6, routes, serviceInfo, serviceDns, dhcpPacket, resolvers, airport });
}

/**
 * True when `networksetup` is present AND this process may actually use it to
 * write.
 *
 * macOS may require root when system-wide preferences are password-protected.
 * Group membership cannot prove that the current non-interactive process may
 * write, so only an effective root process advertises this capability.
 */
export async function isMacWritable(): Promise<boolean> {
	if (!hasMacWritePrivilege(typeof process.getuid === 'function' ? process.getuid() : undefined)) return false;
	try {
		await run(NETWORKSETUP, ['-getcomputername']);
		return true;
	} catch {
		return false;
	}
}

/** Root is the only privilege level that is safe under every macOS policy. */
export function hasMacWritePrivilege(effectiveUID: number | undefined): boolean {
	return effectiveUID === 0;
}

/**
 * Whether this host can offer Wi-Fi at all.
 *
 * Joining does not need Location Services access, but CHOOSING what to join
 * does: without it every name in a scan is `<redacted>`, and `networksetup` is
 * addressed by name, so the picker would list rows that cannot be acted on. The
 * capability therefore follows the names rather than the radio. The answer
 * changes the moment the user grants or revokes the permission in System
 * Settings, so it is a probe and not the constant it used to be; the caller
 * caches it.
 */
export async function isMacWifiConfigurable(): Promise<boolean> {
	const ports = parseHardwarePorts(await runOptional(NETWORKSETUP, ['-listallhardwareports']));
	if (![...ports.values()].some(port => /^Wi-Fi$/i.test(port))) return false;
	return macWifiNamesVisible(await runOptional('/usr/sbin/system_profiler', ['SPAirPortDataType']));
}

/** Scan for the Wi-Fi networks one interface can see. */
export async function scanMacWifi(device: string): Promise<NetWifiNetwork[]> {
	return parseAirportScan(await run('/usr/sbin/system_profiler', ['SPAirPortDataType'], WIFI_SCAN_TIMEOUT_MS), device);
}

/**
 * Build the `networksetup` join.
 *
 * KNOWN WEAKNESS, not a solved problem. The passphrase is the last positional
 * argument, and measured on macOS 15.7.4 an unprivileged local user CAN read
 * another user's full argv — so it is readable by any local account for as long
 * as the call runs. The Windows and Linux paths both keep it out of argv.
 *
 * This is a limit of `networksetup`, which reads nothing from stdin, and NOT of
 * macOS: CoreWLAN's `CWInterface.associate(to:password:)` takes the passphrase
 * directly and would close this hole. Reaching it needs a native helper the
 * bundle does not ship yet, so the exposure stands until that exists rather than
 * being hidden behind a claim that nothing better is possible.
 */
export function macJoinArgs(device: string, ssid: string, password: string): string[] {
	return ['-setairportnetwork', device, ssid, ...(password ? [password] : [])];
}

/**
 * `networksetup` reports a refused join on stdout and still exits 0, so an empty
 * stdout is the only evidence of success it offers.
 */
export function assertMacJoinAccepted(output: string): void {
	const message = output.trim();
	if (message) throw new Error(message);
}

/** The scan is the only proof of association macOS gives us that is not redacted away. */
export function assertMacWifiConnected(networks: NetWifiNetwork[], ssid: string): void {
	if (!networks.some(network => network.active && network.ssid === ssid)) throw new Error('macOS did not connect to the requested Wi-Fi network');
}

/**
 * Join a Wi-Fi network.
 *
 * `-setairportnetwork` returns once the association has settled, but
 * `system_profiler` reports a snapshot that can still be a moment behind it, so
 * the confirming scan is retried rather than believed the first time.
 */
export async function connectMacWifi(device: string, ssid: string, password: string): Promise<void> {
	assertMacJoinAccepted(await run(NETWORKSETUP, macJoinArgs(device, ssid, password), APPLY_TIMEOUT_MS));
	let networks: NetWifiNetwork[] = [];
	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt > 0) await delay(1000);
		networks = await scanMacWifi(device);
		if (networks.some(network => network.active && network.ssid === ssid)) return;
	}
	assertMacWifiConnected(networks, ssid);
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

async function verifyMacIPv4(service: string, config: NetIPv4Config, addressingChanged: boolean, requireLease: boolean): Promise<void> {
	let info = await run(NETWORKSETUP, ['-getinfo', service]);
	if (addressingChanged) {
		const deadline = Date.now() + 20_000;
		while (!macAddressingApplied(config, info, requireLease) && Date.now() < deadline) {
			await delay(200);
			info = await run(NETWORKSETUP, ['-getinfo', service]);
		}
	}
	const dns = config.dns === undefined ? '' : await run(NETWORKSETUP, ['-getdnsservers', service]);
	assertMacIPv4Applied(config, info, dns, addressingChanged, requireLease);
}

/** Resolve the service name a device belongs to. Throws when the device is not part of an enabled service. */
async function serviceForDevice(device: string): Promise<string> {
	const [serviceOrder, routeTable] = await Promise.all([run(NETWORKSETUP, ['-listnetworkserviceorder']), run('/usr/sbin/netstat', ['-rn', '-f', 'inet'])]);
	const service = parseServiceOrder(serviceOrder).get(device);
	if (!service) throw new Error(`no enabled network service uses ${device}`);
	if (parseDefaultRoutes(routeTable).filter(route => route.device === device).length > 1) throw new Error(`multiple default routes use ${device}`);
	return service;
}

/** Apply an IPv4 configuration to one device. Requires root, which is how networksetup guards every write. */
export async function applyMacIPv4(device: string, config: NetIPv4Config, addressingChanged: boolean = true, requireLease: boolean = true): Promise<void> {
	const service = await serviceForDevice(device);
	const [oldInfo, oldDns] = await Promise.all([run(NETWORKSETUP, ['-getinfo', service]), run(NETWORKSETUP, ['-getdnsservers', service])]);
	const oldMode = parseServiceInfo(oldInfo);
	const oldAddress = parseServiceIPv4(oldInfo);
	const oldGateway = parseServiceGateway(oldInfo);
	if (oldMode === 'unknown' || (oldMode === 'static' && (!oldAddress || !oldGateway))) throw new Error('macOS network service configuration cannot be preserved safely');
	const previous: NetIPv4Config = oldMode === 'dhcp' ? { mode: 'dhcp', dns: parseServiceDns(oldDns) } : { mode: 'static', address: oldAddress!.address, prefixLength: oldAddress!.prefixLength, gateway: oldGateway!, dns: parseServiceDns(oldDns) };
	return withMacRollback(
		async () => {
			for (const args of macApplyArgs(service, config, addressingChanged)) await run(NETWORKSETUP, args, APPLY_TIMEOUT_MS);
			await verifyMacIPv4(service, config, addressingChanged, requireLease);
		},
		async () => {
			for (const args of macApplyArgs(service, previous, addressingChanged)) await run(NETWORKSETUP, args, APPLY_TIMEOUT_MS);
			// `networksetup` exiting zero is not the service being back: a restored
			// DHCP service still has to get its lease, and a restored static one still
			// has to hold the address it was handed. An unverified restore is exactly
			// the case that leaves the machine unreachable while the app reports only
			// the original failure.
			await verifyMacIPv4(service, previous, addressingChanged, macRestoreRequiresLease(previous, oldInfo, requireLease));
		}
	);
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
		try {
			await rollback();
		} catch (rollbackError) {
			throw new Error(`network apply failed: ${String(applyError)}; rollback failed: ${String(rollbackError)}`);
		}
		throw applyError;
	}
}
