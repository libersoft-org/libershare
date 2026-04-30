import { type NetworkStatus, type NetworkNodeInfo, type NetworkInfo, type PeerListEntry, type PeerLishEntry, type IPeerLishDetail, type LishSearchResult, type Dataset, type FsInfo, type FsListResult, type SuccessResponse, type CreateLISHResponse, type ImportLISHResponse, type DownloadResponse, type LISHNetworkConfig, type LISHNetworkDefinition, type IStoredLISH, type ILISHSummary, type ILISHDetail, type ILISH, type LISHSortField, type SortOrder, type CompressionAlgorithm } from './index.ts';

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
	readonly identity: IdentityAPI;
	readonly lishnets: LISHnetsAPI;
	readonly lishs: LISHsAPI;
	readonly transfer: TransferAPI;
	readonly search: SearchAPI;

	constructor(client: IWsClient) {
		this.client = client;
		this.datasets = new DatasetsAPI(client);
		this.fs = new FsAPI(client);
		this.settings = new SettingsAPI(client);
		this.identity = new IdentityAPI(client);
		this.lishnets = new LISHnetsAPI(client);
		this.lishs = new LISHsAPI(client);
		this.transfer = new TransferAPI(client);
		this.search = new SearchAPI(client);
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

	async readCompressed(path: string, algorithm: CompressionAlgorithm = 'gzip'): Promise<string> {
		const result = await this.client.call<{ content: string }>('fs.readCompressed', { path, algorithm });
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

	writeCompressed(path: string, content: string, algorithm: CompressionAlgorithm = 'gzip'): Promise<{ success: boolean; error?: string }> {
		return this.client.call<{ success: boolean; error?: string }>('fs.writeCompressed', { path, content, algorithm });
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

	exportToFile(filePath: string, minifyJSON: boolean = false, compress: boolean = false, compressionAlgorithm: CompressionAlgorithm = 'gzip'): Promise<{ success: boolean; error?: string }> {
		return this.client.call<{ success: boolean; error?: string }>('settings.exportToFile', { filePath, minifyJSON, compress, compressionAlgorithm });
	}

	parseFromFile<T = Record<string, unknown>>(filePath: string): Promise<T> {
		return this.client.call<T>('settings.parseFromFile', { filePath });
	}

	parseFromJSON<T = Record<string, unknown>>(json: string): Promise<T> {
		return this.client.call<T>('settings.parseFromJSON', { json });
	}

	parseFromURL<T = Record<string, unknown>>(url: string): Promise<T> {
		return this.client.call<T>('settings.parseFromURL', { url });
	}

	applyImported(data: Record<string, unknown>): Promise<{ applied: number; skipped: string[] }> {
		return this.client.call<{ applied: number; skipped: string[] }>('settings.applyImported', { data });
	}
}

export interface IdentityBackup {
	peerID: string;
	privateKey: string;
}

class IdentityAPI {
	private client: IWsClient;
	constructor(client: IWsClient) {
		this.client = client;
	}

	get(): Promise<IdentityBackup> {
		return this.client.call<IdentityBackup>('identity.get');
	}

	exportToFile(filePath: string): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('identity.exportToFile', { filePath });
	}

	parseFromFile(filePath: string): Promise<IdentityBackup> {
		return this.client.call<IdentityBackup>('identity.parseFromFile', { filePath });
	}

	parseFromJSON(json: string): Promise<IdentityBackup> {
		return this.client.call<IdentityBackup>('identity.parseFromJSON', { json });
	}

	parseFromURL(url: string): Promise<IdentityBackup> {
		return this.client.call<IdentityBackup>('identity.parseFromURL', { url });
	}

	applyImported(privateKey: string): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('identity.applyImported', { privateKey });
	}

	regenerate(): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('identity.regenerate');
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

	exportToFile(networkID: string, filePath: string, minifyJSON?: boolean, compress?: boolean, compressionAlgorithm?: CompressionAlgorithm): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('lishnets.exportToFile', { networkID, filePath, minifyJSON: minifyJSON, compress, compressionAlgorithm });
	}

	exportAllToFile(filePath: string, minifyJSON?: boolean, compress?: boolean, compressionAlgorithm?: CompressionAlgorithm): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('lishnets.exportAllToFile', { filePath, minifyJSON: minifyJSON, compress, compressionAlgorithm });
	}

	// Runtime methods

	importFromFile(path: string, enabled = false): Promise<LISHNetworkConfig[]> {
		return this.client.call<LISHNetworkConfig[]>('lishnets.importFromFile', { path, enabled });
	}

	parseFromFile(path: string): Promise<LISHNetworkDefinition[]> {
		return this.client.call<LISHNetworkDefinition[]>('lishnets.parseFromFile', { path });
	}

	parseFromJSON(json: string): Promise<LISHNetworkDefinition[]> {
		return this.client.call<LISHNetworkDefinition[]>('lishnets.parseFromJSON', { json });
	}

	parseFromURL(url: string): Promise<LISHNetworkDefinition[]> {
		return this.client.call<LISHNetworkDefinition[]>('lishnets.parseFromURL', { url });
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

	getPeers(networkID?: string): Promise<PeerListEntry[]> {
		return this.client.call<PeerListEntry[]>('lishnets.getPeers', { networkID });
	}

	getPeerLishs(peerID: string, networkID: string): Promise<{ lishs: PeerLishEntry[] | null }> {
		return this.client.call<{ lishs: PeerLishEntry[] | null }>('lishnets.getPeerLishs', { peerID, networkID });
	}

	getPeerLish(lishID: string, peerID: string, networkID: string): Promise<IPeerLishDetail | null> {
		return this.client.call<IPeerLishDetail | null>('lishnets.getPeerLish', { lishID, peerID, networkID });
	}

	addPeerLish(lishID: string, peerID: string, networkID: string): Promise<{ lishID: string }> {
		return this.client.call<{ lishID: string }>('lishnets.addPeerLish', { lishID, peerID, networkID });
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

	list(sortBy?: LISHSortField, sortOrder?: SortOrder): Promise<{ items: ILISHSummary[]; verifying: string | null; pendingVerification: string[]; moving: string[]; uploadEnabled: string[]; downloadEnabled: string[] }> {
		return this.client.call<{ items: ILISHSummary[]; verifying: string | null; pendingVerification: string[]; moving: string[]; uploadEnabled: string[]; downloadEnabled: string[] }>('lishs.list', { sortBy, sortOrder });
	}

	get(lishID: string): Promise<ILISHDetail | null> {
		return this.client.call<ILISHDetail | null>('lishs.get', { lishID });
	}

	exportToFile(lishID: string, filePath: string, minifyJSON?: boolean, compress?: boolean, compressionAlgorithm?: CompressionAlgorithm): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('lishs.exportToFile', { lishID, filePath, minifyJSON, compress, compressionAlgorithm });
	}

	exportAllToFile(filePath: string, minifyJSON?: boolean, compress?: boolean, compressionAlgorithm?: CompressionAlgorithm): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('lishs.exportAllToFile', { filePath, minifyJSON, compress, compressionAlgorithm });
	}

	backup(): Promise<IStoredLISH[]> {
		return this.client.call<IStoredLISH[]>('lishs.backup');
	}

	create(dataPath: string, lishFile?: string, addToSharing?: boolean, addToDownloading?: boolean, name?: string, description?: string, algorithm?: string, chunkSize?: number, threads?: number, minifyJSON?: boolean, compress?: boolean, compressionAlgorithm?: CompressionAlgorithm): Promise<CreateLISHResponse> {
		return this.client.call<CreateLISHResponse>('lishs.create', {
			name,
			description,
			dataPath,
			lishFile,
			addToSharing,
			addToDownloading,
			chunkSize,
			algorithm,
			threads,
			minifyJSON,
			compress,
			compressionAlgorithm,
		});
	}

	delete(lishID: string, deleteLISH: boolean, deleteData: boolean): Promise<boolean> {
		return this.client.call<boolean>('lishs.delete', { lishID, deleteLISH: deleteLISH, deleteData });
	}

	importFromFile(filePath: string, downloadPath: string, overwrite?: boolean, enableSharing?: boolean, enableDownloading?: boolean): Promise<ImportLISHResponse> {
		return this.client.call<ImportLISHResponse>('lishs.importFromFile', { filePath, downloadPath, overwrite, enableSharing, enableDownloading });
	}

	importFromJSON(json: string, downloadPath: string, overwrite?: boolean, enableSharing?: boolean, enableDownloading?: boolean): Promise<ImportLISHResponse> {
		return this.client.call<ImportLISHResponse>('lishs.importFromJSON', { json, downloadPath, overwrite, enableSharing, enableDownloading });
	}

	importFromURL(url: string, downloadPath: string, overwrite?: boolean, enableSharing?: boolean, enableDownloading?: boolean): Promise<ImportLISHResponse> {
		return this.client.call<ImportLISHResponse>('lishs.importFromURL', { url, downloadPath, overwrite, enableSharing, enableDownloading });
	}

	parseFromFile(filePath: string): Promise<ILISH[]> {
		return this.client.call<ILISH[]>('lishs.parseFromFile', { filePath });
	}

	parseFromJSON(json: string): Promise<ILISH[]> {
		return this.client.call<ILISH[]>('lishs.parseFromJSON', { json });
	}

	parseFromURL(url: string): Promise<ILISH[]> {
		return this.client.call<ILISH[]>('lishs.parseFromURL', { url });
	}

	verify(lishID: string): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('lishs.verify', { lishID });
	}

	verifyAll(): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('lishs.verifyAll');
	}

	stopVerify(lishID: string): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('lishs.stopVerify', { lishID });
	}

	stopVerifyAll(): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('lishs.stopVerifyAll');
	}

	stopCreate(): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('lishs.stopCreate');
	}

	move(lishID: string, newDirectory: string, moveData: boolean, createSubdirectory?: boolean): Promise<SuccessResponse> {
		return this.client.call<SuccessResponse>('lishs.move', { lishID, newDirectory, moveData, createSubdirectory });
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

/**
 * Browse network → LISH search.
 * `startSearch` returns immediately with a `searchID`; results stream in via the
 * `search:lishs:update` WebSocket event and end with `search:lishs:complete`.
 * `LishSearchResult` aggregates one row per LISH with the list of peers offering it.
 */
class SearchAPI {
	private client: IWsClient;
	constructor(client: IWsClient) {
		this.client = client;
	}

	startSearch(query: string): Promise<{ searchID: string }> {
		return this.client.call<{ searchID: string }>('search.startSearch', { query });
	}

	cancelSearch(searchID: string): Promise<{ ok: true }> {
		return this.client.call<{ ok: true }>('search.cancelSearch', { searchID });
	}
}

export type { LishSearchResult };
