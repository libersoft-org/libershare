import { type LISHNetworkStorage } from '../lishnet/lishNetworkStorage.ts';
import { type LISHNetworkConfig, type LISHNetworkDefinition } from '@shared';

export function initLishNetworksHandlers(lishNetworks: LISHNetworkStorage) {
	const getAll = () => lishNetworks.getAll();
	const get = (p: { networkID: string }) => lishNetworks.get(p.networkID);
	const exists = (p: { networkID: string }) => lishNetworks.exists(p.networkID);
	const add = async (p: { network: LISHNetworkConfig }) => lishNetworks.add(p.network);
	const update = async (p: { network: LISHNetworkConfig }) => lishNetworks.update(p.network);
	const del = async (p: { networkID: string }) => lishNetworks.delete(p.networkID);
	const addIfNotExists = async (p: { network: LISHNetworkDefinition }) => lishNetworks.addIfNotExists(p.network);
	const importNetworks = async (p: { networks: LISHNetworkDefinition[] }) => lishNetworks.importNetworks(p.networks);

	const setAll = async (p: { networks: LISHNetworkConfig[] }) => {
		await lishNetworks.setAll(p.networks);
		return true;
	};

	return { getAll, get, exists, add, update, delete: del, addIfNotExists, import: importNetworks, setAll };
}
