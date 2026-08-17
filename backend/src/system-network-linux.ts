import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { NetAddress, NetAddressMode, NetInterfaceInfo, NetIPv4Config, NetLink, NetWifiInfo, NetWifiNetwork } from '@shared';

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
	/** Signal quality per interface from `/proc/net/wireless`. Used when `iw` reported none. */
	procSignals?: Map<string, number>;
	/** Resolver addresses from /etc/resolv.conf. Attributed to the default-route interface only. */
	resolvers?: string[];
	/** Per-interface resolvers as NetworkManager sees them. Preferred over {@link resolvers} when present. */
	nmDns?: Map<string, string[]> | undefined;
	/**
	 * Devices NetworkManager owns. Undefined when it could not be asked, in which
	 * case no interface is marked unconfigurable — an unavailable answer is not
	 * evidence that a device is unmanaged.
	 */
	managed?: Set<string> | undefined;
	/**
	 * `ipv4.method` of the profile active on each device, as NetworkManager stores
	 * it. Authoritative over anything inferred from the kernel's addresses; absent
	 * for a device with no active profile, where the kernel is all there is.
	 */
	ipv4Methods?: Map<string, NetAddressMode> | undefined;
	/**
	 * Devices that currently have an active NetworkManager profile. The apply path
	 * edits that profile, so a device without one cannot be configured however
	 * thoroughly NetworkManager manages it.
	 */
	activeProfiles?: Set<string> | undefined;
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
 * a guessed number — and {@link parseProcNetWireless} then backfills it.
 *
 * The connected shape is captured from a real associated adapter (brcmfmac on
 * Debian 12/arm64), where this and `/proc/net/wireless` reported the same level
 * at the same moment. The "not connected" branch is still shape-only, but it
 * degrades to nulls, so a mismatch surfaces as "signal unknown" in the UI rather
 * than as a wrong percentage.
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

/**
 * Signal levels from `/proc/net/wireless`, keyed by interface.
 *
 * The kernel writes this file whenever a wireless driver is loaded, so it needs
 * no userspace tool at all — which is why it is the fallback for a host that does
 * not ship `iw`. The columns are `status link level noise`; only `level` is used,
 * and only when it is negative, because that is the form drivers report in dBm.
 * A positive level is a driver-relative unit with no documented scale, and
 * turning that into a percentage would be inventing a number.
 */
