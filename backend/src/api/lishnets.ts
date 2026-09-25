import { type Networks, type SetEnabledResult } from '../lishnet/lishnets.ts';
import { type DataServer } from '../lish/data-server.ts';
import { type Settings } from '../settings.ts';
import { type LISHNetworkConfig, type LISHNetworkDefinition, type SuccessResponse, type SetLISHNetworkEnabledResponse, type NetworkNodeInfo, type NetworkStatus, type NetworkInfo, type PeerListEntry, type PeerLishEntry, type IPeerLishDetail, type ManifestProgressEvent, type ILISH, type ImportLISHResponse, type CompressionAlgorithm, type BootstrapStatus, CodedError, ErrorCodes, productName } from '@shared';
import { setTimeout as sleep } from 'node:timers/promises';
import { LISHClient, LISH_PROTOCOL } from '../protocol/lish-protocol.ts';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;
/**
 * How a peer detail rides out the moment before the other side has processed our own
 * subscription. Short and few: the screen is waiting on this call, so it must fail visibly
 * if the peer really will not serve us rather than hang on hope.
 */
const PEER_LISTING_RETRY_MS = 700;
const PEER_LISTING_RETRIES = 2;
interface LISHnetsHandlers {
	list: () => LISHNetworkConfig[];
	get: (p: { networkID: string }) => LISHNetworkConfig | undefined;
	exists: (p: { networkID: string }) => boolean;
	add: (p: { network: LISHNetworkConfig }) => Promise<boolean>;
	update: (p: { network: LISHNetworkConfig }) => Promise<boolean>;
	delete: (p: { networkID: string }) => Promise<boolean>;
	addIfNotExists: (p: { network: LISHNetworkDefinition }) => Promise<boolean>;
	import: (p: { networks: LISHNetworkDefinition[] }) => Promise<number>;
	replace: (p: { networks: LISHNetworkConfig[] }) => Promise<boolean>;
	exportToFile: (p: { networkID: string; filePath: string; minifyJSON?: boolean; compress?: boolean; compressionAlgorithm?: CompressionAlgorithm }) => Promise<SuccessResponse>;
	exportAllToFile: (p: { filePath: string; minifyJSON?: boolean; compress?: boolean; compressionAlgorithm?: CompressionAlgorithm }) => Promise<SuccessResponse>;
	importFromFile: (p: { path: string; enabled?: boolean }) => Promise<LISHNetworkConfig[]>;
	parseFromFile: (p: { path: string }) => Promise<LISHNetworkDefinition[]>;
	parseFromJSON: (p: { json: string }) => LISHNetworkDefinition[];
	parseFromURL: (p: { url: string }) => Promise<LISHNetworkDefinition[]>;
	setEnabled: (p: { networkID: string; enabled: boolean }) => Promise<SetLISHNetworkEnabledResponse>;
	connect: (p: { multiaddr: string }) => Promise<SuccessResponse>;
	findPeer: (p: { peerID: string }) => Promise<void>;
	getAddresses: () => string[];
	getPeers: (p: { networkID?: string }) => PeerListEntry[];
	getPeerLishs: (p: { peerID: string; networkID: string }) => Promise<{ lishs: PeerLishEntry[] }>;
	getPeerLish: (p: { lishID: string; peerID: string; networkID: string }) => Promise<IPeerLishDetail>;
	addPeerLish: (p: { lishID: string; peerID: string; networkID: string }) => Promise<{ lishID: string }>;
	getNodeInfo: () => NetworkNodeInfo | null;
	getStatus: (p: { networkID: string }) => NetworkStatus;
	infoAll: () => NetworkInfo[];
	getBootstrapStatus: (p: { networkID: string }) => BootstrapStatus | null;
	getAllBootstrapStatuses: () => BootstrapStatus[];
	updateBootstrapPeers: (p: { networkID: string; bootstrapPeers: string[] }) => Promise<LISHNetworkConfig>;
}
/** The import pipeline WITHOUT its admission gate — the caller here already holds it. */
type ImportManifestFn = (lish: ILISH, downloadPath: string, opts?: { overwrite?: boolean; enableSharing?: boolean; enableDownloading?: boolean }) => Promise<ImportLISHResponse>;
type RunLISHMutationFn = <T>(operation: () => Promise<T>) => Promise<T>;

