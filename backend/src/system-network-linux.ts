import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { NetAddress, NetInterfaceInfo, NetIPv4Config, NetLink, NetWifiInfo, NetWifiNetwork } from '@shared';

const execFileAsync = promisify(execFile);

/**
 * Linux host network state, read entirely through `ip -j` (iproute2's JSON
 * output) plus two sysfs/procfs reads.
 *
 * `ip` is used for READING rather than a stack-specific tool because it reports
 * the kernel's actual state — the same answer whether the box is driven by
 * ifupdown, systemd-networkd, NetworkManager or netplan.
 *
 * WRITING is the opposite: it has to go through the stack that owns the device,
 * so the apply half of this module speaks nmcli and refuses to act on a host
 * NetworkManager does not run. See {@link isLinuxWritable}.
 */

/** Hard cap on how long any `ip`/`iw` child process may run before we give up. */
const EXEC_TIMEOUT_MS = 5000;
/** `ip` lives in sbin, which is not on a service account's PATH on every distro. */
const IP_CANDIDATES = ['/usr/sbin/ip', '/sbin/ip', 'ip'];
const IW_CANDIDATES = ['/usr/sbin/iw', '/sbin/iw', 'iw'];
/** IFA_F_PERMANENT lifetime sentinel — a manually configured address never expires. */
const LIFETIME_PERMANENT = 4294967295;

/** One `ip -j addr` entry (only the fields this module reads). */
interface IpAddrEntry {
	ifname: string;
	operstate?: string;
	flags?: string[];
	address?: string;
	addr_info?: Array<{ family: string; local: string; prefixlen: number; scope?: string; dynamic?: boolean; valid_life_time?: number }>;
}
/** One `ip -j -d link` entry. `linkinfo.info_kind` is present only for virtual devices. */
interface IpLinkEntry {
	ifname: string;
	operstate?: string;
	flags?: string[];
	address?: string;
	link_type?: string;
	linkinfo?: { info_kind?: string };
}
/** One `ip -j route show default` entry. */
interface IpRouteEntry {
	dev?: string;
	gateway?: string;
	metric?: number;
}

/** The three `ip` documents a Linux read is built from. */
export interface LinuxNetworkSources {
	addr: string;
	link: string;
	route: string;
	/** Interface names the kernel reports as wireless (a `phy80211` symlink in sysfs). */
	wireless?: Set<string>;
	/** Per-interface `iw dev <if> link` output, when `iw` is installed. */
	iwLinks?: Map<string, string>;
	/** Resolver addresses from /etc/resolv.conf. Attributed to the default-route interface only. */
	resolvers?: string[];
	/** Per-interface resolvers as NetworkManager sees them. Preferred over {@link resolvers} when present. */
	nmDns?: Map<string, string[]> | undefined;
}

/**
 * Convert a raw signal level in dBm to a 0-100 quality percentage.
 *
 * ponytail: the linear -100 dBm → 0 %, -50 dBm → 100 % mapping, which is the
 * convention Windows' `wlanSignalQuality` documents and what `wavemon` and
 * NetworkManager use. It is a convention, not physics — upgrade to a per-band
 * curve only if the bars ever read visibly wrong on real hardware.
 */
export function dbmToQuality(dbm: number): number {
	return Math.min(100, Math.max(0, Math.round(2 * (dbm + 100))));
}

/**
 * Parse `iw dev <if> link` output.
 *
 * Two forms exist: `Not connected.` for an idle adapter, and a `Connected to
 * <bssid>` block with indented `SSID:` / `signal:` lines. A connected adapter
 * whose driver does not report a signal level yields `signal: null` rather than
 * a guessed number.
 *
 * ponytail: the expected shapes are documented, not captured — the Linux node
 * available for this work has no wireless hardware. Both the "not connected"
 * and "no signal line" branches degrade to nulls, so a shape mismatch surfaces
 * as "signal unknown" in the UI, never as a wrong percentage.
 */
