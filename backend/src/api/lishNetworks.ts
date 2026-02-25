import { type LISHNetworkStorage } from '../lishnet/lishNetworkStorage.ts';
import { type LISHNetworkConfig, type LISHNetworkDefinition } from '@shared';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;

export function initLishNetworksHandlers(lishNetworks: LISHNetworkStorage) {
	const getAll = () => lishNetworks.getAll();
	const get = (p: { networkID: string }) => {
		assert(p, ['networkID']);
		return lishNetworks.get(p.networkID);
	};
	const exists = (p: { networkID: string }) => {
		assert(p, ['networkID']);
		return lishNetworks.exists(p.networkID);
	};
	const add = async (p: { network: LISHNetworkConfig }) => {
		assert(p, ['network']);
		return lishNetworks.add(p.network);
	};
	const update = async (p: { network: LISHNetworkConfig }) => {
		assert(p, ['network']);
		return lishNetworks.update(p.network);
	};
	const del = async (p: { networkID: string }) => {
		assert(p, ['networkID']);
		return lishNetworks.delete(p.networkID);
	};
	const addIfNotExists = async (p: { network: LISHNetworkDefinition }) => {
		assert(p, ['network']);
		return lishNetworks.addIfNotExists(p.network);
	};
	const importNetworks = async (p: { networks: LISHNetworkDefinition[] }) => {
		assert(p, ['networks']);
		return lishNetworks.importNetworks(p.networks);
	};
	const setAll = async (p: { networks: LISHNetworkConfig[] }) => {
		assert(p, ['networks']);
		await lishNetworks.setAll(p.networks);
		return true;
	};
	return { getAll, get, exists, add, update, delete: del, addIfNotExists, import: importNetworks, setAll };
}
