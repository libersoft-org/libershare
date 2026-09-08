// Product info
export { productName, productVersion, productIdentifier, productWebsite, productGithub, productNetworkList, productEnvPrefix, DEFAULT_API_PORT, DEFAULT_API_URL, MAX_API_MESSAGE_SIZE, MAX_UPLOAD_CHUNK_SIZE } from './product.ts';

// Utils
export { formatBytes, parseBytes, sanitizeFilename, truncateUTF8End, deriveConnectionStatus, isSelectableInterface, ipv4BaselineOf, sameIPv4Baseline, isIPv4, isIPv6, isValidSSID, isUnambiguousWifiTarget, isValidWifiKey, isWifiHexKey, MAX_DNS_LIST_BYTES, MAX_DNS_SERVERS, canonicalDnsServer, normalizeDnsServers, validateIPv4Config } from './utils.ts';

// Compression

/**
 * Compression algorithms the backend can really compress and decompress with.
 * Order matters — the UI renders the selector in this order.
 */
export const COMPRESSION_ALGORITHMS = ['gzip', 'brotli', 'zstd'] as const;

/** One of the algorithms listed in {@link COMPRESSION_ALGORITHMS}. */
export type CompressionAlgorithm = (typeof COMPRESSION_ALGORITHMS)[number];

/** Canonical file extension appended when exporting with a given algorithm. */
export const COMPRESSION_EXTENSIONS: Record<CompressionAlgorithm, string> = {
	gzip: '.gz',
	brotli: '.br',
	zstd: '.zst',
};

/**
 * Every extension recognised on import, mapped to its algorithm. Includes the
 * long aliases (.gzip, .zstd) so files produced elsewhere still open.
 */
const EXTENSION_ALGORITHMS: Record<string, CompressionAlgorithm> = {
	'.gz': 'gzip',
	'.gzip': 'gzip',
	'.br': 'brotli',
	'.zst': 'zstd',
	'.zstd': 'zstd',
};

/** File extension (with leading dot) written for the given algorithm. */
export function compressionExtension(algorithm: CompressionAlgorithm): string {
	return COMPRESSION_EXTENSIONS[algorithm] ?? COMPRESSION_EXTENSIONS.gzip;
}

/**
 * Detect the compression algorithm of a file path or URL from its extension.
 * Returns null when the path carries no known compression extension.
 */
export function detectCompression(filePath: string): CompressionAlgorithm | null {
	const lower = filePath.toLowerCase();
	for (const [ext, algorithm] of Object.entries(EXTENSION_ALGORITHMS)) if (lower.endsWith(ext)) return algorithm;
	return null;
}

/** Remove a trailing compression extension, if any. Leaves other paths untouched. */
export function stripCompressionExtension(filePath: string): string {
	const lower = filePath.toLowerCase();
	for (const ext of Object.keys(EXTENSION_ALGORITHMS)) if (lower.endsWith(ext)) return filePath.slice(0, -ext.length);
	return filePath;
}

/**
 * Expand file patterns/suffixes with every recognised compression extension,
 * so a picker offering `*.lish` also offers `*.lish.gz`, `*.lish.br`, …
 */
export function withCompressionExtensions(patterns: string[]): string[] {
	const extensions = Object.keys(EXTENSION_ALGORITHMS);
	return patterns.flatMap(pattern => [pattern, ...extensions.map(ext => pattern + ext)]);
}

/**
 * Check if a file path has a compressed file extension.
 * Returns true for known compression extensions (.gz, .br, .zst, …).
 */
export function isCompressed(filePath: string): boolean {
	return detectCompression(filePath) !== null;
}

// LISH types
export * from './lish.ts';

// API client
export { API, type IWsClient } from './api.ts';
export type { IdentityBackup } from './api.ts';

// WebSocket client
export { WsClient } from './client.ts';

// Error codes
export { ErrorCodes, CodedError, type ErrorCode } from './errors.ts';

// Network types

export interface NetworkStatus {
	connected: number;
	connectedPeers: string[];
	peersInStore: number;
	datasets: number;
}

export interface NetworkNodeInfo {
	peerID: string;
	addresses: string[];
}

