import { applyNativeLinuxIPv4 } from './native/linux/network-mutation.ts';
import { requireNativeMutationContext } from './native/mutation-context.ts';
import { connectNativeLinuxWifi, disconnectNativeLinuxWifi } from './native/linux/wifi-mutation.ts';
import type { WifiMutationOptions } from './native/linux/wifi-client.ts';
import { NativeWorkerChannel } from './native/worker-host.ts';
import type { NativeNetworkSources } from './native/linux/network-reader.ts';
import type { NetAddress, NetCapabilities, NetInterfaceInfo, NetIPv4Config, NetLink, NetWifiInfo, NetWifiNetwork } from '@shared';

/** Shared native read budget, in milliseconds. */
const EXEC_TIMEOUT_MS = 5000;
const networkReader = new NativeWorkerChannel('read');
/** IFA_F_PERMANENT lifetime sentinel — a manually configured address never expires. */
const LIFETIME_PERMANENT = 4294967295;

/**
 * True when an address came from a lease rather than from a saved static entry.
 *
 * `dynamic` is what iproute2 sets for a DHCP address; the finite lifetime is the
 * same fact seen from the other side, and is there on builds that omit the flag.
 * Only an explicitly permanent address is taken as evidence of static addressing.
 */
function isLeasedAddress(info: { dynamic?: boolean; valid_life_time?: number }): boolean {
	return info.dynamic === true || info.valid_life_time !== LIFETIME_PERMANENT;
}

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
	/** `ip -j -6 route show default`. Names the interface the host reaches the internet through when there is no IPv4 default route. */
	route6?: string;
	/** Interface names the kernel reports as wireless (a `phy80211` symlink in sysfs). */
	wireless?: Set<string>;
	/** Per-interface `iw dev <if> link` output, when `iw` is installed. */
	iwLinks?: Map<string, string>;
	/** Native association with signal in dBm. */
	nativeWifi?: Map<string, { ssid: string | null; signal: number | null }>;
	/** Signal quality per interface from `/proc/net/wireless`. Used when `iw` reported none. */
	procSignals?: Map<string, number>;
	/** Resolver addresses from /etc/resolv.conf. Attributed to the default-route interface only. */
	resolvers?: string[];
	/** Per-interface resolvers as NetworkManager sees them. Preferred over {@link resolvers} when present. */
	nmDns?: Map<string, string[]> | undefined;
	/** Active NetworkManager profile UUIDs by device. Only these devices can be edited. */
	activeConnections?: Map<string, string> | undefined;
	/** IPv4 settings of each active NetworkManager profile, keyed by device. */
	ipv4Profiles?: Map<string, NmcliIPv4Profile> | undefined;
	/** Devices NetworkManager explicitly reports as managed, active or disconnected. */
	managedDevices?: Set<string> | undefined;
}

/** The profile fields required to decide whether the simple editor can preserve it. */
export interface NmcliIPv4Profile {
	method: string;
	gateway: string | null;
	/** What the profile stores, which is not necessarily what the kernel is using. */
	address: string | null;
	prefixLength: number | null;
	safe: boolean;
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
	const route6Entries = sources.route6 ? (JSON.parse(sources.route6) as IpRouteEntry[]) : [];

	const linkByName = new Map<string, IpLinkEntry>();
	for (const entry of linkEntries) linkByName.set(entry.ifname, entry);