export function parseProcNetWireless(text: string): Map<string, number> {
	const result = new Map<string, number>();
	for (const line of text.split('\n')) {
		const match = line.match(/^\s*([a-zA-Z0-9._-]+):\s*[0-9a-f]+\s+(-?\d+)\.?\s+(-?\d+)\.?/);
		if (!match || !match[1] || !match[3]) continue;
		const level = parseInt(match[3], 10);
		if (level < 0) result.set(match[1], dbmToQuality(level));
	}
	return result;
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
 * IPv4 addressing mode comes from the active NetworkManager profile's
 * `ipv4.method`, because that is the setting the editor changes and the one that
 * survives a reboot. The kernel's own `dynamic` flag is only the fallback for a
 * device with no active profile: it describes the address currently ON the
 * interface, which is not the same question. A DHCP profile with a manual
 * secondary address, a lease that has momentarily lapsed, or an address another
 * process added all read as static from the kernel — and saving then switched the
 * profile to a mode the user had not chosen. Where the kernel is all there is, a
 * DHCP lease carries `dynamic: true` and a manual address has no `dynamic` key
 * and the permanent lifetime sentinel; IPv6 `dynamic` is deliberately ignored,
 * because SLAAC also sets it and SLAAC is not DHCP.
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
	// Kept per device as well: only one interface carries the host's default route,
	// but a multi-homed host gives several of them a gateway of their own. Reporting
	// those as null would seed the edit form with an empty gateway field, and saving
	// any other change on that interface would then clear the gateway it really has.
	let best: IpRouteEntry | null = null;
	const bestByDev = new Map<string, IpRouteEntry>();
	for (const route of routeEntries) {
		if (!route.dev) continue;
		if (!best || (route.metric ?? 0) < (best.metric ?? 0)) best = route;
		const previous = bestByDev.get(route.dev);
		if (!previous || (route.metric ?? 0) < (previous.metric ?? 0)) bestByDev.set(route.dev, route);
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
		const managed = sources.managed?.has(entry.ifname) ?? false;
		const info: NetInterfaceInfo = {
			id: entry.ifname,
			name: entry.ifname,
			medium: mapMedium(wireless, link),
			link: mapLink(link ?? entry),
			defaultRoute: entry.ifname === defaultDev,
			mac: entry.address ?? link?.address ?? null,
			addresses,
			ipv4Mode: sources.ipv4Methods?.get(entry.ifname) ?? ipv4Mode,
			gateway: bestByDev.get(entry.ifname)?.gateway ?? null,
			// Always stated, never left absent. NetworkManager is the only stack the
			// apply path can drive, so a device it does not own cannot be edited — and
			// when it could not be asked at all, the honest answer is still "no": an
			// unknown permission is not a permission, and `isLinuxWritable()` has
			// already reported the host read-only in that case anyway.
			//
			// Being managed is necessary but not sufficient FOR ADDRESSING.
			// `applyLinuxIPv4` edits the profile ACTIVE on the device, so a managed
			// device that is disconnected or unavailable — which "managed" happily
			// includes — has nothing to edit, and offering Configure there showed a
			// working Save that failed every time with "no NetworkManager profile is
			// active". Both conditions, or neither.
			ipv4Configurable: managed && (sources.activeProfiles?.has(entry.ifname) ?? false),
			// Wi-Fi asks nothing of the active profile, and requiring one was a
			// regression: a disconnected adapter has no active profile and is precisely
			// the one a user needs to scan and join with. `nmcli device wifi list`
			// drives the radio, and `nmcli device wifi connect` finds or CREATES a
			// profile for a managed device — so managed is the whole condition.
			wifiScannable: managed && wireless,
			wifiConnectable: managed && wireless,
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
			// `iw` gives both the name and the level, but it is not installed
			// everywhere; the kernel's own file always is, so it backfills the level
			// on a host that has no `iw`. The SSID has no such fallback and stays null.
			if (parsed.signal === null) parsed.signal = sources.procSignals?.get(entry.ifname) ?? null;
			info.wifi = parsed;
		}
		result.push(info);
	}
	return result;
}

/**
 * The environment every child process in this module runs under.
 *
 * The C locale is not a preference, it is what makes the parsing correct. This
 * module matches literal English tokens — `running` from `nmcli general`,
 * `unmanaged` from `nmcli device status`, `Not connected.` from `iw` — and
 * nmcli's own documentation recommends the C locale for machine parsing
 * precisely because those strings are translated otherwise. On a localised host
 * the effect is not a parse error but a wrong answer: `isLinuxWritable()`
 * returns false on a perfectly writable machine, and a device NetworkManager
 * refuses to touch is offered to the user as configurable.
 */
export function cLocaleEnv(): NodeJS.ProcessEnv {
	return { ...process.env, LC_ALL: 'C', LANG: 'C' };
}