export interface PeerConnectionInfo {
	peerID: string;
	direct: number;
	relay: number;
}

/**
 * Per-network gossipsub mesh health snapshot (mesh size, time since the last
 * graft/prune, median peer score). Returned by the network/lishnet layer and
 * surfaced over the `peers:count` event.
 */
export interface IMeshHealth {
	meshSize: number;
	stableSinceMs: number | null;
	medianScore: number | null;
}

export interface PeerListEntry {
	peerID: string;
	networks: Array<{ networkID: string; networkName: string }>;
	direct: number;
	relay: number;
}

export interface PeerLishEntry {
	id: string;
	name?: string | undefined;
	totalSize?: number | undefined;
}

/**
 * Network-wide LISH search result row (Browse network → LISHs tab).
 * Aggregated by `id`: when the same LISH is offered by multiple peers,
 * `peers` accumulates one entry per offering peer.
 * `name` / `totalSize` come from the first responder; subsequent responders
 * may report identical or slightly different values — we keep the first to keep the row stable.
 */
export interface LishSearchResult {
	id: string;
	name?: string | undefined;
	totalSize?: number | undefined;
	peers: Array<{ peerID: string; networkID: string }>;
}

/**
 * Progress of a peer manifest transfer, broadcast as the `lishnets:manifestProgress`
 * event while adding a LISH from a peer or loading its detail. `received`/`total` are
 * byte counts of the length-prefixed manifest frame (received may briefly exceed total
 * by the varint prefix; clamp when turning into a percentage).
 */
export interface ManifestProgressEvent {
	lishID: string;
	peerID: string;
	received: number;
	total: number;
}

// LISH detail for peer preview (no checksums, no chunks)
export interface IPeerLishDetail {
	id: string;
	name?: string | undefined;
	description?: string | undefined;
	created: string;
	chunkSize: number;
	checksumAlgo: import('./lish.ts').HashAlgorithm;
	totalSize: number;
	fileCount: number;
	directoryCount: number;
	files: Array<{ path: string; size: number; permissions?: string; modified?: string; created?: string }>;
	directories: import('./lish.ts').IDirectoryEntry[];
	links: import('./lish.ts').ILinkEntry[];
}

// LISH Network definition (pure network parameters)
export interface LISHNetworkDefinition {
	networkID: string;
	name: string;
	description: string;
	bootstrapPeers: string[];
	created: string;
}

// LISH Network config (stored network with enabled state)
export interface LISHNetworkConfig extends LISHNetworkDefinition {
	enabled: boolean;
}

// Combined network info (config + runtime)
export interface NetworkInfo extends LISHNetworkConfig {
	// Runtime (only present if enabled)
	peerID?: string;
	addresses?: string[];
	connected?: number;
	connectedPeers?: string[];
	peersInStore?: number;
}

/**
 * Per-bootstrap-peer dial outcome.
 *
 * Tracks the latest dial attempt result for one entry in a network's
 * configured `bootstrapPeers` list. This is granular per-entry, so the UI
 * can surface exactly which configured peer is misconfigured rather than
 * just flagging the whole network as "stale".
 */
export type BootstrapPeerDialStatus = 'pending' | 'connected' | 'identity-mismatch' | 'timeout' | 'error';

/**
 * Where this bootstrap-peer entry came from:
 *  - 'configured': it is part of the network's saved `bootstrapPeers` list (user-visible, editable)
 *  - 'discovered': it arrived via peer-announce gossip from another connected peer (transient, not in config)
 *
 * The UI separates the two so the user clearly sees what their own config
 * contains versus what the network told us about. Cleanup actions on
 * 'discovered' entries don't touch the saved config — they purge libp2p
 * peerStore so the dead identity stops being re-dialed and re-gossiped.
 */
export type BootstrapPeerOrigin = 'configured' | 'discovered';