export function parseIwLink(text: string): { ssid: string | null; signal: number | null } {
	if (/^\s*Not connected\.?\s*$/m.test(text)) return { ssid: null, signal: null };
	const ssidMatch = text.match(/^\s*SSID:\s*(.+?)\s*$/m);
	const signalMatch = text.match(/^\s*signal:\s*(-?\d+(?:\.\d+)?)\s*dBm/m);
	return {
		ssid: ssidMatch?.[1] ?? null,
		signal: signalMatch?.[1] ? dbmToQuality(parseFloat(signalMatch[1])) : null,
	};
}

/** Map an `ip` entry's operstate/flags to a carrier state. NO-CARRIER wins over an administratively UP flag. */
function mapLink(entry: { operstate?: string; flags?: string[] }): NetLink {
	if (entry.flags?.includes('NO-CARRIER')) return 'down';
	if (entry.operstate === 'UP') return 'up';
	if (entry.operstate === 'DOWN') return 'down';
	return 'unknown';
}

/**
 * Decide the medium of a Linux interface from kernel evidence only.
 *
 * `linkinfo.info_kind` is emitted by `ip -d link` exclusively for software
 * devices (bridge, veth, tun, vlan, wireguard) — a real NIC has no such key. So
 * "ethernet link type, no info_kind, not loopback" is the only combination we
 * call `wired`; everything else is honestly `other`, including a container's
 * veth uplink, which really is not a cable.
 */
function mapMedium(wireless: boolean, link: IpLinkEntry | undefined): NetInterfaceInfo['medium'] {
	if (wireless) return 'wireless';
	if (link?.linkinfo?.info_kind) return 'other';
	return link?.link_type === 'ether' ? 'wired' : 'other';
}

/**
 * Build the interface list from the three `ip` documents.
 *
 * IPv4 addressing mode comes from the kernel's own `dynamic` flag: a DHCP lease
 * carries `dynamic: true`, a manually configured address has no `dynamic` key
 * and the permanent lifetime sentinel. IPv6 `dynamic` is deliberately ignored —
 * SLAAC also sets it and SLAAC is not DHCP.
 *
 * Nothing is filtered out here: a container's `eth0` has `info_kind: veth` yet
 * carries the default route, so link kind is not a safe exclusion criterion.
 */
export function parseLinuxNetworkState(sources: LinuxNetworkSources): NetInterfaceInfo[] {
	const addrEntries = JSON.parse(sources.addr) as IpAddrEntry[];
	const linkEntries = JSON.parse(sources.link) as IpLinkEntry[];
	const routeEntries = JSON.parse(sources.route) as IpRouteEntry[];

	const linkByName = new Map<string, IpLinkEntry>();
	for (const entry of linkEntries) linkByName.set(entry.ifname, entry);

	// Lowest-metric default route wins; an absent metric means 0 (kernel default).
	let best: IpRouteEntry | null = null;
	for (const route of routeEntries) {
		if (!route.dev) continue;
		if (!best || (route.metric ?? 0) < (best.metric ?? 0)) best = route;
	}
	const defaultDev = best?.dev ?? null;

	const result: NetInterfaceInfo[] = [];
	for (const entry of addrEntries) {
		// Loopback is never a choice a user makes and never a connection to report.
		if (entry.ifname === 'lo') continue;
		const addresses: NetAddress[] = [];
		let ipv4Mode: NetInterfaceInfo['ipv4Mode'] = 'unknown';
		for (const info of entry.addr_info ?? []) {
			const family = info.family === 'inet' ? 'ipv4' : info.family === 'inet6' ? 'ipv6' : null;
			if (!family) continue;
			addresses.push({ family, address: info.local, prefixLength: info.prefixlen });
			if (family !== 'ipv4') continue;
			if (info.dynamic === true) ipv4Mode = 'dhcp';
			else if (ipv4Mode === 'unknown' && info.valid_life_time === LIFETIME_PERMANENT) ipv4Mode = 'static';
		}
		const link = linkByName.get(entry.ifname);
		const wireless = sources.wireless?.has(entry.ifname) ?? false;
		const info: NetInterfaceInfo = {
			id: entry.ifname,
			name: entry.ifname,
			medium: mapMedium(wireless, link),
			link: mapLink(link ?? entry),
			defaultRoute: entry.ifname === defaultDev,
			mac: entry.address ?? link?.address ?? null,
			addresses,
			ipv4Mode,
			gateway: entry.ifname === defaultDev ? (best?.gateway ?? null) : null,
			// NetworkManager knows the resolvers PER LINK, which is the only correct
			// answer on a systemd-resolved host: there /etc/resolv.conf holds the
			// 127.0.0.53 stub, so reporting it would show every machine the same
			// fictional nameserver — and would contradict the servers the user had
			// just set. Only when NM is absent do we fall back to resolv.conf, which
			// is system-wide and so is attributed to the default-route interface.
			dns: sources.nmDns?.get(entry.ifname) ?? (entry.ifname === defaultDev ? (sources.resolvers ?? []) : []),
		};
		if (wireless) {
			const iw = sources.iwLinks?.get(entry.ifname);
			const parsed: NetWifiInfo = iw ? { ...parseIwLink(iw), radio: 'unknown' } : { ssid: null, signal: null, radio: 'unknown' };
			info.wifi = parsed;
		}
		result.push(info);
	}
	return result;
}

