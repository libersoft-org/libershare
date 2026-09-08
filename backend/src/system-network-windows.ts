import { validateIPv4Config, type NetAddress, type NetInterfaceInfo, type NetIPv4Config, type NetMedium, type NetLink, type NetAddressMode, type NetWifiInfo } from '@shared';
export { type WlanSymbol, WLAN_SYMBOLS, openWlanHandleForTest, hasWlanAdapter, loadWlanApiForTest, readConnectionAttributes, readWindowsWifi, isWindowsInterfaceID, wlanErrorMessage, guidToBytes, utf16z, readUtf16z, encodeConnectionParameters, isWindowsWifiConfigurable } from './system-network-windows-wlan.ts';
export { assertProfileNameWritable, profileSsidHex, withJoinCredentials, windowsWifiProfileXml, assertWindowsWifiKey, type StoredProfile, type StoredProfileResult, readStoredProfile, type ProfileChange, type JoinTarget, openJoinDecision, writeJoinProfile, undoProfileChange } from './system-network-windows-profiles.ts';
export { parseAvailableNetworks, findScannedNetwork, type AvailableNetwork, wlanScanErrorMessage, scanWindowsWifi, connectWindowsWifi, disconnectWindowsWifi, assertWindowsWifiMutationIdle } from './system-network-windows-wifi.ts';


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

/**
 * The single read-only PowerShell one-shot backing {@link parseWindowsNetworkState}.
 *
 * `@()` around every collection keeps ConvertTo-Json from collapsing a one-row
 * result into a bare object, and the DNS servers are joined into a plain string
 * because Windows PowerShell serializes an empty array inside a calculated
 * property as `{}` and a one-element array as a bare string.
 */
export const WINDOWS_STATE_COMMAND: string = ['[Console]::OutputEncoding=[System.Text.Encoding]::UTF8', '$ErrorActionPreference = "Stop"', "function Read-OptionalNetRows([scriptblock]$Query) { try { @(& $Query) } catch { if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { @() } else { throw } } }", "$adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop | Select-Object ifIndex, Name, InterfaceGuid, MacAddress, Virtual, InterfaceDescription, @{n='Media';e={[int]$_.NdisPhysicalMedium}}, @{n='IfType';e={[int]$_.InterfaceType}}, @{n='Hidden';e={[int]$_.Hidden}}, @{n='State';e={[int]$_.MediaConnectionState}}, @{n='OperationalState';e={[int]$_.InterfaceOperationalStatus}})", "$addresses = @(Get-NetIPAddress -PolicyStore ActiveStore -ErrorAction Stop | Select-Object ifIndex, @{n='Family';e={[int]$_.AddressFamily}}, IPAddress, PrefixLength, @{n='State';e={[int]$_.AddressState}}, @{n='PrefixOrigin';e={[int]$_.PrefixOrigin}}, @{n='SuffixOrigin';e={[int]$_.SuffixOrigin}}, @{n='Type';e={[int]$_.Type}}, @{n='SkipAsSource';e={[bool]$_.SkipAsSource}}, @{n='Infinite';e={$_.ValidLifetime -eq [TimeSpan]::MaxValue -and $_.PreferredLifetime -eq [TimeSpan]::MaxValue}})", "$persistentAddresses = @(Read-OptionalNetRows { Get-NetIPAddress -AddressFamily IPv4 -PolicyStore PersistentStore -ErrorAction Stop } | Select-Object ifIndex, @{n='Family';e={[int]$_.AddressFamily}}, IPAddress, PrefixLength, @{n='State';e={[int]$_.AddressState}}, @{n='PrefixOrigin';e={[int]$_.PrefixOrigin}}, @{n='SuffixOrigin';e={[int]$_.SuffixOrigin}}, @{n='Type';e={[int]$_.Type}}, @{n='SkipAsSource';e={[bool]$_.SkipAsSource}}, @{n='Infinite';e={$_.ValidLifetime -eq [TimeSpan]::MaxValue -and $_.PreferredLifetime -eq [TimeSpan]::MaxValue}})", "$interfaces = @(Get-NetIPInterface -ErrorAction Stop | Select-Object ifIndex, InterfaceAlias, @{n='ConnectionState';e={[int]$_.ConnectionState}}, @{n='Family';e={[int]$_.AddressFamily}}, @{n='Dhcp';e={[int]$_.Dhcp}})", "$routes = @(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop | Where-Object DestinationPrefix -eq '0.0.0.0/0' | Select-Object ifIndex, NextHop, RouteMetric, InterfaceMetric, @{n='Protocol';e={[int]$_.Protocol}}, @{n='Publish';e={[int]$_.Publish}}, @{n='Infinite';e={$_.ValidLifetime -eq [TimeSpan]::MaxValue}})", "$persistentRoutes = @(Read-OptionalNetRows { Get-NetRoute -AddressFamily IPv4 -PolicyStore PersistentStore -ErrorAction Stop } | Where-Object DestinationPrefix -eq '0.0.0.0/0' | Select-Object ifIndex, NextHop, RouteMetric, InterfaceMetric, @{n='Protocol';e={[int]$_.Protocol}}, @{n='Publish';e={[int]$_.Publish}}, @{n='Infinite';e={$_.ValidLifetime -eq [TimeSpan]::MaxValue}})", "$routes6 = @(Read-OptionalNetRows { Get-NetRoute -AddressFamily IPv6 -PolicyStore ActiveStore -ErrorAction Stop } | Where-Object DestinationPrefix -eq '::/0' | Select-Object ifIndex, RouteMetric, InterfaceMetric)", "$dns = @(Get-DnsClientServerAddress -ErrorAction Stop | Select-Object InterfaceIndex, @{n='Servers';e={($_.ServerAddresses -join ',')}})", '[pscustomobject]@{adapters=$adapters; addresses=$addresses; persistentAddresses=$persistentAddresses; interfaces=$interfaces; routes=$routes; routes6=$routes6; persistentRoutes=$persistentRoutes; dns=$dns} | ConvertTo-Json -Depth 6 -Compress'].join('; ');

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
