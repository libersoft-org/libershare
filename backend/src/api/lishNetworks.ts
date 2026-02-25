import { type LISHNetworkStorage } from '../lishnet/lishNetworkStorage.ts';

type P = Record<string, any>;

export function initLishNetworksHandlers(lishNetworks: LISHNetworkStorage) {
	const getAll = () => lishNetworks.getAll();
	const get = (p: P) => lishNetworks.get(p.networkID);
	const exists = (p: P) => lishNetworks.exists(p.networkID);
	const add = async (p: P) => lishNetworks.add(p.network);
	const update = async (p: P) => lishNetworks.update(p.network);
	const del = async (p: P) => lishNetworks.delete(p.networkID);
	const addIfNotExists = async (p: P) => lishNetworks.addIfNotExists(p.network);
	const importNetworks = async (p: P) => lishNetworks.importNetworks(p.networks);

	const setAll = async (p: P) => {
		await lishNetworks.setAll(p.networks);
		return true;
	};

	return { getAll, get, exists, add, update, delete: del, addIfNotExists, import: importNetworks, setAll };
}
