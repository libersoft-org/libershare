import { type NetworkStatus, type NetworkNodeInfo, type NetworkInfo, type PeerConnectionInfo, type Dataset, type FsInfo, type FsListResult, type SuccessResponse, type CreateLISHResponse, type DownloadResponse, type FetchUrlResponse, type LISHNetworkConfig, type LISHNetworkDefinition } from './index.ts';

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
export class API {
	private client: IWsClient;
	readonly datasets: DatasetsAPI;
	readonly fs: FsAPI;
	readonly settings: SettingsAPI;
	readonly lishnets: LISHnetsAPI;
	readonly lishs: LISHsAPI;
	readonly transfer: TransferAPI;

	constructor(client: IWsClient) {
		this.client = client;
		this.datasets = new DatasetsAPI(client);
		this.fs = new FsAPI(client);
		this.settings = new SettingsAPI(client);
		this.lishnets = new LISHnetsAPI(client);
		this.lishs = new LISHsAPI(client);
		this.transfer = new TransferAPI(client);
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

class DatasetsAPI {
	private client: IWsClient;
	constructor(client: IWsClient) {
		this.client = client;
	}

	list(): Promise<Dataset[]> {
		return this.client.call<Dataset[]>('datasets.getDatasets');
	}

	get(id: string): Promise<Dataset> {
		return this.client.call<Dataset>('datasets.getDataset', { id });
	}
}

class FsAPI {
	private client: IWsClient;
	constructor(client: IWsClient) {
		this.client = client;
	}

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

	exists(path: string): Promise<{ exists: boolean; type?: 'file' | 'directory' }> {
		return this.client.call<{ exists: boolean; type?: 'file' | 'directory' }>('fs.exists', { path });
	}

	writeText(path: string, content: string): Promise<{ success: boolean; error?: string }> {
		return this.client.call<{ success: boolean; error?: string }>('fs.writeText', { path, content });
	}

	writeGzip(path: string, content: string): Promise<{ success: boolean; error?: string }> {
		return this.client.call<{ success: boolean; error?: string }>('fs.writeGzip', { path, content });
	}
}

class SettingsAPI {
	private client: IWsClient;
	constructor(client: IWsClient) {
		this.client = client;
	}

	get<T = any>(path?: string): Promise<T> {
		return this.client.call<T>('settings.get', { path });
	}

	set(path: string, value: any): Promise<boolean> {
		return this.client.call<boolean>('settings.set', { path, value });
	}

	list<T = any>(): Promise<T> {
		return this.client.call<T>('settings.list');
	}

	getDefaults<T = any>(): Promise<T> {
		return this.client.call<T>('settings.getDefaults');
	}

	reset<T = any>(): Promise<T> {
		return this.client.call<T>('settings.reset');
	}
}

class LISHnetsAPI {
	private client: IWsClient;
	constructor(client: IWsClient) {
		this.client = client;
	}

	list(): Promise<LISHNetworkConfig[]> {
		return this.client.call<LISHNetworkConfig[]>('lishnets.list');
	}

	get(networkID: string): Promise<LISHNetworkConfig | undefined> {
		return this.client.call<LISHNetworkConfig | undefined>('lishnets.get', { networkID });
	}

	exists(networkID: string): Promise<boolean> {
		return this.client.call<boolean>('lishnets.exists', { networkID });
	}

	add(network: LISHNetworkConfig): Promise<boolean> {
		return this.client.call<boolean>('lishnets.add', { network });
	}

	update(network: LISHNetworkConfig): Promise<boolean> {
		return this.client.call<boolean>('lishnets.update', { network });
	}

	delete(networkID: string): Promise<boolean> {
		return this.client.call<boolean>('lishnets.delete', { networkID });
	}

	addIfNotExists(network: LISHNetworkDefinition): Promise<boolean> {
		return this.client.call<boolean>('lishnets.addIfNotExists', { network });
	}

	import(networks: LISHNetworkDefinition[]): Promise<number> {
		return this.client.call<number>('lishnets.import', { networks });
	}

	replace(networks: LISHNetworkConfig[]): Promise<boolean> {
		return this.client.call<boolean>('lishnets.replace', { networks });
	}

	// Runtime methods

	importFromFile(path: string, enabled = false): Promise<LISHNetworkConfig> {
		return this.client.call<LISHNetworkConfig>('lishnets.importFromFile', { path, enabled });
	}

	importFromJson(json: string, enabled = false): Promise<LISHNetworkConfig> {
		return this.client.call<LISHNetworkConfig>('lishnets.importFromJson', { json, enabled });
	}

	setEnabled(networkID: string, enabled: boolean): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('lishnets.setEnabled', { networkID, enabled });
	}

	connect(networkID: string, multiaddr: string): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('lishnets.connect', { networkID, multiaddr });
	}

	findPeer(networkID: string, peerID: string): Promise<any> {
		return this.client.call<any>('lishnets.findPeer', { networkID, peerID });
	}

	getAddresses(networkID: string): Promise<string[]> {
		return this.client.call<string[]>('lishnets.getAddresses', { networkID });
	}

	getPeers(networkID: string): Promise<PeerConnectionInfo[]> {
		return this.client.call<PeerConnectionInfo[]>('lishnets.getPeers', { networkID });
	}

	getNodeInfo(): Promise<NetworkNodeInfo> {
		return this.client.call<NetworkNodeInfo>('lishnets.getNodeInfo');
	}

	getStatus(networkID: string): Promise<NetworkStatus> {
		return this.client.call<NetworkStatus>('lishnets.getStatus', { networkID });
	}

	infoAll(): Promise<NetworkInfo[]> {
		return this.client.call<NetworkInfo[]>('lishnets.infoAll');
	}
}

class LISHsAPI {
	private client: IWsClient;
	constructor(client: IWsClient) {
		this.client = client;
	}

	list(): Promise<any[]> {
		return this.client.call<any[]>('lishs.list');
	}

	get(lishID: string): Promise<any> {
		return this.client.call<any>('lishs.get', { lishID });
	}

	create(dataPath: string, lishFile?: string, addToSharing?: boolean, name?: string, description?: string, algorithm?: string, chunkSize?: number, threads?: number, minifyJson?: boolean, compressGzip?: boolean): Promise<CreateLISHResponse> {
		return this.client.call<CreateLISHResponse>('lishs.create', {
			name,
			description,
			dataPath,
			lishFile,
			addToSharing,
			chunkSize,
			algorithm,
			threads,
			minifyJson,
			compressGzip,
		});
	}
}

class TransferAPI {
	private client: IWsClient;
	constructor(client: IWsClient) {
		this.client = client;
	}

	download(networkID: string, lishPath: string): Promise<DownloadResponse> {
		return this.client.call<DownloadResponse>('transfer.download', { networkID, lishPath });
	}
}
