import { dlopen, FFIType, ptr, read, toArrayBuffer, type Pointer } from 'bun:ffi';
import type { NetAddress, NetInterfaceInfo, NetIPv4Config, NetMedium, NetLink, NetAddressMode, NetWifiInfo } from '@shared';

/**
 * Windows host network state.
 *
 * Two independent sources, both read-only:
 *
 * 1. A single `powershell.exe` one-shot ({@link WINDOWS_STATE_COMMAND}) that
 *    emits adapters, addresses, per-family DHCP mode, the IPv4 default route and
 *    the DNS servers as one compact JSON document. One spawn (1.4-1.8 s) instead
 *    of five, and every enum is projected to `[int]` so the parser never depends
 *    on the OS display language.
 * 2. `wlanapi.dll` through `bun:ffi` for the SSID / signal quality / radio state
 *    of Wi-Fi adapters, joined onto the PowerShell rows by interface GUID. There
 *    is no PowerShell cmdlet that reports signal quality, and `netsh wlan show
 *    interfaces` only prints a localized text table.
 *
 * Reading never mutates anything. Applying an IPv4 configuration goes through a
 * second, separate one-shot ({@link windowsApplyIPv4Command}) built only from
 * values the shared validator has already accepted.
 *
 * Wi-Fi on Windows is READ-ONLY here. Scanning and joining need either
 * WlanScan/WlanGetAvailableNetworkList/WlanConnect over this FFI surface or the
 * localized text tables of `netsh wlan`, and neither can be exercised on any
 * machine available to this project — every host reachable from it is wired.
 * Writing that blind would ship an unverified join path, so the capability is
 * reported as false and the UI does not offer it.
 */

// NDIS_PHYSICAL_MEDIUM values we can map with confidence (ntddndis.h). Anything
// else (tunnels, WAN miniports, Hyper-V switches, Bluetooth PAN) stays 'other'.
const NDIS_MEDIUM_NATIVE_802_11 = 9;
const NDIS_MEDIUM_802_3 = 14;
// NdisPhysicalMediumUnspecified. Very common on virtual NICs, so it means "the
// driver did not say", never "not a real adapter".
const NDIS_MEDIUM_UNSPECIFIED = 0;
// IANA ifType (RFC 1213): 6 ethernetCsmacd, 71 ieee80211.
const IF_TYPE_ETHERNET = 6;
const IF_TYPE_IEEE80211 = 71;
// MediaConnectionState (Get-NetAdapter): 0 Unknown, 1 Connected, 2 Disconnected.
const MEDIA_STATE_CONNECTED = 1;
const MEDIA_STATE_DISCONNECTED = 2;
// AddressFamily as projected by [int]: 2 = IPv4 (AF_INET), 23 = IPv6 (AF_INET6).
const AF_INET = 2;
const AF_INET6 = 23;
// AddressState (Get-NetIPAddress): 0 Invalid, 1 Tentative, 2 Duplicate, 3 Deprecated, 4 Preferred.
const ADDRESS_STATE_PREFERRED = 4;
// PrefixOrigin: 2 = WellKnown. SuffixOrigin: 4 = LinkLayerAddress.
// This exact pair identifies Windows' automatic IPv4 link-local fallback.
const PREFIX_ORIGIN_WELL_KNOWN = 2;
const SUFFIX_ORIGIN_LINK_LAYER = 4;
const ORIGIN_MANUAL = 1;
const ADDRESS_TYPE_UNICAST = 1;
const ROUTE_PUBLISH_NO = 0;
const ROUTE_PROTOCOL_NET_MGMT = 3;
/** Windows' empty automatic-DNS sentinel addresses, not usable resolvers. */
const AUTOMATIC_DNS_PLACEHOLDERS = new Set(['fec0:0:0:ffff::1', 'fec0:0:0:ffff::2', 'fec0:0:0:ffff::3']);
// NetIPInterface.Dhcp: 0 Disabled, 1 Enabled. NOTE the opposite convention to
// MediaConnectionState, where 1 means Connected — they must never be swapped.
const DHCP_ENABLED = 1;

/**
 * The single read-only PowerShell one-shot backing {@link parseWindowsNetworkState}.
 *
 * `@()` around every collection keeps ConvertTo-Json from collapsing a one-row
 * result into a bare object, and the DNS servers are joined into a plain string
 * because Windows PowerShell serializes an empty array inside a calculated
 * property as `{}` and a one-element array as a bare string.
 */
