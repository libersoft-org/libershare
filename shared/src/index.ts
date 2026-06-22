// Product info
export { productName, productVersion, productIdentifier, productWebsite, productGithub, productNetworkList, productEnvPrefix, DEFAULT_API_PORT, DEFAULT_API_URL } from './product.ts';

// Utils
export { formatBytes, parseBytes, sanitizeFilename } from './utils.ts';

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
