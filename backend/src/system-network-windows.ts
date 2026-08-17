import { dlopen, FFIType, ptr, read, toArrayBuffer, type Pointer } from 'bun:ffi';
import { isValidWifiKey, isWifiHexKey, type NetAddress, type NetInterfaceInfo, type NetIPv4Config, type NetMedium, type NetLink, type NetAddressMode, type NetWifiInfo, type NetWifiNetwork } from '@shared';

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
const ADDRESS_STATE_TENTATIVE = 1;
const ADDRESS_STATE_DUPLICATE = 2;
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
export const WINDOWS_STATE_COMMAND: string = [
	'[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
	"$adapters = @(Get-NetAdapter -IncludeHidden | Select-Object ifIndex, Name, InterfaceGuid, MacAddress, @{n='Media';e={[int]$_.NdisPhysicalMedium}}, @{n='IfType';e={[int]$_.InterfaceType}}, @{n='Hidden';e={[int]$_.Hidden}}, @{n='State';e={[int]$_.MediaConnectionState}})",
	// The address section reports success for the same reason the two below do, and
	// with more at stake: an apply REMOVES every IPv4 address before writing the new
	// one, and {@link ipv4EditObjection} refuses an interface carrying more than one
	// by counting the addresses in this very reading. A failed section counts zero,
	// which passes that check and then destroys the aliases it exists to protect.
	...sectionStep('addresses', "Get-NetIPAddress -ErrorAction Stop | Select-Object ifIndex, @{n='Family';e={[int]$_.AddressFamily}}, IPAddress, PrefixLength, @{n='State';e={[int]$_.AddressState}}"),
	"$interfaces = @(Get-NetIPInterface | Select-Object ifIndex, @{n='Family';e={[int]$_.AddressFamily}}, @{n='Dhcp';e={[int]$_.Dhcp}})",
	// The two sections below report whether they SUCCEEDED, not merely what they
	// found. `-ErrorAction SilentlyContinue` made "this host has no default route"
	// and "the route provider failed" the same empty array, and the parser then
	// reported a confident state with no gateway and no resolvers — which the edit
	// form shows as empty fields and a save writes back as fact.
	//
	// ObjectNotFound is the one category that is genuinely an absence: a host with
	// no default route really has none. Everything else leaves the section unknown.
	...sectionStep('routes', "Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Select-Object ifIndex, NextHop, RouteMetric, InterfaceMetric"),
	...sectionStep('dns', "Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction Stop | Select-Object InterfaceIndex, @{n='Servers';e={($_.ServerAddresses -join ',')}}"),
	'[pscustomobject]@{adapters=$adapters; addresses=$addresses; addressesOk=$addressesOk; interfaces=$interfaces; routes=$routes; routesOk=$routesOk; dns=$dns; dnsOk=$dnsOk} | ConvertTo-Json -Depth 6 -Compress',
].join('; ');

/** One optional section of the state document, plus the `<name>Ok` flag saying whether it could be read. */
function sectionStep(name: string, query: string): string[] {
	return [`$${name}Ok = $true`, `$${name} = @()`, `try { $${name} = @(${query}) } catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { $${name}Ok = $false } }`];
}

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
	// A section that could not be read leaves this interface's addresses, gateway or
	// resolvers unknown rather than absent — and an apply REPLACES all three, so
	// acting on the empty reading would delete values nobody ever saw. `!== false`
	// so a document captured before these flags existed still parses as the complete
	// read it was.
	//
	// `interfaces` is deliberately not in the list: all it carries is the DHCP flag,
	// which an unread section reports as `ipv4Mode: 'unknown'` — the same honest
	// answer every platform gives for a mode it cannot name, and one the editor
	// already handles by making the user pick. Nothing is deleted by not knowing it.
	const complete = doc['addressesOk'] !== false && doc['routesOk'] !== false && doc['dnsOk'] !== false;

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
			// An addressed stack with no adapter row (RAS, VPN, Teredo) gets an
			// `ifIndex:N` id, and the apply path resolves an adapter by GUID — so
			// `assertWindowsGuid` rejects that id every time. Saying so here keeps the
			// UI from offering a Configure button whose Save could only ever fail.
			ipv4Configurable: guid !== null && complete,
			// Every wlanapi call is addressed by the same GUID, and none of them needs
			// the elevation the address apply does — so on Windows the three answers
			// differ only in what they are asked about, not in what they require.
			wifiScannable: guid !== null,
			wifiConnectable: guid !== null,
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

