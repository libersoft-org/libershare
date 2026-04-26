// Product info
export { productName, productVersion, productIdentifier, productWebsite, productGithub, productNetworkList, DEFAULT_API_PORT, DEFAULT_API_URL } from './product.ts';

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

// API response wrappers
export interface SuccessResponse {
	success: boolean;
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