export interface BootstrapPeerStatus {
	/** The multiaddr exactly as observed (from config OR from inbound peer-announce). */
	multiaddr: string;
	/** PeerID extracted from the multiaddr (the `/p2p/<id>` component), or null if absent. */
	expectedPeerID: string | null;
	/** Latest dial outcome for this entry. */
	status: BootstrapPeerDialStatus;
	/** Source of this entry — see {@link BootstrapPeerOrigin}. */
	origin: BootstrapPeerOrigin;
	/**
	 * If `status === 'identity-mismatch'`, the peerID actually reported by the
	 * remote during Noise handshake (parsed from libp2p's error message). Lets
	 * the UI offer "update entry to <actualPeerID>" as a one-click remedy.
	 */
	actualPeerID: string | null;
	/** Truncated message of the most recent dial failure (≤200 chars), if any. */
	lastError: string | null;
	/** ISO timestamp of the last update to this entry's status. */
	updatedAt: string;
}

/**
 * Per-network bootstrap dial status — one entry per configured bootstrap peer
 * plus aggregate counters.
 *
 * Populated when the backend attempts to dial the bootstrap peers configured
 * for a lishnet. Lets the UI detect which specific entries are stale
 * (identity-mismatch) or unreachable (timeout) and offer corrective actions:
 * delete bad entry, update peerID to the actual one, or refresh the whole
 * list from the public network catalogue.
 *
 * Stats reset when a peer entry is removed/replaced via lishnets.updateBootstrapPeers.
 */
export interface BootstrapStatus {
	networkID: string;
	/** Per-bootstrap-entry dial outcomes, keyed implicitly by `multiaddr`. */
	peers: BootstrapPeerStatus[];
}

/** The independently-wipeable categories of a factory reset. */
export type FactoryResetCategory = 'settings' | 'identity' | 'downloads' | 'networks' | 'peers';

/** Outcome of one factory-reset category. Each category runs independently — a
 * failure in one never prevents the others, so the FE can report one notification
 * per category. */
export interface FactoryResetResult {
	category: FactoryResetCategory;
	ok: boolean;
	/** Failure reason (error message) when `ok` is false. */
	detail?: string;
}

/** The infrastructure steps run around the wipes. `prepare` stops the transfers and the
 * node, `restart` brings them back — neither is a wipe, but both can fail in ways the
 * user has to know about: a failed `prepare` means the destructive categories were not
 * safe to run, a failed `restart` means the node is still down. */
export type FactoryResetPhase = 'prepare' | 'restart';

/** Outcome of one factory-reset phase. */
export interface FactoryResetPhaseResult {
	phase: FactoryResetPhase;
	ok: boolean;
	/** Failure (or skip) reason when `ok` is false. */
	detail?: string;
}

/** Aggregate factory-reset response: `success` is true only when every selected
 * category AND every phase succeeded; `results` carries the per-category outcome and
 * `phases` the prepare/restart outcome. */
export interface FactoryResetResponse {
	success: boolean;
	/** True when the request selected no categories and intentionally changed nothing. */
	noop: boolean;
	results: FactoryResetResult[];
	phases: FactoryResetPhaseResult[];
}

// Dataset types (derived from ILISH entries that have a directory)
export interface Dataset {
	id: string;
	lishID: string;
	directory: string;
	complete: boolean;
}

// Filesystem types
export interface FsInfo {
	platform: 'windows' | 'linux' | 'darwin';
	separator: string;
	home: string;
	roots: string[];
	localFilesystem: boolean;
}

export interface FsEntry {
	name: string;
	path: string;
	type: 'file' | 'directory' | 'drive';
	size?: number;
	modified?: string;
	hidden?: boolean;
}

export interface FsListResult {
	path: string;
	entries: FsEntry[];
	error?: string | undefined;
}

// Result of `fs.exists`.
export interface IPathExistsResult {
	exists: boolean;
	type?: 'file' | 'directory';
}

// Result of file-writing operations (`fs.writeText`, `fs.writeCompressed`, `settings.exportToFile`).
export interface IWriteResult {
	success: boolean;
	error?: string;
}

// API response wrappers
export interface SuccessResponse {
	success: boolean;
}

/** Outcome of changing one lishnet's enabled state in storage and at runtime. */
export interface SetLISHNetworkEnabledResponse extends SuccessResponse {
	applied: boolean;
	transitioned: boolean;
	joined: boolean;
}

// Result of `settings.applyImported`: how many keys were applied vs. skipped.
export interface ISettingsImportResult {
	applied: number;
	skipped: string[];
}