/**
 * A WLAN client handle.
 *
 * Kept as a `bigint` rather than a {@link Pointer} for the whole of its life.
 * Bun represents a pointer as a JavaScript number because a virtual address
 * fits in 53 bits, but its FFI documentation states outright that the Windows
 * `HANDLE` type is NOT a virtual address and must be declared `u64` instead of
 * `ptr`. Rounding one through `Number()` is therefore a conversion the ABI does
 * not sanction, whatever the values a given WLAN service happens to hand out.
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
function withWlanHandle<T>(fn: (api: WlanApi, handle: WlanHandle) => T): T {
	const api = getWlanApi();
	if (!api) throw new Error('the Windows WLAN service is not available on this host');
	const negotiated = new Uint32Array(1);
	const handleOut = new BigUint64Array(1);
	const rc = api.WlanOpenHandle(2, null, ptr(negotiated), ptr(handleOut));
	if (rc !== 0) throw new Error(wlanErrorMessage(rc));
	// Straight out of the output buffer as a bigint. Never through `Number()`: a
	// HANDLE is an opaque 64-bit value, not an address that is guaranteed to fit.
	const handle = handleOut[0] as WlanHandle;
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
 * Wrap a removal step so that "there was nothing to remove" passes and every
 * other failure still stops the script.
 *
 * `-ErrorAction SilentlyContinue` swallowed all of them alike: an adapter that
 * is already on DHCP has no address to delete, but so does one where the delete
 * was refused with access-denied or failed in the CIM provider — and the steps
 * that follow then ran on top of an unknown partial state. Measured on Windows
 * 11: a removal that matches nothing raises `CategoryInfo.Category` of
 * `ObjectNotFound`, while a genuine failure raises anything but, so that one
 * category is the whole of what may be ignored.
 */
function tolerateMissing(command: string): string {
	return ignoringMissing(`${command} -ErrorAction Stop`);
}

/**
 * The same tolerance around a whole statement rather than one cmdlet call — for a
 * reading that has to assign its result, where `-ErrorAction Stop` belongs inside
 * the pipeline instead of after it.
 */
function ignoringMissing(statement: string): string {
	return `try { ${statement} } catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw } }`;
}

/**
 * Capture everything the apply below is about to overwrite.
 *
 * Runs before the first destructive step, because from that point on the machine
 * no longer knows what it used to be: the addresses are gone, the default routes
 * are gone, and a failure two steps later would leave an interface with neither
 * the old configuration nor the new one. What is captured is exactly what
 * {@link windowsRestoreSteps} puts back — DHCP state, every IPv4 address with its
 * prefix, every IPv4 default route with its metric, and the resolver list.
 *
 * Not one of the four may fail open. `-ErrorAction SilentlyContinue` made "this
 * adapter has no static address" and "the address provider could not be reached"
 * the same empty list — and an empty list is what the restore writes back, so a
 * reading that failed here is a rollback that silently deletes the configuration
 * it was supposed to preserve. The other three legitimately return nothing on an
 * adapter that is simply unconfigured, which is `ObjectNotFound` and only that;
 * every other failure aborts the apply before anything has been removed.
 *
 * Each object is captured with the properties a restore has to hand back, not
 * merely the ones that identify it. An address re-created from `IPAddress` and
 * `PrefixLength` alone comes back with `SkipAsSource` false and an infinite
 * lifetime whatever it had before, and a default route re-created from `NextHop`
 * and `RouteMetric` alone comes back as an ordinary published-by-nobody NetMgmt
 * route — so a rollback reported as "the change was undone" left the host in a
 * measurably different state. `New-NetIPAddress` and `New-NetRoute` both accept
 * exactly these back (verified against their parameter binding on Windows 11,
 * including an infinite `TimeSpan.MaxValue` lifetime), and the objects never
 * leave PowerShell, so they need no projection to survive the round trip.
 *
 * `PrefixOrigin` and `SuffixOrigin` are captured for a different purpose: they
 * cannot be written back at all — Windows decides them — so they are what
 * {@link WINDOWS_ORIGIN_GUARD} refuses on rather than what the restore replays.
 *
 * The one property still not round-tripped is store membership. Measured on
 * Windows 11, `New-NetIPAddress` writes to the active AND the persistent store
 * unless told otherwise, so an address that was persistent comes back persistent;
 * an address that had been active-only comes back persistent too, which is the
 * harmless direction of that difference.
 *
 * The resolver snapshot deliberately does NOT use `Get-DnsClientServerAddress`.
 * That cmdlet reports the EFFECTIVE list, which on a DHCP interface is the one
 * the lease handed out — and writing an effective list back with
 * `-ServerAddresses` pins it as a MANUAL override, so an interface that had been
 * taking its resolvers from DHCP silently stops honouring future DHCP changes.
 * Measured on Windows 11: a DHCP interface reports an effective server while its
 * static `NameServer` registry value is empty, and the DHCP-supplied value lives
 * under `DhcpNameServer` instead. `NameServer` is therefore the only reading that
 * answers "was this a manual override?", which is the question the restore asks.
 */
