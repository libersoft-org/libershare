import { type Networks } from '../lishnet/lishnets.ts';
import { type DataServer } from '../lish/data-server.ts';
import { type LISHNetworkConfig, type LISHNetworkDefinition, type SuccessResponse, type NetworkNodeInfo, type NetworkStatus, type NetworkInfo, type PeerConnectionInfo, type CompressionAlgorithm, CodedError, ErrorCodes } from '@shared';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;

interface LISHnetsHandlers {
	list: () => LISHNetworkConfig[];
	get: (p: { networkID: string }) => LISHNetworkConfig | undefined;
	exists: (p: { networkID: string }) => boolean;
	add: (p: { network: LISHNetworkConfig }) => boolean;
	update: (p: { network: LISHNetworkConfig }) => boolean;
	delete: (p: { networkID: string }) => Promise<boolean>;
	addIfNotExists: (p: { network: LISHNetworkDefinition }) => boolean;
	import: (p: { networks: LISHNetworkDefinition[] }) => number;
	replace: (p: { networks: LISHNetworkConfig[] }) => boolean;
	exportToFile: (p: { networkID: string; filePath: string; minifyJSON?: boolean; compress?: boolean; compressionAlgorithm?: CompressionAlgorithm }) => Promise<SuccessResponse>;
	exportAllToFile: (p: { filePath: string; minifyJSON?: boolean; compress?: boolean; compressionAlgorithm?: CompressionAlgorithm }) => Promise<SuccessResponse>;
	importFromFile: (p: { path: string; enabled?: boolean }) => Promise<LISHNetworkConfig[]>;
	parseFromFile: (p: { path: string }) => Promise<LISHNetworkDefinition[]>;
	parseFromJSON: (p: { json: string }) => LISHNetworkDefinition[];
	parseFromURL: (p: { url: string }) => Promise<LISHNetworkDefinition[]>;
	setEnabled: (p: { networkID: string; enabled: boolean }) => Promise<SuccessResponse>;
	connect: (p: { multiaddr: string }) => Promise<SuccessResponse>;
	findPeer: (p: { peerID: string }) => Promise<void>;
	getAddresses: () => string[];
	getPeers: (p: { networkID: string }) => PeerConnectionInfo[];
	getNodeInfo: () => NetworkNodeInfo | null;
	getStatus: (p: { networkID: string }) => NetworkStatus;
	infoAll: () => NetworkInfo[];
}

export function initLISHnetsHandlers(networks: Networks, dataServer: DataServer): LISHnetsHandlers {
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
	function add(p: { network: LISHNetworkConfig }): boolean {
		assert(p, ['network']);
		return networks.add(p.network);
	}
	function update(p: { network: LISHNetworkConfig }): boolean {
		assert(p, ['network']);
		return networks.update(p.network);
	}
	async function del(p: { networkID: string }): Promise<boolean> {
		assert(p, ['networkID']);
		return networks.delete(p.networkID);
	}
	function addIfNotExists(p: { network: LISHNetworkDefinition }): boolean {
		assert(p, ['network']);
		return networks.addIfNotExists(p.network);
	}
	function importNetworks(p: { networks: LISHNetworkDefinition[] }): number {
		assert(p, ['networks']);
		return networks.importNetworks(p.networks);
	}
	function replace(p: { networks: LISHNetworkConfig[] }): boolean {
		assert(p, ['networks']);
		networks.replace(p.networks);
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
		const definitions = await networks.parseFromFile(p.path);
		const results: LISHNetworkConfig[] = [];
		for (const def of definitions) results.push(await networks.importFromLISHnet(def as any, p.enabled ?? false));
		return results;
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
	async function setEnabled(p: { networkID: string; enabled: boolean }): Promise<SuccessResponse> {
		assert(p, ['networkID', 'enabled']);
		return { success: await networks.setEnabled(p.networkID, p.enabled) };
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
	function getPeers(p: { networkID: string }): PeerConnectionInfo[] {
		assert(p, ['networkID']);
		if (!networks.isJoined(p.networkID)) throw new CodedError(ErrorCodes.NETWORK_NOT_JOINED);
		return networks.getTopicPeersInfo(p.networkID);
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
		getNodeInfo,
		getStatus,
		infoAll,
	};
}