/** Run the first candidate binary that exists, returning stdout. Throws when every candidate is missing or exits non-zero. */
async function runFirst(candidates: string[], args: string[], timeoutMs: number = EXEC_TIMEOUT_MS): Promise<string> {
	let lastError: unknown = new Error(`no candidate found for ${args.join(' ')}`);
	for (const bin of candidates) {
		try {
			const { stdout } = await execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
			return stdout;
		} catch (err) {
			lastError = err;
			// ENOENT means this path does not exist — try the next candidate. Any
			// other failure (non-zero exit, timeout) is the real answer: `ip` ran and
			// said no, so a further candidate would only repeat it.
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		}
	}
	throw lastError;
}

/** True when the kernel exposes an 802.11 phy for this interface — no userspace tool required. */
function isWireless(ifname: string): boolean {
	return existsSync(`/sys/class/net/${ifname}/phy80211`);
}

/** Nameserver addresses from /etc/resolv.conf. Empty when the file is missing or has none. */
function readResolvers(): string[] {
	try {
		return readFileSync('/etc/resolv.conf', 'utf8')
			.split('\n')
			.map(line => line.match(/^\s*nameserver\s+(\S+)/)?.[1])
			.filter((v): v is string => !!v);
	} catch {
		return [];
	}
}

/** Read the live Linux network state. Throws when `ip` is absent or fails — the caller degrades to the address-only reader. */
export async function readLinuxNetworkState(): Promise<NetInterfaceInfo[]> {
	const [addr, link, route] = await Promise.all([runFirst(IP_CANDIDATES, ['-j', 'addr']), runFirst(IP_CANDIDATES, ['-j', '-d', 'link']), runFirst(IP_CANDIDATES, ['-j', 'route', 'show', 'default'])]);
	const names = (JSON.parse(addr) as IpAddrEntry[]).map(e => e.ifname);
	const wireless = new Set(names.filter(isWireless));
	const iwLinks = new Map<string, string>();
	for (const name of wireless) {
		try {
			iwLinks.set(name, await runFirst(IW_CANDIDATES, ['dev', name, 'link']));
		} catch {
			// `iw` is not installed (or refused) — the SSID and signal stay null
			// rather than being guessed from anything else.
		}
	}
	return parseLinuxNetworkState({ addr, link, route, wireless, iwLinks, resolvers: readResolvers(), nmDns: await readNetworkManagerDns() });
}