function windowsSnapshotSteps(): string[] {
	return [
		'$oldDhcp = (Get-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction Stop).Dhcp',
		'$oldAddresses = @()',
		ignoringMissing('$oldAddresses = @(Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction Stop | Select-Object IPAddress, PrefixLength, PrefixOrigin, SuffixOrigin, SkipAsSource, ValidLifetime, PreferredLifetime)'),
		'$oldRoutes = @()',
		ignoringMissing("$oldRoutes = @(Get-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Select-Object NextHop, RouteMetric, Protocol, Publish)"),
		// Empty for an interface on automatic DNS, and only then. Windows writes the
		// value comma-separated but has historically also used spaces, so both split.
		//
		// The whole key is read rather than the one value: `-Name NameServer` on an
		// interface that never had a manual override raises InvalidArgument, which is
		// indistinguishable from a real read failure by category. Reading the key
		// leaves an absent value as $null — the honest "no override" — while a key
		// that cannot be read at all still throws.
		'$oldDnsManual = @((Get-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$($adapter.InterfaceGuid)" -ErrorAction Stop).NameServer -split \'[,\\s]+\' | Where-Object { $_ })',
	];
}

/**
 * Put the snapshot back after a failed apply.
 *
 * The two branches are not symmetrical, and deliberately so. An interface that
 * was on DHCP is restored by re-enabling DHCP and nothing else: the addresses and
 * routes in the snapshot came from a lease, and re-adding them by hand would
 * install a static copy that the lease then duplicates. An interface that was
 * static has to have every address and every default route written back
 * individually, metric included, because that configuration exists nowhere else.
 *
 * Resolvers are restored the same way round: the addresses go back only when the
 * snapshot proved they were a MANUAL override, and automatic DNS is put back with
 * `-ResetServerAddresses`. Writing an effective list back unconditionally would
 * convert a DHCP interface's resolvers into a static override it never had — see
 * {@link windowsSnapshotSteps}.
 */
function windowsRestoreSteps(): string[] {
	const restoreStatic = ['Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Disabled', 'foreach ($a in $oldAddresses) { New-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -IPAddress $a.IPAddress -PrefixLength $a.PrefixLength -SkipAsSource $a.SkipAsSource -ValidLifetime $a.ValidLifetime -PreferredLifetime $a.PreferredLifetime -ErrorAction Stop | Out-Null }', "foreach ($r in $oldRoutes) { New-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -NextHop $r.NextHop -RouteMetric $r.RouteMetric -Protocol $r.Protocol -Publish $r.Publish -Confirm:$false -ErrorAction Stop | Out-Null }"].join('; ');
	return [tolerateMissing('Remove-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -Confirm:$false'), tolerateMissing("Remove-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -Confirm:$false"), `if ($oldDhcp -eq 'Enabled') { Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Enabled } else { ${restoreStatic} }`, 'if ($oldDnsManual.Count -gt 0) { Set-DnsClientServerAddress -InterfaceIndex $i -ServerAddresses $oldDnsManual } else { Set-DnsClientServerAddress -InterfaceIndex $i -ResetServerAddresses }'];
}

