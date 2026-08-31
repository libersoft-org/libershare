import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { isIPv4, isIPv6 } from '@shared';
import type { NetAddress, NetCapabilities, NetInterfaceInfo, NetIPv4Config, NetLink, NetWifiInfo, NetWifiNetwork } from '@shared';

const execFileAsync = promisify(execFile);
const C_LOCALE_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

/**
 * Linux host network state, read entirely through `ip -j` (iproute2's JSON
 * output) plus two sysfs/procfs reads.
 *
 * `ip` is used for READING rather than a stack-specific tool because it reports
 * the kernel's actual state — the same answer whether the box is driven by
 * ifupdown, systemd-networkd, NetworkManager or netplan.
 *
 * WRITING is the opposite: it has to go through the stack that owns the device,
 * so the apply half of this module speaks to NetworkManager through nmcli and
 * D-Bus, and refuses to act on a host it does not own. See
 * {@link readLinuxCapabilities}.
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
	/** Active NetworkManager profile UUIDs by device. Only these devices can be edited. */
	activeConnections?: Map<string, string> | undefined;
	/** Exact `ipv4.method` of each active NetworkManager profile, keyed by device. */
	ipv4Methods?: Map<string, string> | undefined;
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
	const routesByDevice = new Map<string, IpRouteEntry[]>();
	for (const route of routeEntries) {
		if (!route.dev) continue;
		const list = routesByDevice.get(route.dev) ?? [];
		list.push(route);
		routesByDevice.set(route.dev, list);
	}

	const result: NetInterfaceInfo[] = [];
	for (const entry of addrEntries) {
		// Loopback is never a choice a user makes and never a connection to report.
		if (entry.ifname === 'lo') continue;
		const addresses: NetAddress[] = [];
		let kernelIPv4Mode: NetInterfaceInfo['ipv4Mode'] = 'unknown';
		for (const info of entry.addr_info ?? []) {
			const family = info.family === 'inet' ? 'ipv4' : info.family === 'inet6' ? 'ipv6' : null;
			if (!family) continue;
			addresses.push({ family, address: info.local, prefixLength: info.prefixlen });
			if (family !== 'ipv4') continue;
			if (info.dynamic === true) kernelIPv4Mode = 'dhcp';
			else if (kernelIPv4Mode === 'unknown' && info.valid_life_time === LIFETIME_PERMANENT) kernelIPv4Mode = 'static';
		}
		const link = linkByName.get(entry.ifname);
		const wireless = sources.wireless?.has(entry.ifname) ?? false;
		const interfaceRoutes = routesByDevice.get(entry.ifname) ?? [];
		const managed = sources.activeConnections?.has(entry.ifname) ?? false;
		// Kernel address flags cannot distinguish manual addressing from shared,
		// link-local or disabled NetworkManager profiles. Only auto/manual are safe
		// for this editor to round-trip; every other managed method stays read-only.
		const ipv4Mode = managed ? parseNmcliIPv4Method(sources.ipv4Methods?.get(entry.ifname) ?? '') : kernelIPv4Mode;
		const info: NetInterfaceInfo = {
			id: entry.ifname,
			name: entry.ifname,
			medium: mapMedium(wireless, link),
			link: mapLink(link ?? entry),
			defaultRoute: entry.ifname === defaultDev,
			mac: entry.address ?? link?.address ?? null,
			addresses,
			ipv4Mode,
			ipv4Configurable: managed && ipv4Mode !== 'unknown' && addresses.filter(address => address.family === 'ipv4').length <= 1 && interfaceRoutes.length <= 1,
			gateway: interfaceRoutes[0]?.gateway ?? null,
			// NetworkManager knows the resolvers PER LINK, which is the only correct
			// answer on a systemd-resolved host: there /etc/resolv.conf holds the
			// 127.0.0.53 stub, so reporting it would show every machine the same
			// fictional nameserver — and would contradict the servers the user had
			// just set. Only when NM is absent do we fall back to resolv.conf, which
			// is system-wide and so is attributed to the default-route interface.
			dns: sources.nmDns !== undefined ? (sources.nmDns.get(entry.ifname) ?? []) : entry.ifname === defaultDev ? (sources.resolvers ?? []) : [],
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

/** Run the first candidate binary that exists, returning stdout. Throws when every candidate is missing or exits non-zero. */
async function runFirst(candidates: string[], args: string[], timeoutMs: number = EXEC_TIMEOUT_MS): Promise<string> {
	let lastError: unknown = new Error(`no candidate found for ${args.join(' ')}`);
	for (const bin of candidates) {
		try {
			const { stdout } = await execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: C_LOCALE_ENV });
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

/** `execFile` cannot feed stdin; use this only for nmcli's password prompt. */
async function runFirstWithInput(candidates: string[], args: string[], input: string, timeoutMs: number): Promise<string> {
	let lastError: unknown = new Error(`no candidate found for ${args.join(' ')}`);
	for (const bin of candidates) {
		try {
			return await new Promise<string>((resolve, reject) => {
				const child = spawn(bin, args, { env: C_LOCALE_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
				let stdout = '';
				let stderr = '';
				let timedOut = false;
				const timer = setTimeout(() => {
					timedOut = true;
					child.kill('SIGKILL');
				}, timeoutMs);
				child.stdout.on('data', chunk => (stdout += String(chunk)));
				child.stderr.on('data', chunk => (stderr += String(chunk)));
				child.stdin.on('error', () => {});
				child.on('error', error => {
					clearTimeout(timer);
					reject(error);
				});
				child.on('close', code => {
					clearTimeout(timer);
					if (!timedOut && code === 0) resolve(stdout);
					else {
						const error = new Error(timedOut ? `${bin} timed out` : `${bin} failed with exit code ${code ?? 'unknown'}`);
						Object.assign(error, { stdout, stderr, code });
						reject(error);
					}
				});
				child.stdin.end(input);
			});
		} catch (error) {
			lastError = error;
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
	const [nmDns, profiles] = await Promise.all([readNetworkManagerDns(), readNetworkManagerProfiles()]);
	return parseLinuxNetworkState({ addr, link, route, wireless, iwLinks, procSignals: readProcSignals(), resolvers: readResolvers(), nmDns, activeConnections: profiles?.connections, ipv4Methods: profiles?.ipv4Methods });
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
const BUSCTL_CANDIDATES = ['/usr/bin/busctl', '/bin/busctl', 'busctl'];
/** Match NetworkManager's documented default activation wait explicitly. */
const NMCLI_ACTIVATION_WAIT_SECONDS = 90;
/** Keep the checkpoint alive throughout activation and leave time to commit it. */
const CHECKPOINT_ROLLBACK_SECONDS = NMCLI_ACTIVATION_WAIT_SECONDS + 10;
const NMCLI_MUTATION_TIMEOUT_MS = (NMCLI_ACTIVATION_WAIT_SECONDS + 5) * 1000;
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
const NM_CONTROL_PERMISSION = 'org.freedesktop.NetworkManager.network-control';
const NM_WIFI_SCAN_PERMISSION = 'org.freedesktop.NetworkManager.wifi.scan';
const NM_CHECKPOINT_PERMISSION = 'org.freedesktop.NetworkManager.checkpoint-rollback';

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
/** Probe address and Wi-Fi rights separately; custom polkit policies may differ. */
export async function readLinuxCapabilities(): Promise<NetCapabilities> {
	try {
		if (!(await runFirst(NMCLI_CANDIDATES, ['-t', '-f', 'RUNNING', 'general'])).trim().startsWith('running')) return { ipv4: false, wifi: false, staticGatewayRequired: false };
		await runFirst(BUSCTL_CANDIDATES, ['--version']);
		return parseLinuxCapabilities(await runFirst(NMCLI_CANDIDATES, ['-t', '-f', 'PERMISSION,VALUE', 'general', 'permissions']));
	} catch {
		return { ipv4: false, wifi: false, staticGatewayRequired: false };
	}
}

/**
 * Per-interface resolvers from NetworkManager, including IPv4 and IPv6.
 *
 * Returns undefined — not an empty map — when NetworkManager is absent or fails,
 * so the caller can tell "NM says this link has no resolvers" apart from "there
 * is no NM to ask" and fall back to /etc/resolv.conf only in the latter case.
 */
async function readNetworkManagerDns(): Promise<Map<string, string[]> | undefined> {
	try {
		return parseNmcliDns(await runFirst(NMCLI_CANDIDATES, ['-t', '-f', 'GENERAL.DEVICE,IP4.DNS,IP6.DNS', 'device', 'show']));
	} catch {
		return undefined;
	}
}

/**
 * Parse the per-device blocks of NetworkManager DNS output.
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
		// NetworkManager versions disagree on whether ':' inside an IPv6 value is
		// escaped in terse mode. Rejoining the value fields accepts both forms.
		const value = fields.slice(1).join(':');
		if (key === 'GENERAL.DEVICE') {
			device = value || null;
			if (device) result.set(device, []);
		} else if (device && (key.startsWith('IP4.DNS') || key.startsWith('IP6.DNS'))) {
			if (value) result.get(device)?.push(value);
		}
	}
	return result;
}

/** Parse active NetworkManager profile UUIDs keyed by their device. */
export function parseNmcliActiveConnections(text: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		const [uuid, device] = splitNmcliFields(line);
		if (uuid && device) result.set(device, uuid);
	}
	return result;
}

/** Map only the two NetworkManager methods this editor can preserve exactly. */
export function parseNmcliIPv4Method(text: string): NetInterfaceInfo['ipv4Mode'] {
	const method = text.trim().toLowerCase();
	if (method === 'auto') return 'dhcp';
	if (method === 'manual') return 'static';
	return 'unknown';
}

/** Active profiles and their exact IPv4 method. Any incomplete read stays read-only. */
async function readNetworkManagerProfiles(): Promise<{ connections: Map<string, string>; ipv4Methods: Map<string, string> } | undefined> {
	try {
		const connections = await activeConnections();
		const ipv4Methods = new Map<string, string>();
		await Promise.all(
			[...connections].map(async ([device, uuid]) => {
				const method = await runFirst(NMCLI_CANDIDATES, ['-g', 'ipv4.method', 'connection', 'show', 'uuid', uuid]);
				ipv4Methods.set(device, method.trim());
			})
		);
		return { connections, ipv4Methods };
	} catch {
		return undefined;
	}
}

/** Fresh active-profile lookup shared by the read and apply paths. */
async function activeConnections(): Promise<Map<string, string>> {
	return parseNmcliActiveConnections(await runFirst(NMCLI_CANDIDATES, ['-t', '-f', 'UUID,DEVICE', 'connection', 'show', '--active']));
}

/**
 * UUID of the NetworkManager profile currently active on a device.
 *
 * Modifying the active profile (rather than creating a new one) is what makes an
 * edit idempotent: applying twice leaves one profile, not two competing ones.
 */
async function activeConnection(device: string): Promise<string | null> {
	return (await activeConnections()).get(device) ?? null;
}

/**
 * Build the `nmcli connection modify` arguments for a desired IPv4 config.
 *
 * Switching to DHCP clears the manual fields explicitly: NetworkManager keeps a
 * stale `ipv4.addresses` on a profile whose method changed, and that address
 * comes back the moment the user switches to static again.
 */
function nmcliDnsArgs(config: NetIPv4Config): string[] {
	if (config.dns === undefined) return [];
	const ignoreAutomatic = config.dns.length > 0 ? 'yes' : 'no';
	return ['ipv4.dns', config.dns.filter(isIPv4).join(','), 'ipv4.ignore-auto-dns', ignoreAutomatic, 'ipv6.dns', config.dns.filter(isIPv6).join(','), 'ipv6.ignore-auto-dns', ignoreAutomatic];
}

export function nmcliModifyArgs(connectionUUID: string, config: NetIPv4Config, addressingChanged: boolean = true): string[] {
	const base = ['connection', 'modify', 'uuid', connectionUUID];
	const dns = nmcliDnsArgs(config);
	if (!addressingChanged) return [...base, ...dns];
	if (config.mode === 'dhcp') return [...base, 'ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '', ...dns];
	return [...base, 'ipv4.method', 'manual', 'ipv4.addresses', `${config.address}/${config.prefixLength}`, 'ipv4.gateway', config.gateway ?? '', ...dns];
}

/** Address one active profile unambiguously even when display names collide. */
export function nmcliActivateArgs(connectionUUID: string): string[] {
	return ['connection', 'up', 'uuid', connectionUUID];
}

const NM_SERVICE = 'org.freedesktop.NetworkManager';
const NM_PATH = '/org/freedesktop/NetworkManager';
const NM_INTERFACE = 'org.freedesktop.NetworkManager';
const NM_CHECKPOINT_DELETE_NEW_CONNECTIONS = 2;

/** Create a device checkpoint that also removes profiles created by a failed mutation. */
export function networkManagerCheckpointCreateArgs(devicePath: string): string[] {
	return ['--system', 'call', NM_SERVICE, NM_PATH, NM_INTERFACE, 'CheckpointCreate', 'aouu', '1', devicePath, String(CHECKPOINT_ROLLBACK_SECONDS), String(NM_CHECKPOINT_DELETE_NEW_CONNECTIONS)];
}

/** Finish a checkpoint explicitly; rollback is never left waiting for an interactive timeout. */
export function networkManagerCheckpointFinishArgs(method: 'CheckpointDestroy' | 'CheckpointRollback', checkpointPath: string): string[] {
	return ['--system', 'call', NM_SERVICE, NM_PATH, NM_INTERFACE, method, 'o', checkpointPath];
}

/** Parse the stable object-path output of `busctl call ... CheckpointCreate`. */
export function parseNetworkManagerCheckpointPath(output: string): string {
	const match = output.trim().match(/^o\s+"?(\/org\/freedesktop\/NetworkManager\/Checkpoint\/\d+)"?$/);
	if (!match?.[1]) throw new Error('NetworkManager returned an invalid checkpoint path');
	return match[1];
}

/** Reject a D-Bus rollback that completed but failed for any checkpointed device. */
export function assertNetworkManagerRollback(output: string): void {
	const header = output.trim().match(/^a\{su\}\s+(\d+)\s*(.*)$/s);
	if (!header) throw new Error('NetworkManager returned an invalid rollback result');
	const expected = Number(header[1]);
	const entries = [...(header[2] ?? '').matchAll(/"([^"]+)"\s+(\d+)/g)];
	if (expected === 0 || entries.length !== expected || entries.some(entry => Number(entry[2]) !== 0)) throw new Error('NetworkManager failed to roll back a checkpointed device');
}

/** Transaction invariant shared by IPv4 and Wi-Fi mutations. */
export async function withNetworkManagerCheckpoint<T>(operations: { create: () => Promise<string>; mutate: () => Promise<T>; commit: (checkpointPath: string) => Promise<void>; rollback: (checkpointPath: string) => Promise<void> }): Promise<T> {
	const checkpointPath = await operations.create();
	try {
		const result = await operations.mutate();
		await operations.commit(checkpointPath);
		return result;
	} catch (error) {
		try {
			await operations.rollback(checkpointPath);
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], 'network mutation failed and rollback also failed');
		}
		throw error;
	}
}

async function networkManagerDevicePath(device: string): Promise<string> {
	const path = (await runFirst(NMCLI_CANDIDATES, ['-g', 'GENERAL.DBUS-PATH', 'device', 'show', device])).trim();
	if (!/^\/org\/freedesktop\/NetworkManager\/Devices\/\d+$/.test(path)) throw new Error(`NetworkManager returned an invalid D-Bus path for ${device}`);
	return path;
}

async function createNetworkManagerCheckpoint(devicePath: string): Promise<string> {
	return parseNetworkManagerCheckpointPath(await runFirst(BUSCTL_CANDIDATES, networkManagerCheckpointCreateArgs(devicePath)));
}

async function destroyNetworkManagerCheckpoint(checkpointPath: string): Promise<void> {
	await runFirst(BUSCTL_CANDIDATES, networkManagerCheckpointFinishArgs('CheckpointDestroy', checkpointPath));
}

async function rollbackNetworkManagerCheckpoint(checkpointPath: string): Promise<void> {
	assertNetworkManagerRollback(await runFirst(BUSCTL_CANDIDATES, networkManagerCheckpointFinishArgs('CheckpointRollback', checkpointPath), NMCLI_MUTATION_TIMEOUT_MS));
}

async function withDeviceCheckpoint<T>(device: string, mutate: () => Promise<T>): Promise<T> {
	const devicePath = await networkManagerDevicePath(device);
	return withNetworkManagerCheckpoint({
		create: () => createNetworkManagerCheckpoint(devicePath),
		mutate,
		commit: destroyNetworkManagerCheckpoint,
		rollback: rollbackNetworkManagerCheckpoint,
	});
}

/** Apply an IPv4 configuration to one device and bring the profile back up. Throws when NetworkManager does not own the device. */
export async function applyLinuxIPv4(device: string, config: NetIPv4Config, addressingChanged: boolean = true): Promise<void> {
	const connectionUUID = await activeConnection(device);
	if (!connectionUUID) throw new Error(`no NetworkManager profile is active on ${device}`);
	await withDeviceCheckpoint(device, async () => {
		await runFirst(NMCLI_CANDIDATES, nmcliModifyArgs(connectionUUID, config, addressingChanged));
		const activate = addressingChanged ? nmcliActivateArgs(connectionUUID) : ['device', 'reapply', device];
		await runFirst(NMCLI_CANDIDATES, ['--wait', String(NMCLI_ACTIVATION_WAIT_SECONDS), ...activate], NMCLI_MUTATION_TIMEOUT_MS);
	});
}

/**
 * Parse `nmcli -t -f SSID,BSSID,SIGNAL,SECURITY,IN-USE device wifi list`.
 *
 * Hidden networks report an empty SSID and are dropped: they cannot be joined by
 * name, so offering an unnamed row would be offering something that fails.
 * Every BSSID stays distinct so equal SSIDs with different security cannot be
 * mistaken for the same network.
 */
export function parseNmcliWifiList(text: string): NetWifiNetwork[] {
	const networks = new Map<string, NetWifiNetwork>();
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		const [ssid, rawBssid, signal, security, inUse] = splitNmcliFields(line);
		if (!ssid) continue;
		const bssid = rawBssid && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(rawBssid) ? rawBssid.toUpperCase() : null;
		const parsed = signal ? parseInt(signal, 10) : NaN;
		const securityName = security?.trim() ?? '';
		const enterprise = /(?:802\.1X|ENTERPRISE|EAP)/i.test(securityName);
		const obsolete = /\bWEP\b/i.test(securityName);
		const entry: NetWifiNetwork = {
			ssid,
			bssid,
			signal: Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : null,
			// nmcli leaves SECURITY empty for an open network and prints the key
			// management (WPA2, WPA3, WEP, 802.1X) otherwise.
			secured: securityName.length > 0,
			security: securityName,
			supported: securityName.length === 0 || (/\bWPA\d*\b/i.test(securityName) && !enterprise && !obsolete),
			active: inUse?.trim() === '*',
		};
		const key = `${ssid}\0${bssid ?? ''}\0${securityName}`;
		const previous = networks.get(key);
		if (!previous) networks.set(key, entry);
		else if ((entry.signal ?? -1) > (previous.signal ?? -1)) networks.set(key, { ...entry, active: previous.active || entry.active });
		else if (entry.active && !previous.active) networks.set(key, { ...previous, active: true });
	}
	return [...networks.values()].sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1));
}

/** Scan for Wi-Fi networks reachable from one device. */
export async function scanLinuxWifi(device: string): Promise<NetWifiNetwork[]> {
	return parseNmcliWifiList(await runFirst(NMCLI_CANDIDATES, ['-t', '-f', 'SSID,BSSID,SIGNAL,SECURITY,IN-USE', 'device', 'wifi', 'list', 'ifname', device, '--rescan', 'yes'], WIFI_SCAN_TIMEOUT_MS));
}

/** Map NetworkManager's three independent policy decisions to real capabilities. */
export function parseLinuxCapabilities(text: string): NetCapabilities {
	const canModify = parseNmcliPermission(text, NM_MODIFY_PERMISSION) === 'yes';
	const canActivate = parseNmcliPermission(text, NM_CONTROL_PERMISSION) === 'yes';
	const canCheckpoint = parseNmcliPermission(text, NM_CHECKPOINT_PERMISSION) === 'yes';
	return {
		ipv4: canModify && canActivate && canCheckpoint,
		wifi: canModify && canActivate && canCheckpoint && parseNmcliPermission(text, NM_WIFI_SCAN_PERMISSION) === 'yes',
		staticGatewayRequired: false,
	};
}

/** Build the public part of a Wi-Fi connect command; the secret is never an argument. */
export function nmcliWifiConnectArgs(device: string, ssid: string, askForPassword: boolean, bssid: string | null = null): string[] {
	return [...(askForPassword ? ['--ask'] : []), 'device', 'wifi', 'connect', ssid, ...(bssid ? ['bssid', bssid] : []), 'ifname', device];
}

/**
 * Join a Wi-Fi network.
 *
 * `device wifi connect` reuses a saved profile when one exists and creates one
 * otherwise, so the same call covers both "reconnect to a known network" and
 * "join a new one with a password". A password is supplied through stdin to
 * `nmcli --ask`, never argv, so another local user cannot read it from
 * `/proc/<pid>/cmdline` while the command is running.
 */
export async function connectLinuxWifi(device: string, ssid: string, password: string, bssid: string | null = null): Promise<void> {
	const args = ['--wait', String(NMCLI_ACTIVATION_WAIT_SECONDS), ...nmcliWifiConnectArgs(device, ssid, !!password, bssid)];
	await withDeviceCheckpoint(device, () => (password ? runFirstWithInput(NMCLI_CANDIDATES, args, `${password}\n`, NMCLI_MUTATION_TIMEOUT_MS) : runFirst(NMCLI_CANDIDATES, args, NMCLI_MUTATION_TIMEOUT_MS)));
}
