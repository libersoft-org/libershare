import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { NetAddress, NetInterfaceInfo, NetLink, NetWifiInfo } from '@shared';

const execFileAsync = promisify(execFile);

/**
 * Linux host network state, read entirely through `ip -j` (iproute2's JSON
 * output) plus two sysfs/procfs reads. Nothing here mutates configuration.
 *
 * `ip` is used rather than a stack-specific tool because it reports the kernel's
 * actual state — the same answer whether the box is driven by ifupdown,
 * systemd-networkd, NetworkManager or netplan. Detecting the owning stack only
 * matters for WRITING config, which this module deliberately does not do.
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
			// ponytail: /etc/resolv.conf is the system-wide resolver list, so it is
			// attributed to the interface that actually reaches it (the default
			// route). Per-link attribution needs resolvectl and only exists on
			// systemd-resolved hosts.
			dns: entry.ifname === defaultDev ? (sources.resolvers ?? []) : [],
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
async function runFirst(candidates: string[], args: string[]): Promise<string> {
	let lastError: unknown = new Error(`no candidate found for ${args.join(' ')}`);
	for (const bin of candidates) {
		try {
			const { stdout } = await execFileAsync(bin, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
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
	return parseLinuxNetworkState({ addr, link, route, wireless, iwLinks, resolvers: readResolvers() });
}
