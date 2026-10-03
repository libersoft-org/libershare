import { validateIPv4Config, type NetAddress, type NetInterfaceInfo, type NetMedium, type NetLink, type NetAddressMode, type NetWifiInfo } from '@shared';
export { type WlanSymbol, WLAN_SYMBOLS, openWlanHandleForTest, hasWlanAdapter, loadWlanApiForTest, readConnectionAttributes, readWindowsWifi, isWindowsInterfaceID, wlanErrorMessage, guidToBytes, utf16z, readUtf16z, encodeConnectionParameters, isWindowsWifiConfigurable } from './system-network-windows-wlan.ts';
export { assertProfileNameWritable, profileSsidHex, withJoinCredentials, windowsWifiProfileXml, assertWindowsWifiKey, type StoredProfile, type StoredProfileResult, readStoredProfile, type ProfileChange, type JoinTarget, openJoinDecision, writeJoinProfile, undoProfileChange } from './system-network-windows-profiles.ts';
export { parseAvailableNetworks, findScannedNetwork, type AvailableNetwork, wlanScanErrorMessage, scanWindowsWifi, connectWindowsWifi, disconnectWindowsWifi, assertWindowsWifiMutationIdle } from './system-network-windows-wifi.ts';

/** Windows network state projection and validated IPv4 operations. */

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
// NetIPInterface.ConnectionState uses 0 for disconnected, unlike MediaConnectionState.
const IP_STATE_DISCONNECTED = 0;
const IP_STATE_CONNECTED = 1;
// IF_OPER_STATUS: down and not present both prove that an adapter cannot carry traffic.
const OPER_STATUS_DOWN = 2;
const OPER_STATUS_NOT_PRESENT = 6;
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

interface WindowsAdapterRow {
	ifIndex: number;
	Name: string;
	Virtual?: boolean;
	InterfaceDescription?: string;
	InterfaceGuid: string;
	MacAddress: string;
	Media: number;
	/** IANA interface type. Optional so a document captured before this field existed still parses. */
	IfType?: number;
	/** 1 when Windows hides the adapter from the network UI (miniports, tunnels). */
	Hidden?: number;
	State: number;
	OperationalState?: number;
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
	InterfaceAlias?: string;
	ConnectionState?: number;
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

function mapLink(state: number, operationalState?: number): NetLink {
	if (state === MEDIA_STATE_CONNECTED) return 'up';
	if (state === MEDIA_STATE_DISCONNECTED) return 'down';
	if (operationalState === OPER_STATUS_DOWN || operationalState === OPER_STATUS_NOT_PRESENT) return 'down';
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
		const info = buildInterface(adapter.ifIndex, adapter.Name, mapMedium(adapter.Media, adapter.IfType, adapter.Hidden), mapLink(adapter.State, adapter.OperationalState), adapter.MacAddress, adapter.InterfaceGuid ? normalizeGuid(adapter.InterfaceGuid) : null);
		if (typeof adapter.Virtual === 'boolean') info.virtual = adapter.Virtual;
		if (adapter.Hidden === 0 || adapter.Hidden === 1) info.hidden = adapter.Hidden === 1;
		if (typeof adapter.InterfaceDescription === 'string' && adapter.InterfaceDescription.trim()) info.description = adapter.InterfaceDescription;
		result.push(info);
	}
	// Addressed stacks with no adapter row (RAS/VPN) — keep them, medium unknown.
	for (const ifIndex of addressesByIndex.keys()) {
		if (seen.has(ifIndex)) continue;
		const rows = ipInterfaces.filter(row => row.ifIndex === ifIndex);
		const name = rows.find(row => row.InterfaceAlias?.trim())?.InterfaceAlias ?? `#${ifIndex}`;
		const link: NetLink = rows.some(row => row.ConnectionState === IP_STATE_CONNECTED) ? 'up' : rows.length > 0 && rows.every(row => row.ConnectionState === IP_STATE_DISCONNECTED) ? 'down' : 'unknown';
		result.push(buildInterface(ifIndex, name, 'other', link, '', null));
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
