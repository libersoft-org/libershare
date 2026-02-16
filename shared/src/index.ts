// Lish manifest types
export * from './lish.ts';

// API client
export { Api, type IWsClient } from './api.ts';

// WebSocket client
export { WsClient } from './client.ts';

// Network types
export interface NetworkDefinition {
	id: string;
	version: number;
	name: string;
	description: string | null;
	bootstrap_peers: string[];
	enabled: boolean;
}

export interface NetworkStatus {
	connected: number;
	connectedPeers: string[];
	peersInStore: number;
	datasets: number;
}

export interface NetworkNodeInfo {
	peerId: string;
	addresses: string[];
}

export interface PeerConnectionInfo {
	peerId: string;
	direct: number;
	relay: number;
}

// Combined network info (config + runtime)
export interface NetworkInfo {
	// Config
	id: string;
	version: number;
	name: string;
	description: string | null;
	bootstrap_peers: string[];
	enabled: boolean;
	// Runtime (only present if enabled)
	peerId?: string;
	addresses?: string[];
	connected?: number;
	connectedPeers?: string[];
	peersInStore?: number;
}

// Stats types
export interface Stats {
	networks: {
		total: number;
		enabled: number;
		connected: number;
	};
	peers: number;
	datasets: {
		total: number;
		complete: number;
		downloading: number;
	};
	space: SpaceInfo[];
	transfers: {
		download: TransferStats;
		upload: TransferStats;
	};
}

export interface SpaceInfo {
	path: string;
	free: number;
	usedByDatabase: number;
	usedByDatasets: number;
}

export interface TransferStats {
	now: number;
	total: number;
}

// Dataset types
export interface Dataset {
	id: number;
	manifestId: string;
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
	manifestId: string;
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
