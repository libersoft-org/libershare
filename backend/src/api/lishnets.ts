import { type Networks } from '../lishnet/networks.ts';
import { type DataServer } from '../lish/data-server.ts';
import { type LISHNetworkConfig, type LISHNetworkDefinition, type SuccessResponse, type NetworkNodeInfo, type NetworkStatus, type NetworkInfo, type PeerConnectionInfo } from '@shared';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;

export function initLISHnetsHandlers(networks: Networks, dataServer: DataServer) {
	function list(): LISHNetworkConfig[] {
		return networks.getAll();
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
	async function setAll(p: { networks: LISHNetworkConfig[] }): Promise<boolean> {
		assert(p, ['networks']);
		await networks.setAll(p.networks);
		return true;
	}
	async function importFromFile(p: { path: string; enabled?: boolean }): Promise<LISHNetworkConfig> {
		assert(p, ['path']);
		return networks.importFromFile(p.path, p.enabled ?? false);
	}
	async function importFromJson(p: { json: string; enabled?: boolean }): Promise<LISHNetworkConfig> {
		assert(p, ['json']);
		return networks.importFromJson(p.json, p.enabled ?? false);
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
		if (!networks.isJoined(p.networkID)) throw new Error('Network not joined');
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
		const configs = networks.getAll();
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
		list, get, exists, add, update, delete: del, addIfNotExists, import: importNetworks, setAll,
		importFromFile, importFromJson, setEnabled, connect, findPeer, getAddresses, getPeers, getNodeInfo, getStatus, infoAll,
	};
}