export const WINDOWS_STATE_COMMAND: string = ['[Console]::OutputEncoding=[System.Text.Encoding]::UTF8', '$ErrorActionPreference = "Stop"', "function Read-OptionalNetRows([scriptblock]$Query) { try { @(& $Query) } catch { if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { @() } else { throw } } }", "$adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop | Select-Object ifIndex, Name, InterfaceGuid, MacAddress, @{n='Media';e={[int]$_.NdisPhysicalMedium}}, @{n='IfType';e={[int]$_.InterfaceType}}, @{n='Hidden';e={[int]$_.Hidden}}, @{n='State';e={[int]$_.MediaConnectionState}})", "$addresses = @(Get-NetIPAddress -PolicyStore ActiveStore -ErrorAction Stop | Select-Object ifIndex, @{n='Family';e={[int]$_.AddressFamily}}, IPAddress, PrefixLength, @{n='State';e={[int]$_.AddressState}}, @{n='PrefixOrigin';e={[int]$_.PrefixOrigin}}, @{n='SuffixOrigin';e={[int]$_.SuffixOrigin}}, @{n='Type';e={[int]$_.Type}}, @{n='SkipAsSource';e={[bool]$_.SkipAsSource}}, @{n='Infinite';e={$_.ValidLifetime -eq [TimeSpan]::MaxValue -and $_.PreferredLifetime -eq [TimeSpan]::MaxValue}})", "$persistentAddresses = @(Read-OptionalNetRows { Get-NetIPAddress -AddressFamily IPv4 -PolicyStore PersistentStore -ErrorAction Stop } | Select-Object ifIndex, @{n='Family';e={[int]$_.AddressFamily}}, IPAddress, PrefixLength, @{n='State';e={[int]$_.AddressState}}, @{n='PrefixOrigin';e={[int]$_.PrefixOrigin}}, @{n='SuffixOrigin';e={[int]$_.SuffixOrigin}}, @{n='Type';e={[int]$_.Type}}, @{n='SkipAsSource';e={[bool]$_.SkipAsSource}}, @{n='Infinite';e={$_.ValidLifetime -eq [TimeSpan]::MaxValue -and $_.PreferredLifetime -eq [TimeSpan]::MaxValue}})", "$interfaces = @(Get-NetIPInterface -ErrorAction Stop | Select-Object ifIndex, @{n='Family';e={[int]$_.AddressFamily}}, @{n='Dhcp';e={[int]$_.Dhcp}})", "$routes = @(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop | Where-Object DestinationPrefix -eq '0.0.0.0/0' | Select-Object ifIndex, NextHop, RouteMetric, InterfaceMetric, @{n='Protocol';e={[int]$_.Protocol}}, @{n='Publish';e={[int]$_.Publish}}, @{n='Infinite';e={$_.ValidLifetime -eq [TimeSpan]::MaxValue}})", "$persistentRoutes = @(Read-OptionalNetRows { Get-NetRoute -AddressFamily IPv4 -PolicyStore PersistentStore -ErrorAction Stop } | Where-Object DestinationPrefix -eq '0.0.0.0/0' | Select-Object ifIndex, NextHop, RouteMetric, InterfaceMetric, @{n='Protocol';e={[int]$_.Protocol}}, @{n='Publish';e={[int]$_.Publish}}, @{n='Infinite';e={$_.ValidLifetime -eq [TimeSpan]::MaxValue}})", "$dns = @(Get-DnsClientServerAddress -ErrorAction Stop | Select-Object InterfaceIndex, @{n='Servers';e={($_.ServerAddresses -join ',')}})", '[pscustomobject]@{adapters=$adapters; addresses=$addresses; persistentAddresses=$persistentAddresses; interfaces=$interfaces; routes=$routes; persistentRoutes=$persistentRoutes; dns=$dns} | ConvertTo-Json -Depth 6 -Compress'].join('; ');

interface WindowsAdapterRow {
	ifIndex: number;
	Name: string;
	InterfaceGuid: string;
	MacAddress: string;
	Media: number;
	/** IANA interface type. Optional so a document captured before this field existed still parses. */
	IfType?: number;
	/** 1 when Windows hides the adapter from the network UI (miniports, tunnels). */
	Hidden?: number;
	State: number;
}
interface WindowsAddressRow {
	ifIndex: number;
	Family: number;
	IPAddress: string;
	PrefixLength: number;
	State: number;
	/** Optional so state documents captured before origin projection still parse. */
	PrefixOrigin?: number;
	SuffixOrigin?: number;
	Type?: number;
	SkipAsSource?: boolean;
	Infinite?: boolean;
}
interface WindowsInterfaceRow {
	ifIndex: number;
	Family: number;
	Dhcp: number;
}
interface WindowsRouteRow {
	ifIndex: number;
	NextHop: string;
	RouteMetric: number;
	InterfaceMetric?: number;
	Protocol?: number;
	Publish?: number;
	Infinite?: boolean;
}
interface WindowsDnsRow {
	InterfaceIndex: number;
	Servers: string;
}

/** ConvertTo-Json emits a bare object for a single row; normalize both shapes to an array. */
function asArray<T>(value: unknown): T[] {
	if (Array.isArray(value)) return value as T[];
	return value === null || value === undefined ? [] : [value as T];
}

/**
 * True for addresses that never identify the host on a network: IPv4 link-local
 * auto-configuration (APIPA, i.e. "DHCP did not answer") and loopback. Dropping
 * loopback also removes the adapterless pseudo-interface that owns it, which has
 * no business in an interface picker.
 */
function isUnusableAddress(address: string): boolean {
	return address.startsWith('169.254.') || address.startsWith('127.') || address === '::1';
}

/** Automatic APIPA may be ignored for edit-safety only when Windows proves its origin. */
function isAutomaticApipa(row: WindowsAddressRow): boolean {
	return row.IPAddress.startsWith('169.254.') && row.PrefixOrigin === PREFIX_ORIGIN_WELL_KNOWN && row.SuffixOrigin === SUFFIX_ORIGIN_LINK_LAYER;
}

