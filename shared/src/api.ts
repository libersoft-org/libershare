import { type NetworkStatus, type NetworkNodeInfo, type NetworkInfo, type PeerConnectionInfo, type Dataset, type FsInfo, type FsListResult, type SuccessResponse, type CreateLishResponse, type DownloadResponse, type FetchUrlResponse, type LISHNetworkConfig, type LISHNetworkDefinition } from './index.ts';

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
	readonly datasets: DatasetsApi;
	readonly fs: FsApi;
	readonly settings: SettingsApi;
	readonly lishNetworks: LISHNetworksApi;
	readonly lishs: LishsApi;
	readonly transfer: TransferApi;

	constructor(private client: IWsClient) {
		this.datasets = new DatasetsApi(client);
		this.fs = new FsApi(client);
		this.settings = new SettingsApi(client);
		this.lishNetworks = new LISHNetworksApi(client);
		this.lishs = new LishsApi(client);
		this.transfer = new TransferApi(client);
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

	subscribe(...events: string[]): Promise<boolean> {
		return this.client.call<boolean>('events.subscribe', { events });
	}

	unsubscribe(...events: string[]): Promise<boolean> {
		return this.client.call<boolean>('events.unsubscribe', { events });
	}

	fetchUrl(url: string): Promise<FetchUrlResponse> {
		return this.client.call<FetchUrlResponse>('fetchUrl', { url });
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

	writeText(path: string, content: string): Promise<{ success: boolean; error?: string }> {
		return this.client.call<{ success: boolean; error?: string }>('fs.writeText', { path, content });
	}

	writeGzip(path: string, content: string): Promise<{ success: boolean; error?: string }> {
		return this.client.call<{ success: boolean; error?: string }>('fs.writeGzip', { path, content });
	}
}

class SettingsApi {
	constructor(private client: IWsClient) {}

	get<T = any>(path?: string): Promise<T> {
		return this.client.call<T>('settings.get', { path });
	}

	set(path: string, value: any): Promise<boolean> {
		return this.client.call<boolean>('settings.set', { path, value });
	}

	getAll<T = any>(): Promise<T> {
		return this.client.call<T>('settings.getAll');
	}

	getDefaults<T = any>(): Promise<T> {
		return this.client.call<T>('settings.getDefaults');
	}

	reset<T = any>(): Promise<T> {
		return this.client.call<T>('settings.reset');
	}
}

class LISHNetworksApi {
	constructor(private client: IWsClient) {}

	getAll(): Promise<LISHNetworkConfig[]> {
		return this.client.call<LISHNetworkConfig[]>('lishNetworks.getAll');
	}

	get(networkID: string): Promise<LISHNetworkConfig | undefined> {
		return this.client.call<LISHNetworkConfig | undefined>('lishNetworks.get', { networkID });
	}

	exists(networkID: string): Promise<boolean> {
		return this.client.call<boolean>('lishNetworks.exists', { networkID });
	}

	add(network: LISHNetworkConfig): Promise<boolean> {
		return this.client.call<boolean>('lishNetworks.add', { network });
	}

	update(network: LISHNetworkConfig): Promise<boolean> {
		return this.client.call<boolean>('lishNetworks.update', { network });
	}

	delete(networkID: string): Promise<boolean> {
		return this.client.call<boolean>('lishNetworks.delete', { networkID });
	}

	addIfNotExists(network: LISHNetworkDefinition): Promise<boolean> {
		return this.client.call<boolean>('lishNetworks.addIfNotExists', { network });
	}

	import(networks: LISHNetworkDefinition[]): Promise<number> {
		return this.client.call<number>('lishNetworks.import', { networks });
	}

	setAll(networks: LISHNetworkConfig[]): Promise<boolean> {
		return this.client.call<boolean>('lishNetworks.setAll', { networks });
	}

	// Runtime methods

	importFromFile(path: string, enabled = false): Promise<LISHNetworkConfig> {
		return this.client.call<LISHNetworkConfig>('lishNetworks.importFromFile', { path, enabled });
	}

	importFromJson(json: string, enabled = false): Promise<LISHNetworkConfig> {
		return this.client.call<LISHNetworkConfig>('lishNetworks.importFromJson', { json, enabled });
	}

	setEnabled(networkID: string, enabled: boolean): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('lishNetworks.setEnabled', { networkID, enabled });
	}

	connect(networkID: string, multiaddr: string): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('lishNetworks.connect', { networkID, multiaddr });
	}

	findPeer(networkID: string, peerID: string): Promise<any> {
		return this.client.call<any>('lishNetworks.findPeer', { networkID, peerID });
	}

	getAddresses(networkID: string): Promise<string[]> {
		return this.client.call<string[]>('lishNetworks.getAddresses', { networkID });
	}

	getPeers(networkID: string): Promise<PeerConnectionInfo[]> {
		return this.client.call<PeerConnectionInfo[]>('lishNetworks.getPeers', { networkID });
	}

	getNodeInfo(): Promise<NetworkNodeInfo> {
		return this.client.call<NetworkNodeInfo>('lishNetworks.getNodeInfo');
	}

	getStatus(networkID: string): Promise<NetworkStatus> {
		return this.client.call<NetworkStatus>('lishNetworks.getStatus', { networkID });
	}

	infoAll(): Promise<NetworkInfo[]> {
		return this.client.call<NetworkInfo[]>('lishNetworks.infoAll');
	}
}

class LishsApi {
	constructor(private client: IWsClient) {}

	list(): Promise<any[]> {
		return this.client.call<any[]>('lishs.getAll');
	}

	get(lishID: string): Promise<any> {
		return this.client.call<any>('lishs.get', { lishID });
	}

	create(dataPath: string, lishFile?: string, addToSharing?: boolean, name?: string, description?: string, algorithm?: string, chunkSize?: number, threads?: number): Promise<CreateLishResponse> {
		return this.client.call<CreateLishResponse>('lishs.create', {
			name,
			description,
			dataPath,
			lishFile,
			addToSharing,
			chunkSize,
			algorithm,
			threads,
		});
	}
}

class TransferApi {
	constructor(private client: IWsClient) {}

	download(networkID: string, lishPath: string): Promise<DownloadResponse> {
		return this.client.call<DownloadResponse>('transfer.download', { networkID, lishPath });
	}
}