	// Lowest-metric default route wins; an absent metric means 0 (kernel default).
	const lowestMetric = (entries: IpRouteEntry[]): IpRouteEntry | null => {
		let best: IpRouteEntry | null = null;
		for (const route of entries) {
			if (!route.dev) continue;
			if (!best || (route.metric ?? 0) < (best.metric ?? 0)) best = route;
		}
		return best;
	};
	// A host reachable only over IPv6 still has a default route, just not an IPv4
	// one. Without this the footer would call a working connection "disconnected"
	// purely because the automatic pick had nothing to point at. The IPv4 route
	// stays first: everything this screen edits is IPv4.
	const defaultDev = lowestMetric(routeEntries)?.dev ?? lowestMetric(route6Entries)?.dev ?? null;
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
		let liveIPv4: LiveIPv4Address | null = null;
		for (const info of entry.addr_info ?? []) {
			const family = info.family === 'inet' ? 'ipv4' : info.family === 'inet6' ? 'ipv6' : null;
			if (!family) continue;
			addresses.push({ family, address: info.local, prefixLength: info.prefixlen });
			if (family !== 'ipv4') continue;
			liveIPv4 ??= { address: info.local, prefixLength: info.prefixlen, leased: isLeasedAddress(info) };
			if (info.dynamic === true) kernelIPv4Mode = 'dhcp';
			else if (kernelIPv4Mode === 'unknown' && info.valid_life_time === LIFETIME_PERMANENT) kernelIPv4Mode = 'static';
		}
		const link = linkByName.get(entry.ifname);
		const wireless = sources.wireless?.has(entry.ifname) ?? false;
		const interfaceRoutes = routesByDevice.get(entry.ifname) ?? [];
		const activeProfile = sources.ipv4Profiles?.get(entry.ifname);
		const managed = sources.activeConnections?.has(entry.ifname) === true && activeProfile !== undefined;
		// Kernel address flags cannot distinguish manual addressing from shared,
		// link-local or disabled NetworkManager profiles. Only auto/manual are safe
		// for this editor to round-trip; every other managed method stays read-only.
		const ipv4Mode = managed ? parseNmcliIPv4Method(activeProfile.method) : kernelIPv4Mode;
		const ipv4Addresses = addresses.filter(address => address.family === 'ipv4');
		const info: NetInterfaceInfo = {
			id: entry.ifname,
			name: entry.ifname,
			medium: mapMedium(wireless, link),
			link: mapLink(link ?? entry),
			defaultRoute: entry.ifname === defaultDev,
			mac: entry.address ?? link?.address ?? null,
			addresses,
			ipv4Mode,
			ipv4Configurable: managed && activeProfile.safe && ipv4Mode !== 'unknown' && ipv4Addresses.length <= 1 && interfaceRoutes.length <= 1 && nmcliProfileMatchesLive(activeProfile, liveIPv4, interfaceRoutes[0]?.gateway ?? null),
			wifiConfigurable: wireless && sources.managedDevices?.has(entry.ifname) === true,
			gateway: interfaceRoutes[0]?.gateway ?? activeProfile?.gateway ?? null,
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
			const native = sources.nativeWifi?.get(entry.ifname);
			const parsed: NetWifiInfo = native ? { ssid: native.ssid, signal: native.signal === null ? null : dbmToQuality(native.signal), radio: 'unknown' } : iw ? { ...parseIwLink(iw), radio: 'unknown' } : { ssid: null, signal: null, radio: 'unknown' };
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

/** A Linux read: the interfaces, and whether NetworkManager's profiles could not be read. */
export interface LinuxNetworkRead {
	interfaces: NetInterfaceInfo[];
	/** NetworkManager manages at least one device, but reading the profiles failed or was incomplete. */
	ipv4ProfilesUnavailable: boolean;
}

/** Reads native state in a worker; a failed kernel dump rejects the whole read. */
export async function readLinuxNetworkState(): Promise<LinuxNetworkRead> {
	const { sources, ipv4ProfilesUnavailable } = await networkReader.call<NativeNetworkSources>({ method: 'linux.network.snapshot', args: { timeoutMs: EXEC_TIMEOUT_MS } }, EXEC_TIMEOUT_MS);
	return { interfaces: parseLinuxNetworkState(sources), ipv4ProfilesUnavailable };
}

/** Match NetworkManager's documented default activation wait explicitly. */
const NM_ACTIVATION_WAIT_SECONDS = 90;
export const NETWORK_MANAGER_PROFILE_UPDATE_TIMEOUT_MS: number = EXEC_TIMEOUT_MS;
export const NETWORK_MANAGER_MUTATION_TIMEOUT_MS: number = (NM_ACTIVATION_WAIT_SECONDS + 5) * 1000;
export const NETWORK_MANAGER_ROLLBACK_TIMEOUT_MS: number = NETWORK_MANAGER_MUTATION_TIMEOUT_MS;
export const NETWORK_MANAGER_CHECKPOINT_SAFETY_MS: number = 30000;
/** A rescan has to wait for the radio to sweep every channel. */
const WIFI_SCAN_TIMEOUT_MS = 30000;
/** Profile reads, update, activation and read-back before releasing the checkpoint. */
export const NETWORK_MANAGER_IPV4_TRANSACTION_TIMEOUT_MS: number =
	2 * EXEC_TIMEOUT_MS + // resolve the active profile and read it back to judge it
	EXEC_TIMEOUT_MS + // ipv6.method, before an IPv6 resolver is offered to it
	NETWORK_MANAGER_PROFILE_UPDATE_TIMEOUT_MS +
	NETWORK_MANAGER_MUTATION_TIMEOUT_MS +
	EXEC_TIMEOUT_MS + // the profile is still the one active on the device
	EXEC_TIMEOUT_MS + // method, address and route, read together
	EXEC_TIMEOUT_MS; // profile and live resolvers, read together
/** Both activations, profile commit, association verification and password compensation. */
export const NETWORK_MANAGER_WIFI_TRANSACTION_TIMEOUT_MS: number = 2 * NETWORK_MANAGER_MUTATION_TIMEOUT_MS + 2 * NETWORK_MANAGER_PROFILE_UPDATE_TIMEOUT_MS + WIFI_SCAN_TIMEOUT_MS;
/**
 * How long NetworkManager holds the checkpoint before rolling back on its own.
 *
 * Long enough for the slowest transaction, the explicit rollback that may follow
 * it, and a margin on top — so the automatic rollback is a backstop for a
 * process that died, never a second rollback racing our own.
 */
export const NETWORK_MANAGER_CHECKPOINT_TIMEOUT_SECONDS: number = Math.ceil((Math.max(NETWORK_MANAGER_IPV4_TRANSACTION_TIMEOUT_MS, NETWORK_MANAGER_WIFI_TRANSACTION_TIMEOUT_MS) + NETWORK_MANAGER_ROLLBACK_TIMEOUT_MS + NETWORK_MANAGER_CHECKPOINT_SAFETY_MS) / 1000) + 1;

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
		return await networkReader.call<NetCapabilities>({ method: 'linux.network.capabilities', args: { timeoutMs: EXEC_TIMEOUT_MS } }, EXEC_TIMEOUT_MS);
	} catch {
		return { ipv4: false, wifi: false, staticGatewayRequired: false };
	}
}

