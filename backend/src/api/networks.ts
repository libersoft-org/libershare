import { type Networks } from '../lishnet/networks.ts';
import { type DataServer } from '../lish/data-server.ts';

type P = Record<string, any>;

export function initNetworksHandlers(networks: Networks, dataServer: DataServer) {
	const list = () => networks.getAll();
	const get = (p: P) => networks.get(p.networkID);
	const importFromFile = async (p: P) => networks.importFromFile(p.path, p.enabled ?? false);
	const importFromJson = async (p: P) => networks.importFromJson(p.json, p.enabled ?? false);
	const setEnabled = async (p: P) => ({ success: await networks.setEnabled(p.networkID, p.enabled) });
	const del = async (p: P) => ({ success: await networks.delete(p.networkID) });

	const connect = async (p: P) => {
		const network = networks.getNetwork();
		if (!network.isRunning()) throw new Error('Network not running');
		await network.connectToPeer(p.multiaddr);
		return { success: true };
	};

	const findPeer = (p: P) => {
		const network = networks.getNetwork();
		if (!network.isRunning()) throw new Error('Network not running');
		return network.cliFindPeer(p.peerID);
	};

	const getAddresses = () => {
		const network = networks.getNetwork();
		if (!network.isRunning()) throw new Error('Network not running');
		const info = network.getNodeInfo();
		return info?.addresses || [];
	};

	const getPeers = (p: P) => {
		if (!networks.isJoined(p.networkID)) throw new Error('Network not joined');
		return networks.getTopicPeersInfo(p.networkID);
	};

	const getNodeInfo = () => networks.getNetwork().getNodeInfo();

	const getStatus = (p: P) => {
		const network = networks.getNetwork();
		if (!network.isRunning()) throw new Error('Network not running');
		const allPeers = network.getPeers();
		const topicPeers = networks.getTopicPeers(p.networkID);
		return {
			connected: topicPeers.length,
			connectedPeers: topicPeers,
			peersInStore: allPeers.length,
			datasets: dataServer.getAllLishs().filter(l => l.directory).length,
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
