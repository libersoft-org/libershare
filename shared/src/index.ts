// Product info
export { productName, productVersion, productIdentifier, productWebsite, productGithub, productNetworkList } from './product.ts';

// LISH types
export * from './lish.ts';

// API client
export { Api, type IWsClient } from './api.ts';

// WebSocket client
export { WsClient } from './client.ts';

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

// Combined network info (config + runtime)
export interface NetworkInfo extends LISHNetworkConfig {
	// Runtime (only present if enabled)
	peerID?: string;
	addresses?: string[];
	connected?: number;
	connectedPeers?: string[];
	peersInStore?: number;
}

// Dataset types (derived from ILish entries that have a directory)
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
}

// API response wrappers
export interface SuccessResponse {
	success: boolean;
}

export interface CreateLishResponse {
	lishID: string;
}

export interface DownloadResponse {
	downloadDir: string;
}

export interface FetchUrlResponse {
	url: string;
	status: number;
	contentType: string | null;
	content: string;
}

// LISH Network file format (.lishnet) — fields may be optional in imported files
export interface ILISHNetwork {
	version: number;
	networkID: string;
	name: string;
	description?: string;
	bootstrapPeers: string[];
	created?: string;
}

// LISH Network definition (pure network parameters)
export interface LISHNetworkDefinition {
	version: number;
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