/** True only when rollback can recreate the original static policy exactly. */
function isSimplePersistentStaticState(ifIndex: number, activeAddresses: WindowsAddressRow[], persistentAddresses: WindowsAddressRow[], activeRoutes: WindowsRouteRow[], persistentRoutes: WindowsRouteRow[]): boolean {
	const addresses = activeAddresses.filter(row => row.ifIndex === ifIndex && row.Family === AF_INET);
	const storedAddresses = persistentAddresses.filter(row => row.ifIndex === ifIndex && row.Family === AF_INET);
	const simpleAddress = (row: WindowsAddressRow): boolean => row.PrefixOrigin === ORIGIN_MANUAL && row.SuffixOrigin === ORIGIN_MANUAL && row.Type === ADDRESS_TYPE_UNICAST && row.SkipAsSource === false && row.Infinite === true;
	const sameAddress = (left: WindowsAddressRow, right: WindowsAddressRow): boolean => left.IPAddress === right.IPAddress && left.PrefixLength === right.PrefixLength;
	if (addresses.length !== storedAddresses.length || !addresses.every(simpleAddress) || !storedAddresses.every(simpleAddress) || !addresses.every(row => storedAddresses.some(stored => sameAddress(row, stored)))) return false;

	const routes = activeRoutes.filter(row => row.ifIndex === ifIndex);
	const storedRoutes = persistentRoutes.filter(row => row.ifIndex === ifIndex);
	const simpleRoute = (row: WindowsRouteRow): boolean => row.Protocol === ROUTE_PROTOCOL_NET_MGMT && row.Publish === ROUTE_PUBLISH_NO && row.Infinite === true;
	const sameRoute = (left: WindowsRouteRow, right: WindowsRouteRow): boolean => left.NextHop === right.NextHop && left.RouteMetric === right.RouteMetric;
	return routes.length === storedRoutes.length && routes.every(simpleRoute) && storedRoutes.every(simpleRoute) && routes.every(row => storedRoutes.some(stored => sameRoute(row, stored)));
}

/**
 * Decide the medium of a Windows adapter.
 *
 * `NdisPhysicalMedium` is authoritative when the driver fills it in, but a great
 * many do not: every VirtIO, Hyper-V and VMware NIC reports
 * NdisPhysicalMediumUnspecified (0), which used to make a virtual machine report
 * its only Ethernet card as `other` — and so made the footer widget say "state
 * unknown" on a host that was plainly plugged in.
 *
 * The fallback is the IANA interface type, which those drivers do fill in
 * correctly, restricted to adapters Windows does not hide. That restriction is
 * what keeps the WFP/WAN miniports out: they are ethernetCsmacd too, but they are
 * all `Hidden`, while real NICs are not.
 */
function mapMedium(media: number, ifType: number = 0, hidden: number = 0): NetMedium {
	if (media === NDIS_MEDIUM_802_3) return 'wired';
	if (media === NDIS_MEDIUM_NATIVE_802_11) return 'wireless';
	if (media === NDIS_MEDIUM_UNSPECIFIED && hidden === 0) {
		if (ifType === IF_TYPE_ETHERNET) return 'wired';
		if (ifType === IF_TYPE_IEEE80211) return 'wireless';
	}
	return 'other';
}

function mapLink(state: number): NetLink {
	if (state === MEDIA_STATE_CONNECTED) return 'up';
	if (state === MEDIA_STATE_DISCONNECTED) return 'down';
	return 'unknown';
}

/** Normalize `{GUID}` / `guid` to the canonical uppercase braced form used to join the Wi-Fi data. */
function normalizeGuid(guid: string): string {
	const bare = guid
		.trim()
		.replace(/^\{|\}$/g, '')
		.toUpperCase();
	return `{${bare}}`;
}

/**
 * Parse the JSON document produced by {@link WINDOWS_STATE_COMMAND} into interfaces.
 *
 * Addresses are LEFT-joined onto adapters by ifIndex: RAS/VPN stacks (WireGuard
 * wintun, Teredo) own an ifIndex that `Get-NetAdapter` does not report, and
 * dropping those rows would hide a live tunnel — they are kept as `other`.
 * APIPA and non-Preferred (tentative/deprecated/duplicate) addresses are dropped
 * because they are not addresses the host can actually be reached on.
 */