/**
 * Refuse an interface carrying more than one IPv4 address, counted on the machine
 * itself rather than in the reading.
 *
 * `ipv4EditObjection` already refuses aliases, but it counts what
 * {@link parseWindowsNetworkState} REPORTS — and that reader drops every address
 * Windows does not call `Preferred`, because a tentative or deprecated address is
 * not one the host can be reached on. The apply is not so selective: a single
 * `Remove-NetIPAddress -AddressFamily IPv4` takes ALL of them. So an interface
 * holding one preferred address beside a deprecated one looked like a plain
 * single-address interface, passed the check, and lost the address nobody had
 * been shown.
 *
 * Counted out of the snapshot, which is the same query with no state filter, so
 * this costs no extra call. Placed after the snapshot and before the first
 * removal — nothing has been changed yet, so the refusal is free.
 *
 * NO address is exempt, and in particular not `169.254.*`. That prefix was
 * excluded on the grounds that a link-local address only exists because DHCP did
 * not answer — but the prefix does not say who created it. Windows distinguishes
 * an automatic APIPA address (`PrefixOrigin` WellKnown, `SuffixOrigin`
 * LinkLayerAddress) from one a user configured by hand (both `Manual`), and the
 * text `169.254.` is identical in the two cases. The removal that follows takes
 * every IPv4 address on the interface either way, so exempting the prefix let a
 * manually configured link-local alias pass the count and then be deleted — an
 * alias the reader also hides, so it was not even visible beforehand.
 */
export const WINDOWS_ALIAS_GUARD: string = `if (@($oldAddresses).Count -gt 1) { throw "this interface carries several IPv4 addresses, which this app cannot preserve" }`;

/**
 * The same refusal for default routes, and for the same reason.
 *
 * {@link parseWindowsNetworkState} reports at most ONE gateway per interface — it
 * ranks the competing default routes and keeps the best — so the configuration
 * the user edits can express one. The apply removes ALL of them and creates at
 * most one, which on an interface carrying a backup route, or a second default
 * route installed by a VPN client or by device management, destroys the extra
 * ones for good while reporting success. The user need not even have touched the
 * gateway: a DNS-only change ran the same removal.
 *
 * Refusing is the honest answer until the configuration can carry more than one
 * route. Counted out of the snapshot, so it costs no extra call, and placed
 * before the first removal, so nothing has to be undone.
 */
export const WINDOWS_ROUTE_GUARD: string = `if (@($oldRoutes).Count -gt 1) { throw "this interface carries several IPv4 default routes, which this app cannot preserve" }`;

/**
 * Refuse an interface holding a static address whose provenance the restore
 * cannot reproduce.
 *
 * {@link windowsRestoreSteps} re-creates a static interface's addresses with
 * `New-NetIPAddress`, and everything Windows makes that way is `Manual` in both
 * `PrefixOrigin` and `SuffixOrigin`. There is no parameter for either — the stack
 * assigns them from HOW the address came to exist — so an address that got its
 * prefix from a router advertisement, or its suffix from the link layer, comes
 * back as a different object however carefully the rest is replayed.
 *
 * Only the static branch is checked, because the DHCP branch does not re-create
 * anything: it re-enables DHCP and lets the lease put the addresses back.
 *
 * Measured on Windows 11: a hand-configured address reports Manual/Manual, a
 * lease reports Dhcp/Dhcp, and an automatic APIPA address reports
 * WellKnown/LinkLayerAddress — which is also the pair that tells that address
 * apart from a link-local one a user set by hand.
 */
export const WINDOWS_ORIGIN_GUARD: string = `if ($oldDhcp -ne 'Enabled') { foreach ($a in $oldAddresses) { if ($a.PrefixOrigin -ne 'Manual' -or $a.SuffixOrigin -ne 'Manual') { throw "this interface carries an IPv4 address this app could not put back if the change failed" } } }`;

/** How long duplicate address detection may run before the apply gives up on it. */
const DAD_TIMEOUT_MS = 15000;
/** How often the address state is re-read while duplicate address detection runs. */
const DAD_POLL_MS = 250;

/**
 * Wait for a freshly created address to become usable, and fail the apply if it
 * does not.
 *
 * `New-NetIPAddress` returns as soon as the object exists, and Windows then runs
 * duplicate address detection: until that finishes the address is `Tentative`,
 * and it can end as `Duplicate` because some other device on the segment already
 * answers for it. Checking only that an object with the requested IP exists —
 * which is all the apply used to do — reports success for both outcomes.
 *
 * That is not merely optimistic, it contradicts the reader: it accepts only
 * `Preferred` addresses, so the state broadcast right after a "successful" apply
 * showed an interface with no IPv4 address at all.
 *
 * `Deprecated` and `Invalid` are failures for the same reason `Duplicate` is —
 * the reader will not report them, so calling the apply a success would leave the
 * UI contradicting itself — but they are described separately, because the answer
 * to a duplicate is to pick another address and the answer to the others is not.
 */