export interface CreateLISHResponse {
	lishID: string;
	lishFile?: string | undefined;
}

export interface ImportLISHResponse {
	lishID: string;
	directory: string;
}

export interface DownloadResponse {
	downloadDir: string;
}

// LISH Network file format (.lishnet) — fields may be optional in imported files
export interface ILISHNetwork {
	networkID: string;
	name: string;
	description?: string;
	bootstrapPeers: string[];
	created?: string;
}

// System metrics
export interface SystemRAMInfo {
	used: number;
	total: number;
}

export interface SystemStorageInfo {
	used: number;
	total: number;
}

export interface SystemCPUInfo {
	usage: number;
}

// System time / clock configuration

/**
 * Where the list of selectable timezone identifiers comes from.
 * - `intl`: the runtime's ICU database (`Intl.supportedValuesOf('timeZone')`) — the
 *   same IANA identifiers Linux and macOS use natively, so the list is identical on
 *   every platform.
 * - `unavailable`: the runtime exposes no timezone list, so nothing can be offered
 *   for selection and a timezone change cannot be validated.
 */
export type SystemTimezoneSource = 'intl' | 'unavailable';

/**
 * Which system-time facilities the host actually provides, probed from the OS
 * (presence of the managing tool / sync daemon) and NOT inferred from a write that
 * failed. A denied write means "run with more privileges", not "this host cannot do
 * it" — the two must stay distinguishable or an unprivileged dev session would
 * permanently mark a capable kiosk as incapable.
 */
export interface SystemTimeCapabilities {
	/** The wall clock can be set (some managing tool exists for it). */
	setClock: boolean;
	/** The system timezone can be changed. */
	setTimezone: boolean;
	/** The NTP server address can be configured. */
	setNtpServer: boolean;
	/** Automatic time synchronisation can be switched on and off. */
	setNtpEnabled: boolean;
}

/**
 * A snapshot of the host's time configuration. Read live from the OS on every
 * request — the OS owns this state (RTC, `/etc/localtime`, the sync daemon's
 * config), so nothing here is cached or persisted by the application.
 */
export interface SystemTimeStatus {
	/** False on a platform with no implemented time backend — every setter then reports `unsupported`. */
	supported: boolean;
	/** Current wall-clock time as a Unix timestamp in milliseconds. */
	nowMs: number;
	/** Active timezone as an IANA identifier (e.g. `Europe/Prague`). */
	timezone: string;
	/** Minutes to ADD to UTC to get local time — positive east of Greenwich (e.g. 120 for CEST). */
	utcOffsetMinutes: number;
	/** Use the observed OS offset when named timezone rules cannot represent host policy. */
	timezoneOffsetMode?: 'zone' | 'fixed';
	/** Where {@link SystemTimeStatus.timezone} and the selectable list come from. */
	timezoneSource: SystemTimezoneSource;
	/**
	 * Automatic time synchronisation (NTP) is switched on, or null when the host's
	 * state could not be determined (the managing tool is missing, wedged, refused the
	 * read, or printed something unparseable).
	 *
	 * Tri-state deliberately: collapsing an unreadable state to false would let the UI
	 * offer a manual clock set while synchronisation is in fact running, and the daemon
	 * would step the clock back seconds later. A hand-set clock requires a definite
	 * false — never merely "not known to be true".
	 */
	ntpEnabled: boolean | null;
	/** The last synchronisation actually succeeded; null where the OS does not report it. */
	ntpSynchronized: boolean | null;
	/** Configured NTP server address, or null when none is configured / it cannot be read. */
	ntpServer: string | null;
	/** Operations available to this client; the OS may still require elevated privileges. */
	capabilities: SystemTimeCapabilities;
}

/** The changed fields of one serialized system-time settings save. */
export interface SystemTimeChanges {
	ntpEnabled?: boolean;
	ntpServer?: string;
	timezone?: string;
	clock?: { hours: number; minutes: number; seconds: number };
}