export function toSetEnabledResponse(result: SetEnabledResult): SetLISHNetworkEnabledResponse {
	return { success: result.found && result.applied, applied: result.applied, transitioned: result.transitioned, joined: result.joined };
}

/**
 * `shutdownSignal` belongs to the API server and aborts only when the backend shuts down. It
 * cancels the three outgoing peer reads below — the dial, the stream and the request — so a
 * shutdown does not wait out a peer that answered the dial and then never sent the manifest.
 */
export function initLISHnetsHandlers(networks: Networks, dataServer: DataServer, broadcast: (event: string, data: any) => void, settings: Settings, importManifestAdmitted: ImportManifestFn, runLISHMutation: RunLISHMutationFn, shutdownSignal: AbortSignal): LISHnetsHandlers {
	/**
	 * Dial the peer, open a LISH client and run one request, all cancellable by the shutdown
	 * signal. The stream is aborted when the signal fires at any point — including between the
	 * dial returning and the listener being attached — and the close is still awaited in
	 * cleanup, so the caller's finally really is the end of the work.
	 */
	async function withPeerClient<T>(peerID: string, request: (client: LISHClient) => Promise<T>): Promise<T> {
		shutdownSignal.throwIfAborted();
		const network = networks.getRunningNetwork();
		const { stream } = await network.dialProtocolByPeerId(peerID, LISH_PROTOCOL, shutdownSignal);
		let client: LISHClient;
		try {
			client = new LISHClient(stream);
		} catch (error) {
			try {
				stream.abort(error instanceof Error ? error : new Error(String(error)));
			} catch {}
			throw error;
		}
		const onAbort = (): void => client.abort(shutdownSignal.reason instanceof Error ? shutdownSignal.reason : new Error('Backend is shutting down'));
		shutdownSignal.addEventListener('abort', onAbort, { once: true });
		try {
			// Aborted before the listener was attached: nothing sent, stream torn down now.
			if (shutdownSignal.aborted) onAbort();
			shutdownSignal.throwIfAborted();
			try {
				return await request(client);
			} finally {
				// Close in finally so a throwing request (peer error, validation) cannot leak
				// the stream; swallow close errors so they never mask the request error.
				await client.close().catch(() => {});
			}
		} finally {
			shutdownSignal.removeEventListener('abort', onAbort);
		}
	}

	function list(): LISHNetworkConfig[] {
		return networks.list();
	}
	function get(p: { networkID: string }): LISHNetworkConfig | undefined {
		assert(p, ['networkID']);
		return networks.get(p.networkID);
	}
	function exists(p: { networkID: string }): boolean {
		assert(p, ['networkID']);
		return networks.exists(p.networkID);
	}
	async function add(p: { network: LISHNetworkConfig }): Promise<boolean> {
		assert(p, ['network']);
		return networks.add(p.network);
	}
	async function update(p: { network: LISHNetworkConfig }): Promise<boolean> {
		assert(p, ['network']);
		return networks.update(p.network);
	}
	async function del(p: { networkID: string }): Promise<boolean> {
		assert(p, ['networkID']);
		return networks.delete(p.networkID);
	}
	async function addIfNotExists(p: { network: LISHNetworkDefinition }): Promise<boolean> {
		assert(p, ['network']);
		return networks.addIfNotExists(p.network);
	}
	async function importNetworks(p: { networks: LISHNetworkDefinition[] }): Promise<number> {
		assert(p, ['networks']);
		return networks.importNetworks(p.networks);
	}
	async function replace(p: { networks: LISHNetworkConfig[] }): Promise<boolean> {
		assert(p, ['networks']);
		await networks.replace(p.networks);
		return true;
	}
	async function exportToFile(p: { networkID: string; filePath: string; minifyJSON?: boolean; compress?: boolean; compressionAlgorithm?: CompressionAlgorithm }): Promise<SuccessResponse> {
		assert(p, ['networkID', 'filePath']);
		const network = networks.get(p.networkID);
		if (!network) throw new CodedError(ErrorCodes.NETWORK_NOT_FOUND, p.networkID);
		const { enabled, ...definition } = network;
		await Utils.writeJSONToFile(definition, p.filePath, p.minifyJSON, p.compress, p.compressionAlgorithm);
		console.log(`✓ Network exported to: ${p.filePath}`);
		return { success: true };
	}

	async function exportAllToFile(p: { filePath: string; minifyJSON?: boolean; compress?: boolean; compressionAlgorithm?: CompressionAlgorithm }): Promise<SuccessResponse> {
		assert(p, ['filePath']);
		const nets = networks.list();
		if (nets.length === 0) throw new CodedError(ErrorCodes.NO_NETWORKS);
		const exportData = nets.map(({ enabled, ...definition }) => definition);
		await Utils.writeJSONToFile(exportData, p.filePath, p.minifyJSON, p.compress, p.compressionAlgorithm);
		console.log(`✓ All networks exported to: ${p.filePath}`);
		return { success: true };
	}

	async function importFromFile(p: { path: string; enabled?: boolean }): Promise<LISHNetworkConfig[]> {
		assert(p, ['path']);
		return networks.importFromFile(p.path, p.enabled ?? false);
	}
	async function parseFromFile(p: { path: string }): Promise<LISHNetworkDefinition[]> {
		assert(p, ['path']);
		return networks.parseFromFile(p.path);
	}
	function parseFromJSON(p: { json: string }): LISHNetworkDefinition[] {
		assert(p, ['json']);
		return networks.parseFromJSON(p.json);
	}
	async function parseFromURL(p: { url: string }): Promise<LISHNetworkDefinition[]> {
		assert(p, ['url']);
		return networks.parseFromURL(p.url);
	}
	async function setEnabled(p: { networkID: string; enabled: boolean }): Promise<SetLISHNetworkEnabledResponse> {
		assert(p, ['networkID', 'enabled']);
		const result = await networks.setEnabled(p.networkID, p.enabled);
		// Only a settled transition is broadcast, and the event names the state the network
		// actually ended in. Broadcasting on "the network exists" plus the REQUESTED flag
		// announced a join for a request a newer one had already overruled, and repeated the
		// event for an enable of an already-enabled network.
		//
		// The name comes from the operation, not from a get() of our own. Reading the row
		// before the await missed a network that was still being added — undefined, so the
		// join it really did perform was never broadcast — and carried the pre-rename name
		// when an edit was queued ahead of the enable. Reading it after the await races the
		// next write instead.
		if (result.transitioned && result.network) broadcast(result.joined ? 'lishnets:joined' : 'lishnets:left', result.network);
		return toSetEnabledResponse(result);
	}
	async function connect(p: { multiaddr: string }): Promise<SuccessResponse> {
		assert(p, ['multiaddr']);
		const network = networks.getRunningNetwork();
		await network.connectToPeer(p.multiaddr);
		return { success: true };
	}
	function findPeer(p: { peerID: string }): Promise<void> {
		assert(p, ['peerID']);
		const network = networks.getRunningNetwork();
		return network.cliFindPeer(p.peerID);
	}
	function getAddresses(): string[] {
		const network = networks.getRunningNetwork();
		const info = network.getNodeInfo();
		return info?.addresses || [];
	}
	function getPeers(p: { networkID?: string }): PeerListEntry[] {
		if (p.networkID) {
			// Single network
			if (!networks.isJoined(p.networkID)) throw new CodedError(ErrorCodes.NETWORK_NOT_JOINED);
			const net = networks.get(p.networkID);
			const peers = networks.getTopicPeersInfo(p.networkID);
			return peers.map(peer => ({
				peerID: peer.peerID,
				networks: [{ networkID: p.networkID!, networkName: net?.name ?? p.networkID! }],
				direct: peer.direct,
				relay: peer.relay,
			}));
		}
		// All networks — aggregate and deduplicate
		const allConfigs = networks.list().filter(n => n.enabled);
		const peerMap = new Map<string, PeerListEntry>();
		for (const config of allConfigs) {
			if (!networks.isJoined(config.networkID)) continue;
			const peers = networks.getTopicPeersInfo(config.networkID);
			for (const peer of peers) {
				const existing = peerMap.get(peer.peerID);
				if (existing) {
					existing.networks.push({ networkID: config.networkID, networkName: config.name });
					existing.direct += peer.direct;
					existing.relay += peer.relay;
				} else {
					peerMap.set(peer.peerID, {
						peerID: peer.peerID,
						networks: [{ networkID: config.networkID, networkName: config.name }],
						direct: peer.direct,
						relay: peer.relay,
					});
				}
			}
		}
		return [...peerMap.values()];
	}
	async function getPeerLishs(p: { peerID: string; networkID: string }): Promise<{ lishs: PeerLishEntry[] }> {
		assert(p, ['peerID', 'networkID']);
		// A peer that has not yet processed our own subscription refuses the listing, and both
		// sides converge out of that on their own within a moment. Search retries for exactly
		// this reason; without the same here, opening a peer's detail right after connecting
		// shows an error that no longer reflects reality and only a manual refresh clears.
		// Bounded and confined to that one code: every other failure is reported at once.
		for (let attempt = 0; ; attempt++) {
			try {
				shutdownSignal.throwIfAborted();
				return await getPeerLishsOnce(p);
			} catch (error: any) {
				shutdownSignal.throwIfAborted();
				if (error?.code !== ErrorCodes.PEER_LISTING_NOT_AUTHORIZED || attempt >= PEER_LISTING_RETRIES) throw error;
				await sleep(PEER_LISTING_RETRY_MS, undefined, { signal: shutdownSignal }).catch(timerError => {
					throw shutdownSignal.aborted ? shutdownSignal.reason : timerError;
				});
			}
		}
	}

	async function getPeerLishsOnce(p: { peerID: string; networkID: string }): Promise<{ lishs: PeerLishEntry[] }> {
		try {
			const lishs = await withPeerClient(p.peerID, client => client.requestList());
			shutdownSignal.throwIfAborted();
			return { lishs };
		} catch (error: any) {
			shutdownSignal.throwIfAborted();
			if (error instanceof CodedError) throw error;
			console.error(`[Peers] Failed to get LISH list from ${p.peerID.slice(0, 12)}:`, error.message?.slice(0, 120) ?? error);
			throw new CodedError(ErrorCodes.PEER_UNREACHABLE, p.peerID);
		}
	}
	async function getPeerLish(p: { lishID: string; peerID: string; networkID: string }): Promise<IPeerLishDetail> {
		assert(p, ['lishID', 'peerID', 'networkID']);
		try {
			const onProgress = (received: number, total: number): void => broadcast('lishnets:manifestProgress', { lishID: p.lishID, peerID: p.peerID, received, total } satisfies ManifestProgressEvent);
			const manifest = await withPeerClient(p.peerID, client => client.requestManifest(p.lishID, onProgress));
			shutdownSignal.throwIfAborted();
			// Strip checksums from files and compute summary
			const files = (manifest.files ?? []).map(f => {
				const entry: { path: string; size: number; permissions?: string; modified?: string; created?: string } = { path: f.path, size: f.size };
				if (f.permissions !== undefined) entry.permissions = f.permissions;
				if (f.modified !== undefined) entry.modified = f.modified;
				if (f.created !== undefined) entry.created = f.created;
				return entry;
			});
			const totalSize = files.reduce((sum, f) => sum + f.size, 0);
			return {
				id: manifest.id,
				name: manifest.name,
				description: manifest.description,
				created: manifest.created,
				chunkSize: manifest.chunkSize,
				checksumAlgo: manifest.checksumAlgo,
				totalSize,
				fileCount: files.length,
				directoryCount: (manifest.directories ?? []).length,
				files,
				directories: manifest.directories ?? [],
				links: manifest.links ?? [],
			};
		} catch (error: any) {
			shutdownSignal.throwIfAborted();
			if (error instanceof CodedError) throw error;
			console.error(`[Peers] Failed to get LISH ${p.lishID.slice(0, 8)} from ${p.peerID.slice(0, 12)}:`, error.message?.slice(0, 120) ?? error);
			throw new CodedError(ErrorCodes.PEER_UNREACHABLE, p.peerID);
		}
	}
	async function addPeerLish(p: { lishID: string; peerID: string; networkID: string }): Promise<{ lishID: string }> {
		return runLISHMutation(() => addPeerLishAdmitted(p));
	}

	async function addPeerLishAdmitted(p: { lishID: string; peerID: string; networkID: string }): Promise<{ lishID: string }> {
		assert(p, ['lishID', 'peerID', 'networkID']);
		let manifest;
		try {
			const onProgress = (received: number, total: number): void => broadcast('lishnets:manifestProgress', { lishID: p.lishID, peerID: p.peerID, received, total } satisfies ManifestProgressEvent);
			manifest = await withPeerClient(p.peerID, client => client.requestManifest(p.lishID, onProgress));
		} catch (error: any) {
			shutdownSignal.throwIfAborted();
			if (error instanceof CodedError) throw error;
			console.error(`[Peers] Failed to add LISH ${p.lishID.slice(0, 8)} from ${p.peerID.slice(0, 12)}:`, error.message?.slice(0, 120) ?? error);
			throw new CodedError(ErrorCodes.PEER_UNREACHABLE, p.peerID);
		}
		// Delegate to the shared import pipeline — handles temp allocation, finalDirectory wiring,
		// DB persist, broadcast, verification kick-off and markDownloadEnabled.
		//
		// The admitted variant, because this function already runs inside the mutation gate its
		// public entry point took. The gated one entered it a second time, so a reset closing
		// admission while the manifest was still downloading made an already-accepted operation
		// refuse its own second half.
		// A manifest that arrived after the shutdown began is not imported.
		shutdownSignal.throwIfAborted();
		const downloadPath = settings.get('storage.downloadPath') ?? `~/${productName}/finished/`;
		const enableSharing = settings.get('network.autoStartSharing') ?? true;
		const enableDownloading = settings.get('network.autoStartDownloading') ?? true;
		const result = await importManifestAdmitted(manifest, downloadPath, { enableSharing, enableDownloading });
		return { lishID: result.lishID };
	}
	function getNodeInfo(): NetworkNodeInfo | null {
		return networks.getNetwork().getNodeInfo();
	}
	function getStatus(p: { networkID: string }): NetworkStatus {
		assert(p, ['networkID']);
		const network = networks.getRunningNetwork();
		const allPeers = network.getPeers();
		const topicPeers = networks.getTopicPeers(p.networkID);
		return {
			connected: topicPeers.length,
			connectedPeers: topicPeers,
			peersInStore: allPeers.length,
			datasets: dataServer.getDatasets().length,
		};
	}
	function getBootstrapStatus(p: { networkID: string }): BootstrapStatus | null {
		assert(p, ['networkID']);
		return networks.getBootstrapStatus(p.networkID);
	}
	function getAllBootstrapStatuses(): BootstrapStatus[] {
		return networks.getAllBootstrapStatuses();
	}
	async function updateBootstrapPeers(p: { networkID: string; bootstrapPeers: string[] }): Promise<LISHNetworkConfig> {
		assert(p, ['networkID', 'bootstrapPeers']);
		if (!Array.isArray(p.bootstrapPeers)) throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, 'bootstrapPeers must be an array');
		const updated = await networks.updateBootstrapPeers(p.networkID, p.bootstrapPeers);
		if (!updated) throw new CodedError(ErrorCodes.NETWORK_NOT_FOUND, p.networkID);
		broadcast('lishnets:updated', { networkID: updated.networkID });
		return updated;
	}
	function infoAll(): NetworkInfo[] {
		const configs = networks.list();
		const network = networks.getNetwork();
		const nodeInfo = network.isRunning() ? network.getNodeInfo() : null;
		const result: NetworkInfo[] = [];
		for (const config of configs) {
			const info: NetworkInfo = { ...config };
			if (config.enabled && nodeInfo) {
				info.peerID = nodeInfo.peerID;
				info.addresses = nodeInfo.addresses;
				const topicPeers = networks.getTopicPeers(config.networkID);
				info.connected = topicPeers.length;
				info.connectedPeers = topicPeers;
			}
			result.push(info);
		}
		return result;
	}
	return {
		list,
		get,
		exists,
		add,
		update,
		delete: del,
		addIfNotExists,
		import: importNetworks,
		replace,
		exportToFile,
		exportAllToFile,
		importFromFile,
		parseFromFile,
		parseFromJSON,
		parseFromURL,
		setEnabled,
		connect,
		findPeer,
		getAddresses,
		getPeers,
		getPeerLishs,
		getPeerLish,
		addPeerLish,
		getNodeInfo,
		getStatus,
		infoAll,
		getBootstrapStatus,
		getAllBootstrapStatuses,
		updateBootstrapPeers,
	};
}
