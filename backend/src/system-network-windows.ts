import { dlopen, FFIType, ptr, read, toArrayBuffer, type Pointer } from 'bun:ffi';
import type { NetAddress, NetInterfaceInfo, NetIPv4Config, NetMedium, NetLink, NetAddressMode, NetWifiInfo, NetWifiNetwork } from '@shared';

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
export const WINDOWS_STATE_COMMAND: string = ['[Console]::OutputEncoding=[System.Text.Encoding]::UTF8', "$adapters = @(Get-NetAdapter -IncludeHidden | Select-Object ifIndex, Name, InterfaceGuid, MacAddress, @{n='Media';e={[int]$_.NdisPhysicalMedium}}, @{n='IfType';e={[int]$_.InterfaceType}}, @{n='Hidden';e={[int]$_.Hidden}}, @{n='State';e={[int]$_.MediaConnectionState}})", "$addresses = @(Get-NetIPAddress | Select-Object ifIndex, @{n='Family';e={[int]$_.AddressFamily}}, IPAddress, PrefixLength, @{n='State';e={[int]$_.AddressState}})", "$interfaces = @(Get-NetIPInterface | Select-Object ifIndex, @{n='Family';e={[int]$_.AddressFamily}}, @{n='Dhcp';e={[int]$_.Dhcp}})", "$routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object ifIndex, NextHop, RouteMetric, InterfaceMetric)", "$dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object InterfaceIndex, @{n='Servers';e={($_.ServerAddresses -join ',')}})", '[pscustomobject]@{adapters=$adapters; addresses=$addresses; interfaces=$interfaces; routes=$routes; dns=$dns} | ConvertTo-Json -Depth 6 -Compress'].join('; ');

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
	// Kept per interface as well: only one of them carries the host's default route,
	// but on a multi-homed machine several have a gateway of their own. Reporting
	// those as null would seed the edit form with an empty gateway field, and saving
	// any other change on that interface would then clear the gateway it really has.
	let best: WindowsRouteRow | null = null;
	const bestByIndex = new Map<number, WindowsRouteRow>();
	for (const row of routes) {
		if (!best || effectiveMetric(row) < effectiveMetric(best)) best = row;
		const previous = bestByIndex.get(row.ifIndex);
		if (!previous || effectiveMetric(row) < effectiveMetric(previous)) bestByIndex.set(row.ifIndex, row);
	}
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
		result.push(buildInterface(adapter.ifIndex, adapter.Name, mapMedium(adapter.Media, adapter.IfType, adapter.Hidden), mapLink(adapter.State), adapter.MacAddress, adapter.InterfaceGuid ? normalizeGuid(adapter.InterfaceGuid) : null));
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
			gateway: bestByIndex.get(ifIndex)?.NextHop ?? null,
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