/**
 * Writing configuration, unlike reading it, must go through the stack that owns
 * the device — an `ip addr add` would be silently reverted by whatever daemon is
 * in charge. NetworkManager is the only stack supported here: it drives every
 * desktop distribution the app targets, and it is the only one that persists a
 * change and reapplies it after a reboot through a single command.
 *
 * A host running systemd-networkd, ifupdown or netplan reports `ipv4: false` and
 * the UI keeps the read-only view rather than offering an edit that would not stick.
 */
const NMCLI_CANDIDATES = ['/usr/bin/nmcli', '/bin/nmcli', 'nmcli'];
/** Reconfiguring an interface renegotiates DHCP and can rebuild routes, which is far slower than a read. */
const APPLY_TIMEOUT_MS = 45000;
/** A rescan has to wait for the radio to sweep every channel. */
const WIFI_SCAN_TIMEOUT_MS = 30000;

/**
 * Split one `nmcli -t` output line into fields.
 *
 * Terse mode separates with `:` and backslash-escapes any `:` or backslash inside
 * a value, so a naive `split(':')` tears apart every SSID containing a colon and
 * every IPv6 address. Values are unescaped as they are split.
 */
export function splitNmcliFields(line: string): string[] {
	const fields: string[] = [];
	let current = '';
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '\\' && i + 1 < line.length) {
			current += line[++i];
			continue;
		}
		if (char === ':') {
			fields.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	fields.push(current);
	return fields;
}

/** True when NetworkManager is installed and running, so configuration can actually be written. */
export async function isLinuxWritable(): Promise<boolean> {
	try {
		return (await runFirst(NMCLI_CANDIDATES, ['-t', '-f', 'RUNNING', 'general'])).trim().startsWith('running');
	} catch {
		return false;
	}
}

/**
 * Per-interface resolvers from `nmcli -t -f GENERAL.DEVICE,IP4.DNS device show`.
 *
 * Returns undefined — not an empty map — when NetworkManager is absent or fails,
 * so the caller can tell "NM says this link has no resolvers" apart from "there
 * is no NM to ask" and fall back to /etc/resolv.conf only in the latter case.
 */
async function readNetworkManagerDns(): Promise<Map<string, string[]> | undefined> {
	try {
		return parseNmcliDns(await runFirst(NMCLI_CANDIDATES, ['-t', '-f', 'GENERAL.DEVICE,IP4.DNS', 'device', 'show']));
	} catch {
		return undefined;
	}
}

/**
 * Parse the per-device blocks of `nmcli -t -f GENERAL.DEVICE,IP4.DNS device show`.
 *
 * Output is one blank-line-separated block per device: a `GENERAL.DEVICE` line
 * followed by zero or more `IP4.DNS[n]` lines. A device with no resolvers still
 * gets an entry (an empty array), which is what lets the caller distinguish it
 * from a device NetworkManager does not manage at all.
 */
export function parseNmcliDns(text: string): Map<string, string[]> {
	const result = new Map<string, string[]>();
	let device: string | null = null;
	for (const line of text.split('\n')) {
		const fields = splitNmcliFields(line.trim());
		const key = fields[0];
		if (!key) continue;
		if (key === 'GENERAL.DEVICE') {
			device = fields[1] ?? null;
			if (device) result.set(device, []);
		} else if (device && key.startsWith('IP4.DNS')) {
			if (fields[1]) result.get(device)?.push(fields[1]);
		}
	}
	return result;
}

/**
 * Name of the NetworkManager profile currently active on a device.
 *
 * Modifying the active profile (rather than creating a new one) is what makes an
 * edit idempotent: applying twice leaves one profile, not two competing ones.
 */
async function activeConnection(device: string): Promise<string | null> {
	const out = await runFirst(NMCLI_CANDIDATES, ['-t', '-f', 'NAME,DEVICE', 'connection', 'show', '--active']);
	for (const line of out.split('\n')) {
		if (!line.trim()) continue;
		const fields = splitNmcliFields(line);
		if (fields[1] === device) return fields[0] ?? null;
	}
	return null;
}

