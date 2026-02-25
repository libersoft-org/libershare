import { type Networks } from '../lishnet/networks.ts';
import { type DataServer } from '../lish/data-server.ts';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;

export function initNetworksHandlers(networks: Networks, dataServer: DataServer) {
	const list = () => networks.getAll();
	const get = (p: { networkID: string }) => {
		assert(p, ['networkID']);
		return networks.get(p.networkID);
	};
	const importFromFile = async (p: { path: string; enabled?: boolean }) => {
		assert(p, ['path']);
		return networks.importFromFile(p.path, p.enabled ?? false);
	};
	const importFromJson = async (p: { json: string; enabled?: boolean }) => {
		assert(p, ['json']);
		return networks.importFromJson(p.json, p.enabled ?? false);
	};
	const setEnabled = async (p: { networkID: string; enabled: boolean }) => {
		assert(p, ['networkID', 'enabled']);
		return { success: await networks.setEnabled(p.networkID, p.enabled) };
	};
	const del = async (p: { networkID: string }) => {
		assert(p, ['networkID']);
		return { success: await networks.delete(p.networkID) };
	};

	const connect = async (p: { multiaddr: string }) => {
		assert(p, ['multiaddr']);
		const network = networks.getRunningNetwork();
		await network.connectToPeer(p.multiaddr);
		return { success: true };
	};

	const findPeer = (p: { peerID: string }) => {
		assert(p, ['peerID']);
		const network = networks.getRunningNetwork();
		return network.cliFindPeer(p.peerID);
	};

	const getAddresses = () => {
		const network = networks.getRunningNetwork();
		const info = network.getNodeInfo();
		return info?.addresses || [];
	};

	const getPeers = (p: { networkID: string }) => {
		assert(p, ['networkID']);
		if (!networks.isJoined(p.networkID)) throw new Error('Network not joined');
		return networks.getTopicPeersInfo(p.networkID);
	};

	const getNodeInfo = () => networks.getNetwork().getNodeInfo();

	const getStatus = (p: { networkID: string }) => {
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
	};

	const infoAll = () => {
		const definitions = networks.getAll();
		const network = networks.getNetwork();
		const nodeInfo = network.isRunning() ? network.getNodeInfo() : null;
		const result = [];
		for (const def of definitions) {
			const info: any = {
				id: def.id,
				version: def.version,
				name: def.name,
				description: def.description,
				bootstrap_peers: def.bootstrap_peers,
				enabled: def.enabled,
			};
			if (def.enabled && nodeInfo) {
				info.peerID = nodeInfo.peerID;
				info.addresses = nodeInfo.addresses;
				const topicPeers = networks.getTopicPeers(def.id);
				info.connected = topicPeers.length;
				info.connectedPeers = topicPeers;
			}
			result.push(info);
		}
		return result;
	};

	return { list, get, importFromFile, importFromJson, setEnabled, delete: del, connect, findPeer, getAddresses, getPeers, getNodeInfo, getStatus, infoAll };
}
