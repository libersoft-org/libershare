import type { NetworkDefinition, NetworkStatus, NetworkNodeInfo, NetworkInfo, Stats, Dataset, FsInfo, FsListResult, SuccessResponse, CreateLishResponse, DownloadResponse, FetchUrlResponse } from './index.ts';

type EventCallback = (data: any) => void;

/**
 * Interface for the underlying WebSocket client.
 * Both browser and CLI clients must implement this interface.
 */
export interface IWsClient {
	call<T = any>(method: string, params?: Record<string, any>): Promise<T>;
	on(event: string, callback: EventCallback): (() => void) | void;
	off(event: string, callback: EventCallback): void;
}

/**
 * High-level API client that wraps a WebSocket client.
 * Can be used in both browser and CLI environments.
 */
export class Api {
	readonly networks: NetworksApi;
	readonly manifests: ManifestsApi;
	readonly datasets: DatasetsApi;
	readonly fs: FsApi;

	constructor(private client: IWsClient) {
		this.networks = new NetworksApi(client);
		this.manifests = new ManifestsApi(client);
		this.datasets = new DatasetsApi(client);
		this.fs = new FsApi(client);
	}

	// Raw call access
	call<T = any>(method: string, params?: Record<string, any>): Promise<T> {
		return this.client.call<T>(method, params);
	}

	on(event: string, callback: EventCallback): (() => void) | void {
		return this.client.on(event, callback);
	}

	off(event: string, callback: EventCallback): void {
		this.client.off(event, callback);
	}

	// Top-level operations
	getStats(): Promise<Stats> {
		return this.client.call<Stats>('getStats');
	}

	createLish(inputPath: string, saveToFile: boolean = true, addToSharing: boolean = true, name?: string, description?: string, outputFilePath?: string, algorithm?: string, chunkSize?: number, threads?: number): Promise<CreateLishResponse> {
		return this.client.call<CreateLishResponse>('createLish', {
			inputPath,
			saveToFile,
			addToSharing,
			name,
			description,
			outputFilePath,
			algorithm,
			chunkSize,
			threads,
		});
	}

	download(networkId: string, manifestPath: string): Promise<DownloadResponse> {
		return this.client.call<DownloadResponse>('download', { networkId, manifestPath });
	}

	fetchUrl(url: string): Promise<FetchUrlResponse> {
		return this.client.call<FetchUrlResponse>('fetchUrl', { url });
	}
}

class NetworksApi {
	constructor(private client: IWsClient) {}

	list(): Promise<NetworkDefinition[]> {
		return this.client.call<NetworkDefinition[]>('networks.list');
	}

	get(networkId: string): Promise<NetworkDefinition> {
		return this.client.call<NetworkDefinition>('networks.get', { networkId });
	}

	importFromFile(path: string, enabled = false): Promise<NetworkDefinition> {
		return this.client.call<NetworkDefinition>('networks.importFromFile', { path, enabled });
	}

	importFromJson(json: string, enabled = false): Promise<NetworkDefinition> {
		return this.client.call<NetworkDefinition>('networks.importFromJson', { json, enabled });
	}

	setEnabled(networkId: string, enabled: boolean): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('networks.setEnabled', { networkId, enabled });
	}

	delete(networkId: string): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('networks.delete', { networkId });
	}

	connect(networkId: string, multiaddr: string): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('networks.connect', { networkId, multiaddr });
	}

	findPeer(networkId: string, peerId: string): Promise<any> {
		return this.client.call<any>('networks.findPeer', { networkId, peerId });
	}

	getAddresses(networkId: string): Promise<string[]> {
		return this.client.call<string[]>('networks.getAddresses', { networkId });
	}

	getPeers(networkId: string): Promise<string[]> {
		return this.client.call<string[]>('networks.getPeers', { networkId });
	}

	getNodeInfo(networkId: string): Promise<NetworkNodeInfo> {
		return this.client.call<NetworkNodeInfo>('networks.getNodeInfo', { networkId });
	}

	getStatus(networkId: string): Promise<NetworkStatus> {
		return this.client.call<NetworkStatus>('networks.getStatus', { networkId });
	}

	infoAll(): Promise<NetworkInfo[]> {
		return this.client.call<NetworkInfo[]>('networks.infoAll');
	}
}

class ManifestsApi {
	constructor(private client: IWsClient) {}

	list(): Promise<any[]> {
		return this.client.call<any[]>('manifests.getAllManifests');
	}

	get(lishId: string): Promise<any> {
		return this.client.call<any>('manifests.getManifest', { lishId });
	}
}

class DatasetsApi {
	constructor(private client: IWsClient) {}

	list(): Promise<Dataset[]> {
		return this.client.call<Dataset[]>('datasets.getDatasets');
	}

	get(id: string): Promise<Dataset> {
		return this.client.call<Dataset>('datasets.getDataset', { id });
	}
}

class FsApi {
	constructor(private client: IWsClient) {}

	info(): Promise<FsInfo> {
		return this.client.call<FsInfo>('fs.info');
	}

	list(path?: string): Promise<FsListResult> {
		return this.client.call<FsListResult>('fs.list', { path });
	}

	async readText(path: string): Promise<string> {
		const result = await this.client.call<{ content: string }>('fs.readText', { path });
		return result.content;
	}

	async readGzip(path: string): Promise<string> {
		const result = await this.client.call<{ content: string }>('fs.readGzip', { path });
		return result.content;
	}

	delete(path: string): Promise<{ success: boolean }> {
		return this.client.call<{ success: boolean }>('fs.delete', { path });
	}

	mkdir(path: string): Promise<{ success: boolean }> {
		return this.client.call<{ success: boolean }>('fs.mkdir', { path });
	}

	open(path: string): Promise<{ success: boolean }> {
		return this.client.call<{ success: boolean }>('fs.open', { path });
	}

	rename(path: string, newName: string): Promise<{ success: boolean }> {
		return this.client.call<{ success: boolean }>('fs.rename', { path, newName });
	}

	exists(path: string): Promise<{ exists: boolean }> {
		return this.client.call<{ exists: boolean }>('fs.exists', { path });
	}

	writeText(path: string, content: string): Promise<{ success: boolean }> {
		return this.client.call<{ success: boolean }>('fs.writeText', { path, content });
	}

	writeGzip(path: string, content: string): Promise<{ success: boolean }> {
		return this.client.call<{ success: boolean }>('fs.writeGzip', { path, content });
	}
}