/** Map only the two NetworkManager methods this editor can preserve exactly. */
export function parseNmcliIPv4Method(text: string): NetInterfaceInfo['ipv4Mode'] {
	const method = text.trim().toLowerCase();
	if (method === 'auto') return 'dhcp';
	if (method === 'manual') return 'static';
	return 'unknown';
}

/** The one IPv4 address the kernel holds on a device, and whether it came from a lease. */
export interface LiveIPv4Address {
	address: string;
	prefixLength: number;
	leased: boolean;
}

/**
 * True when the saved profile still describes what the kernel is actually using.
 *
 * The screen shows the kernel's state and the form saves back into the profile,
 * so the two have to agree before an edit can round-trip. `nmcli connection
 * modify` without a reapply leaves them apart, and either direction is dangerous:
 * a profile that already holds the next static address would have it overwritten
 * by the one on screen, and a profile switched to DHCP would have that switch
 * activated by the `device reapply` a DNS-only save runs — changing the address
 * the user never touched. Both are the thing the baseline check exists to prevent
 * one layer up, so a divergent interface is not offered for editing at all.
 *
 * The origin of the live address decides it in both directions, which is why a
 * numeric match is not enough on its own: a profile switched to manual over an
 * address the kernel is still leasing looks identical to one that owns it, and
 * saving the form would activate that pending switch. A DHCP profile agrees with
 * a leased address, and with having none yet: the link may be down, no server may
 * have answered, or the kernel may hold only the link-local fallback.
 */
export function nmcliProfileMatchesLive(profile: NmcliIPv4Profile, live: LiveIPv4Address | null, liveGateway: string | null): boolean {
	if (parseNmcliIPv4Method(profile.method) === 'static') return live !== null && !live.leased && profile.address === live.address && profile.prefixLength === live.prefixLength && profile.gateway === liveGateway;
	return live === null || live.leased || live.address.startsWith('169.254.');
}

/** Apply an IPv4 configuration to one device and bring the profile back up. Throws when NetworkManager does not own the device. */
export async function applyLinuxIPv4(device: string, config: NetIPv4Config, addressingChanged: boolean = true, requireLease: boolean = true): Promise<void> {
	await applyNativeLinuxIPv4(requireNativeMutationContext(), device, config, {
		addressingChanged,
		requireLease,
		readTimeoutMs: EXEC_TIMEOUT_MS,
		updateTimeoutMs: NETWORK_MANAGER_PROFILE_UPDATE_TIMEOUT_MS,
		activationTimeoutMs: NETWORK_MANAGER_MUTATION_TIMEOUT_MS,
		rollbackTimeoutMs: NETWORK_MANAGER_ROLLBACK_TIMEOUT_MS,
		checkpointSafetyMs: NETWORK_MANAGER_CHECKPOINT_SAFETY_MS,
		checkpointTimeoutSeconds: NETWORK_MANAGER_CHECKPOINT_TIMEOUT_SECONDS,
	});
}

/** Scan for Wi-Fi networks reachable from one device. */
export async function scanLinuxWifi(device: string): Promise<NetWifiNetwork[]> {
	return networkReader.call<NetWifiNetwork[]>({ method: 'linux.network.scan', args: { device, timeoutMs: WIFI_SCAN_TIMEOUT_MS } }, WIFI_SCAN_TIMEOUT_MS);
}

const nativeWifiOptions: WifiMutationOptions = {
	readTimeoutMs: EXEC_TIMEOUT_MS,
	scanTimeoutMs: WIFI_SCAN_TIMEOUT_MS,
	updateTimeoutMs: NETWORK_MANAGER_PROFILE_UPDATE_TIMEOUT_MS,
	activationTimeoutMs: NETWORK_MANAGER_MUTATION_TIMEOUT_MS,
	rollbackTimeoutMs: NETWORK_MANAGER_ROLLBACK_TIMEOUT_MS,
	checkpointSafetyMs: NETWORK_MANAGER_CHECKPOINT_SAFETY_MS,
	checkpointTimeoutSeconds: NETWORK_MANAGER_CHECKPOINT_TIMEOUT_SECONDS,
};

export async function connectLinuxWifi(device: string, ssid: string, password: string, bssid: string | null = null): Promise<void> {
	await connectNativeLinuxWifi(requireNativeMutationContext(), device, ssid, password, bssid, nativeWifiOptions);
}

/** Deactivate the device without removing its saved profiles. */
export async function disconnectLinuxWifi(device: string): Promise<void> {
	await disconnectNativeLinuxWifi(requireNativeMutationContext(), device, nativeWifiOptions);
}