export function parseWindowsNetworkState(json: string, wifi: Map<string, NetWifiInfo> = new Map()): NetInterfaceInfo[] {
	const doc = JSON.parse(json) as Record<string, unknown>;
	for (const key of ['adapters', 'addresses', 'persistentAddresses', 'interfaces', 'routes', 'persistentRoutes', 'dns']) {
		if (!Object.prototype.hasOwnProperty.call(doc, key) || doc[key] === null) throw new Error(`incomplete Windows network state: missing ${key}`);
	}
	const adapters = asArray<WindowsAdapterRow>(doc['adapters']);
	const addresses = asArray<WindowsAddressRow>(doc['addresses']);
	const persistentAddresses = asArray<WindowsAddressRow>(doc['persistentAddresses']);
	const ipInterfaces = asArray<WindowsInterfaceRow>(doc['interfaces']);
	const routes = asArray<WindowsRouteRow>(doc['routes']);
	const persistentRoutes = asArray<WindowsRouteRow>(doc['persistentRoutes']);
	const dnsRows = asArray<WindowsDnsRow>(doc['dns']);

	const addressesByIndex = new Map<number, NetAddress[]>();
	const ipv4RowsByIndex = new Map<number, number>();
	const automaticApipaByIndex = new Map<number, number>();
	for (const row of addresses) {
		if (row.Family === AF_INET) {
			ipv4RowsByIndex.set(row.ifIndex, (ipv4RowsByIndex.get(row.ifIndex) ?? 0) + 1);
			if (isAutomaticApipa(row)) automaticApipaByIndex.set(row.ifIndex, (automaticApipaByIndex.get(row.ifIndex) ?? 0) + 1);
		}
		if (row.State !== ADDRESS_STATE_PREFERRED) continue;
		const family = row.Family === AF_INET ? 'ipv4' : row.Family === AF_INET6 ? 'ipv6' : null;
		if (!family) continue;
		// A scope suffix (`fe80::1%20`) is an addressing artifact, not part of the address.
		const address = row.IPAddress.split('%')[0] ?? row.IPAddress;
		if (!address || isUnusableAddress(address)) continue;
		const list = addressesByIndex.get(row.ifIndex) ?? [];
		list.push({ family, address, prefixLength: row.PrefixLength });
		addressesByIndex.set(row.ifIndex, list);
	}

	const dhcpByIndex = new Map<number, NetAddressMode>();
	for (const row of ipInterfaces) {
		if (row.Family !== AF_INET) continue;
		dhcpByIndex.set(row.ifIndex, row.Dhcp === DHCP_ENABLED ? 'dhcp' : 'static');
	}

	// Windows ranks competing default routes by RouteMetric PLUS the owning
	// interface's metric, not by RouteMetric alone — a VPN tunnel typically has
	// RouteMetric 0 and InterfaceMetric 5 against a NIC's 25, and comparing route
	// metrics alone would pick the wrong adapter on any multi-homed host.
	const effectiveMetric = (row: WindowsRouteRow): number => row.RouteMetric + (row.InterfaceMetric ?? 0);
	let best: WindowsRouteRow | null = null;
	for (const row of routes) if (!best || effectiveMetric(row) < effectiveMetric(best)) best = row;
	const defaultIndex = best?.ifIndex ?? null;
	const routesByIndex = new Map<number, WindowsRouteRow[]>();
	for (const row of routes) {
		const list = routesByIndex.get(row.ifIndex) ?? [];
		list.push(row);
		routesByIndex.set(row.ifIndex, list);
	}

	const dnsByIndex = new Map<number, string[]>();
	for (const row of dnsRows) {
		const servers = (row.Servers ?? '')
			.split(',')
			.map(s => s.trim())
			.filter(s => s.length > 0 && !AUTOMATIC_DNS_PLACEHOLDERS.has(s.toLowerCase()));
		if (servers.length > 0) dnsByIndex.set(row.InterfaceIndex, [...(dnsByIndex.get(row.InterfaceIndex) ?? []), ...servers]);
	}

	const result: NetInterfaceInfo[] = [];
	const seen = new Set<number>();
	for (const adapter of adapters) {
		seen.add(adapter.ifIndex);
		result.push(buildInterface(adapter.ifIndex, adapter.Name, mapMedium(adapter.Media, adapter.IfType, adapter.Hidden), mapLink(adapter.State), adapter.MacAddress, adapter.InterfaceGuid ? normalizeGuid(adapter.InterfaceGuid) : null));
	}
	// Addressed stacks with no adapter row (RAS/VPN) — keep them, medium unknown.
	for (const ifIndex of addressesByIndex.keys()) {
		if (seen.has(ifIndex)) continue;
		result.push(buildInterface(ifIndex, `#${ifIndex}`, 'other', 'unknown', '', null));
	}
	return result;

	function buildInterface(ifIndex: number, name: string, medium: NetMedium, link: NetLink, mac: string, guid: string | null): NetInterfaceInfo {
		const interfaceAddresses = addressesByIndex.get(ifIndex) ?? [];
		const interfaceRoutes = routesByIndex.get(ifIndex) ?? [];
		const ipv4Mode = dhcpByIndex.get(ifIndex) ?? 'unknown';
		const ipv4RowCount = (ipv4RowsByIndex.get(ifIndex) ?? 0) - (ipv4Mode === 'dhcp' ? (automaticApipaByIndex.get(ifIndex) ?? 0) : 0);
		const radio = medium === 'wireless' && guid ? wifi.get(guid) : undefined;
		const info: NetInterfaceInfo = {
			// The GUID (registry NetCfgInstanceId) survives reboots and adapter
			// disable/enable; ifIndex explicitly does not, and the id is persisted as
			// the user's primary-interface preference. ifIndex is still what the
			// PowerShell rows are joined on, it just never leaves this function.
			id: guid ?? `ifIndex:${ifIndex}`,
			name,
			medium,
			link,
			defaultRoute: ifIndex === defaultIndex,
			mac: mac && mac.length > 0 ? mac : null,
			addresses: interfaceAddresses,
			ipv4Mode,
			ipv4Configurable: guid !== null && ipv4Mode !== 'unknown' && ipv4RowCount === interfaceAddresses.filter(address => address.family === 'ipv4').length && ipv4RowCount <= 1 && interfaceRoutes.length <= 1 && (ipv4Mode !== 'static' || isSimplePersistentStaticState(ifIndex, addresses, persistentAddresses, routes, persistentRoutes)) && (medium !== 'wireless' || radio !== undefined),
			wifiConfigurable: false,
			gateway: interfaceRoutes[0]?.NextHop ?? null,
			dns: dnsByIndex.get(ifIndex) ?? [],
		};
		// Wi-Fi Direct virtual adapters also report medium 9 but have no WLAN
		// interface of their own, so an absent entry leaves `wifi` undefined.
		if (radio) info.wifi = radio;
		return info;
	}
}