/**
 * Build the `nmcli connection modify` arguments for a desired IPv4 config.
 *
 * Switching to DHCP clears the manual fields explicitly: NetworkManager keeps a
 * stale `ipv4.addresses` on a profile whose method changed, and that address
 * comes back the moment the user switches to static again.
 */
export function nmcliModifyArgs(connection: string, config: NetIPv4Config): string[] {
	const base = ['connection', 'modify', connection];
	if (config.mode === 'dhcp') return [...base, 'ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '', 'ipv4.dns', '', 'ipv4.ignore-auto-dns', 'no'];
	const dns = config.dns ?? [];
	return [
		...base,
		'ipv4.method',
		'manual',
		'ipv4.addresses',
		`${config.address}/${config.prefixLength}`,
		'ipv4.gateway',
		config.gateway ?? '',
		'ipv4.dns',
		dns.join(','),
		// Without this a static profile still merges resolvers handed out by any
		// other active connection, so the user's DNS choice silently does nothing.
		'ipv4.ignore-auto-dns',
		dns.length > 0 ? 'yes' : 'no',
	];
}

/** Apply an IPv4 configuration to one device and bring the profile back up. Throws when NetworkManager does not own the device. */
export async function applyLinuxIPv4(device: string, config: NetIPv4Config): Promise<void> {
	const connection = await activeConnection(device);
	if (!connection) throw new Error(`no NetworkManager profile is active on ${device}`);
	await runFirst(NMCLI_CANDIDATES, nmcliModifyArgs(connection, config), APPLY_TIMEOUT_MS);
	// `connection up` re-applies the edited profile in place. The device drops for
	// a moment either way — that is inherent to changing an address, not to this.
	await runFirst(NMCLI_CANDIDATES, ['connection', 'up', connection], APPLY_TIMEOUT_MS);
}

/**
 * Parse `nmcli -t -f SSID,SIGNAL,SECURITY,IN-USE device wifi list`.
 *
 * Hidden networks report an empty SSID and are dropped: they cannot be joined by
 * name, so offering an unnamed row would be offering something that fails.
 * Duplicates (one row per access point for a roaming network) collapse to the strongest.
 */
export function parseNmcliWifiList(text: string): NetWifiNetwork[] {
	const best = new Map<string, NetWifiNetwork>();
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		const [ssid, signal, security, inUse] = splitNmcliFields(line);
		if (!ssid) continue;
		const parsed = signal ? parseInt(signal, 10) : NaN;
		const entry: NetWifiNetwork = {
			ssid,
			signal: Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : null,
			// nmcli leaves SECURITY empty for an open network and prints the key
			// management (WPA2, WPA3, WEP, 802.1X) otherwise.
			secured: !!security?.trim(),
			active: inUse?.trim() === '*',
		};
		const previous = best.get(ssid);
		if (!previous || (entry.signal ?? -1) > (previous.signal ?? -1)) best.set(ssid, previous ? { ...entry, active: previous.active || entry.active } : entry);
	}
	return [...best.values()].sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1));
}

/** Scan for Wi-Fi networks reachable from one device. */
export async function scanLinuxWifi(device: string): Promise<NetWifiNetwork[]> {
	return parseNmcliWifiList(await runFirst(NMCLI_CANDIDATES, ['-t', '-f', 'SSID,SIGNAL,SECURITY,IN-USE', 'device', 'wifi', 'list', 'ifname', device, '--rescan', 'yes'], WIFI_SCAN_TIMEOUT_MS));
}

/**
 * Join a Wi-Fi network.
 *
 * `device wifi connect` reuses a saved profile when one exists and creates one
 * otherwise, so the same call covers both "reconnect to a known network" and
 * "join a new one with a password". The password is passed as a separate argv
 * entry — never interpolated into a command line — so no quoting rule applies to it.
 */
export async function connectLinuxWifi(device: string, ssid: string, password: string): Promise<void> {
	const args = ['device', 'wifi', 'connect', ssid, 'ifname', device];
	if (password) args.push('password', password);
	await runFirst(NMCLI_CANDIDATES, args, APPLY_TIMEOUT_MS);
}
