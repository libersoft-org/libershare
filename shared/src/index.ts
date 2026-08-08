// Product info
export { productName, productVersion, productIdentifier, productWebsite, productGithub, productNetworkList, productEnvPrefix, DEFAULT_API_PORT, DEFAULT_API_URL } from './product.ts';

// Utils
export { formatBytes, parseBytes, sanitizeFilename, deriveConnectionStatus, isSelectableInterface, isIPv4, isValidSSID, validateIPv4Config } from './utils.ts';

// Compression
export type CompressionAlgorithm = 'gzip';

/**
 * Check if a file path has a compressed file extension.
 * Returns true for known compression extensions (.gz, .gzip, etc.).
 */
export function isCompressed(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return lower.endsWith('.gz') || lower.endsWith('.gzip');
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

/** Aggregate factory-reset response: `success` is true only when every selected
 * category succeeded; `results` carries the per-category outcome. */
export interface FactoryResetResponse {
	success: boolean;
	results: FactoryResetResult[];
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
	medium: NetMedium;
	link: NetLink;
	/** True for the interface carrying the IPv4 default route. */
	defaultRoute: boolean;
	mac: string | null;
	addresses: NetAddress[];
	ipv4Mode: NetAddressMode;
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
	/** Wi-Fi networks can be scanned and joined. */
	wifi: boolean;
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
	/** Empty means "let the OS decide" (DHCP-supplied, or none for a static address). */
	dns?: string[];
}

/** One network seen by a Wi-Fi scan. */
export interface NetWifiNetwork {
	ssid: string;
	/** 0-100 signal quality, never dBm. Null = the scanner did not report one. */
	signal: number | null;
	/** False for a genuinely open network — the UI must not ask for a password. */
	secured: boolean;
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