// ---------------------------------------------------------------------------
// wlanapi.dll (SSID / signal quality / radio state)
// ---------------------------------------------------------------------------

/** WLAN_INTERFACE_INFO: GUID(16) + WCHAR strInterfaceDescription[256] (512) + WLAN_INTERFACE_STATE(4). */
const WLAN_INTERFACE_INFO_SIZE = 532;
/** Offset of the first WLAN_INTERFACE_INFO inside WLAN_INTERFACE_INFO_LIST (dwNumberOfItems + dwIndex). */
const WLAN_INTERFACE_LIST_HEADER = 8;
/** wlan_intf_opcode_radio_state. */
const OPCODE_RADIO_STATE = 4;
/** wlan_intf_opcode_current_connection. */
const OPCODE_CURRENT_CONNECTION = 7;
/** DOT11_RADIO_STATE: 0 unknown, 1 on, 2 off. */
const RADIO_ON = 1;
const RADIO_OFF = 2;
/** ERROR_INVALID_STATE — the adapter is simply not associated. Not a failure. */
const ERROR_INVALID_STATE = 5023;
/** WLAN_CONNECTION_ATTRIBUTES: isState(4) + wlanConnectionMode(4) + strProfileName[256] (512) = 520. */
const CONN_ASSOCIATION_OFFSET = 520;
/** WLAN_ASSOCIATION_ATTRIBUTES: DOT11_SSID = ULONG uSSIDLength + UCHAR ucSSID[32]. */
const ASSOC_SSID_LENGTH_OFFSET = CONN_ASSOCIATION_OFFSET;
const ASSOC_SSID_OFFSET = CONN_ASSOCIATION_OFFSET + 4;
/** WLAN_ASSOCIATION_ATTRIBUTES: ssid(36) + bssType(4) + bssid(6, padded to 8) + phyType(4) + phyIndex(4) = 56. */
const ASSOC_SIGNAL_QUALITY_OFFSET = CONN_ASSOCIATION_OFFSET + 56;
/** DOT11_SSID caps the SSID at 32 octets — a longer value means we read the wrong offset. */
const MAX_SSID_LENGTH = 32;

interface WlanApi {
	WlanOpenHandle: (version: number, reserved: null, negotiated: Pointer, handle: Pointer) => number;
	WlanCloseHandle: (handle: Pointer, reserved: null) => number;
	WlanEnumInterfaces: (handle: Pointer, reserved: null, list: Pointer) => number;
	WlanQueryInterface: (handle: Pointer, guid: Pointer, opcode: number, reserved: null, size: Pointer, data: Pointer, valueType: Pointer) => number;
	WlanFreeMemory: (memory: Pointer) => void;
}

let wlanApi: WlanApi | null = null;
let wlanUnavailable = false;

/** Load wlanapi.dll once. Returns null on a host without the WLAN stack (Server Core, stripped images). */
function getWlanApi(): WlanApi | null {
	if (wlanUnavailable) return null;
	if (!wlanApi) {
		try {
			const lib = dlopen('wlanapi.dll', {
				WlanOpenHandle: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
				WlanCloseHandle: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
				WlanEnumInterfaces: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
				WlanQueryInterface: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
				WlanFreeMemory: { args: [FFIType.ptr], returns: FFIType.void },
			});
			wlanApi = lib.symbols as unknown as WlanApi;
		} catch {
			wlanUnavailable = true;
			return null;
		}
	}
	return wlanApi;
}

/** Format the 16 raw GUID bytes at `offset` as the canonical `{XXXXXXXX-XXXX-...}` string Windows prints. */
function guidToString(base: Pointer, offset: number): string {
	const bytes = new Uint8Array(toArrayBuffer(base, offset, 16));
	const hex = (i: number): string => bytes[i]!.toString(16).padStart(2, '0').toUpperCase();
	const d1 = `${hex(3)}${hex(2)}${hex(1)}${hex(0)}`;
	const d2 = `${hex(5)}${hex(4)}`;
	const d3 = `${hex(7)}${hex(6)}`;
	const d4 = `${hex(8)}${hex(9)}`;
	let d5 = '';
	for (let i = 10; i < 16; i++) d5 += hex(i);
	return `{${d1}-${d2}-${d3}-${d4}-${d5}}`;
}

/**
 * Decide the radio state from a WLAN_RADIO_STATE buffer.
 *
 * The struct is `DWORD dwNumberOfPhys` followed by up to 64
 * `WLAN_PHY_RADIO_STATE { dwPhyIndex; softwareRadioState; hardwareRadioState }`
 * entries. A phy is usable only when BOTH switches are on, and the adapter as a
 * whole is on as soon as one phy is usable (verified live against a 6-phy
 * MediaTek adapter with the software radio killed: soft=2, hard=1 → 'off').
 */
function readRadioState(data: Pointer, size: number): NetWifiInfo['radio'] {
	const phys = Math.min(read.u32(data, 0), Math.floor(Math.max(0, size - 4) / 12));
	let sawOff = false;
	for (let i = 0; i < phys; i++) {
		const base = 4 + i * 12;
		const software = read.u32(data, base + 4);
		const hardware = read.u32(data, base + 8);
		if (software === RADIO_ON && hardware === RADIO_ON) return 'on';
		if (software === RADIO_OFF || hardware === RADIO_OFF) sawOff = true;
	}
	return sawOff ? 'off' : 'unknown';
}

