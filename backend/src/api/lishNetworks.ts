import { type LISHNetworkStorage } from '../lishnet/lishNetworkStorage.ts';

type P = Record<string, any>;

export function initLishNetworksHandlers(lishNetworks: LISHNetworkStorage) {
	const getAll = () => lishNetworks.getAll();
	const get = (p: P) => lishNetworks.get(p.networkID);
	const exists = (p: P) => lishNetworks.exists(p.networkID);
	const add = (p: P) => lishNetworks.add(p.network);
	const update = (p: P) => lishNetworks.update(p.network);
	const del = (p: P) => lishNetworks.delete(p.networkID);
	const addIfNotExists = (p: P) => lishNetworks.addIfNotExists(p.network);
	const importNetworks = (p: P) => lishNetworks.importNetworks(p.networks);

	const setAll = (p: P) => {
		lishNetworks.setAll(p.networks);
		return true;
	};

	return { getAll, get, exists, add, update, delete: del, addIfNotExists, import: importNetworks, setAll };
}