/**
 * How a system-time write ended.
 * - `ok`: the OS applied the change.
 * - `permission-denied`: the facility exists but the process lacks the privilege
 *   (not root / not elevated) — actionable by the operator.
 * - `unsupported`: this host has no such facility; retrying with privileges will not help.
 * - `auto-sync-enabled`: the clock cannot be set by hand while NTP owns it — switch
 *   automatic synchronisation off first.
 * - `invalid-input`: the value failed validation and no command was ever run.
 * - `error`: anything else; {@link SystemTimeResult.message} carries the underlying text.
 */
export type SystemTimeOutcome = 'ok' | 'permission-denied' | 'unsupported' | 'auto-sync-enabled' | 'invalid-input' | 'error';

/** One command of a multi-step system-time write, and how it went. */
export interface SystemTimeStep {
	/** The command line as run, for a log or an error detail. Never contains user input beyond a validated value. */
	command: string;
	ok: boolean;
}

/**
 * Result of a system-time write. `success` is exactly `outcome === 'ok'` — a failure is
 * never reported as a success.
 *
 * A failure is not the same as "nothing happened". Several of these writes are sequences
 * (`sc config` then `sc start`; `sc stop` then `sc config`), and the sequence stops at the
 * first step that fails — with every step before it already applied. `changed` and
 * `stateMayHaveChanged` say which of the two a caller is looking at, so a failed request
 * still refreshes what it shows instead of leaving a stale screen.
 */
export interface SystemTimeResult {
	success: boolean;
	outcome: SystemTimeOutcome;
	/** Underlying OS message or the validation reason; null when there is nothing to add. */
	message: string | null;
	/** At least one step completed, so the host is definitely not as it was. */
	changed?: boolean;
	/** At least one step was attempted. A step that failed may still have applied part of its change. */
	stateMayHaveChanged?: boolean;
	/** Per-step outcome, in order, for a sequence that stopped part-way. Absent when nothing ran. */
	steps?: SystemTimeStep[];
}

// Relay (circuit-relay server) statistics — counts of reservations, active tunnels and bytes/sec going through us
export interface RelayStats {
	reservations: number;
	activeTunnels: number;
	downloadSpeed: number;
	uploadSpeed: number;
}

// Host network state
//
// Deliberately platform-agnostic: every OS-specific enum (Windows
// NdisPhysicalMedium, Linux `info_kind`, macOS hardware port) is collapsed by
// the backend reader before the document crosses the wire, so neither the
// frontend nor the shared projection ever has to know which host produced it.

/** How an interface is physically attached. 'other' = tunnel/virtual/bridge/unknown. */
export type NetMedium = 'wired' | 'wireless' | 'other';

/** Carrier state of a link. 'unknown' = the platform reader could not tell. */
export type NetLink = 'up' | 'down' | 'unknown';

/** How an address family is configured. 'unknown' = not determinable on this host. */
export type NetAddressMode = 'dhcp' | 'static' | 'unknown';

/** A single address bound to an interface. */
export interface NetAddress {
	family: 'ipv4' | 'ipv6';
	address: string;
	prefixLength: number;
}

/** Wireless association state of an interface. */
export interface NetWifiInfo {
	/** Null when not associated, or when the OS withholds it. */
	ssid: string | null;
	/** 0-100 signal QUALITY, never dBm, never a driver-scaled bar count. Null = unknown. */
	signal: number | null;
	radio: 'on' | 'off' | 'unknown';
}

/** One network interface of the host, as reported by the OS. */
export interface NetInterfaceInfo {
	/** Stable key used by settings + the widget. Windows: adapter GUID. Linux/macOS: device name. */
	id: string;
	/** OS friendly name, already localized by the OS — display only, never matched against. */
	name: string;
	/** Present only when the OS explicitly classifies the adapter as virtual or physical. */
	virtual?: boolean;
	/** Present only when the OS explicitly marks whether an adapter is hidden. */
	hidden?: boolean;
	/** OS adapter description, for distinguishing hardware from virtual interfaces. */
	description?: string;
	medium: NetMedium;
	link: NetLink;
	/** True for the interface carrying the IPv4 default route. */
	defaultRoute: boolean;
	mac: string | null;
	addresses: NetAddress[];
	ipv4Mode: NetAddressMode;
	/** True only when the platform apply path can resolve this exact interface. */
	ipv4Configurable: boolean;
	/** True only when the platform Wi-Fi path manages this exact wireless device. */
	wifiConfigurable: boolean;
	gateway: string | null;
	dns: string[];
	/** Present only when medium === 'wireless'. */
	wifi?: NetWifiInfo;
}