interface WlanApi {
	WlanOpenHandle: (version: number, reserved: null, negotiated: Pointer, handle: Pointer) => number;
	WlanCloseHandle: (handle: Pointer, reserved: null) => number;
	WlanEnumInterfaces: (handle: Pointer, reserved: null, list: Pointer) => number;
	WlanQueryInterface: (handle: Pointer, guid: Pointer, opcode: number, reserved: null, size: Pointer, data: Pointer, valueType: Pointer) => number;
	WlanScan: (handle: Pointer, guid: Pointer, ssid: null, ieData: null, reserved: null) => number;
	WlanGetAvailableNetworkList: (handle: Pointer, guid: Pointer, flags: number, reserved: null, list: Pointer) => number;
	WlanSetProfile: (handle: Pointer, guid: Pointer, flags: number, xml: Pointer, security: null, overwrite: number, reserved: null, reasonCode: Pointer) => number;
	WlanGetProfile: (handle: Pointer, guid: Pointer, name: Pointer, reserved: null, xml: Pointer, flags: Pointer, access: null) => number;
	WlanConnect: (handle: Pointer, guid: Pointer, parameters: Pointer, reserved: null) => number;
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
 */
export const WLAN_SYMBOLS: Record<keyof WlanApi, WlanSymbol> = {
	WlanOpenHandle: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanCloseHandle: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanEnumInterfaces: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanQueryInterface: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanScan: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanGetAvailableNetworkList: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanSetProfile: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanGetProfile: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanConnect: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
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
const connectedGuids = new Set<string>();

/**
 * Read the Wi-Fi state of every WLAN adapter, keyed by canonical interface GUID.
 * Returns an empty map when the WLAN service is not running or the DLL is absent
 * — the caller then leaves `wifi` undefined rather than guessing.
 */
export function readWindowsWifi(): Map<string, NetWifiInfo> {
	try {
		return withWlanHandle((api, handle) => {
			const result = new Map<string, NetWifiInfo>();
			connectedGuids.clear();
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
					if (connection?.connected) connectedGuids.add(guid);
				}
			} finally {
				api.WlanFreeMemory(list);
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
				const rc = api.WlanQueryInterface(handle, guidPtr, opcode, null, ptr(size), ptr(dataOut), ptr(valueType));
				if (rc !== 0) return null;
				const data = Number(dataOut[0]) as Pointer;
				try {
					return map(data, size[0]!);
				} finally {
					api.WlanFreeMemory(data);
				}
			}
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
function withWlanHandle<T>(fn: (api: WlanApi, handle: Pointer) => T): T {
	const api = getWlanApi();
	if (!api) throw new Error('the Windows WLAN service is not available on this host');
	const negotiated = new Uint32Array(1);
	const handleOut = new BigUint64Array(1);
	const rc = api.WlanOpenHandle(2, null, ptr(negotiated), ptr(handleOut));
	if (rc !== 0) throw new Error(wlanErrorMessage(rc));
	const handle = Number(handleOut[0]) as Pointer;
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
 * The existing address and default route are removed first so a repeated apply
 * cannot stack a second address on the adapter — `New-NetIPAddress` adds, it does
 * not replace. Both removals tolerate "there was nothing there", which is the
 * normal state of an adapter currently on DHCP.
 *
 * Every interpolated value has been through the shared validator, so each one is
 * a dotted-quad literal, a small integer, or a GUID. No quoting rule protects
 * this string — the validation does.
 */
export function windowsApplyIPv4Command(guid: string, config: NetIPv4Config): string {
	const steps = ['[Console]::OutputEncoding=[System.Text.Encoding]::UTF8', '$ErrorActionPreference = "Stop"', `$adapter = Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceGuid -eq '${guid}' }`, 'if (-not $adapter) { throw "interface not found" }', '$i = $adapter.ifIndex', 'Remove-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue', "Remove-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -Confirm:$false -ErrorAction SilentlyContinue"];
	if (config.mode === 'dhcp') {
		steps.push('Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Enabled', 'Set-DnsClientServerAddress -InterfaceIndex $i -ResetServerAddresses');
	} else {
		const gateway = config.gateway ? ` -DefaultGateway ${config.gateway}` : '';
		const dns = config.dns ?? [];
		steps.push('Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Disabled', `New-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -IPAddress ${config.address} -PrefixLength ${config.prefixLength}${gateway} | Out-Null`, dns.length > 0 ? `Set-DnsClientServerAddress -InterfaceIndex $i -ServerAddresses ${dns.join(',')}` : 'Set-DnsClientServerAddress -InterfaceIndex $i -ResetServerAddresses');
	}
	return steps.join('; ');
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
const AVAILABLE_SSID_LENGTH_OFFSET = 512;
const AVAILABLE_SSID_OFFSET = 516;
const AVAILABLE_SIGNAL_OFFSET = 604;
const AVAILABLE_SECURITY_OFFSET = 608;
const AVAILABLE_AUTH_OFFSET = 612;
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
/** DOT11_AUTH_ALGO_WPA3_SAE — WPA3-Personal, which needs a different profile than WPA2. */
const AUTH_ALGO_WPA3_SAE = 9;

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

/**
 * Read a NUL-terminated UTF-16LE string back out of a pointer the WLAN API
 * allocated. The counterpart of {@link utf16z}, for the profile document
 * WlanGetProfile hands back.
 *
 * The length is not known up front, so the buffer is walked to the terminator; the
 * cap is a safety stop for a pointer that is not the string we think it is, well
 * above any real profile (a WLAN profile is a few hundred characters).
 */
export function readUtf16z(pointer: Pointer, maxChars: number = 65536): string {
	const view = new Uint16Array(toArrayBuffer(pointer, 0, maxChars * 2));
	let length = 0;
	while (length < view.length && view[length] !== 0) length++;
	return String.fromCharCode(...view.subarray(0, length));
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

/** Escape the five XML metacharacters. An SSID may legally contain any of them. */
function escapeXml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
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
 * ponytail: WPA2PSK and WPA3SAE cover personal networks, including the WPA2/WPA3
 * transition mode consumer access points ship with (which advertises itself as
 * WPA2 and accepts the WPA2 profile). Enterprise 802.1X and OWE "enhanced open"
 * are not covered — those fail with a reason code from Windows rather than
 * silently doing nothing, and would need their own profile shapes.
 */
export function windowsWifiProfileXml(ssid: string, password: string, sae: boolean = false): string {
	const name = escapeXml(ssid);
	const security = password ? `<authEncryption><authentication>${sae ? 'WPA3SAE' : 'WPA2PSK'}</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption><sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${escapeXml(password)}</keyMaterial></sharedKey>` : `<authEncryption><authentication>open</authentication><encryption>none</encryption><useOneX>false</useOneX></authEncryption>`;
	return `<?xml version="1.0"?><WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"><name>${name}</name><SSIDConfig><SSID><name>${name}</name></SSID></SSIDConfig><connectionType>ESS</connectionType><connectionMode>auto</connectionMode><MSM><security>${security}</security></MSM></WLANProfile>`;
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
	for (const { auth: _auth, ...entry } of availableNetworks(list)) {
		const previous = best.get(entry.ssid);
		if (!previous) best.set(entry.ssid, entry);
		else if ((entry.signal ?? -1) > (previous.signal ?? -1)) best.set(entry.ssid, { ...entry, active: previous.active || entry.active, secured: previous.secured || entry.secured });
		else if (entry.active) best.set(entry.ssid, { ...previous, active: true });
	}
	return [...best.values()].sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1));
}

/**
 * The DOT11_AUTH_ALGORITHM Windows last saw one network use, or null when the
 * list does not contain it. Used to pick between a WPA2 and a WPA3 profile.
 */
export function findAuthAlgorithm(list: Pointer, ssid: string): number | null {
	for (const entry of availableNetworks(list)) if (entry.ssid === ssid) return entry.auth;
	return null;
}

/** One decoded WLAN_AVAILABLE_NETWORK, plus the authentication algorithm the public list omits. */
type AvailableNetwork = NetWifiNetwork & { auth: number };

/** Walk the entries of a WLAN_AVAILABLE_NETWORK_LIST, skipping the ones that cannot be offered. */
function* availableNetworks(list: Pointer): Generator<AvailableNetwork> {
	const count = Math.min(read.u32(list, 0), MAX_AVAILABLE_NETWORKS);
	const decoder = new TextDecoder();
	for (let i = 0; i < count; i++) {
		const base = AVAILABLE_LIST_HEADER + i * AVAILABLE_NETWORK_SIZE;
		const ssidLength = read.u32(list, base + AVAILABLE_SSID_LENGTH_OFFSET);
		const signal = read.u32(list, base + AVAILABLE_SIGNAL_OFFSET);
		if (ssidLength === 0 || ssidLength > MAX_SSID_LENGTH || signal > 100) continue;
		yield {
			ssid: decoder.decode(new Uint8Array(toArrayBuffer(list, base + AVAILABLE_SSID_OFFSET, MAX_SSID_LENGTH)).subarray(0, ssidLength)),
			signal,
			secured: read.u32(list, base + AVAILABLE_SECURITY_OFFSET) !== 0,
			active: (read.u32(list, base + AVAILABLE_FLAGS_OFFSET) & AVAILABLE_NETWORK_CONNECTED) !== 0,
			auth: read.u32(list, base + AVAILABLE_AUTH_OFFSET),
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
 */
export async function connectWindowsWifi(guid: string, ssid: string, password: string): Promise<void> {
	const guidBytes = guidToBytes(guid);
	// Held in a local of its own: WLAN_CONNECTION_PARAMETERS stores only the
	// ADDRESS of the profile name, so the array behind it has to outlive the call.
	const profileName = utf16z(ssid);
	const parameters = encodeConnectionParameters(BigInt(ptr(profileName)));
	// The document Windows held for this network before we touched it, kept so a
	// join that never lands can put it back. Null when there was nothing stored.
	let replacedProfile: string | null = null;
	withWlanHandle((api, handle) => {
		const connect = (): number => api.WlanConnect(handle, ptr(guidBytes), ptr(parameters), null);
		const writeProfile = (overwrite: number): number => {
			const xml = utf16z(windowsWifiProfileXml(ssid, password, password ? usesSae(api, handle, guidBytes, ssid) : false));
			const reasonCode = new Uint32Array(1);
			return api.WlanSetProfile(handle, ptr(guidBytes), 0, ptr(xml), null, overwrite, null, ptr(reasonCode));
		};
		if (password) {
			// Read before overwriting: the typed key may be wrong, and the profile
			// being replaced may be the working one the user has had for years.
			replacedProfile = readStoredProfile(api, handle, guidBytes, ssid);
			const set = writeProfile(1);
			if (set !== 0) throw new Error(wlanErrorMessage(set));
			const rc = connect();
			if (rc !== 0) throw new Error(wlanErrorMessage(rc));
			return;
		}
		const rc = connect();
		if (rc === 0) return;
		// Nothing stored for this name. The only network that can be joined without a
		// key is an open one, so give Windows an open profile to work from — but
		// never in place of one it already holds. When one does already exist, the
		// failed connect is the real story and its code is the one worth reporting.
		const set = writeProfile(0);
		if (set !== 0) throw new Error(wlanErrorMessage(set === ERROR_ALREADY_EXISTS ? rc : set));
		const retry = connect();
		if (retry !== 0) throw new Error(wlanErrorMessage(retry));
	});
	try {
		await waitForAssociation(guid, ssid);
	} catch (err) {
		// The join failed, and the profile we wrote to attempt it is now standing
		// where a working one used to. Put the old one back: the usual reason to be
		// here is a mistyped key, and losing a saved network to a typo would be a
		// worse outcome than the failure the user is about to be told about.
		if (replacedProfile) restoreStoredProfile(guidBytes, replacedProfile);
		throw err;
	}
}

/**
 * The stored profile document for one network, or null when Windows holds none.
 *
 * The key material comes back encrypted (reading it in the clear needs elevation
 * this app does not have), which is exactly what {@link restoreStoredProfile}
 * needs: the same user on the same machine can hand that ciphertext straight
 * back, so the saved key survives without ever being seen.
 */
function readStoredProfile(api: WlanApi, handle: Pointer, guidBytes: Uint8Array, ssid: string): string | null {
	const name = utf16z(ssid);
	const xmlOut = new BigUint64Array(1);
	// In/out: zero asks for the profile as stored, without the plaintext key.
	const flags = new Uint32Array(1);
	const rc = api.WlanGetProfile(handle, ptr(guidBytes), ptr(name), null, ptr(xmlOut), ptr(flags), null);
	if (rc !== 0 || xmlOut[0] === 0n) return null;
	const xmlPointer = Number(xmlOut[0]) as Pointer;
	try {
		return readUtf16z(xmlPointer);
	} finally {
		api.WlanFreeMemory(xmlPointer);
	}
}

/**
 * Write a profile document back, replacing whatever stands in its place.
 *
 * Best-effort by design: this runs while an error is already on its way to the
 * user, and a failure to restore must not replace that error with one about the
 * restore. It opens its own handle because the one used for the join is long
 * closed by the time the association times out.
 */
function restoreStoredProfile(guidBytes: Uint8Array, profileXml: string): void {
	try {
		withWlanHandle((api, handle) => {
			const xml = utf16z(profileXml);
			const reasonCode = new Uint32Array(1);
			api.WlanSetProfile(handle, ptr(guidBytes), 0, ptr(xml), null, 1, null, ptr(reasonCode));
		});
	} catch {
		// Nothing better to do: the join failure is the error worth reporting.
	}
}

/**
 * True when the network Windows can currently see under this name uses
 * WPA3-Personal.
 *
 * This reads the list the WLAN service already holds — no scan is triggered, so
 * it costs a call and not four seconds. A network that is not in the list yields
 * false, which is the right default: WPA2 is what the transition mode most access
 * points run advertises, and it is also what an out-of-date list would have said.
 */
function usesSae(api: WlanApi, handle: Pointer, guidBytes: Uint8Array, ssid: string): boolean {
	const listOut = new BigUint64Array(1);
	if (api.WlanGetAvailableNetworkList(handle, ptr(guidBytes), 0, null, ptr(listOut)) !== 0) return false;
	const list = Number(listOut[0]) as Pointer;
	try {
		return findAuthAlgorithm(list, ssid) === AUTH_ALGO_WPA3_SAE;
	} finally {
		api.WlanFreeMemory(list);
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
		if (readWindowsWifi().get(guid)?.ssid === ssid && connectedGuids.has(guid)) return;
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