export function windowsAddressStateWait(address: string): string {
	const found = `@(Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq '${address}' })`;
	// `$state` is read again after the loop: `break` leaves it Preferred, and
	// falling out of the `while` leaves whatever the last poll saw, which is the
	// only way to tell a timeout apart from a success.
	const poll = [`$found = ${found}`, 'if ($found.Count -eq 0) { throw "the address was accepted but is not on the interface" }', '$state = [int]$found[0].AddressState', `if ($state -eq ${ADDRESS_STATE_PREFERRED}) { break }`, `if ($state -eq ${ADDRESS_STATE_DUPLICATE}) { throw "another device on this network is already using that address" }`, `if ($state -ne ${ADDRESS_STATE_TENTATIVE}) { throw "Windows accepted the address but will not use it" }`, `Start-Sleep -Milliseconds ${DAD_POLL_MS}`].join('; ');
	return [`$deadline = (Get-Date).AddMilliseconds(${DAD_TIMEOUT_MS})`, '$state = 0', `do { ${poll} } while ((Get-Date) -lt $deadline)`, `if ($state -ne ${ADDRESS_STATE_PREFERRED}) { throw "Windows is still checking the new address for duplicates" }`].join('; ');
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
 * between would leave it that way. {@link windowsSnapshotSteps} records what was
 * there and {@link windowsRestoreSteps} puts it back before the error is
 * rethrown. A rollback that itself fails is reported alongside the original
 * failure rather than in place of it, because the machine is then in a state
 * neither error alone describes.
 *
 * A static apply is verified before it is called a success: PowerShell can report
 * a clean run for a `New-NetIPAddress` the stack did not honour, and an
 * unverified apply would answer "done" while the interface still has no address.
 * That verification waits for duplicate address detection rather than merely
 * looking the object up — see {@link windowsAddressStateWait}.
 *
 * Every interpolated value has been through the shared validator, so each one is
 * a dotted-quad literal, a small integer, or a GUID. No quoting rule protects
 * this string — the validation does.
 */
export function windowsApplyIPv4Command(guid: string, config: NetIPv4Config): string {
	const preamble = ['[Console]::OutputEncoding=[System.Text.Encoding]::UTF8', '$ErrorActionPreference = "Stop"', `$adapter = Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceGuid -eq '${guid}' }`, 'if (-not $adapter) { throw "interface not found" }', '$i = $adapter.ifIndex'];
	const mutation = [tolerateMissing('Remove-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -Confirm:$false'), tolerateMissing("Remove-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -Confirm:$false")];
	if (config.mode === 'dhcp') {
		mutation.push('Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Enabled', 'Set-DnsClientServerAddress -InterfaceIndex $i -ResetServerAddresses');
	} else {
		const gateway = config.gateway ? ` -DefaultGateway ${config.gateway}` : '';
		const dns = config.dns ?? [];
		mutation.push('Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Disabled', `New-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -IPAddress ${config.address} -PrefixLength ${config.prefixLength}${gateway} | Out-Null`, dns.length > 0 ? `Set-DnsClientServerAddress -InterfaceIndex $i -ServerAddresses ${dns.join(',')}` : 'Set-DnsClientServerAddress -InterfaceIndex $i -ResetServerAddresses', windowsAddressStateWait(config.address as string));
	}
	const guarded = `try { ${mutation.join('; ')} } catch { $applyError = $_; try { ${windowsRestoreSteps().join('; ')} } catch { throw "the change failed ($($applyError.Exception.Message)) and rolling it back also failed ($($_.Exception.Message))" }; throw $applyError }`;
	return [...preamble, ...windowsSnapshotSteps(), WINDOWS_ALIAS_GUARD, WINDOWS_ROUTE_GUARD, WINDOWS_ORIGIN_GUARD, guarded].join('; ');
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
 * The join is a one-off: `<connectionMode>manual</connectionMode>` means Windows
 * will not re-associate with this network by itself later. `auto` was the wrong
 * default because the user is never asked — the UI offers Connect and nothing
 * else — so an explicit single join to a guest or conference network silently
 * changed the machine's long-term behaviour, up to and including auto-joining an
 * open network of that name anywhere in the world. A "remember this network"
 * option would be the way to offer the other mode; until one exists, the mode the
 * user did not ask for is the one not to pick.
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
	const hex = [...ssidBytes].map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('');
	// A 64-hex credential is a raw 256-bit PSK, not a passphrase, and the profile
	// has to say so: announced as `passPhrase` Windows hashes it a second time, so
	// the profile is written, accepted, and then simply never authenticates.
	const keyType = isWifiHexKey(password) ? 'networkKey' : 'passPhrase';
	const security = password ? `<authEncryption><authentication>${sae ? 'WPA3SAE' : 'WPA2PSK'}</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption><sharedKey><keyType>${keyType}</keyType><protected>false</protected><keyMaterial>${escapeXml(password)}</keyMaterial></sharedKey>` : `<authEncryption><authentication>open</authentication><encryption>none</encryption><useOneX>false</useOneX></authEncryption>`;
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
		const entry: NetWifiNetwork = { ssid: found.ssid, signal: found.signal, secured: found.secured, active: found.active };
		const previous = best.get(entry.ssid);
		if (!previous) best.set(entry.ssid, entry);
		else if ((entry.signal ?? -1) > (previous.signal ?? -1)) best.set(entry.ssid, { ...entry, active: previous.active || entry.active, secured: previous.secured || entry.secured });
		else if (entry.active) best.set(entry.ssid, { ...previous, active: true });
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
export function findScannedNetwork(list: Pointer, ssid: string): AvailableNetwork | null {
	let best: AvailableNetwork | null = null;
	for (const entry of availableNetworks(list)) if (entry.ssid === ssid && (!best || (entry.signal ?? -1) > (best.signal ?? -1))) best = entry;
	return best;
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
		yield {
			// Lossy by nature — an SSID is not guaranteed to be UTF-8 — so this form
			// is for display and for matching what the user picked, never for
			// building a profile. `ssidBytes` is the authoritative value.
			ssid: decoder.decode(ssidBytes),
			ssidBytes,
			profileName: readFixedUtf16(list, base + AVAILABLE_PROFILE_NAME_OFFSET, AVAILABLE_PROFILE_NAME_CHARS),
			signal,
			secured: read.u32(list, base + AVAILABLE_SECURITY_OFFSET) !== 0,
			active: (read.u32(list, base + AVAILABLE_FLAGS_OFFSET) & AVAILABLE_NETWORK_CONNECTED) !== 0,
			auth: read.u32(list, base + AVAILABLE_AUTH_OFFSET),
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
	if (password) assertWindowsWifiKey(password, sae);
	// Held in a local of its own: WLAN_CONNECTION_PARAMETERS stores only the
	// ADDRESS of the profile name, so the array behind it has to outlive the call.
	const profileNameW = utf16z(profileName);
	const parameters = encodeConnectionParameters(BigInt(ptr(profileNameW)));
	const profileXml = windowsWifiProfileXml(profileName, ssidBytes, password, sae);
	/** What Windows held under this profile name before the attempt. Null when it held nothing. */
	let replaced: StoredProfile | null = null;
	/** True once this attempt has written a profile that did not exist before it. */
	let created = false;
	try {
		withWlanHandle((api, handle) => {
			if (password) {
				const change = writeJoinProfile(api, handle, guidBytes, profileName, profileXml);
				replaced = change.replaced;
				created = change.created;
				connectByProfile(api, handle, guidBytes, parameters);
				return;
			}
			const rc = api.WlanConnect(handle, ptr(guidBytes), ptr(parameters), null);
			if (rc === 0) return;
			// Nothing stored for this name. The only network that can be joined without a
			// key is an open one, so give Windows an open profile to work from — but
			// never in place of one it already holds. When one does already exist, the
			// failed connect is the real story and its code is the one worth reporting.
			if (writeProfile(api, handle, guidBytes, profileXml, WLAN_PROFILE_USER, 0) === ERROR_ALREADY_EXISTS) throw new Error(wlanErrorMessage(rc));
			created = true;
			connectByProfile(api, handle, guidBytes, parameters);
		});
		await waitForAssociation(guid, ssid);
	} catch (err) {
		const rollback = undoWifiProfileChange(guidBytes, profileName, replaced, created);
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
	if (!isValidWifiKey(password, sae)) throw new Error('the password is not one a WPA2 or WPA3 personal network could accept');
	if (!/^[\x20-\x7e]+$/.test(password)) throw new Error('Windows accepts only printable ASCII characters in a Wi-Fi passphrase');
}

/** A stored WLAN profile, as {@link readStoredProfile} found it. */
export interface StoredProfile {
	/** The document exactly as Windows holds it, key material still encrypted. */
	readonly xml: string;
	/** WLAN_PROFILE_* flags. Writing it back with any others changes its scope. */
	readonly flags: number;
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
		return { kind: 'found', profile: { xml: readUtf16z(xmlPointer), flags: flags[0] ?? 0 } };
	} catch (err) {
		// A document that cannot be read back is a document that cannot be restored.
		return { kind: 'error', message: (err as Error).message };
	} finally {
		api.WlanFreeMemory(xmlPointer);
	}
}

/** What one attempt did to the stored profiles, so the rollback knows what to undo. */
interface ProfileChange {
	/** The profile this attempt overwrote, or null when it created one. */
	readonly replaced: StoredProfile | null;
	/** True when nothing was stored under this name before this attempt. */
	readonly created: boolean;
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
export function writeJoinProfile(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, profileName: string, profileXml: string): ProfileChange {
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
	if (writeProfile(api, handle, guidBytes, profileXml, WLAN_PROFILE_USER, 0) !== ERROR_ALREADY_EXISTS) return { replaced: null, created: true };
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
		writeProfile(api, handle, guidBytes, profileXml, existing.flags, 1);
		return { replaced: existing, created: false };
	}
}

/**
 * Write a profile document, turning a refusal into an error that carries the
 * reason code. Returns the raw result so the caller can tell the one tolerable
 * outcome — ERROR_ALREADY_EXISTS after asking not to overwrite — from a failure.
 */
function writeProfile(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, profileXml: string, flags: number, overwrite: number): number {
	const document = utf16z(profileXml);
	const reason = new Uint32Array(1);
	const rc = api.WlanSetProfile(handle, ptr(guidBytes), flags, ptr(document), null, overwrite, null, ptr(reason));
	if (rc !== 0 && rc !== ERROR_ALREADY_EXISTS) throw new Error(describeProfileFailure(api, rc, reason[0] ?? 0));
	return rc;
}

/** Queue an association through a stored profile, or fail with the code Windows gave. */
function connectByProfile(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, parameters: Uint8Array): void {
	const rc = api.WlanConnect(handle, ptr(guidBytes), ptr(parameters), null);
	if (rc !== 0) throw new Error(wlanErrorMessage(rc));
}

/**
 * Undo whatever the failed attempt wrote. Returns a description of a rollback
 * that itself failed, or null when there was nothing to undo or it worked.
 *
 * The two cases are different actions, not one with a null in it. A profile this
 * attempt CREATED has to be deleted — "restoring what was there before" would
 * mean writing nothing and leaving the new one standing, which is how a failed
 * join used to leave a dead profile behind. A profile it OVERWROTE goes back with
 * the flags it had, so its scope is unchanged.
 */
function undoWifiProfileChange(guidBytes: Uint8Array, profileName: string, replaced: StoredProfile | null, created: boolean): string | null {
	if (!created && !replaced) return null;
	try {
		// Its own handle: the one used for the join is long closed by the time an
		// association times out.
		return withWlanHandle((api, handle) => {
			const name = utf16z(profileName);
			if (created) {
				const rc = api.WlanDeleteProfile(handle, ptr(guidBytes), ptr(name), null);
				return rc === 0 ? null : `the profile this attempt created could not be deleted (${wlanErrorMessage(rc)})`;
			}
			const document = utf16z((replaced as StoredProfile).xml);
			const reason = new Uint32Array(1);
			const rc = api.WlanSetProfile(handle, ptr(guidBytes), (replaced as StoredProfile).flags, ptr(document), null, 1, null, ptr(reason));
			return rc === 0 ? null : `the previous profile could not be restored (${describeProfileFailure(api, rc, reason[0] ?? 0)})`;
		});
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
type ScanLookup = { readonly kind: 'found'; readonly network: AvailableNetwork } | { readonly kind: 'notFound' } | { readonly kind: 'readError'; readonly message: string };

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
		return network ? { kind: 'found', network } : { kind: 'notFound' };
	} catch (err) {
		// A list that describes itself impossibly (see MAX_AVAILABLE_NETWORKS) is a
		// structure we cannot read, not a network that is not there.
		return { kind: 'readError', message: (err as Error).message };
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
