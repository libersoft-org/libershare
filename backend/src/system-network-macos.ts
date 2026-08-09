import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NetAddress, NetInterfaceInfo, NetIPv4Config, NetLink, NetMedium } from '@shared';

const execFileAsync = promisify(execFile);

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
 * Wi-Fi is READ-ONLY and partially blind, by the operating system's design:
 * since macOS 14 the SSID is withheld from any process that has not been granted
 * Location Services access, and both `ipconfig getsummary` and `system_profiler`
 * return the literal string `<redacted>` instead. Measured on macOS 15.7.4 even
 * when running as root. A scan is therefore a list of unnamed networks, which
 * cannot be offered as something to join — so {@link isMacWifiConfigurable} is
 * false and the UI does not show Wi-Fi actions on this platform. The signal
 * strength, security and connection state are NOT redacted and are reported.
 */

/** Hard cap on any single tool invocation. These are local BSD utilities; a slow one is a hung one. */
const EXEC_TIMEOUT_MS = 5000;
/** Reconfiguring a service renegotiates DHCP, which is far slower than a read. */
const APPLY_TIMEOUT_MS = 45000;
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
	/** Per-service `networksetup -getinfo <service>`, keyed by DEVICE. */
	serviceInfo?: Map<string, string>;
	/** Per-service `networksetup -getdnsservers <service>`, keyed by DEVICE. */
	serviceDns?: Map<string, string>;
	/** Per-device `ipconfig getpacket <device>`, keyed by DEVICE. Supplies the DHCP-handed resolvers. */
	dhcpPacket?: Map<string, string>;
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
export function parseServiceOrder(text: string): Map<string, string> {
	const result = new Map<string, string>();
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const header = lines[i]?.match(/^\(\s*(\*?)\d+\)\s*(.+?)\s*$/);
		if (!header) continue;
		if (header[1] === '*') continue;
		const device = lines[i + 1]?.match(/Device:\s*(\S+?)\s*\)/);
		if (device && device[1] && header[2] && !result.has(device[1])) result.set(device[1], header[2]);
	}
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
	if (/^\s*(DHCP|BOOTP) Configuration/m.test(text)) return 'dhcp';
	return 'unknown';
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
		.filter(line => /^\d+\.\d+\.\d+\.\d+$/.test(line) || /^[0-9a-f:]+$/i.test(line));
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
		.filter(server => /^\d+\.\d+\.\d+\.\d+$/.test(server) || /^[0-9a-f:]+$/i.test(server));
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

/** Resolvers for one device: the user's own choice first, the DHCP lease second. */
function pickDns(sources: MacNetworkSources, device: string): string[] {
	const manual = sources.serviceDns?.has(device) ? parseServiceDns(sources.serviceDns.get(device) as string) : [];
	if (manual.length > 0) return manual;
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
	const services = parseServiceOrder(sources.serviceOrder);
	const interfaces = parseIfconfig(sources.ifconfig);
	const route = parseDefaultRoute(sources.route);
	const airport = sources.airport ? parseAirport(sources.airport) : null;

	const result: NetInterfaceInfo[] = [];
	for (const [device, entry] of interfaces) {
		if (entry.loopback) continue;
		const port = ports.get(device);
		const medium = mapMedium(port);
		const defaultRoute = device === route.device;
		const info: NetInterfaceInfo = {
			id: device,
			// The service name is what the user sees in System Settings, so it is the
			// better label; the device name is the fallback for anything unmanaged.
			name: services.get(device) ?? port ?? device,
			medium,
			link: mapLink(entry.status),
			defaultRoute,
			mac: entry.mac,
			addresses: entry.addresses,
			ipv4Mode: sources.serviceInfo?.has(device) ? parseServiceInfo(sources.serviceInfo.get(device) as string) : 'unknown',
			gateway: defaultRoute ? route.gateway : null,
			// Manually set servers win; otherwise fall back to what the DHCP lease
			// handed out, so a DHCP link reports the resolvers it actually uses.
			dns: pickDns(sources, device),
		};
		if (medium === 'wireless' && airport) {
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
	const { stdout } = await execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
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
	const [hardwarePorts, serviceOrder, ifconfig, route] = await Promise.all([run(NETWORKSETUP, ['-listallhardwareports']), run(NETWORKSETUP, ['-listnetworkserviceorder']), run('/sbin/ifconfig', ['-a']), runOptional('/sbin/route', ['-n', 'get', 'default'])]);

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
	return parseMacNetworkState({ hardwarePorts, serviceOrder, ifconfig, route, serviceInfo, serviceDns, dhcpPacket, airport });
}

/** True when `networksetup` is present, which is the only supported way to persist a change. */
export async function isMacWritable(): Promise<boolean> {
	try {
		await run(NETWORKSETUP, ['-getcomputername']);
		return true;
	} catch {
		return false;
	}
}

/**
 * Wi-Fi configuration is not offered on macOS.
 *
 * Joining needs a network name, and macOS withholds every name from a process
 * without Location Services access — a scan comes back as a list of `<redacted>`
 * entries. Rather than ship a picker that cannot name anything, the capability is
 * reported as false. This is a constant, not a probe: the answer cannot change
 * without the user granting the permission to this binary in System Settings.
 */
export function isMacWifiConfigurable(): boolean {
	return false;
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
export function macApplyArgs(service: string, config: NetIPv4Config): string[][] {
	const dns = config.dns ?? [];
	const dnsArgs = ['-setdnsservers', service, ...(dns.length > 0 ? dns : ['Empty'])];
	if (config.mode === 'dhcp') return [['-setdhcp', service], dnsArgs];
	const address = ['-setmanual', service, config.address as string, netmaskFromPrefix(config.prefixLength as number)];
	// An interface on an isolated segment has no gateway, and networksetup takes
	// the router as an optional trailing argument rather than an empty string.
	if (config.gateway) address.push(config.gateway);
	return [address, dnsArgs];
}

/** Resolve the service name a device belongs to. Throws when the device is not part of an enabled service. */
async function serviceForDevice(device: string): Promise<string> {
	const service = parseServiceOrder(await run(NETWORKSETUP, ['-listnetworkserviceorder'])).get(device);
	if (!service) throw new Error(`no enabled network service uses ${device}`);
	return service;
}

/** Apply an IPv4 configuration to one device. Requires root, which is how networksetup guards every write. */
export async function applyMacIPv4(device: string, config: NetIPv4Config): Promise<void> {
	const service = await serviceForDevice(device);
	for (const args of macApplyArgs(service, config)) await run(NETWORKSETUP, args, APPLY_TIMEOUT_MS);
}
