import { dlopen, FFIType, ptr, read, toArrayBuffer, type Pointer } from 'bun:ffi';
import { isWifiHexKey, validateIPv4Config, type NetAddress, type NetInterfaceInfo, type NetIPv4Config, type NetMedium, type NetLink, type NetAddressMode, type NetWifiInfo, type NetWifiNetwork } from '@shared';

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
 * Wi-Fi scanning and joining use the same `wlanapi.dll` surface (WlanScan,
 * WlanGetAvailableNetworkList, WlanSetProfile, WlanConnect) rather than `netsh
 * wlan`, whose output is a localized text table that would have to be re-parsed
 * per display language.
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
export const WINDOWS_STATE_COMMAND: string = ['[Console]::OutputEncoding=[System.Text.Encoding]::UTF8', '$ErrorActionPreference = "Stop"', "function Read-OptionalNetRows([scriptblock]$Query) { try { @(& $Query) } catch { if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { @() } else { throw } } }", "$adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop | Select-Object ifIndex, Name, InterfaceGuid, MacAddress, @{n='Media';e={[int]$_.NdisPhysicalMedium}}, @{n='IfType';e={[int]$_.InterfaceType}}, @{n='Hidden';e={[int]$_.Hidden}}, @{n='State';e={[int]$_.MediaConnectionState}})", "$addresses = @(Get-NetIPAddress -PolicyStore ActiveStore -ErrorAction Stop | Select-Object ifIndex, @{n='Family';e={[int]$_.AddressFamily}}, IPAddress, PrefixLength, @{n='State';e={[int]$_.AddressState}}, @{n='PrefixOrigin';e={[int]$_.PrefixOrigin}}, @{n='SuffixOrigin';e={[int]$_.SuffixOrigin}}, @{n='Type';e={[int]$_.Type}}, @{n='SkipAsSource';e={[bool]$_.SkipAsSource}}, @{n='Infinite';e={$_.ValidLifetime -eq [TimeSpan]::MaxValue -and $_.PreferredLifetime -eq [TimeSpan]::MaxValue}})", "$persistentAddresses = @(Read-OptionalNetRows { Get-NetIPAddress -AddressFamily IPv4 -PolicyStore PersistentStore -ErrorAction Stop } | Select-Object ifIndex, @{n='Family';e={[int]$_.AddressFamily}}, IPAddress, PrefixLength, @{n='State';e={[int]$_.AddressState}}, @{n='PrefixOrigin';e={[int]$_.PrefixOrigin}}, @{n='SuffixOrigin';e={[int]$_.SuffixOrigin}}, @{n='Type';e={[int]$_.Type}}, @{n='SkipAsSource';e={[bool]$_.SkipAsSource}}, @{n='Infinite';e={$_.ValidLifetime -eq [TimeSpan]::MaxValue -and $_.PreferredLifetime -eq [TimeSpan]::MaxValue}})", "$interfaces = @(Get-NetIPInterface -ErrorAction Stop | Select-Object ifIndex, @{n='Family';e={[int]$_.AddressFamily}}, @{n='Dhcp';e={[int]$_.Dhcp}})", "$routes = @(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop | Where-Object DestinationPrefix -eq '0.0.0.0/0' | Select-Object ifIndex, NextHop, RouteMetric, InterfaceMetric, @{n='Protocol';e={[int]$_.Protocol}}, @{n='Publish';e={[int]$_.Publish}}, @{n='Infinite';e={$_.ValidLifetime -eq [TimeSpan]::MaxValue}})", "$persistentRoutes = @(Read-OptionalNetRows { Get-NetRoute -AddressFamily IPv4 -PolicyStore PersistentStore -ErrorAction Stop } | Where-Object DestinationPrefix -eq '0.0.0.0/0' | Select-Object ifIndex, NextHop, RouteMetric, InterfaceMetric, @{n='Protocol';e={[int]$_.Protocol}}, @{n='Publish';e={[int]$_.Publish}}, @{n='Infinite';e={$_.ValidLifetime -eq [TimeSpan]::MaxValue}})", "$routes6 = @(Read-OptionalNetRows { Get-NetRoute -AddressFamily IPv6 -PolicyStore ActiveStore -ErrorAction Stop } | Where-Object DestinationPrefix -eq '::/0' | Select-Object ifIndex, RouteMetric, InterfaceMetric)", "$dns = @(Get-DnsClientServerAddress -ErrorAction Stop | Select-Object InterfaceIndex, @{n='Servers';e={($_.ServerAddresses -join ',')}})", '[pscustomobject]@{adapters=$adapters; addresses=$addresses; persistentAddresses=$persistentAddresses; interfaces=$interfaces; routes=$routes; routes6=$routes6; persistentRoutes=$persistentRoutes; dns=$dns} | ConvertTo-Json -Depth 6 -Compress'].join('; ');

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
	const routes6 = asArray<WindowsRouteRow>(doc['routes6']);
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
	const lowestMetric = (rows: WindowsRouteRow[]): WindowsRouteRow | null => {
		let best: WindowsRouteRow | null = null;
		for (const row of rows) if (!best || effectiveMetric(row) < effectiveMetric(best)) best = row;
		return best;
	};
	// A host reachable only over IPv6 still has a default route, just not an IPv4
	// one, and the footer would otherwise call a working connection "disconnected"
	// because the automatic pick had nothing to point at. The IPv4 route stays
	// first: everything this screen edits is IPv4. Only this flag looks at IPv6 —
	// the gateway and the editability rules keep reading the IPv4 rows alone.
	const defaultIndex = (lowestMetric(routes) ?? lowestMetric(routes6))?.ifIndex ?? null;
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
		const visibleIPv4 = interfaceAddresses.filter(address => address.family === 'ipv4');
		const staticShapeSafe = ipv4Mode !== 'static' || (visibleIPv4.length === 1 && validateIPv4Config({ mode: 'static', address: visibleIPv4[0]!.address, prefixLength: visibleIPv4[0]!.prefixLength, gateway: interfaceRoutes[0]?.NextHop ?? '' }) === null);
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
			ipv4Configurable: guid !== null && ipv4Mode !== 'unknown' && staticShapeSafe && ipv4RowCount === visibleIPv4.length && ipv4RowCount <= 1 && interfaceRoutes.length <= 1 && (ipv4Mode !== 'static' || isSimplePersistentStaticState(ifIndex, addresses, persistentAddresses, routes, persistentRoutes)) && (medium !== 'wireless' || radio !== undefined),
			// Scanning and joining go through the WLAN service, which needs no elevated
			// token - an adapter the service lists is one it can drive. The IPv4 rules
			// above are unrelated: an adapter whose addressing this app will not touch
			// can still be asked to join a network.
			wifiConfigurable: medium === 'wireless' && guid !== null && radio !== undefined,
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
/** WLAN_CONNECTION_ATTRIBUTES.isState is the first member. */
const CONN_STATE_OFFSET = 0;
/** WLAN_INTERFACE_STATE: 1 = wlan_interface_state_connected. Every other value is on the way to or from it. */
const INTERFACE_STATE_CONNECTED = 1;
/** WLAN_ASSOCIATION_ATTRIBUTES: DOT11_SSID = ULONG uSSIDLength + UCHAR ucSSID[32]. */
const ASSOC_SSID_LENGTH_OFFSET = CONN_ASSOCIATION_OFFSET;
const ASSOC_SSID_OFFSET = CONN_ASSOCIATION_OFFSET + 4;
/** WLAN_ASSOCIATION_ATTRIBUTES: ssid(36) + bssType(4) + bssid(6, padded to 8) + phyType(4) + phyIndex(4) = 56. */
const ASSOC_SIGNAL_QUALITY_OFFSET = CONN_ASSOCIATION_OFFSET + 56;
/** DOT11_SSID caps the SSID at 32 octets — a longer value means we read the wrong offset. */
const MAX_SSID_LENGTH = 32;

/**
 * A Windows HANDLE is an opaque 64-bit value, not a virtual address, so it is
 * declared to the FFI as `u64` and carried as a bigint. Declaring it as `ptr`
 * happens to work while handle values stay small, but nothing guarantees that.
 */
type WlanHandle = bigint;

interface WlanApi {
	WlanOpenHandle: (version: number, reserved: null, negotiated: Pointer, handle: Pointer) => number;
	WlanCloseHandle: (handle: WlanHandle, reserved: null) => number;
	WlanEnumInterfaces: (handle: WlanHandle, reserved: null, list: Pointer) => number;
	WlanQueryInterface: (handle: WlanHandle, guid: Pointer, opcode: number, reserved: null, size: Pointer, data: Pointer, valueType: Pointer) => number;
	WlanScan: (handle: WlanHandle, guid: Pointer, ssid: null, ieData: null, reserved: null) => number;
	WlanGetAvailableNetworkList: (handle: WlanHandle, guid: Pointer, flags: number, reserved: null, list: Pointer) => number;
	WlanSetProfile: (handle: WlanHandle, guid: Pointer, flags: number, xml: Pointer, security: null, overwrite: number, reserved: null, reasonCode: Pointer) => number;
	WlanGetProfile: (handle: WlanHandle, guid: Pointer, name: Pointer, reserved: null, xml: Pointer, flags: Pointer, access: null) => number;
	WlanDeleteProfile: (handle: WlanHandle, guid: Pointer, name: Pointer, reserved: null) => number;
	WlanGetProfileCustomUserData: (handle: WlanHandle, guid: Pointer, name: Pointer, reserved: null, size: Pointer, data: Pointer) => number;
	WlanSetProfileCustomUserData: (handle: WlanHandle, guid: Pointer, name: Pointer, size: number, data: Pointer | null, reserved: null) => number;
	WlanConnect: (handle: WlanHandle, guid: Pointer, parameters: Pointer, reserved: null) => number;
	WlanReasonCodeToString: (reason: number, size: number, buffer: Pointer, reserved: null) => number;
	WlanFreeMemory: (memory: Pointer) => void;
}

/** One FFI symbol declaration: the ABI of each parameter, and of the result. */
export interface WlanSymbol {
	readonly args: readonly FFIType[];
	readonly returns: FFIType;
}

/**
 * The wlanapi.dll symbol table handed to `dlopen`.
 *
 * Lifted out of {@link getWlanApi} so the declared ABI of each parameter is a
 * value a test can assert rather than a literal buried inside a lazy loader.
 *
 * Every leading `HANDLE` is {@link FFIType.u64}, never `ptr` — see
 * {@link WlanHandle}. `WlanOpenHandle`'s fourth argument is the exception that
 * proves it: that one really is a pointer, to the caller's output buffer.
 */
export const WLAN_SYMBOLS: Record<keyof WlanApi, WlanSymbol> = {
	WlanOpenHandle: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanCloseHandle: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
	WlanEnumInterfaces: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanQueryInterface: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanScan: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanGetAvailableNetworkList: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanSetProfile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanGetProfile: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanDeleteProfile: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanGetProfileCustomUserData: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanSetProfileCustomUserData: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanConnect: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	// The one entry point here that takes no handle at all: a reason code is
	// translated by the DLL itself, so the first argument is the code.
	WlanReasonCodeToString: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanFreeMemory: { args: [FFIType.ptr], returns: FFIType.void },
};