/**
 * Extract the SSID and signal quality from a WLAN_CONNECTION_ATTRIBUTES buffer.
 *
 * The struct offsets are documentation-derived — the machine this was written on
 * had its Wi-Fi radio soft-killed and associating would have been a mutation, so
 * they could not be confirmed against a populated struct. The sanity gate below
 * is what makes that acceptable: an out-of-range signal or SSID length yields
 * `null` (widget renders "unknown"), never a plausible-looking wrong percentage.
 */
export function readConnectionAttributes(data: Pointer, size: number): { ssid: string | null; signal: number | null } {
	if (size < ASSOC_SIGNAL_QUALITY_OFFSET + 4) return { ssid: null, signal: null };
	const signalRaw = read.u32(data, ASSOC_SIGNAL_QUALITY_OFFSET);
	const ssidLength = read.u32(data, ASSOC_SSID_LENGTH_OFFSET);
	if (signalRaw > 100 || ssidLength > MAX_SSID_LENGTH) return { ssid: null, signal: null };
	const ssidBytes = new Uint8Array(toArrayBuffer(data, ASSOC_SSID_OFFSET, MAX_SSID_LENGTH)).subarray(0, ssidLength);
	const ssid = ssidLength > 0 ? new TextDecoder().decode(ssidBytes) : null;
	return { ssid, signal: signalRaw };
}

/**
 * Read the Wi-Fi state of every WLAN adapter, keyed by canonical interface GUID.
 * Returns an empty map when the WLAN service is not running or the DLL is absent
 * — the caller then leaves `wifi` undefined rather than guessing.
 */
export function readWindowsWifi(): Map<string, NetWifiInfo> {
	const result = new Map<string, NetWifiInfo>();
	const api = getWlanApi();
	if (!api) return result;
	const negotiated = new Uint32Array(1);
	const handleOut = new BigUint64Array(1);
	// Client version 2 = Vista and later; every supported Windows negotiates it.
	if (api.WlanOpenHandle(2, null, ptr(negotiated), ptr(handleOut)) !== 0) return result;
	const handle = Number(handleOut[0]) as Pointer;
	try {
		const listOut = new BigUint64Array(1);
		if (api.WlanEnumInterfaces(handle, null, ptr(listOut)) !== 0) return result;
		const list = Number(listOut[0]) as Pointer;
		try {
			const count = read.u32(list, 0);
			for (let i = 0; i < count; i++) {
				const base = WLAN_INTERFACE_LIST_HEADER + i * WLAN_INTERFACE_INFO_SIZE;
				const guid = guidToString(list, base);
				const guidPtr = ((list as unknown as number) + base) as unknown as Pointer;
				const radio = query(guidPtr, OPCODE_RADIO_STATE, readRadioState) ?? 'unknown';
				const connection = query(guidPtr, OPCODE_CURRENT_CONNECTION, readConnectionAttributes);
				result.set(guid, { ssid: connection?.ssid ?? null, signal: connection?.signal ?? null, radio });
			}
		} finally {
			api.WlanFreeMemory(list);
		}
	} finally {
		api.WlanCloseHandle(handle, null);
	}
	return result;

	/**
	 * Run one WlanQueryInterface and map the returned buffer, freeing it afterwards.
	 * A non-zero result yields null; the common one is ERROR_INVALID_STATE
	 * ({@link ERROR_INVALID_STATE}), which just means the adapter is not associated
	 * and is not worth logging.
	 */
	function query<T>(guidPtr: Pointer, opcode: number, map: (data: Pointer, size: number) => T): T | null {
		const size = new Uint32Array(1);
		const dataOut = new BigUint64Array(1);
		const valueType = new Uint32Array(1);
		const rc = api!.WlanQueryInterface(handle, guidPtr, opcode, null, ptr(size), ptr(dataOut), ptr(valueType));
		if (rc !== 0) return null;
		const data = Number(dataOut[0]) as Pointer;
		try {
			return map(data, size[0]!);
		} finally {
			api!.WlanFreeMemory(data);
		}
	}
}

/**
 * Canonical braced GUID — the shape {@link normalizeGuid} produces and the only
 * thing ever interpolated into a PowerShell script. Anything else is rejected
 * before a child process is spawned.
 */
const GUID_PATTERN = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/i;

/** True when an interface id is a well-formed adapter GUID. */
export function isWindowsInterfaceID(id: string): boolean {
	return GUID_PATTERN.test(id);
}

/**
 * Build the PowerShell one-shot that applies an IPv4 configuration.
 *
 * The interface is resolved by GUID rather than by name because `netsh` and the
 * `-InterfaceAlias` parameters take a localized, user-renameable string, while
 * the GUID is what the reader already reports as the interface id.
 *
 * The existing address and default route are removed first so a repeated apply
 * cannot stack a second address on the adapter — `New-NetIPAddress` adds, it does
 * not replace. Both removals tolerate "there was nothing there", which is the
 * normal state of an adapter currently on DHCP.
 *
 * Every interpolated value has been through the shared validator, so each one is
 * a dotted-quad literal, a small integer, or a GUID. No quoting rule protects
 * this string — the validation does.
 */
