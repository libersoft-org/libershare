import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { isIPv4, isIPv6, type NetAddress, type NetInterfaceInfo, type NetIPv4Config, type NetLink, type NetMedium } from '@shared';

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
	/** `netstat -rn -f inet`, used to detect every IPv4 default route. */
	routes?: string;
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
		.filter(line => isIPv4(line) || isIPv6(line));
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
		.filter(server => isIPv4(server) || isIPv6(server));
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
	const serviceBindings = parseServiceBindings(sources.serviceOrder);
	const services = parseServiceOrder(sources.serviceOrder);
	const interfaces = parseIfconfig(sources.ifconfig);
	const route = parseDefaultRoute(sources.route);
	const routeDetailKnown = sources.routes === undefined || sources.routes.trim() !== '';
	const routes = sources.routes === undefined ? (route.device && route.gateway ? [{ device: route.device, gateway: route.gateway }] : []) : parseDefaultRoutes(sources.routes);
	const airport = sources.airport ? parseAirport(sources.airport) : null;
	const wirelessDevices = [...ports].filter(([, port]) => mapMedium(port) === 'wireless').map(([device]) => device);

	const result: NetInterfaceInfo[] = [];
	for (const [device, entry] of interfaces) {
		if (entry.loopback) continue;
		const port = ports.get(device);
		const medium = mapMedium(port);
		const defaultRoute = device === route.device;
		const deviceRoutes = routes.filter(entry => entry.device === device);
		const serviceInfo = sources.serviceInfo?.get(device) ?? '';
		const ipv4Mode = serviceInfo ? parseServiceInfo(serviceInfo) : 'unknown';
		const liveIPv4Addresses = entry.addresses.filter(address => address.family === 'ipv4');
		const storedIPv4 = liveIPv4Addresses.length === 0 ? parseServiceIPv4(serviceInfo) : null;
		const addresses = storedIPv4 ? [...entry.addresses, storedIPv4] : entry.addresses;
		const ipv4Addresses = addresses.filter(address => address.family === 'ipv4');
		const serviceGateway = parseServiceGateway(serviceInfo);
		const gateway = serviceGateway ?? (defaultRoute ? route.gateway : null);
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
			ipv4Configurable: routeDetailKnown && services.has(device) && ipv4Mode !== 'unknown' && (ipv4Mode !== 'static' || serviceGateway !== null) && ipv4Addresses.length <= 1 && deviceRoutes.length <= 1,
			wifiConfigurable: false,
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
	const [hardwarePorts, serviceOrder, ifconfig, route, routes] = await Promise.all([run(NETWORKSETUP, ['-listallhardwareports']), run(NETWORKSETUP, ['-listnetworkserviceorder']), run('/sbin/ifconfig', ['-a']), runOptional('/sbin/route', ['-n', 'get', 'default']), runOptional('/usr/sbin/netstat', ['-rn', '-f', 'inet'])]);

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
	return parseMacNetworkState({ hardwarePorts, serviceOrder, ifconfig, route, routes, serviceInfo, serviceDns, dhcpPacket, airport });
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

function macAddressingApplied(config: NetIPv4Config, info: string): boolean {
	if (parseServiceInfo(info) !== config.mode) return false;
	const current = parseServiceCurrentIPv4(info);
	if (config.mode === 'dhcp') return !!current && current.address !== '0.0.0.0' && !current.address.startsWith('169.254.');
	return !!current && current.address === config.address && current.prefixLength === config.prefixLength && parseServiceGateway(info) === (config.gateway || null);
}

export function assertMacIPv4Applied(config: NetIPv4Config, info: string, dnsText: string, addressingChanged: boolean): void {
	if (addressingChanged && !macAddressingApplied(config, info)) throw new Error(config.mode === 'dhcp' ? 'macOS did not obtain a usable DHCP lease' : 'macOS did not apply the requested IPv4 configuration');
	if (config.dns !== undefined && !sameAddressSet(parseServiceDns(dnsText), config.dns)) throw new Error('macOS did not apply the requested DNS policy');
}

async function verifyMacIPv4(service: string, config: NetIPv4Config, addressingChanged: boolean): Promise<void> {
	let info = await run(NETWORKSETUP, ['-getinfo', service]);
	if (addressingChanged) {
		const deadline = Date.now() + 20_000;
		while (!macAddressingApplied(config, info) && Date.now() < deadline) {
			await delay(200);
			info = await run(NETWORKSETUP, ['-getinfo', service]);
		}
	}
	const dns = config.dns === undefined ? '' : await run(NETWORKSETUP, ['-getdnsservers', service]);
	assertMacIPv4Applied(config, info, dns, addressingChanged);
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
export async function applyMacIPv4(device: string, config: NetIPv4Config, addressingChanged: boolean = true): Promise<void> {
	const service = await serviceForDevice(device);
	const [oldInfo, oldDns] = await Promise.all([run(NETWORKSETUP, ['-getinfo', service]), run(NETWORKSETUP, ['-getdnsservers', service])]);
	const oldMode = parseServiceInfo(oldInfo);
	const oldAddress = parseServiceIPv4(oldInfo);
	const oldGateway = parseServiceGateway(oldInfo);
	if (oldMode === 'unknown' || (oldMode === 'static' && (!oldAddress || !oldGateway))) throw new Error('macOS network service configuration cannot be preserved safely');
	const previous: NetIPv4Config = oldMode === 'dhcp' ? { mode: 'dhcp', dns: parseServiceDns(oldDns) } : { mode: 'static', address: oldAddress!.address, prefixLength: oldAddress!.prefixLength, gateway: oldGateway!, dns: parseServiceDns(oldDns) };
	try {
		for (const args of macApplyArgs(service, config, addressingChanged)) await run(NETWORKSETUP, args, APPLY_TIMEOUT_MS);
		await verifyMacIPv4(service, config, addressingChanged);
	} catch (applyError) {
		try {
			for (const args of macApplyArgs(service, previous, addressingChanged)) await run(NETWORKSETUP, args, APPLY_TIMEOUT_MS);
		} catch (rollbackError) {
			throw new Error(`network apply failed: ${String(applyError)}; rollback failed: ${String(rollbackError)}`);
		}
		throw applyError;
	}
}
