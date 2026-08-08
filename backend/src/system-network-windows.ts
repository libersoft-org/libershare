import { dlopen, FFIType, ptr, read, toArrayBuffer, type Pointer } from 'bun:ffi';
import type { NetAddress, NetInterfaceInfo, NetMedium, NetLink, NetAddressMode, NetWifiInfo } from '@shared';

/**
 * Windows host network state.
 *
 * Two independent sources, both read-only:
 *
 * 1. A single `powershell.exe` one-shot ({@link WINDOWS_STATE_COMMAND}) that
 *    emits adapters, addresses, per-family DHCP mode, the IPv4 default route and
 *    the DNS servers as one compact JSON document. One spawn (~700 ms) instead
 *    of five, and every enum is projected to `[int]` so the parser never depends
 *    on the OS display language.
 * 2. `wlanapi.dll` through `bun:ffi` for the SSID / signal quality / radio state
 *    of Wi-Fi adapters, joined onto the PowerShell rows by interface GUID. There
 *    is no PowerShell cmdlet that reports signal quality, and `netsh wlan show
 *    interfaces` only prints a localized text table.
 *
 * Nothing here mutates configuration — every call is a query.
 */

// NDIS_PHYSICAL_MEDIUM values we can map with confidence (ntddndis.h). Anything
// else (tunnels, WAN miniports, Hyper-V switches, Bluetooth PAN) stays 'other'.
const NDIS_MEDIUM_NATIVE_802_11 = 9;
const NDIS_MEDIUM_802_3 = 14;
// MediaConnectionState (Get-NetAdapter): 0 Unknown, 1 Connected, 2 Disconnected.
const MEDIA_STATE_CONNECTED = 1;
const MEDIA_STATE_DISCONNECTED = 2;
// AddressFamily as projected by [int]: 2 = IPv4 (AF_INET), 23 = IPv6 (AF_INET6).
const AF_INET = 2;
const AF_INET6 = 23;
// AddressState (Get-NetIPAddress): 0 Invalid, 1 Tentative, 2 Duplicate, 3 Deprecated, 4 Preferred.
const ADDRESS_STATE_PREFERRED = 4;
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
export const WINDOWS_STATE_COMMAND: string = ['[Console]::OutputEncoding=[System.Text.Encoding]::UTF8', "$adapters = @(Get-NetAdapter -IncludeHidden | Select-Object ifIndex, Name, InterfaceGuid, MacAddress, @{n='Media';e={[int]$_.NdisPhysicalMedium}}, @{n='State';e={[int]$_.MediaConnectionState}})", "$addresses = @(Get-NetIPAddress | Select-Object ifIndex, @{n='Family';e={[int]$_.AddressFamily}}, IPAddress, PrefixLength, @{n='State';e={[int]$_.AddressState}})", "$interfaces = @(Get-NetIPInterface | Select-Object ifIndex, @{n='Family';e={[int]$_.AddressFamily}}, @{n='Dhcp';e={[int]$_.Dhcp}})", "$routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object ifIndex, NextHop, RouteMetric, InterfaceMetric)", "$dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object InterfaceIndex, @{n='Servers';e={($_.ServerAddresses -join ',')}})", '[pscustomobject]@{adapters=$adapters; addresses=$addresses; interfaces=$interfaces; routes=$routes; dns=$dns} | ConvertTo-Json -Depth 6 -Compress'].join('; ');

interface WindowsAdapterRow {
	ifIndex: number;
	Name: string;
	InterfaceGuid: string;
	MacAddress: string;
	Media: number;
	State: number;
}
interface WindowsAddressRow {
	ifIndex: number;
	Family: number;
	IPAddress: string;
	PrefixLength: number;
	State: number;
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

function mapMedium(media: number): NetMedium {
	if (media === NDIS_MEDIUM_802_3) return 'wired';
	if (media === NDIS_MEDIUM_NATIVE_802_11) return 'wireless';
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
	const adapters = asArray<WindowsAdapterRow>(doc['adapters']);
	const addresses = asArray<WindowsAddressRow>(doc['addresses']);
	const ipInterfaces = asArray<WindowsInterfaceRow>(doc['interfaces']);
	const routes = asArray<WindowsRouteRow>(doc['routes']);
	const dnsRows = asArray<WindowsDnsRow>(doc['dns']);

	const addressesByIndex = new Map<number, NetAddress[]>();
	for (const row of addresses) {
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

	const dnsByIndex = new Map<number, string[]>();
	for (const row of dnsRows) {
		const servers = (row.Servers ?? '')
			.split(',')
			.map(s => s.trim())
			.filter(s => s.length > 0);
		if (servers.length > 0) dnsByIndex.set(row.InterfaceIndex, servers);
	}

	const result: NetInterfaceInfo[] = [];
	const seen = new Set<number>();
	for (const adapter of adapters) {
		seen.add(adapter.ifIndex);
		result.push(buildInterface(adapter.ifIndex, adapter.Name, mapMedium(adapter.Media), mapLink(adapter.State), adapter.MacAddress, adapter.InterfaceGuid ? normalizeGuid(adapter.InterfaceGuid) : null));
	}
	// Addressed stacks with no adapter row (RAS/VPN) — keep them, medium unknown.
	for (const ifIndex of addressesByIndex.keys()) {
		if (seen.has(ifIndex)) continue;
		result.push(buildInterface(ifIndex, `#${ifIndex}`, 'other', 'unknown', '', null));
	}
	return result;

	function buildInterface(ifIndex: number, name: string, medium: NetMedium, link: NetLink, mac: string, guid: string | null): NetInterfaceInfo {
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
			addresses: addressesByIndex.get(ifIndex) ?? [],
			ipv4Mode: dhcpByIndex.get(ifIndex) ?? 'unknown',
			gateway: ifIndex === defaultIndex ? (best?.NextHop ?? null) : null,
			dns: dnsByIndex.get(ifIndex) ?? [],
		};
		// Wi-Fi Direct virtual adapters also report medium 9 but have no WLAN
		// interface of their own, so an absent entry leaves `wifi` undefined.
		const radio = medium === 'wireless' && guid ? wifi.get(guid) : undefined;
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