export function windowsApplyIPv4Command(guid: string, config: NetIPv4Config, addressingChanged: boolean = true): string {
	const prefix = ['[Console]::OutputEncoding=[System.Text.Encoding]::UTF8', '$ErrorActionPreference = "Stop"', `$adapter = Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceGuid -eq '${guid}' }`, 'if (-not $adapter) { throw "interface not found" }', '$i = $adapter.ifIndex'];
	const dnsStep = config.dns === undefined ? null : config.dns.length > 0 ? `Set-DnsClientServerAddress -InterfaceIndex $i -ServerAddresses ${config.dns.map(server => `'${server}'`).join(',')}` : 'Set-DnsClientServerAddress -InterfaceIndex $i -ResetServerAddresses';
	const dnsSnapshot = ['$oldDns4 = @(Get-DnsClientServerAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction Stop)', '$oldDns6 = @(Get-DnsClientServerAddress -InterfaceIndex $i -AddressFamily IPv6 -ErrorAction Stop)', 'if ($oldDns4.Count -eq 0 -or $oldDns6.Count -eq 0) { throw "DNS state is incomplete" }', '$oldDnsServers4 = @($oldDns4.ServerAddresses | Where-Object { $_ })', '$oldDnsServers6 = @($oldDns6.ServerAddresses | Where-Object { $_ })', '$dnsKey4 = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$($adapter.InterfaceGuid)"', '$dnsKey6 = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters\\Interfaces\\$($adapter.InterfaceGuid)"', '$oldDnsNameServer4 = [string](Get-ItemProperty -LiteralPath $dnsKey4 -ErrorAction SilentlyContinue).NameServer', '$oldDnsNameServer6 = [string](Get-ItemProperty -LiteralPath $dnsKey6 -ErrorAction SilentlyContinue).NameServer', '$oldDnsAutomatic4 = [string]::IsNullOrWhiteSpace($oldDnsNameServer4)', '$oldDnsAutomatic6 = [string]::IsNullOrWhiteSpace($oldDnsNameServer6)'];
	const dnsRollback = ['if ($oldDnsAutomatic4) { Set-DnsClientServerAddress -InputObject $oldDns4 -ResetServerAddresses } else { Set-DnsClientServerAddress -InputObject $oldDns4 -ServerAddresses $oldDnsServers4 }', 'if ($oldDnsAutomatic6) { Set-DnsClientServerAddress -InputObject $oldDns6 -ResetServerAddresses } else { Set-DnsClientServerAddress -InputObject $oldDns6 -ServerAddresses $oldDnsServers6 }'];
	const dnsVerify = config.dns === undefined ? [] : config.dns.length === 0 ? ['$appliedDnsNameServer4 = [string](Get-ItemProperty -LiteralPath $dnsKey4 -ErrorAction SilentlyContinue).NameServer', '$appliedDnsNameServer6 = [string](Get-ItemProperty -LiteralPath $dnsKey6 -ErrorAction SilentlyContinue).NameServer', 'if (-not [string]::IsNullOrWhiteSpace($appliedDnsNameServer4) -or -not [string]::IsNullOrWhiteSpace($appliedDnsNameServer6)) { throw "DNS apply did not restore automatic policy" }'] : [`$expectedDns = @(${config.dns.map(server => `'${server}'`).join(',')}) | Sort-Object -Unique`, '$appliedDns = @(Get-DnsClientServerAddress -InterfaceIndex $i -ErrorAction Stop | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Sort-Object -Unique)', 'if (@(Compare-Object -ReferenceObject $expectedDns -DifferenceObject $appliedDns).Count -ne 0) { throw "DNS apply did not set the requested servers" }', '$appliedDnsNameServer4 = [string](Get-ItemProperty -LiteralPath $dnsKey4 -ErrorAction SilentlyContinue).NameServer', '$appliedDnsNameServer6 = [string](Get-ItemProperty -LiteralPath $dnsKey6 -ErrorAction SilentlyContinue).NameServer', 'if ([string]::IsNullOrWhiteSpace($appliedDnsNameServer4) -and [string]::IsNullOrWhiteSpace($appliedDnsNameServer6)) { throw "DNS apply did not set manual policy" }'];
	if (!addressingChanged) {
		if (!dnsStep) return prefix.join('; ');
		const rollback = ['$applyError = $_', 'try {', ...dnsRollback, '} catch { throw "network apply failed: $($applyError.Exception.Message); rollback failed: $($_.Exception.Message)" }', 'throw $applyError'];
		return [...prefix, ...dnsSnapshot, `try { ${[dnsStep, ...dnsVerify].join('; ')} } catch { ${rollback.join('; ')} }`].join('; ');
	}

	const snapshot = ['$oldAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.InterfaceIndex -eq $i })', "$oldRoutes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.InterfaceIndex -eq $i -and $_.DestinationPrefix -eq '0.0.0.0/0' })", '$oldDhcp = (Get-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction Stop).Dhcp', '$oldDhcpNeedsAddress = $oldDhcp -eq "Enabled" -and @($oldAddresses | Where-Object { $_.AddressState -eq "Preferred" -and $_.IPAddress -notlike "169.254.*" }).Count -gt 0', '$oldDhcpNeedsRoute = $oldDhcp -eq "Enabled" -and $oldRoutes.Count -gt 0', ...dnsSnapshot];
	const apply = ['if ($oldAddresses.Count -gt 0) { $oldAddresses | Remove-NetIPAddress -Confirm:$false -ErrorAction Stop }', 'if ($oldRoutes.Count -gt 0) { $oldRoutes | Remove-NetRoute -Confirm:$false -ErrorAction Stop }'];
	if (config.mode === 'dhcp') {
		apply.push('Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Enabled', '$deadline = [DateTime]::UtcNow.AddSeconds(20); do { $appliedAddresses = @(Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.AddressState -eq "Preferred" -and $_.IPAddress -notlike "169.254.*" }); if ($appliedAddresses.Count -gt 0) { break }; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $deadline); if ($appliedAddresses.Count -eq 0) { throw "DHCP apply did not obtain a usable lease" }');
	} else {
		apply.push('Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Disabled', `New-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -IPAddress ${config.address} -PrefixLength ${config.prefixLength} | Out-Null`, `$deadline = [DateTime]::UtcNow.AddSeconds(10); do { $addressState = (Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -IPAddress ${config.address} -ErrorAction SilentlyContinue).AddressState; if ($addressState -eq 'Preferred') { break }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $deadline); if ($addressState -ne 'Preferred') { throw 'IPv4 address did not become usable' }`);
		if (config.gateway) apply.push(`$routeMetric = ($oldRoutes | Select-Object -First 1).RouteMetric; if ($null -eq $routeMetric) { New-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -NextHop ${config.gateway} | Out-Null } else { New-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -NextHop ${config.gateway} -RouteMetric $routeMetric | Out-Null }`);
		apply.push(`$appliedAddresses = @(Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction Stop); if ($appliedAddresses.Count -ne 1 -or $appliedAddresses[0].IPAddress -ne '${config.address}' -or $appliedAddresses[0].PrefixLength -ne ${config.prefixLength}) { throw "IPv4 apply did not preserve the requested address" }`, "$appliedRoutes = @(Get-NetRoute -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' })", config.gateway ? `if ($appliedRoutes.Count -ne 1 -or $appliedRoutes[0].NextHop -ne '${config.gateway}') { throw "IPv4 apply did not preserve the requested gateway" }` : 'if ($appliedRoutes.Count -ne 0) { throw "IPv4 apply kept an unexpected default route" }');
	}
	if (dnsStep) apply.push(dnsStep);
	apply.push(...dnsVerify);
	const rollback = ['$applyError = $_', 'try {', '$currentAddresses = @(Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue); if ($currentAddresses.Count -gt 0) { $currentAddresses | Remove-NetIPAddress -Confirm:$false -ErrorAction Stop }', "$currentRoutes = @(Get-NetRoute -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' }); if ($currentRoutes.Count -gt 0) { $currentRoutes | Remove-NetRoute -Confirm:$false -ErrorAction Stop }", 'if ($oldDhcp -eq "Enabled") { Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Enabled; if ($oldDhcpNeedsAddress -or $oldDhcpNeedsRoute) { $deadline = [DateTime]::UtcNow.AddSeconds(20); do { $restoredAddresses = @(Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.AddressState -eq "Preferred" -and $_.IPAddress -notlike "169.254.*" }); $restoredRoutes = @(Get-NetRoute -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -eq "0.0.0.0/0" }); $addressReady = -not $oldDhcpNeedsAddress -or $restoredAddresses.Count -gt 0; $routeReady = -not $oldDhcpNeedsRoute -or $restoredRoutes.Count -gt 0; if ($addressReady -and $routeReady) { break }; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $deadline); if (-not ($addressReady -and $routeReady)) { throw "DHCP rollback did not restore a usable lease" } } } else { Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Disabled; foreach ($address in $oldAddresses) { New-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -IPAddress $address.IPAddress -PrefixLength $address.PrefixLength | Out-Null; $deadline = [DateTime]::UtcNow.AddSeconds(10); do { $restoredState = (Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -IPAddress $address.IPAddress -ErrorAction SilentlyContinue).AddressState; if ($restoredState -eq "Duplicate") { throw "restored IPv4 address is duplicate" }; if ($restoredState -eq "Preferred") { break }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $deadline); if ($restoredState -ne "Preferred") { throw "restored IPv4 address did not become usable" } }; foreach ($route in $oldRoutes) { New-NetRoute -InterfaceIndex $i -DestinationPrefix $route.DestinationPrefix -NextHop $route.NextHop -RouteMetric $route.RouteMetric | Out-Null } }', ...dnsRollback, '} catch { throw "network apply failed: $($applyError.Exception.Message); rollback failed: $($_.Exception.Message)" }', 'throw $applyError'];
	return [...prefix, ...snapshot, `try { ${apply.join('; ')} } catch { ${rollback.join('; ')} }`].join('; ');
}

/**
 * One-shot that answers whether this process holds an elevated token.
 *
 * Applying an address needs it: measured on a standard account, the very first
 * privileged step answers "Access is denied" and nothing is changed. Being an
 * administrator is not enough on its own — with UAC split tokens a member of the
 * Administrators group still runs unelevated, and the write fails just the same,
 * so the role check has to be against the CURRENT token rather than the account.
 */
export const WINDOWS_ELEVATION_COMMAND: string = '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';

/** True when the one-shot above reported an elevated token. */
export function parseElevation(stdout: string): boolean {
	return stdout.trim().toLowerCase() === 'true';
}