/** Read-only snapshot of the host's network configuration. */
export interface NetworkStateInfo {
	interfaces: NetInterfaceInfo[];
	/** id of the interface the app treats as primary: the user's pick, else the default-route one, else null. */
	primaryID: string | null;
	/** 'full' = medium/link/DHCP known. 'addressesOnly' = addresses + MAC only. */
	detail: 'full' | 'addressesOnly';
	/** False until the first successful read settles — mirrors the volume `known` pattern. */
	known: boolean;
	/** What this host actually lets the app change. Both false on a read-only platform. */
	capabilities: NetCapabilities;
}

/**
 * What the host's configuration backend supports.
 *
 * Reported per host rather than assumed per platform: the same Linux build is
 * writable on a NetworkManager desktop and read-only on a systemd-networkd
 * server, and the UI must not offer an edit that would silently not stick.
 */
export interface NetCapabilities {
	/** Address, gateway and DNS of an interface can be changed. */
	ipv4: boolean;
	/** The next IPv4 mutation must run through the trusted privileged helper. */
	ipv4Elevation?: boolean;
	/** Wi-Fi networks can be scanned and joined. */
	wifi: boolean;
	/** Static IPv4 requires a gateway because the platform tool has no no-router form. */
	staticGatewayRequired: boolean;
}

/**
 * Desired IPv4 configuration for one interface.
 *
 * IPv4 only: IPv6 is left to the OS. Every supported host autoconfigures it, and
 * a half-configured IPv6 stack breaks connectivity in ways that are far harder to
 * back out of than a wrong IPv4 address.
 */
export interface NetIPv4Config {
	mode: 'dhcp' | 'static';
	/** Required when mode is 'static', ignored otherwise. */
	address?: string;
	/** Required when mode is 'static'. 1-32. */
	prefixLength?: number;
	/** Optional even for 'static' — an interface on an isolated segment has no gateway. */
	gateway?: string;
	/**
	 * Resolver update requested by the user. Undefined preserves the current
	 * resolver policy, an empty array selects automatic DNS, and a non-empty
	 * array replaces it with the listed IPv4/IPv6 resolvers.
	 */
	dns?: string[];
}

/**
 * The IPv4 facts an edit form was seeded from.
 *
 * Sent back with the change so that a form opened on one configuration cannot
 * quietly overwrite a different one that arrived in the meantime — DHCP switched
 * on by a system tool, another client's edit. The backend compares it with a
 * fresh read and refuses a stale form instead of applying it.
 */
export interface NetIPv4Baseline {
	mode: NetAddressMode;
	address: string | null;
	prefixLength: number | null;
	gateway: string | null;
	dns: string[];
}

/** One network seen by a Wi-Fi scan. */
export interface NetWifiNetwork {
	ssid: string;
	/** Original SSID bytes as hex when available; the display name may be a lossy decode. */
	ssidHex?: string;
	/** Access-point identity used to disambiguate equal SSIDs. */
	bssid: string | null;
	/** 0-100 signal quality, never dBm. Null = the scanner did not report one. */
	signal: number | null;
	/** False for a genuinely open network — the UI must not ask for a password. */
	secured: boolean;
	/** Scanner security label, for display and capability decisions. */
	security: string;
	/** True only for open and personal WPA networks the one-password form supports. */
	supported: boolean;
	/** False when the host reports that association is unavailable, independently of security support. */
	connectable?: boolean;
	/** Host-provided explanation when connectable is false. */
	unavailableReason?: string;
	/** True when the interface is currently associated with this network. */
	active: boolean;
}

/** What the footer connection widget renders. Derived from NetworkStateInfo, never fabricated. */
export interface ConnectionStatus {
	kind: 'wired' | 'wifi' | 'wifiOff' | 'none' | 'unknown';
	connected: boolean;
	signal: number | null;
	ssid: string | null;
	interfaceName: string | null;
}