/** Run the first candidate binary that exists, returning stdout. Throws when every candidate is missing or exits non-zero. */
async function runFirst(candidates: string[], args: string[], timeoutMs: number = EXEC_TIMEOUT_MS): Promise<string> {
	let lastError: unknown = new Error(`no candidate found for ${args.join(' ')}`);
	for (const bin of candidates) {
		try {
			const { stdout } = await execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: cLocaleEnv() });
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

/** Signal levels straight from the kernel. Empty when no wireless driver is loaded. */
function readProcSignals(): Map<string, number> {
	try {
		return parseProcNetWireless(readFileSync('/proc/net/wireless', 'utf8'));
	} catch {
		return new Map();
	}
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
	const active = await readLinuxActiveProfiles();
	return parseLinuxNetworkState({ addr, link, route, wireless, iwLinks, procSignals: readProcSignals(), resolvers: readResolvers(), nmDns: await readNetworkManagerDns(), managed: await readManagedDevices(), ipv4Methods: active?.methods, activeProfiles: active?.devices });
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

/** The polkit action that persisting a connection change needs. */
const NM_MODIFY_PERMISSION = 'org.freedesktop.NetworkManager.settings.modify.system';

/**
 * Read one permission verdict out of `nmcli -t -f PERMISSION,VALUE general permissions`.
 *
 * The values (`yes`, `no`, `auth`) are NOT localized even though the table form
 * of the same command is — verified against a Czech-locale host, where the table
 * printed "ano" and the terse form still printed "yes".
 */
export function parseNmcliPermission(text: string, permission: string): string | null {
	for (const line of text.split('\n')) {
		const fields = splitNmcliFields(line.trim());
		if (fields[0] === permission) return fields[1] ?? null;
	}
	return null;
}

/**
 * True when NetworkManager is running AND this process may actually persist a
 * change to it.
 *
 * The second half matters as much as the first. polkit answers `auth` for an
 * unprivileged process — meaning "a human would have to type an admin password" —
 * and a backend with no polkit agent cannot answer that prompt, so the write
 * fails. Reporting the capability from "nmcli exists" alone would put an edit
 * form in front of the user whose Save could never succeed.
 */
export async function isLinuxWritable(): Promise<boolean> {
	try {
		if (!(await runFirst(NMCLI_CANDIDATES, ['-t', '-f', 'RUNNING', 'general'])).trim().startsWith('running')) return false;
		return parseNmcliPermission(await runFirst(NMCLI_CANDIDATES, ['-t', '-f', 'PERMISSION,VALUE', 'general', 'permissions']), NM_MODIFY_PERMISSION) === 'yes';
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
/**
 * Devices NetworkManager actually owns, or undefined when it cannot be asked.
 *
 * The interface list comes from the kernel and includes devices another stack
 * manages — a networkd NIC, a container bridge. Offering an edit for those shows
 * the user an action that can only end in an error, because the apply needs an
 * active NetworkManager profile on the device.
 */
async function readManagedDevices(): Promise<Set<string> | undefined> {
	try {
		return parseNmcliManagedDevices(await runFirst(NMCLI_CANDIDATES, ['-t', '-f', 'DEVICE,STATE', 'device', 'status']));
	} catch {
		return undefined;
	}
}

/** Devices from `nmcli -t -f DEVICE,STATE device status` that NetworkManager is not ignoring. */
export function parseNmcliManagedDevices(text: string): Set<string> {
	const managed = new Set<string>();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [device, state] = splitNmcliFields(line);
		// "unmanaged" is NetworkManager saying the device belongs to something else;
		// every other state (connected, disconnected, unavailable) is still its own.
		if (device && state && state !== 'unmanaged') managed.add(device);
	}
	return managed;
}

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
	// Asked for by UUID, not NAME: profile names are not unique, so a host with two
	// profiles of the same name would leave `connection modify` free to pick either
	// — and the one it picks may not be the one on this device.
	const out = await runFirst(NMCLI_CANDIDATES, ['-t', '-f', 'UUID,DEVICE', 'connection', 'show', '--active']);
	return parseNmcliActiveUUID(out, device);
}

/** Pick the UUID of the profile active on `device` out of `nmcli -t -f UUID,DEVICE` output. */
export function parseNmcliActiveUUID(text: string, device: string): string | null {
	return parseNmcliActiveUUIDs(text).get(device) ?? null;
}

/** Every device with an active profile, mapped to that profile's UUID. */
export function parseNmcliActiveUUIDs(text: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [uuid, device] = splitNmcliFields(line);
		// A profile with no device is active but not on anything (a VPN awaiting a
		// base connection), and the first profile on a device is the one that owns it.
		if (uuid && device && !result.has(device)) result.set(device, uuid);
	}
	return result;
}

/**
 * Translate NetworkManager's `ipv4.method` into the model's addressing mode.
 *
 * Only `auto` and `manual` have a counterpart. `link-local`, `shared` and
 * `disabled` are real methods the model cannot name, and calling any of them
 * DHCP or static would put a mode in the editor that saving would then impose.
 */
export function nmcliMethodToMode(method: string): NetAddressMode {
	if (method === 'auto') return 'dhcp';
	if (method === 'manual') return 'static';
	return 'unknown';
}

/**
 * The NetworkManager profiles currently active, and each one's `ipv4.method`.
 *
 * Two answers from one read because both come from the same list. The set of
 * devices decides whether an interface can be edited at all — the apply edits the
 * ACTIVE profile, so a device without one has nothing to edit — and the methods
 * decide what addressing mode to report for those that can.
 *
 * One `nmcli` call to list the active profiles, then one per profile: a host has
 * a handful of them, and the read already spawns `iw` once per wireless device.
 * Undefined when NetworkManager cannot be asked at all, so the caller falls back
 * to the kernel rather than reporting every interface as unknown.
 */
async function readLinuxActiveProfiles(): Promise<{ devices: Set<string>; methods: Map<string, NetAddressMode> } | undefined> {
	let active: Map<string, string>;
	try {
		active = parseNmcliActiveUUIDs(await runFirst(NMCLI_CANDIDATES, ['-t', '-f', 'UUID,DEVICE', 'connection', 'show', '--active']));
	} catch {
		return undefined;
	}
	const methods = new Map<string, NetAddressMode>();
	for (const [device, uuid] of active) {
		try {
			methods.set(device, nmcliMethodToMode(parseNmcliProperties(await runFirst(NMCLI_CANDIDATES, ['-t', '-f', 'ipv4.method', 'connection', 'show', 'uuid', uuid])).get('ipv4.method') ?? ''));
		} catch {
			// This one profile could not be read; the kernel inference stands for it.
		}
	}
	return { devices: new Set(active.keys()), methods };
}

/**
 * Build the `nmcli connection modify` arguments for a desired IPv4 config.
 *
 * Switching to DHCP clears the manual fields explicitly: NetworkManager keeps a
 * stale `ipv4.addresses` on a profile whose method changed, and that address
 * comes back the moment the user switches to static again.
 */
export function nmcliModifyArgs(uuid: string, config: NetIPv4Config): string[] {
	// `uuid <UUID>` rather than a bare argument: nmcli would otherwise match the
	// value against names first, and a profile named like another one's UUID — or
	// simply two profiles sharing a name — makes the target ambiguous.
	const base = ['connection', 'modify', 'uuid', uuid];
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

/**
 * Build the `nmcli connection up` arguments that re-apply an edited profile.
 *
 * `ifname <device>` is not optional here. Without it NetworkManager is free to
 * pick any device the profile is compatible with, and a profile that is not
 * hard-bound to one interface (no `connection.interface-name`, a generic wired
 * profile) can then come up on a DIFFERENT adapter from the one the user edited
 * — leaving the edited interface down and reconfiguring another.
 */
export function nmcliActivateArgs(uuid: string, device: string): string[] {
	return ['connection', 'up', 'uuid', uuid, 'ifname', device];
}

/**
 * The IPv4 properties an apply rewrites, and so the ones worth reading first.
 *
 * Exactly the set {@link nmcliModifyArgs} writes: restoring a subset would leave
 * the profile a mixture of the old configuration and the failed new one, which is
 * a third state that was never true of the machine.
 */
const NM_IPV4_FIELDS = ['ipv4.method', 'ipv4.addresses', 'ipv4.gateway', 'ipv4.dns', 'ipv4.ignore-auto-dns'] as const;

/**
 * Read the requested properties out of `nmcli -t -f <fields> connection show`.
 *
 * Terse mode prints one `key:value` line per field. An unset property prints as
 * empty or as nmcli's `--` placeholder, and both become an empty string — which
 * is also how a value is CLEARED on the way back in, so the round trip is exact.
 */
export function parseNmcliProperties(text: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [key, ...rest] = splitNmcliFields(line);
		if (!key) continue;
		const value = rest.join(':');
		result.set(key, value === '--' ? '' : value);
	}
	return result;
}

/** Build the `nmcli connection modify` arguments that put a snapshot back verbatim. */
export function nmcliRestoreArgs(uuid: string, snapshot: Map<string, string>): string[] {
	const args = ['connection', 'modify', 'uuid', uuid];
	for (const field of NM_IPV4_FIELDS) args.push(field, snapshot.get(field) ?? '');
	return args;
}

/**
 * A restorable snapshot parsed out of `nmcli connection show` output, or null
 * when the output does not hold one.
 *
 * Completeness is the whole check. {@link nmcliRestoreArgs} writes an EMPTY value
 * for every field the snapshot does not carry, so restoring from a partial
 * reading would not put the profile back — it would clear precisely the
 * properties that failed to read. A snapshot is all five fields or it is nothing.
 */
export function parseLinuxIPv4Snapshot(text: string): Map<string, string> | null {
	const properties = parseNmcliProperties(text);
	return NM_IPV4_FIELDS.every(field => properties.has(field)) ? properties : null;
}

/** The profile's current IPv4 properties, or null when a complete set could not be read. */
async function readLinuxIPv4Properties(uuid: string): Promise<Map<string, string> | null> {
	try {
		return parseLinuxIPv4Snapshot(await runFirst(NMCLI_CANDIDATES, ['-t', '-f', NM_IPV4_FIELDS.join(','), 'connection', 'show', 'uuid', uuid]));
	} catch {
		return null;
	}
}

/**
 * Apply an IPv4 configuration to one device and bring the profile back up.
 * Throws when NetworkManager does not own the device.
 *
 * `connection modify` rewrites the stored profile immediately and permanently,
 * before `connection up` has had a chance to prove the new configuration works.
 * A failed activation therefore used to leave the profile on disk permanently
 * changed — and because the connection that was already running often keeps
 * working, the damage only surfaced at the next reconnect or reboot, far from
 * anything the user could connect it to. Reading the properties first is what
 * makes the change undoable.
 *
 * Two things follow from that, and both were missing. Nothing may be changed
 * without a complete snapshot: an unreadable profile is not a profile to edit
 * hopefully, because the rollback would have nothing to write back. And the
 * `connection modify` has to be INSIDE the guard — it is the step that rewrites
 * the profile permanently, so a failure or a timeout in it left the stored
 * configuration changed with no rollback attempted at all.
 */
export async function applyLinuxIPv4(device: string, config: NetIPv4Config): Promise<void> {
	const connection = await activeConnection(device);
	if (!connection) throw new Error(`no NetworkManager profile is active on ${device}`);
	const snapshot = await readLinuxIPv4Properties(connection);
	if (!snapshot) throw new Error(`the current IPv4 configuration of ${device} could not be read in full, so it will not be changed`);
	try {
		// Permanent the moment it returns, and permanent as well if it times out
		// having already applied — which is why the rollback has to cover it.
		await runFirst(NMCLI_CANDIDATES, nmcliModifyArgs(connection, config), APPLY_TIMEOUT_MS);
		// `connection up` re-applies the edited profile in place. The device drops for
		// a moment either way — that is inherent to changing an address, not to this.
		await runFirst(NMCLI_CANDIDATES, nmcliActivateArgs(connection, device), APPLY_TIMEOUT_MS);
	} catch (err) {
		const rollback = await restoreLinuxIPv4(connection, device, snapshot);
		// Both, not just the first: a rollback that failed leaves the profile in a
		// state the activation error says nothing about.
		if (rollback) throw new Error(`${(err as Error).message} — and undoing the change failed: ${rollback}`);
		throw err;
	}
}

/**
 * Put the profile's IPv4 properties back and bring it up again. Returns what
 * went wrong, or null when the rollback succeeded.
 *
 * Re-activating is part of the rollback, not an extra: the failed `connection up`
 * may well have torn the old connection down before it gave up, so restoring the
 * file alone would leave the device configured correctly and switched off.
 *
 * The snapshot is not nullable. {@link applyLinuxIPv4} refuses to change anything
 * without one, so "there was nothing to restore from" is a state this function
 * can no longer be reached in.
 */
async function restoreLinuxIPv4(uuid: string, device: string, snapshot: Map<string, string>): Promise<string | null> {
	try {
		await runFirst(NMCLI_CANDIDATES, nmcliRestoreArgs(uuid, snapshot), APPLY_TIMEOUT_MS);
	} catch (err) {
		return `the profile still holds the rejected configuration (${(err as Error).message})`;
	}
	try {
		await runFirst(NMCLI_CANDIDATES, nmcliActivateArgs(uuid, device), APPLY_TIMEOUT_MS);
	} catch (err) {
		return `the profile was restored but could not be brought back up (${(err as Error).message})`;
	}
	return null;
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
		if (!previous) best.set(ssid, entry);
		// The strongest access point wins the signal, but IN-USE belongs to the
		// network, not to that row: on a roaming network the host is regularly
		// associated with the weaker of two access points, and dropping the marker
		// with the losing row stops the UI showing which network it is on.
		else best.set(ssid, { ...((entry.signal ?? -1) > (previous.signal ?? -1) ? entry : previous), active: previous.active || entry.active });
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