let wlanApi: WlanApi | null = null;
let wlanUnavailable = false;

/** Load wlanapi.dll once. Returns null on a host without the WLAN stack (Server Core, stripped images). */
function getWlanApi(): WlanApi | null {
	if (wlanUnavailable) return null;
	if (!wlanApi) {
		try {
			wlanApi = dlopen('wlanapi.dll', WLAN_SYMBOLS).symbols as unknown as WlanApi;
		} catch {
			wlanUnavailable = true;
			return null;
		}
	}
	return wlanApi;
}

/** The loaded library, for the FFI test that checks every declared symbol really bound. */
export function loadWlanApiForTest(): WlanApi | null {
	return getWlanApi();
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
export function readConnectionAttributes(data: Pointer, size: number): { ssid: string | null; signal: number | null; connected: boolean } {
	if (size < ASSOC_SIGNAL_QUALITY_OFFSET + 4) return { ssid: null, signal: null, connected: false };
	// The SSID is filled in while the adapter is still ASSOCIATING, so its presence
	// is a statement of intent, not of success. Only `isState` says whether the
	// adapter is actually on the network.
	const connected = read.u32(data, CONN_STATE_OFFSET) === INTERFACE_STATE_CONNECTED;
	const signalRaw = read.u32(data, ASSOC_SIGNAL_QUALITY_OFFSET);
	const ssidLength = read.u32(data, ASSOC_SSID_LENGTH_OFFSET);
	if (signalRaw > 100 || ssidLength > MAX_SSID_LENGTH) return { ssid: null, signal: null, connected };
	const ssidBytes = new Uint8Array(toArrayBuffer(data, ASSOC_SSID_OFFSET, MAX_SSID_LENGTH)).subarray(0, ssidLength);
	const ssid = ssidLength > 0 ? new TextDecoder().decode(ssidBytes) : null;
	return { ssid, signal: signalRaw, connected };
}

/**
 * Adapters the last {@link readWindowsWifi} found actually associated, as opposed
 * to merely attempting it. Kept beside the map rather than inside `NetWifiInfo`
 * because it answers a question only the join path asks, and `link` already tells
 * the UI the same thing.
 */

/**
 * Run one WlanQueryInterface and map the returned buffer, freeing it afterwards.
 *
 * A non-zero result yields null; the common one is ERROR_INVALID_STATE
 * ({@link ERROR_INVALID_STATE}), which just means the adapter is not associated
 * and is not worth logging.
 */
function queryInterface<T>(api: WlanApi, handle: WlanHandle, guidPtr: Pointer, opcode: number, map: (data: Pointer, size: number) => T): T | null {
	const size = new Uint32Array(1);
	const dataOut = new BigUint64Array(1);
	const valueType = new Uint32Array(1);
	const rc = api.WlanQueryInterface(handle, guidPtr, opcode, null, ptr(size), ptr(dataOut), ptr(valueType));
	if (rc !== 0) return null;
	const data = Number(dataOut[0]) as Pointer;
	try {
		return map(data, size[0]!);
	} finally {
		api.WlanFreeMemory(data);
	}
}

/**
 * Read the Wi-Fi state of every WLAN adapter, keyed by canonical interface GUID.
 * Returns an empty map when the WLAN service is not running or the DLL is absent
 * — the caller then leaves `wifi` undefined rather than guessing.
 */
export function readWindowsWifi(): Map<string, NetWifiInfo> {
	try {
		return withWlanHandle((api, handle) => {
			const result = new Map<string, NetWifiInfo>();
			const listOut = new BigUint64Array(1);
			if (api.WlanEnumInterfaces(handle, null, ptr(listOut)) !== 0) return result;
			const list = Number(listOut[0]) as Pointer;
			try {
				const count = read.u32(list, 0);
				for (let i = 0; i < count; i++) {
					const base = WLAN_INTERFACE_LIST_HEADER + i * WLAN_INTERFACE_INFO_SIZE;
					const guid = guidToString(list, base);
					const guidPtr = ((list as unknown as number) + base) as unknown as Pointer;
					const radio = queryInterface(api, handle, guidPtr, OPCODE_RADIO_STATE, readRadioState) ?? 'unknown';
					const connection = queryInterface(api, handle, guidPtr, OPCODE_CURRENT_CONNECTION, readConnectionAttributes);
					result.set(guid, { ssid: connection?.ssid ?? null, signal: connection?.signal ?? null, radio });
				}
			} finally {
				api.WlanFreeMemory(list);
			}
			return result;
		});
	} catch {
		// Reading Wi-Fi is best-effort: a host with no WLAN service simply has no
		// wireless detail to report, which is not a reason to fail the whole read.
		return new Map();
	}
}

/**
 * Open a WLAN client handle, run `fn`, and close the handle whatever happens.
 *
 * Every WLAN call needs one, and leaking it would hold a handle in the WLAN
 * service for the life of the process. Client version 2 is Vista and later, which
 * every supported Windows negotiates.
 */
function withWlanHandle<T>(fn: (api: WlanApi, handle: WlanHandle) => T): T {
	const api = getWlanApi();
	if (!api) throw new Error('the Windows WLAN service is not available on this host');
	const negotiated = new Uint32Array(1);
	const handleOut = new BigUint64Array(1);
	// Client version 2 = Vista and later; every supported Windows negotiates it.
	const rc = api.WlanOpenHandle(2, null, ptr(negotiated), ptr(handleOut));
	if (rc !== 0) throw new Error(wlanErrorMessage(rc));
	const handle: WlanHandle = handleOut[0]!;
	try {
		return fn(api, handle);
	} finally {
		api.WlanCloseHandle(handle, null);
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
 * The shape is snapshot → mutate → verify, with a restore on any failure. The
 * existing address and default route have to be removed before the new ones are
 * written — `New-NetIPAddress` adds, it does not replace, so a repeated apply
 * would otherwise stack a second address on the adapter — and that is precisely
 * what makes the snapshot mandatory: between the removal and the last step the
 * interface holds no usable configuration at all, and a failure anywhere in
 * between would leave it that way. the snapshot records what was there and {@link windowsRestoreSteps} puts it back before the error is
 * rethrown. A rollback that itself fails is reported alongside the original
 * failure rather than in place of it, because the machine is then in a state
 * neither error alone describes.
 *
 * A static apply is verified before it is called a success: PowerShell can report
 * a clean run for a `New-NetIPAddress` the stack did not honour, and an
 * unverified apply would answer "done" while the interface still has no address.
 * That verification waits for duplicate address detection rather than merely
 * looking the object up.
 *
 * `$addressingChanged` is what keeps the rollback proportionate to the change. A
 * configuration whose address, prefix and gateway already match is not rewritten,
 * and the settings form posts the whole configuration whichever field was edited —
 * so the common apply is a DNS-only one that never touches the addressing. Undoing
 * such a failure by clearing every address and default route and rebuilding them
 * is destructive for nothing: it can alter store membership, a route's metric or
 * an address's type, and it does so on an interface the user only changed the
 * resolvers of. The flag is raised at the first destructive step, so the rollback
 * repairs the addressing exactly when the apply disturbed it. Duplicate address
 * detection hangs off the same flag — there is no new address to check when none
 * was created.
 *
 * `$dnsWriteStarted` is the same idea for the other half. The resolvers used to be
 * restored unconditionally, so an apply that failed before ever calling
 * `Set-DnsClientServerAddress` — at the first address removal, say — still wrote the
 * snapshot's DNS back, overwriting a resolver change some other process had made in
 * between. A rollback may only undo what this apply actually did.
 *
 * Every interpolated value has been through the shared validator, so each one is
 * a dotted-quad literal, a small integer, or a GUID. No quoting rule protects
 * this string — the validation does.
 */
export function windowsApplyIPv4Command(guid: string, config: NetIPv4Config, addressingChanged: boolean = true, requireLease: boolean = true): string {
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

	// The snapshot objects come from the active store, and piping them into the
	// Remove-* cmdlets removes them from the persistent store as well — verified
	// on Windows 11: after a static A→B apply the persistent store held only B,
	// and after a forced failure the rollback restored A in both stores. The
	// persistent-store checks after the apply are what would catch a Windows
	// build that behaves differently.

	const snapshot = ['$oldAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.InterfaceIndex -eq $i })', "$oldRoutes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.InterfaceIndex -eq $i -and $_.DestinationPrefix -eq '0.0.0.0/0' })", '$oldDhcp = (Get-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction Stop).Dhcp', '$oldDhcpNeedsAddress = $oldDhcp -eq "Enabled" -and @($oldAddresses | Where-Object { $_.AddressState -eq "Preferred" -and $_.IPAddress -notlike "169.254.*" }).Count -gt 0', '$oldDhcpNeedsRoute = $oldDhcp -eq "Enabled" -and $oldRoutes.Count -gt 0', ...dnsSnapshot];
	const apply = ['if ($oldAddresses.Count -gt 0) { $oldAddresses | Remove-NetIPAddress -Confirm:$false -ErrorAction Stop }', 'if ($oldRoutes.Count -gt 0) { $oldRoutes | Remove-NetRoute -Confirm:$false -ErrorAction Stop }'];
	if (config.mode === 'dhcp') {
		apply.push('Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Enabled');
		// With the link down there is no lease to wait for: the mode is what gets
		// saved, and the lease arrives when the cable does.
		if (requireLease) apply.push('$deadline = [DateTime]::UtcNow.AddSeconds(20); do { $appliedAddresses = @(Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.AddressState -eq "Preferred" -and $_.IPAddress -notlike "169.254.*" }); if ($appliedAddresses.Count -gt 0) { break }; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $deadline); if ($appliedAddresses.Count -eq 0) { throw "DHCP apply did not obtain a usable lease" }');
		else apply.push('if ((Get-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction Stop).Dhcp -ne "Enabled") { throw "DHCP apply did not enable DHCP" }');
	} else {
		apply.push('Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Disabled', `New-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -IPAddress ${config.address} -PrefixLength ${config.prefixLength} | Out-Null`, `$deadline = [DateTime]::UtcNow.AddSeconds(10); do { $addressState = (Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -IPAddress ${config.address} -ErrorAction SilentlyContinue).AddressState; if ($addressState -eq 'Preferred') { break }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $deadline); if ($addressState -ne 'Preferred') { throw 'IPv4 address did not become usable' }`);
		if (config.gateway) apply.push(`$routeMetric = ($oldRoutes | Select-Object -First 1).RouteMetric; if ($null -eq $routeMetric) { New-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -NextHop ${config.gateway} | Out-Null } else { New-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -NextHop ${config.gateway} -RouteMetric $routeMetric | Out-Null }`);
		apply.push(`$appliedAddresses = @(Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction Stop); if ($appliedAddresses.Count -ne 1 -or $appliedAddresses[0].IPAddress -ne '${config.address}' -or $appliedAddresses[0].PrefixLength -ne ${config.prefixLength}) { throw "IPv4 apply did not preserve the requested address" }`, "$appliedRoutes = @(Get-NetRoute -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' })", config.gateway ? `if ($appliedRoutes.Count -ne 1 -or $appliedRoutes[0].NextHop -ne '${config.gateway}') { throw "IPv4 apply did not preserve the requested gateway" }` : 'if ($appliedRoutes.Count -ne 0) { throw "IPv4 apply kept an unexpected default route" }');
		// The reader only offers an adapter for editing while ActiveStore and
		// PersistentStore agree, so a change that leaves them apart would make the
		// adapter read-only and resurface the old address after a reboot. Checking
		// the persistent side here turns that into a failure with a rollback.
		apply.push(`$persistedAddresses = @(Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -PolicyStore PersistentStore -ErrorAction SilentlyContinue); if ($persistedAddresses.Count -ne 1 -or $persistedAddresses[0].IPAddress -ne '${config.address}' -or $persistedAddresses[0].PrefixLength -ne ${config.prefixLength}) { throw "IPv4 apply did not persist the requested address" }`, "$persistedRoutes = @(Get-NetRoute -InterfaceIndex $i -AddressFamily IPv4 -PolicyStore PersistentStore -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' })", config.gateway ? `if ($persistedRoutes.Count -ne 1 -or $persistedRoutes[0].NextHop -ne '${config.gateway}') { throw "IPv4 apply did not persist the requested gateway" }` : 'if ($persistedRoutes.Count -ne 0) { throw "IPv4 apply left a persistent default route" }');
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

// ---------------------------------------------------------------------------
// wlanapi.dll (scanning and joining)
// ---------------------------------------------------------------------------

/**
 * WLAN_AVAILABLE_NETWORK, x64 (wlanapi.h). Every member is a DWORD or a DWORD
 * array, so the struct needs no padding and its size is the plain sum:
 *
 *   strProfileName[256] WCHAR   512  @   0
 *   dot11Ssid (DOT11_SSID)       36  @ 512   ULONG uSSIDLength + UCHAR ucSSID[32]
 *   dot11BssType                  4  @ 548
 *   uNumberOfBssids               4  @ 552
 *   bNetworkConnectable           4  @ 556
 *   wlanNotConnectableReason      4  @ 560
 *   uNumberOfPhyTypes             4  @ 564
 *   dot11PhyTypes[8]             32  @ 568
 *   bMorePhyTypes                 4  @ 600
 *   wlanSignalQuality             4  @ 604
 *   bSecurityEnabled              4  @ 608
 *   dot11DefaultAuthAlgorithm     4  @ 612
 *   dot11DefaultCipherAlgorithm   4  @ 616
 *   dwFlags                       4  @ 620
 *   dwReserved                    4  @ 624
 */
const AVAILABLE_NETWORK_SIZE = 628;
const AVAILABLE_PROFILE_NAME_OFFSET = 0;
/** strProfileName is a WCHAR[256] field, NUL-padded rather than NUL-terminated when full. */
const AVAILABLE_PROFILE_NAME_CHARS = 256;
const AVAILABLE_SSID_LENGTH_OFFSET = 512;
/** bNetworkConnectable: FALSE when Windows already knows it cannot join this network. */
const AVAILABLE_CONNECTABLE_OFFSET = 556;
/** wlanNotConnectableReason: a WLAN reason code, meaningful only when the flag above is FALSE. */
const AVAILABLE_NOT_CONNECTABLE_REASON_OFFSET = 560;
const AVAILABLE_SSID_OFFSET = 516;
const AVAILABLE_SIGNAL_OFFSET = 604;
const AVAILABLE_SECURITY_OFFSET = 608;
const AVAILABLE_AUTH_OFFSET = 612;
/** WLAN_AVAILABLE_NETWORK.dot11DefaultCipherAlgorithm, the field after the authentication one. */
const AVAILABLE_CIPHER_OFFSET = 616;
const AVAILABLE_FLAGS_OFFSET = 620;
/** Offset of the first WLAN_AVAILABLE_NETWORK inside WLAN_AVAILABLE_NETWORK_LIST (dwNumberOfItems + dwIndex). */
const AVAILABLE_LIST_HEADER = 8;
/** WLAN_AVAILABLE_NETWORK_CONNECTED — the interface is currently associated with this network. */
const AVAILABLE_NETWORK_CONNECTED = 0x00000001;
/**
 * Refuse to walk a list longer than this. The count comes out of a struct whose
 * layout is asserted, not negotiated, so a wrong offset would otherwise have us
 * read gigabytes of unrelated memory instead of failing.
 */
const MAX_AVAILABLE_NETWORKS = 512;

/** WLAN_CONNECTION_MODE: connect using a stored profile, by name. The only mode used here. */
const CONNECTION_MODE_PROFILE = 0;
/** dot11_BSS_type_infrastructure — an access point, as opposed to ad-hoc. */
const BSS_TYPE_INFRASTRUCTURE = 1;
/** WlanSetProfile with bOverwrite FALSE: this network is already saved, and we asked not to replace it. */
const ERROR_ALREADY_EXISTS = 183;
/**
 * ERROR_NOT_FOUND — the ONLY `WlanGetProfile` result that means "Windows holds
 * nothing under this name". Every other non-zero code (access denied, invalid
 * handle, out of memory, an RPC failure) leaves the question unanswered, and
 * reading one as absence is how a profile that did exist gets overwritten with no
 * backup and then deleted by the rollback.
 */
const ERROR_NOT_FOUND = 1168;
/**
 * ERROR_FILE_NOT_FOUND — the only `WlanGetProfileCustomUserData` result that means
 * "this profile has no custom data". Measured on Windows 11 both for a profile that
 * never had any and for one whose data a rewrite discarded.
 */
const ERROR_FILE_NOT_FOUND = 2;
/** DOT11_AUTH_ALGO_WPA3_SAE — WPA3-Personal, which needs a different profile than WPA2. */
const AUTH_ALGO_WPA3_SAE = 9;
/** WLAN_PROFILE_GROUP_POLICY — pushed by policy. Not this app's to replace, and not restorable if it were. */
const WLAN_PROFILE_GROUP_POLICY = 0x00000001;
/** WLAN_PROFILE_USER — visible to this account only, which is all a one-off join needs. */
const WLAN_PROFILE_USER = 0x00000002;
/** Buffer given to WlanReasonCodeToString. Microsoft's own samples use this size. */
const WLAN_REASON_TEXT_CHARS = 256;

/**
 * How long to let the radio sweep before reading the network list.
 *
 * WlanScan is asynchronous: it returns as soon as the request is queued and the
 * results appear in the interface's list some seconds later. Microsoft documents
 * four seconds as the point at which a caller that is not listening for the
 * scan-complete notification should give up waiting, so that is what we wait.
 */
const SCAN_SETTLE_MS = 4000;
/** How long to wait for an association after WlanConnect accepted the request. */
const JOIN_TIMEOUT_MS = 20000;
/** How often the association is re-read while waiting for a join to complete. */
const JOIN_POLL_MS = 500;

/**
 * Turn a Win32 result code into something a user can act on.
 *
 * These are the codes the WLAN calls in this module actually return; anything
 * else keeps its hexadecimal form rather than being described as something it
 * might not be.
 */
export function wlanErrorMessage(code: number): string {
	switch (code) {
		case 5:
			return 'access denied by Windows';
		case 87:
			return 'the WLAN service rejected the request as invalid';
		case 1062:
			return 'the WLAN AutoConfig service is not running';
		case 1168:
			// ERROR_NOT_FOUND. Whether the missing thing is a saved profile or the
			// interface itself depends on the call — a scan on a Wi-Fi Direct virtual
			// adapter answers with this too, and naming only the profile there would
			// describe a cause that has nothing to do with what was asked.
			return 'Windows found no matching interface or saved profile';
		case 1223:
			return 'the request was cancelled';
		case 2150899714:
			return 'the Wi-Fi radio is switched off';
		case ERROR_INVALID_STATE:
			return 'the adapter is not in a state that allows this';
		default:
			return `Wi-Fi error 0x${(code >>> 0).toString(16).toUpperCase()}`;
	}
}

/**
 * The 16 raw bytes of a `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}` GUID.
 *
 * The inverse of {@link guidToString}: the first three fields are little-endian
 * words and the last two are byte sequences, which is what makes a GUID's text
 * form and its memory form disagree. Throws rather than returning a wrong GUID,
 * because a malformed one would silently address a different adapter.
 */
export function guidToBytes(guid: string): Uint8Array {
	if (!isWindowsInterfaceID(guid)) throw new Error('not a Windows interface GUID');
	const hex = guid.replace(/[{}-]/g, '');
	const raw = new Uint8Array(16);
	for (let i = 0; i < 16; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	const bytes = new Uint8Array(16);
	bytes.set([raw[3]!, raw[2]!, raw[1]!, raw[0]!, raw[5]!, raw[4]!, raw[7]!, raw[6]!]);
	bytes.set(raw.subarray(8), 8);
	return bytes;
}

/** A NUL-terminated UTF-16LE string, which is what every `LPCWSTR` parameter here expects. */
export function utf16z(text: string): Uint16Array {
	const out = new Uint16Array(text.length + 1);
	for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
	return out;
}

/** First block of characters mapped by {@link readUtf16z}; comfortably larger than any real profile. */
const INITIAL_UTF16_BLOCK = 1024;

/**
 * Read a NUL-terminated UTF-16LE string back out of a pointer the WLAN API
 * allocated. The counterpart of {@link utf16z}, for the profile document
 * WlanGetProfile hands back.
 *
 * The length is not known up front, so the buffer is walked to the terminator;
 * the cap is a safety stop for a pointer that is not the string we think it is,
 * well above any real profile (a WLAN profile is a few hundred characters).
 * Reaching that cap without finding a terminator is an ERROR, never a shorter
 * string — see the throw below.
 */
export function readUtf16z(pointer: Pointer, maxChars: number = 65536): string {
	// Mapped in growing blocks rather than as one 128 KiB view. The length of the
	// allocation is not knowable from here, so every character mapped beyond the
	// terminator is a read of memory that may not belong to this buffer; a real
	// profile is a few hundred characters, and starting small means the usual case
	// never maps more than the first block.
	for (let mapped = Math.min(INITIAL_UTF16_BLOCK, maxChars); ; mapped = Math.min(mapped * 2, maxChars)) {
		const view = new Uint16Array(toArrayBuffer(pointer, 0, mapped * 2));
		const end = view.indexOf(0);
		if (end !== -1) return String.fromCharCode(...view.subarray(0, end));
		// No terminator yet. Growing is only worthwhile while there is room left.
		if (mapped >= maxChars) break;
	}
	// Returning the first `maxChars` here would be a silent truncation, and the
	// caller's whole purpose is to hand this document back to WlanSetProfile — a
	// truncated profile is not a smaller profile, it is a malformed one that would
	// replace a working network's saved configuration.
	throw new Error('the WLAN profile document is not NUL-terminated within its expected length');
}

/**
 * A WLAN_CONNECTION_PARAMETERS for a connect-by-profile, x64:
 *
 *   wlanConnectionMode   4  @  0   (4 bytes of padding follow, the next member is a pointer)
 *   strProfile           8  @  8
 *   pDot11Ssid           8  @ 16   NULL — the profile already names the network
 *   pDesiredBssidList    8  @ 24   NULL — any access point of that network will do
 *   dot11BssType         4  @ 32
 *   dwFlags              4  @ 36
 *
 * The profile address is passed as a bigint so this stays a pure function a test
 * can check byte for byte.
 */
export function encodeConnectionParameters(profile: bigint): Uint8Array {
	const bytes = new Uint8Array(40);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, CONNECTION_MODE_PROFILE, true);
	view.setBigUint64(8, profile, true);
	view.setUint32(32, BSS_TYPE_INFRASTRUCTURE, true);
	return bytes;
}

/**
 * Read a fixed-size, NUL-padded UTF-16LE field out of a struct.
 *
 * Unlike {@link readUtf16z} the length is known from the layout, and a field
 * filled to capacity carries no terminator at all — so running off the end is the
 * normal case rather than an error.
 */
function readFixedUtf16(base: Pointer, offset: number, maxChars: number): string {
	const view = new Uint16Array(toArrayBuffer(base, offset, maxChars * 2));
	const end = view.indexOf(0);
	return String.fromCharCode(...view.subarray(0, end === -1 ? maxChars : end));
}

/**
 * Control characters an XML 1.0 document cannot carry, even escaped.
 *
 * A WLAN profile IS a document, and the profile name goes into it as text - the
 * SSID itself is written as hex and is safe whatever bytes it holds. A name
 * carrying one of these makes WlanSetProfile refuse the document as malformed
 * rather than as a wrong name, so it is refused here where that can be said.
 * Tab, LF and CR are legal there and stay out of the set. This is a WINDOWS rule
 * and lives on the Windows side: the same name is perfectly joinable through
 * NetworkManager.
 */
const XML_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

/** Refuse a profile name a WLAN profile document could not carry. */
export function assertProfileNameWritable(profileName: string): void {
	if (XML_FORBIDDEN.test(profileName)) throw new Error('this network name contains characters a Windows profile cannot store');
}

/** Escape the five XML metacharacters. An SSID may legally contain any of them. */
function escapeXml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * The `<sharedKey>` element for one credential, or empty for an open network.
 */
function sharedKeyElement(password: string): string {
	// A 64-hex credential is a raw 256-bit PSK, not a passphrase, and the profile
	// has to say so: announced as `passPhrase` Windows hashes it a second time, so
	// the profile is written, accepted, and then simply never authenticates.
	const keyType = isWifiHexKey(password) ? 'networkKey' : 'passPhrase';
	return password ? `<sharedKey><keyType>${keyType}</keyType><protected>false</protected><keyMaterial>${escapeXml(password)}</keyMaterial></sharedKey>` : '';
}

/**
 * The `<security>` element a NEW profile needs. Empty password means an open network.
 */
function joinSecurityElement(password: string, sae: boolean): string {
	const method = password ? (sae ? 'WPA3SAE' : 'WPA2PSK') : 'open';
	const cipher = password ? 'AES' : 'none';
	return `<authEncryption><authentication>${method}</authentication><encryption>${cipher}</encryption><useOneX>false</useOneX></authEncryption>${sharedKeyElement(password)}`;
}

/**
 * The SSID a stored profile targets, as uppercase hex.
 *
 * Windows keeps the profile NAME and the SSID apart, so a name says nothing
 * about which network a profile belongs to: a profile called "Office" can target
 * any SSID at all. Null when the document names no SSID, which is a document
 * this code will not reason about.
 */
export function profileSsidHex(xml: string): string | null {
	const hex = xml.match(/<hex>\s*([0-9a-f]+)\s*<\/hex>/i);
	if (hex?.[1]) return hex[1].toUpperCase();
	// Older documents carry the name form instead; it is only unambiguous for an
	// SSID that really is text, which is exactly when Windows writes it.
	const name = xml.match(/<SSID>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/SSID>/i);
	return name?.[1] === undefined ? null : ssidHex(new TextEncoder().encode(unescapeXml(name[1])));
}

/** The SSID bytes as the uppercase hex a WLAN profile carries. */
function ssidHex(ssidBytes: Uint8Array): string {
	return [...ssidBytes].map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/** The five entities `escapeXml` produces, back to the characters they stand for. */
function unescapeXml(text: string): string {
	return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name] as string);
}

/**
 * The stored document with its credentials changed and nothing else.
 *
 * A join must not rewrite a profile the user already has. Replacing the whole
 * `<security>` element still dropped what lived inside it beside the key - a
 * profile with `<FIPSMode>true</FIPSMode>` came back without it, which is a
 * security setting and not a formatting detail - so only the three elements the
 * join actually decides are touched: the method, the cipher and the key.
 *
 * Every write goes through {@link spliceAt}, never `String.replace` with a computed
 * replacement: there `$$`, `$&` and `$`` in the text are substitution syntax, so a
 * password containing one was silently rewritten before it ever reached Windows.
 *
 * Null when the document is not shaped like one Windows hands back. The caller
 * then refuses rather than falling back to a generated document, because that
 * fallback is the data loss this exists to prevent.
 */
export function withJoinCredentials(xml: string, password: string, sae: boolean): string | null {
	const security = xml.match(/<security>[\s\S]*?<\/security>/i);
	if (!security) return null;
	const method = xml.slice(security.index).match(/<authentication>[\s\S]*?<\/authentication>/i);
	const cipher = xml.slice(security.index).match(/<encryption>[\s\S]*?<\/encryption>/i);
	if (!method || !cipher) return null;
	let edited = security[0];
	edited = spliceAt(edited, method[0], `<authentication>${password ? (sae ? 'WPA3SAE' : 'WPA2PSK') : 'open'}</authentication>`);
	edited = spliceAt(edited, cipher[0], `<encryption>${password ? 'AES' : 'none'}</encryption>`);
	const key = sharedKeyElement(password);
	const stored = edited.match(/<sharedKey>[\s\S]*?<\/sharedKey>/i);
	// An open profile has no key element to replace, so the new one goes where
	// the schema puts it: straight after the method it belongs to.
	if (stored) edited = spliceAt(edited, stored[0], key);
	else if (key) edited = spliceAt(edited, '</authEncryption>', `</authEncryption>${key}`);
	return spliceAt(xml, security[0], edited);
}

/** Replace the first occurrence of `find` with `insert`, taking `insert` literally. */
function spliceAt(text: string, find: string, insert: string): string {
	const at = text.indexOf(find);
	return at < 0 ? text : text.slice(0, at) + insert + text.slice(at + find.length);
}

/**
 * A WLAN profile document for one network.
 *
 * Windows will not associate with a network it has no profile for, and a profile
 * is only expressible as this XML — there is no struct form. An empty password
 * produces an open-network profile.
 *
 * `sae` selects WPA3-Personal instead of WPA2. It is not a preference but a
 * requirement of the access point: a WPA3-only network refuses a WPA2PSK profile
 * and a WPA2 network refuses a WPA3SAE one, so the caller passes what the scan
 * said the network actually uses.
 *
 * A NEW profile is written `manual`: the user is never asked - the UI offers
 * Connect and nothing else - so an explicit single join to a guest or conference
 * network must not silently change the machine's long-term behaviour, up to and
 * including auto-joining an open network of that name anywhere in the world. A
 * "remember this network" option would be the way to offer the other mode.
 *
 * Replacing an EXISTING profile never goes through here: that path edits the
 * stored document instead, so the mode the user chose in Windows - and
 * everything else it carries - stays exactly as it was.
 *
 * ponytail: WPA2PSK and WPA3SAE cover personal networks, including the WPA2/WPA3
 * transition mode consumer access points ship with (which advertises itself as
 * WPA2 and accepts the WPA2 profile). Enterprise 802.1X and OWE "enhanced open"
 * are not covered — those fail with a reason code from Windows rather than
 * silently doing nothing, and would need their own profile shapes.
 */
export function windowsWifiProfileXml(profileName: string, ssidBytes: Uint8Array, password: string, sae: boolean = false): string {
	// The profile name and the SSID are two different things. Windows keeps them
	// apart — the profile name is a case-sensitive label the user or a policy can
	// change, the SSID is what goes on the air — and writing the SSID into both
	// created a second, competing profile whenever the real one was named anything
	// else.
	const name = escapeXml(profileName);
	// The SSID goes in as `<hex>` rather than `<name>`, because an SSID is a byte
	// sequence and is not guaranteed to be UTF-8. Round-tripping it through text
	// replaces every undecodable octet with U+FFFD, and the profile would then
	// target a network that does not exist. `<hex>` is authoritative and `<name>`
	// is ignored when it is present, so only the hex form is emitted.
	const hex = ssidHex(ssidBytes);
	const security = joinSecurityElement(password, sae);
	return `<?xml version="1.0"?><WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"><name>${name}</name><SSIDConfig><SSID><hex>${hex}</hex></SSID></SSIDConfig><connectionType>ESS</connectionType><connectionMode>manual</connectionMode><MSM><security>${security}</security></MSM></WLANProfile>`;
}

/**
 * Decode a WLAN_AVAILABLE_NETWORK_LIST into the networks a user could join.
 *
 * Hidden networks report a zero-length SSID and are dropped for the same reason
 * the Linux reader drops them: they cannot be joined by name, so an unnamed row
 * would offer something that fails. One SSID can appear more than once (a roaming
 * network, or the same name with and without a stored profile), so entries
 * collapse to the strongest reading — carrying `active` and `secured` across,
 * since only one of the duplicates is the associated one.
 *
 * Implausible readings are dropped rather than reported: a signal above 100 or an
 * SSID longer than the 32 octets DOT11_SSID can hold means the offsets are being
 * read against something that is not this struct.
 */
export function parseAvailableNetworks(list: Pointer): NetWifiNetwork[] {
	const best = new Map<string, NetWifiNetwork>();
	for (const found of availableNetworks(list)) {
		// Projected explicitly rather than by rest-spread: the decoded entry carries
		// the raw SSID bytes and the stored profile name, which the join path needs
		// and the wire contract does not have a field for.
		const entry: NetWifiNetwork = { ssid: found.ssid, bssid: found.bssid, signal: found.signal, secured: found.secured, security: found.security, supported: found.supported, active: found.active };
		const previous = best.get(entry.ssid);
		if (!previous) {
			best.set(entry.ssid, entry);
			continue;
		}
		// One row wins outright and every field describing the NETWORK comes from it.
		// Merging them field by field invented readings no access point advertised:
		// an open row beside a WPA2 row of the same name produced `secured` from one
		// and `security` from the other, so the form asked for a password the profile
		// then declared open — and which of the two answers came out depended on the
		// order Windows happened to list them in.
		const strongest = (entry.signal ?? -1) > (previous.signal ?? -1) ? entry : previous;
		// `active` is the exception, and not a merge: it says this interface is
		// associated with this network, which is true of the network whichever of its
		// access points carries the association.
		best.set(entry.ssid, { ...strongest, active: previous.active || entry.active });
	}
	return [...best.values()].sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1));
}

/**
 * The scan entry for one network name, or null when the list does not hold it.
 *
 * This is what a join resolves its target from: the profile name Windows itself
 * uses for the network, the SSID exactly as the radio reported it, and the
 * authentication algorithm that decides between a WPA2 and a WPA3 profile. A
 * network that is not in the list yields null, and the caller then falls back to
 * what the user asked for, which is the best available answer rather than a
 * guess about a network nobody can currently see.
 *
 * ponytail: a name is not an identity — one SSID can be several access points,
 * and on a WPA2/WPA3 transition network they can differ in authentication. The
 * strongest entry is taken, which is also the one the radio is likeliest to
 * associate with. Resolving this properly needs a scan identity (interface +
 * BSSID + SSID bytes) carried through the API, which the wire contract has no
 * field for.
 */
export function findScannedNetwork(list: Pointer, ssid: string): AvailableNetwork | 'ambiguous' | null {
	let best: AvailableNetwork | null = null;
	for (const entry of availableNetworks(list)) {
		if (entry.ssid !== ssid) continue;
		// An SSID is a byte sequence, and a decode is lossy: two DIFFERENT networks
		// whose names differ only in an undecodable octet arrive here under one
		// display name. Picking the strongest of those would join whichever happened
		// to be closer at that instant, which is not the network the user chose - and
		// the choice would flip between the list and the join.
		if (best && !sameBytes(best.ssidBytes, entry.ssidBytes)) return 'ambiguous';
		if (!best || (entry.signal ?? -1) > (best.signal ?? -1)) best = entry;
	}
	return best;
}

/** Byte-for-byte equality of two SSIDs, which is the only identity an SSID has. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** DOT11_CIPHER_ALGO_NONE — what an open network reports. */
const CIPHER_ALGO_NONE = 0;
/** DOT11_CIPHER_ALGO_CCMP — AES, and the only cipher the profiles here name. */
const CIPHER_ALGO_CCMP = 4;

/** DOT11_AUTH_ALGO_80211_OPEN — no authentication at all. */
const AUTH_ALGO_OPEN = 1;
/** DOT11_AUTH_ALGO_RSNA_PSK — WPA2-Personal. Note 6 is RSNA, which is 802.1X enterprise and NOT this. */
const AUTH_ALGO_RSNA_PSK = 7;

/**
 * The security label and joinability of one scanned network.
 *
 * The wire contract carries a scanner label because the Linux reader has one
 * from nmcli; Windows reports a DOT11_AUTH_ALGORITHM instead, so the label is
 * built from it. Only open, WPA2-PSK and WPA3-SAE are offered - everything else
 * (802.1X enterprise, the legacy WPA-None modes) needs a profile shape this app
 * does not write, and offering it would hand the user a button that fails.
 */
function windowsWifiSecurity(auth: number, cipher: number, secured: boolean): { security: string; supported: boolean } {
	if (!secured) return { security: '', supported: auth === AUTH_ALGO_OPEN && cipher === CIPHER_ALGO_NONE };
	// The authentication method is only half the answer. `joinSecurityElement` writes
	// `<encryption>AES</encryption>` and nothing else, so a network running WPA2 with
	// TKIP was offered as joinable and then handed a profile demanding a cipher it
	// does not speak — the association failed and the message sent the user to check
	// a password that was never the problem. Supporting TKIP is not the fix; not
	// claiming to support it is.
	const usable = cipher === CIPHER_ALGO_CCMP;
	if (auth === AUTH_ALGO_WPA3_SAE) return { security: 'WPA3', supported: usable };
	if (auth === AUTH_ALGO_RSNA_PSK) return { security: usable ? 'WPA2' : 'WPA2-TKIP', supported: usable };
	return { security: 'WPA-ENTERPRISE', supported: false };
}

/** One decoded WLAN_AVAILABLE_NETWORK, plus the fields the public list has no room for. */
export type AvailableNetwork = NetWifiNetwork & {
	/** DOT11_AUTH_ALGORITHM, as Windows last saw the network advertise it. */
	auth: number;
	/** The SSID as the radio reported it. Copied out of the list, which the caller frees. */
	ssidBytes: Uint8Array;
	/** Windows' own name for the stored profile of this network. Empty when nothing is stored. */
	profileName: string;
	/** False when Windows has already decided it cannot associate with this network. */
	connectable: boolean;
	/** Why not, as a WLAN reason code. Meaningful only when {@link connectable} is false. */
	notConnectableReason: number;
};

/** Walk the entries of a WLAN_AVAILABLE_NETWORK_LIST, skipping the ones that cannot be offered. */
function* availableNetworks(list: Pointer): Generator<AvailableNetwork> {
	const count = read.u32(list, 0);
	// A count past the cap is not a long list to be trimmed, it is evidence that
	// this buffer is not the structure we think it is — a wrong header offset, a
	// stale pointer, a layout change. Clamping and walking anyway read whatever
	// followed the allocation and reported it as networks; the only safe reading
	// of a corrupt structure is to refuse it. Windows' own list does not approach
	// this many entries even in the densest environment.
	if (count > MAX_AVAILABLE_NETWORKS) throw new Error(`the WLAN network list declares ${count} entries, which is not a plausible scan result`);
	const decoder = new TextDecoder();
	for (let i = 0; i < count; i++) {
		const base = AVAILABLE_LIST_HEADER + i * AVAILABLE_NETWORK_SIZE;
		const ssidLength = read.u32(list, base + AVAILABLE_SSID_LENGTH_OFFSET);
		const signal = read.u32(list, base + AVAILABLE_SIGNAL_OFFSET);
		if (ssidLength === 0 || ssidLength > MAX_SSID_LENGTH || signal > 100) continue;
		// `slice`, not `subarray`: the caller frees the list as soon as this
		// generator is drained, and the bytes have to outlive it.
		const ssidBytes = new Uint8Array(toArrayBuffer(list, base + AVAILABLE_SSID_OFFSET, MAX_SSID_LENGTH)).slice(0, ssidLength);
		const secured = read.u32(list, base + AVAILABLE_SECURITY_OFFSET) !== 0;
		const auth = read.u32(list, base + AVAILABLE_AUTH_OFFSET);
		const cipher = read.u32(list, base + AVAILABLE_CIPHER_OFFSET);
		yield {
			// Lossy by nature — an SSID is not guaranteed to be UTF-8 — so this form
			// is for display and for matching what the user picked, never for
			// building a profile. `ssidBytes` is the authoritative value.
			ssid: decoder.decode(ssidBytes),
			ssidBytes,
			profileName: readFixedUtf16(list, base + AVAILABLE_PROFILE_NAME_OFFSET, AVAILABLE_PROFILE_NAME_CHARS),
			signal,
			secured,
			active: (read.u32(list, base + AVAILABLE_FLAGS_OFFSET) & AVAILABLE_NETWORK_CONNECTED) !== 0,
			auth,
			...windowsWifiSecurity(auth, cipher, secured),
			// WLAN_AVAILABLE_NETWORK describes a NETWORK, not one access point, and
			// carries no BSSID. The Linux reader has one and uses it to tell equal
			// names apart; here the profile names the SSID and the WLAN service picks
			// the access point itself, so there is nothing honest to put here.
			bssid: null,
			connectable: read.u32(list, base + AVAILABLE_CONNECTABLE_OFFSET) !== 0,
			notConnectableReason: read.u32(list, base + AVAILABLE_NOT_CONNECTABLE_REASON_OFFSET),
		};
	}
}

/**
 * Explain a refused scan.
 *
 * Windows gates the available-network APIs on the location permission, so a scan
 * that comes back access-denied is almost never about privileges — it is the
 * location setting, and saying only "access denied" sends the user looking in the
 * wrong place. Every other code keeps its ordinary description.
 */
export function wlanScanErrorMessage(code: number): string {
	return code === 5 ? 'Windows refused the scan: allow location access for this app in Windows privacy settings' : wlanErrorMessage(code);
}

/** Scan for the Wi-Fi networks one adapter can see. */
export async function scanWindowsWifi(guid: string): Promise<NetWifiNetwork[]> {
	const guidBytes = guidToBytes(guid);
	const scanResult = withWlanHandle((api, handle) => api.WlanScan(handle, ptr(guidBytes), null, null, null));
	await delay(SCAN_SETTLE_MS);
	const networks = withWlanHandle((api, handle) => {
		const listOut = new BigUint64Array(1);
		const rc = api.WlanGetAvailableNetworkList(handle, ptr(guidBytes), 0, null, ptr(listOut));
		if (rc !== 0) throw new Error(wlanScanErrorMessage(rc));
		const list = Number(listOut[0]) as Pointer;
		try {
			return parseAvailableNetworks(list);
		} finally {
			api.WlanFreeMemory(list);
		}
	});
	// A refused scan is only worth reporting when it left us with nothing to show.
	// Windows declines a rescan that comes too soon after the last one, and in that
	// case the list it already holds is a perfectly good answer.
	if (networks.length === 0 && scanResult !== 0) throw new Error(wlanScanErrorMessage(scanResult));
	return networks;
}

/**
 * Join a Wi-Fi network, and wait until the adapter is actually on it.
 *
 * Windows only associates through a stored profile, so the whole job is deciding
 * which profile to connect by:
 *
 *  - With a password, the profile is written first, replacing any earlier one —
 *    that is what lets a user fix a network whose key has changed.
 *  - Without one, the stored profile is used as it stands. Only if there is none
 *    to use is a profile written, and then with overwrite off, so this path can
 *    never quietly replace a saved key with an open-network profile. A network
 *    that turns out not to be open then simply fails to associate.
 *
 * WlanConnect merely queues the association: it returns success long before the
 * adapter has associated, and a wrong password produces no error from it at all.
 * So the association is confirmed by re-reading it, and a join that never lands
 * is reported as a failure rather than as the success WlanConnect claimed.
 *
 * EVERY step that can change stored state is inside one try/catch, and the catch
 * undoes exactly what was done. This used to be three separate concerns and none
 * of them held: the profile overwrite and the synchronous WlanConnect happened
 * BEFORE the guard, so an immediately-refused connect threw past the restore
 * entirely; a profile this attempt had CREATED was never deleted, only "restored"
 * to nothing; and the restoring write ignored its own return code, its reason
 * code and the profile's original flags alike. One failed attempt could therefore
 * leave a network's stored configuration permanently changed or a dead profile
 * behind, and report neither.
 */
export async function connectWindowsWifi(guid: string, ssid: string, password: string): Promise<void> {
	const guidBytes = guidToBytes(guid);
	// Everything about the target is resolved once, from the list the WLAN service
	// already holds — no scan is triggered, so this costs a call and not four
	// seconds. Null when the network is not currently visible.
	const lookup = withWlanHandle((api, handle) => readScannedNetwork(api, handle, guidBytes, ssid));
	// A list that could not be read is not a network that is not there. Everything
	// below falls back to values GUESSED from what the user typed — the SSID as
	// text, the SSID as the profile name, WPA2 — and then writes a profile out of
	// them. That fallback is right for a network which is genuinely not visible;
	// running it because the WLAN service hiccuped is how a transient error came to
	// overwrite a saved network's configuration.
	if (lookup.kind === 'readError') throw new Error(`the list of visible networks could not be read, so this network was not joined (${lookup.message})`);
	// Two networks whose names differ only in a byte no decode can show apart. The
	// user picked one of them and there is no way to tell which, so neither is
	// joined rather than the stronger one being guessed at.
	if (lookup.kind === 'ambiguous') throw new Error('more than one network is broadcasting this name, and they cannot be told apart by name alone');
	const scanned = lookup.kind === 'found' ? lookup.network : null;
	// A profile name is NOT an SSID. Windows keeps the two apart, the profile name
	// is case-sensitive, and `WLAN_AVAILABLE_NETWORK` already carries the real one —
	// so addressing everything below by SSID meant an existing custom-named profile
	// was never found, never backed up, and a second competing profile was created
	// beside it. The SSID is only the fallback for a network the scan cannot see.
	const profileName = scanned?.profileName || ssid;
	// The SSID is a byte sequence, not text. The decoded form is what the user
	// picked from and what the association is checked against, but the profile is
	// built from the bytes the radio actually reported.
	const ssidBytes = scanned?.ssidBytes ?? new TextEncoder().encode(ssid);
	// WPA2 is the right default for a network the list does not name: it is what
	// the transition mode most access points run advertises, and it is also what an
	// out-of-date list would have said.
	const sae = scanned?.auth === AUTH_ALGO_WPA3_SAE;
	// Windows sets `bNetworkConnectable` FALSE when it has already decided it
	// cannot associate — an unsupported authentication or cipher, a policy
	// restriction. Attempting anyway spent twenty seconds waiting for an
	// association that was never going to happen and then told the user to check
	// the password, which was not the problem. The reason code Windows supplied
	// alongside it is the answer, so it is asked for by name.
	if (scanned && !scanned.connectable) throw new Error(withWlanHandle(api => wlanReasonText(api, scanned.notConnectableReason)) ?? 'Windows reports that this network cannot be joined');
	assertProfileNameWritable(profileName);
	if (password) assertWindowsWifiKey(password, sae);
	// Held in a local of its own: WLAN_CONNECTION_PARAMETERS stores only the
	// ADDRESS of the profile name, so the array behind it has to outlive the call.
	const profileNameW = utf16z(profileName);
	const parameters = encodeConnectionParameters(BigInt(ptr(profileNameW)));
	// A profile this join CREATES is written `manual`: the user is never asked, so
	// a one-off join must not make the machine re-associate by itself later. An
	// existing profile is edited instead, and keeps whatever it already said.
	const target: JoinTarget = { ssidHex: ssidHex(ssidBytes), password, sae, newProfile: () => windowsWifiProfileXml(profileName, ssidBytes, password, sae) };
	/** What this attempt did to the profile store, or null while it has done nothing. */
	let change: ProfileChange | null = null;
	try {
		withWlanHandle((api, handle) => {
			if (password) {
				change = writeJoinProfile(api, handle, guidBytes, profileName, target);
				connectByProfile(api, handle, guidBytes, parameters);
				return;
			}
			// The profile is addressed BY NAME here too, so what it holds is checked
			// before it is used. Connecting first and asking afterwards let
			// `WlanConnect` associate with whatever network the stored profile named.
			if (openJoinDecision(readStoredProfile(api, handle, guidBytes, profileName), target) === 'connect') {
				connectByProfile(api, handle, guidBytes, parameters);
				return;
			}
			// Believed absent, and the write is what makes that checkable: anything but
			// ERROR_ALREADY_EXISTS means it landed on the empty name it was aimed at.
			if (writeProfile(api, handle, guidBytes, target.newProfile(), WLAN_PROFILE_USER, 0) === ERROR_ALREADY_EXISTS) throw new Error('another process saved a profile for this network while it was being joined, so it was not joined');
			change = { replaced: null, created: true, written: readWrittenProfile(api, handle, guidBytes, profileName) };
			connectByProfile(api, handle, guidBytes, parameters);
		});
		await waitForAssociation(guid, ssid);
	} catch (err) {
		const rollback = undoWifiProfileChange(guidBytes, profileName, change);
		// Both errors, not just the first. A rollback that failed leaves the machine
		// in a state neither error describes on its own, and reporting only the
		// original one would claim the attempt had been undone.
		if (rollback) throw new Error(`${(err as Error).message} — and undoing the attempt failed: ${rollback}`);
		throw err;
	}
}

/**
 * Refuse a credential the chosen mechanism or the Windows profile schema could
 * not accept, before anything is written.
 *
 * Two constraints the shared validator cannot apply. It does not know whether
 * this access point runs WPA3 SAE, where a raw 64-hex PSK is written, accepted
 * and then simply never authenticates. And the Microsoft profile schema is
 * narrower than 802.11i: `passPhrase` key material is 8 to 63 PRINTABLE ASCII
 * characters, so a passphrase carrying an accented letter is refused by
 * WlanSetProfile with an opaque reason code rather than by anything that can
 * explain itself — and on Windows the profile is written BEFORE the association
 * is attempted, so that refusal comes after a working profile was replaced.
 */
export function assertWindowsWifiKey(password: string, sae: boolean): void {
	if (isWifiHexKey(password)) {
		if (sae) throw new Error('this network uses WPA3, which takes a passphrase rather than a raw 64-digit key');
		return;
	}
	// The Microsoft profile schema, not the 802.11 rule the shared validator
	// applies: `passPhrase` key material is 8 to 63 PRINTABLE ASCII characters, and
	// that holds for WPA3SAE here as much as for WPA2PSK. NetworkManager sets no
	// length for SAE — measured — which is why this cannot live in the shared
	// check. Refused here it is refused before anything is written; refused by
	// WlanSetProfile it comes back as an opaque reason code, after a working
	// profile has already been replaced.
	if (!/^[\x20-\x7e]+$/.test(password)) throw new Error('Windows accepts only printable ASCII characters in a Wi-Fi passphrase');
	if (password.length < 8 || password.length > 63) throw new Error('Windows saves a Wi-Fi passphrase of 8 to 63 characters');
}

/** A stored WLAN profile, as {@link readStoredProfile} found it. */
export interface StoredProfile {
	/** The document exactly as Windows holds it, key material still encrypted. */
	readonly xml: string;
	/** WLAN_PROFILE_* flags. Writing it back with any others changes its scope. */
	readonly flags: number;
	/**
	 * The opaque per-profile blob another WLAN client may keep beside this profile,
	 * or null when it keeps none.
	 *
	 * Windows stores it separately from the document and DISCARDS it whenever the
	 * document is rewritten with different content — measured on Windows 11: an
	 * identical `WlanSetProfile` leaves it alone, one that changes the profile (which
	 * every join does, because it writes the key the user just typed) drops it, and
	 * a delete takes it with the profile. It belongs to whoever wrote it — enterprise
	 * provisioning, a vendor's connection manager — and this app has no way to
	 * reconstruct it, so the only honest thing is to hand it back.
	 */
	readonly customUserData: Uint8Array | null;
}

/**
 * What {@link readStoredProfile} found: the profile, its PROVABLE absence, or a
 * failure that is neither.
 *
 * The third case is the whole reason this is a union rather than a nullable
 * profile. `WlanGetProfile` answers ERROR_NOT_FOUND for a name Windows holds
 * nothing under, but it also answers access-denied, an invalid handle, out of
 * memory and RPC failures — and collapsing all of those to `null` told the caller
 * the profile did not exist. It then overwrote a profile it had no backup of and,
 * on failure, DELETED one it had never created.
 */
export type StoredProfileResult = { readonly kind: 'found'; readonly profile: StoredProfile } | { readonly kind: 'notFound' } | { readonly kind: 'error'; readonly message: string };

/**
 * The stored profile for one profile name.
 *
 * The key material comes back encrypted (reading it in the clear needs elevation
 * this app does not have), which is exactly what a restore needs: the same user
 * on the same machine can hand that ciphertext straight back, so the saved key
 * survives without ever being seen.
 *
 * The flags matter as much as the document. `WlanGetProfile` reports whether the
 * profile is all-user, per-user or pushed by group policy, and those are not
 * interchangeable — a per-user profile written back as all-user is a different
 * object, and a policy profile must not be touched at all.
 *
 * Only ERROR_NOT_FOUND is absence. A success that hands back a null document is
 * an error too: there is then nothing to restore from, which is exactly the
 * situation the caller must not proceed into.
 *
 * A custom-data blob that could not be READ makes the whole reading an error, for
 * the same reason. Every caller of this either overwrites the profile or decides
 * whether the profile is still its own, and both need a snapshot they can hand
 * back; "the document, and no idea about the blob beside it" is not one.
 */
export function readStoredProfile(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, profileName: string): StoredProfileResult {
	const name = utf16z(profileName);
	const xmlOut = new BigUint64Array(1);
	// In/out: zero asks for the profile as stored, without the plaintext key.
	const flags = new Uint32Array(1);
	const rc = api.WlanGetProfile(handle, ptr(guidBytes), ptr(name), null, ptr(xmlOut), ptr(flags), null);
	if (rc === ERROR_NOT_FOUND) return { kind: 'notFound' };
	if (rc !== 0) return { kind: 'error', message: wlanErrorMessage(rc) };
	if (xmlOut[0] === 0n) return { kind: 'error', message: 'the WLAN service reported a saved profile but returned no document for it' };
	const xmlPointer = Number(xmlOut[0]) as Pointer;
	try {
		const custom = readProfileCustomUserData(api, handle, guidBytes, name);
		if (custom.kind === 'error') return { kind: 'error', message: `the data another program stores with this network could not be read (${custom.message})` };
		return { kind: 'found', profile: { xml: readUtf16z(xmlPointer), flags: flags[0] ?? 0, customUserData: custom.kind === 'found' ? custom.data : null } };
	} catch (err) {
		// A document that cannot be read back is a document that cannot be restored.
		return { kind: 'error', message: (err as Error).message };
	} finally {
		api.WlanFreeMemory(xmlPointer);
	}
}

/**
 * What reading a profile's custom user data established: the blob, its PROVABLE
 * absence, or a failure that is neither.
 *
 * A union for the same reason {@link StoredProfileResult} is one. Every non-zero
 * code used to read as "there is none", so `ERROR_INVALID_HANDLE`,
 * `ERROR_INVALID_PARAMETER`, an access denial and an RPC failure all reported the
 * same thing an empty profile does. The consequence was not symmetrical with the
 * profile document's: on the overwrite path the caller then wrote its own profile,
 * destroying a blob it had no copy of, and reported the join a success; on the
 * rollback path it reported the data restored when it had never been read.
 */
type CustomDataResult = { readonly kind: 'none' } | { readonly kind: 'found'; readonly data: Uint8Array } | { readonly kind: 'error'; readonly message: string };

/**
 * The custom user data stored against one profile.
 *
 * Only ERROR_FILE_NOT_FOUND is an absence — see {@link ERROR_FILE_NOT_FOUND}. A
 * clean read that hands back nothing is one too: there is then provably no blob to
 * lose.
 *
 * `name` is the already-encoded profile name, because every caller has one.
 */
function readProfileCustomUserData(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, name: Uint16Array): CustomDataResult {
	const size = new Uint32Array(1);
	const dataOut = new BigUint64Array(1);
	const rc = api.WlanGetProfileCustomUserData(handle, ptr(guidBytes), ptr(name), null, ptr(size), ptr(dataOut));
	if (rc === ERROR_FILE_NOT_FOUND) return { kind: 'none' };
	if (rc !== 0) return { kind: 'error', message: wlanErrorMessage(rc) };
	const length = size[0] ?? 0;
	if (dataOut[0] === 0n || length === 0) return { kind: 'none' };
	const pointer = Number(dataOut[0]) as Pointer;
	try {
		// Copied out before the buffer is freed — a view over freed memory is not data.
		return { kind: 'found', data: new Uint8Array(toArrayBuffer(pointer, 0, length)).slice() };
	} finally {
		api.WlanFreeMemory(pointer);
	}
}

/**
 * Put somebody else's custom user data back after this attempt rewrote the profile
 * out from under it, and say whether that worked.
 *
 * The return code used to be discarded on the grounds that the write which lost the
 * data had already happened, so failing here would report a failure for a join that
 * worked. That holds on the ROLLBACK path and nowhere else. On the overwrite path
 * this runs inside {@link writeJoinProfile}, before the association is even
 * attempted — so a failure there can be reported honestly, the original profile put
 * back, and no connection made. `WlanSetProfileCustomUserData` has its own ways to
 * fail (a removed USB adapter, a handle that has gone stale), and silently losing
 * another program's data is not something to report as success.
 *
 * Nothing is written when the snapshot found no data: there is then nothing to
 * lose, and a zero-length write is a clear rather than a no-op.
 */
function restoreProfileCustomUserData(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, name: Uint16Array, data: Uint8Array | null): string | null {
	if (!data || data.length === 0) return null;
	const rc = api.WlanSetProfileCustomUserData(handle, ptr(guidBytes), ptr(name), data.length, ptr(data), null);
	return rc === 0 ? null : wlanErrorMessage(rc);
}

/** What one attempt did to the stored profiles, so the rollback knows what to undo. */
export interface ProfileChange {
	/** The profile this attempt overwrote, or null when it created one. */
	readonly replaced: StoredProfile | null;
	/** True when nothing was stored under this name before this attempt. */
	readonly created: boolean;
	/**
	 * What Windows held under this name immediately AFTER the write — this
	 * attempt's fingerprint on the profile store, and the only evidence the
	 * rollback has that the profile it is about to touch is still its own.
	 *
	 * Not the document that was written: Windows normalizes what it is given and
	 * stores the key material encrypted, so the two never match. Read back instead,
	 * through the same call the rollback uses, so the comparison is like for like.
	 * Null when that read-back failed, which leaves the rollback unable to prove
	 * ownership and so unwilling to act.
	 */
	readonly written: StoredProfile | null;
}

/** What a join is trying to write, and to which network. */
export interface JoinTarget {
	/** The SSID as uppercase hex — the only unambiguous statement of which network this is. */
	readonly ssidHex: string;
	readonly password: string;
	readonly sae: boolean;
	/** The document to write when this network has no profile yet. */
	newProfile(): string;
}

/**
 * Refuse a stored profile that belongs to a different network.
 *
 * A profile NAME is not a network: Windows lets the two differ, and this app
 * falls back to the SSID for the name when the scan names no profile. Both the
 * write and the connect address the profile BY NAME, so without this a saved
 * "Cafe" pointing at another SSID would be overwritten by one join and used to
 * associate by another - `WlanConnect` takes the networks from the profile it is
 * given, not from the name it was asked for.
 */
function assertProfileIsForNetwork(xml: string, target: JoinTarget): void {
	if (profileSsidHex(xml) !== target.ssidHex) throw new Error('a different network is already saved under this name in Windows, so this one was not joined');
}

/**
 * What an open-network join should do about the profile stored under this name:
 * use it, or create one.
 *
 * A decision of its own because the branch it drives is pure FFI on both sides,
 * which is how it came to skip the ownership check the keyed branch had. Throws
 * rather than returning a third case: neither an unreadable profile nor one
 * belonging to another network leaves anything safe to do.
 */
export function openJoinDecision(stored: StoredProfileResult, target: JoinTarget): 'connect' | 'create' {
	if (stored.kind === 'error') throw new Error(`the saved configuration of this network could not be read, so it was not joined (${stored.message})`);
	if (stored.kind === 'notFound') return 'create';
	assertProfileIsForNetwork(stored.profile.xml, target);
	return 'connect';
}

/**
 * Write the profile a keyed join needs, and report what that did to what Windows
 * already held.
 *
 * Read before overwriting: the typed key may be wrong, and the profile being
 * replaced may be the working one the user has had for years. The FLAGS come back
 * with it, because restoring an all-user or a per-user profile as flags 0 changes
 * its scope — a different profile in all but name, and a rollback that fails for
 * that reason alone.
 *
 * The absent case is where the race lives. Between the read that found nothing
 * and the write, another process — a second client of this app, netsh, the
 * Windows UI, a policy refresh — can save a profile under that name. Writing with
 * `bOverwrite` TRUE would replace it and, because this attempt believed it had
 * CREATED the profile, a later rollback would DELETE a network the user had just
 * saved. So the first write asks not to overwrite: ERROR_ALREADY_EXISTS is
 * Windows answering that the absence no longer holds, and the profile that
 * appeared is then read, backed up and overwritten like any other existing one.
 */
export function writeJoinProfile(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, profileName: string, target: JoinTarget): ProfileChange {
	const stored = readStoredProfile(api, handle, guidBytes, profileName);
	// A read that FAILED is not a read that found nothing. Proceeding on one would
	// overwrite a profile with no backup taken, and the rollback would then delete
	// a network the user had saved for years. Only a provable absence lets this
	// attempt create a profile of its own.
	if (stored.kind === 'error') throw new Error(`the saved configuration of this network could not be read, so it will not be replaced (${stored.message})`);
	if (stored.kind === 'found') return overwrite(stored.profile);
	// Believed absent — and asking not to overwrite is what makes that belief
	// checkable rather than merely assumed. Anything but ERROR_ALREADY_EXISTS means
	// the write landed on the empty name it was aimed at.
	if (writeProfile(api, handle, guidBytes, target.newProfile(), WLAN_PROFILE_USER, 0) !== ERROR_ALREADY_EXISTS) return { replaced: null, created: true, written: readWrittenProfile(api, handle, guidBytes, profileName) };
	const raced = readStoredProfile(api, handle, guidBytes, profileName);
	// It existed a moment ago and cannot be read now: there is a profile here that
	// this attempt cannot back up, so it does not touch it.
	if (raced.kind !== 'found') throw new Error('another process saved a profile for this network while it was being joined, and it could not be read');
	return overwrite(raced.profile);

	/**
	 * Replace an existing profile, keeping its scope. A new one would be created
	 * per-user instead: creating one for every account on the machine needs a
	 * privilege the Wi-Fi capability never established, and a one-off join has no
	 * business reaching outside this account.
	 */
	function overwrite(existing: StoredProfile): ProfileChange {
		// A group-policy profile is not this app's to replace. The overwrite is
		// refused on most hosts, and where it is not, nothing here can put a policy
		// profile back afterwards.
		if ((existing.flags & WLAN_PROFILE_GROUP_POLICY) !== 0) throw new Error('this network is managed by group policy and cannot be changed here');
		// A profile NAME is not a network. Windows lets the two differ, so a stored
		// profile called the same thing as the network being joined may belong to a
		// completely different SSID — and overwriting it destroys that network's
		// saved configuration on SUCCESS, where nothing rolls anything back.
		assertProfileIsForNetwork(existing.xml, target);
		// Only the credentials change. Regenerating the document kept the SSID and
		// the key and dropped everything else the user had set on this profile.
		const edited = withJoinCredentials(existing.xml, target.password, target.sae);
		if (edited === null) throw new Error('the saved configuration of this network is not in a shape this app can edit, so it was left alone');
		writeProfile(api, handle, guidBytes, edited, existing.flags, 1);
		// The write just discarded whatever another WLAN client kept beside this
		// profile — see StoredProfile.customUserData. Replacing the credentials is
		// what the user asked for; destroying somebody else's metadata is not, so it
		// goes straight back, before the fingerprint is taken.
		const lost = restoreProfileCustomUserData(api, handle, guidBytes, utf16z(profileName), existing.customUserData);
		// Nothing has been connected yet, so this failure is one that can still be
		// answered honestly: put the document back as it was and stop. Carrying on
		// would associate successfully and report a join that had quietly destroyed
		// another program's data.
		if (lost) throw new Error(`the data another program stores with this network could not be put back, so this network was not joined (${lost})${describeRestore(writeStoredProfile(api, handle, guidBytes, profileName, existing))}`);
		return { replaced: existing, created: false, written: readWrittenProfile(api, handle, guidBytes, profileName) };
	}
}

/**
 * The profile as Windows holds it right after a write — see
 * {@link ProfileChange.written}.
 *
 * Anything but a clean read yields null rather than an error: the write itself
 * succeeded, so failing the join over a fingerprint that could not be taken would
 * report a failure that did not happen. What it costs instead is the rollback's
 * ability to prove the profile is still its own, which that path answers for
 * itself.
 */
function readWrittenProfile(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, profileName: string): StoredProfile | null {
	const stored = readStoredProfile(api, handle, guidBytes, profileName);
	return stored.kind === 'found' ? stored.profile : null;
}

/**
 * Put a snapshotted profile back exactly as it was, document, scope and the data
 * another program stores beside it, and report what went wrong rather than throwing.
 *
 * Shared by the two paths that undo a write — the overwrite giving up because the
 * custom data could not be handed back, and the rollback after a failed
 * association — because "restore this profile" means the same thing in both, and
 * restoring only the document leaves half the object behind.
 */
function writeStoredProfile(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, profileName: string, profile: StoredProfile): string | null {
	const name = utf16z(profileName);
	const document = utf16z(profile.xml);
	const reason = new Uint32Array(1);
	const rc = api.WlanSetProfile(handle, ptr(guidBytes), profile.flags, ptr(document), null, 1, null, ptr(reason));
	if (rc !== 0) return `the previous profile could not be restored (${describeProfileFailure(api, rc, reason[0] ?? 0)})`;
	// That WlanSetProfile discarded the custom data again, exactly as the write being
	// undone did, so it goes back too — and a failure here is reported rather than
	// swallowed, because the restore is then only partly done.
	const lost = restoreProfileCustomUserData(api, handle, guidBytes, name, profile.customUserData);
	return lost ? `the previous profile was restored but the data another program stores with it was not (${lost})` : null;
}

/** A restore outcome as a clause to append to an error, or nothing when it worked. */
function describeRestore(failure: string | null): string {
	return failure ? ` — and ${failure}` : '';
}

/**
 * Whether two custom-data snapshots are the same blob, BY CONTENT.
 *
 * Reference equality would answer no to two identical reads, since each one copies
 * the bytes out of a buffer the WLAN service then frees — so the fingerprint would
 * report a conflict on every profile that has custom data at all.
 */
function sameCustomUserData(a: Uint8Array | null, b: Uint8Array | null): boolean {
	if (a === null || b === null) return a === b;
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Write a profile document, turning a refusal into an error that carries the
 * reason code. Returns the raw result so the caller can tell the one tolerable
 * outcome — ERROR_ALREADY_EXISTS after asking not to overwrite — from a failure.
 */
function writeProfile(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, profileXml: string, flags: number, overwrite: 0 | 1): number {
	const document = utf16z(profileXml);
	const reason = new Uint32Array(1);
	const rc = api.WlanSetProfile(handle, ptr(guidBytes), flags, ptr(document), null, overwrite, null, ptr(reason));
	// ERROR_ALREADY_EXISTS is an answer to a CREATE: it says the name was taken, and
	// the caller decides what to do about that. Answered to an overwrite it means
	// Windows did not write - documented for a profile whose scope has changed since
	// it was read - and tolerating it there reported a password as saved that was
	// never stored, then went on to associate through the old profile and call that
	// success.
	if (rc !== 0 && !(overwrite === 0 && rc === ERROR_ALREADY_EXISTS)) throw new Error(describeProfileFailure(api, rc, reason[0] ?? 0));
	return rc;
}

/** Queue an association through a stored profile, or fail with the code Windows gave. */
function connectByProfile(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, parameters: Uint8Array): void {
	const rc = api.WlanConnect(handle, ptr(guidBytes), ptr(parameters), null);
	if (rc !== 0) throw new Error(wlanErrorMessage(rc));
}

/**
 * Undo what the failed attempt wrote — but only while the profile is still the
 * one it wrote.
 *
 * The two undo actions are different, not one with a null in it. A profile this
 * attempt CREATED has to be deleted — "restoring what was there before" would
 * mean writing nothing and leaving the new one standing, which is how a failed
 * join used to leave a dead profile behind. A profile it OVERWROTE goes back with
 * the flags it had, so its scope is unchanged.
 *
 * What both share is that they are only correct if nobody else has touched the
 * profile in the meantime, and up to twenty seconds pass between the write and
 * the rollback while the adapter tries to associate. The host mutex covers this
 * process and nothing else: the Windows network UI, `netsh`, a group policy
 * refresh, the Network List Manager and a second instance of this app can all
 * save a profile under that name inside that window. Deleting or overwriting
 * unconditionally would then discard a change the user had just made — the same
 * hazard the write path already refuses, arriving from the other end.
 *
 * So the profile is re-read and compared against {@link ProfileChange.written},
 * the fingerprint taken right after the write. Equal means it is still ours and
 * the undo runs. Anything else — changed, removed, or a fingerprint that could
 * not be taken — means the third party's version stands and this reports the
 * conflict instead of resolving it.
 *
 * ALL THREE parts of the fingerprint are compared, the custom user data included.
 * Comparing only the document and the flags left the one part another WLAN client
 * can change on its own out of the test: during the same twenty-second window a
 * vendor's connection manager can write its blob and touch nothing else, and the
 * rollback then judged the profile still its own — deleting the newly created
 * profile along with the foreign blob, or overwriting the profile and putting the
 * older blob back over the newer one. (This is not the deferred race between two
 * adjacent wlanapi calls; it is the long window this whole function exists for.)
 *
 * The one exception is a profile this attempt created that has since been
 * deleted: the undo's whole goal was for it not to exist, and it does not.
 */
export function undoProfileChange(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, profileName: string, change: ProfileChange): string | null {
	if (!change.written) return 'what this attempt saved for this network could not be read back, so its configuration was left as it stands';
	const current = readStoredProfile(api, handle, guidBytes, profileName);
	if (current.kind === 'error') return `this network's saved configuration could not be re-read, so it was left as it stands (${current.message})`;
	if (current.kind === 'notFound') return change.created ? null : 'another process removed this network while it was being joined, so the previous configuration was not put back';
	if (current.profile.xml !== change.written.xml || current.profile.flags !== change.written.flags || !sameCustomUserData(current.profile.customUserData, change.written.customUserData)) return 'another process changed this network while it was being joined, so its configuration was left as it stands';
	const name = utf16z(profileName);
	if (change.created) {
		const rc = api.WlanDeleteProfile(handle, ptr(guidBytes), ptr(name), null);
		return rc === 0 ? null : `the profile this attempt created could not be deleted (${wlanErrorMessage(rc)})`;
	}
	return writeStoredProfile(api, handle, guidBytes, profileName, change.replaced as StoredProfile);
}

/** {@link undoProfileChange} on a handle of its own — the one used for the join is long closed by the time an association times out. */
function undoWifiProfileChange(guidBytes: Uint8Array, profileName: string, change: ProfileChange | null): string | null {
	if (!change || (!change.created && !change.replaced)) return null;
	try {
		return withWlanHandle((api, handle) => undoProfileChange(api, handle, guidBytes, profileName, change));
	} catch (err) {
		return `the WLAN service could not be reached to undo it (${(err as Error).message})`;
	}
}

/**
 * Describe a refused WlanSetProfile, reason code included.
 *
 * The reason code is the whole point of the out-parameter that used to be
 * allocated and then discarded: WlanSetProfile answers the same Win32 code for
 * an unsupported cipher, a schema violation and a policy restriction alike, and
 * only the reason code separates them. Windows can put it into words in the
 * user's own language, so it is asked rather than printing a bare number.
 */
function describeProfileFailure(api: WlanApi, rc: number, reason: number): string {
	const text = wlanReasonText(api, reason);
	return text ? `${wlanErrorMessage(rc)}: ${text}` : wlanErrorMessage(rc);
}

/** Windows' own wording for a WLAN reason code, or null when it has none for it. */
function wlanReasonText(api: WlanApi, reason: number): string | null {
	if (reason === 0) return null;
	const buffer = new Uint16Array(WLAN_REASON_TEXT_CHARS);
	if (api.WlanReasonCodeToString(reason, buffer.length, ptr(buffer), null) !== 0) return null;
	const end = buffer.indexOf(0);
	const text = String.fromCharCode(...buffer.subarray(0, end === -1 ? buffer.length : end)).trim();
	return text.length > 0 ? text : null;
}

/**
 * What a lookup in the WLAN service's own network list established.
 *
 * `notFound` and `readError` are not the same answer, and treating them as one
 * was how a transient WLAN failure came to trigger the destructive fallback: the
 * caller took `null` for "this network is not currently visible", carried on with
 * a guessed profile name, guessed SSID bytes and a guessed security type, and
 * wrote a profile from them. A list that could not be read says nothing about the
 * network, so nothing may be guessed from it.
 */
type ScanLookup = { readonly kind: 'found'; readonly network: AvailableNetwork } | { readonly kind: 'notFound' } | { readonly kind: 'ambiguous' } | { readonly kind: 'readError'; readonly message: string };

/**
 * What the WLAN service currently knows about one network name on one adapter.
 *
 * Reads the list the service already holds — no scan is triggered, so this costs
 * a call and not four seconds.
 */
function readScannedNetwork(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, ssid: string): ScanLookup {
	const listOut = new BigUint64Array(1);
	const rc = api.WlanGetAvailableNetworkList(handle, ptr(guidBytes), 0, null, ptr(listOut));
	if (rc !== 0) return { kind: 'readError', message: wlanScanErrorMessage(rc) };
	const list = Number(listOut[0]) as Pointer;
	try {
		const network = findScannedNetwork(list, ssid);
		if (network === 'ambiguous') return { kind: 'ambiguous' };
		return network ? { kind: 'found', network } : { kind: 'notFound' };
	} catch (err) {
		// A list that describes itself impossibly (see MAX_AVAILABLE_NETWORKS) is a
		// structure we cannot read, not a network that is not there.
		return { kind: 'readError', message: (err as Error).message };
	} finally {
		api.WlanFreeMemory(list);
	}
}

/**
 * The association of ONE adapter, read straight from the WLAN service.
 *
 * Asked for by GUID rather than taken from {@link readWindowsWifi}, which
 * describes every adapter and answers on the wire contract - it has no field for
 * whether the radio is actually on the network, only for the name it is
 * associating with. Null when the adapter has no current connection, which is
 * what an unassociated one reports.
 */
function readAssociation(guid: string): { ssid: string | null; connected: boolean } | null {
	try {
		return withWlanHandle((api, handle) => {
			const guidBytes = guidToBytes(guid);
			return queryInterface(api, handle, ptr(guidBytes), OPCODE_CURRENT_CONNECTION, readConnectionAttributes);
		});
	} catch {
		// A service that cannot be asked right now is not an adapter that has
		// joined; the caller polls again until its own deadline.
		return null;
	}
}

/** Poll the adapter's association until it reports the requested network, or give up. */
async function waitForAssociation(guid: string, ssid: string): Promise<void> {
	const deadline = Date.now() + JOIN_TIMEOUT_MS;
	for (;;) {
		// Both conditions matter: the adapter has to be ON a network, and it has to be
		// THIS one. WlanConnect only queues the attempt, and the SSID shows up in the
		// connection attributes while the adapter is still associating — so a check on
		// the name alone reports a join that never happened.
		const association = readAssociation(guid);
		if (association?.connected && association.ssid === ssid) return;
		if (Date.now() >= deadline) throw new Error('the adapter did not join the network — check the password');
		await delay(JOIN_POLL_MS);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * True when this host has a WLAN stack the app can drive.
 *
 * Enumerating the interfaces is the probe: `wlanapi.dll` is present on every
 * desktop Windows whether or not the machine has a radio, so loading it proves
 * nothing, while an adapter in the list is exactly the thing scanning and joining
 * need. Unlike applying an address, none of this needs an elevated token.
 */
export function isWindowsWifiConfigurable(): boolean {
	return readWindowsWifi().size > 0;
}
