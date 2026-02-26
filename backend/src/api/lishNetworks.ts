import { type LISHNetworkStorage } from '../lishnet/lishNetworkStorage.ts';
import { type LISHNetworkConfig, type LISHNetworkDefinition } from '@shared';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;

export function initLishNetworksHandlers(lishNetworks: LISHNetworkStorage) {
	function getAll() { return lishNetworks.getAll(); }
	function get(p: { networkID: string }) {
		assert(p, ['networkID']);
		return lishNetworks.get(p.networkID);
	}
	function exists(p: { networkID: string }) {
		assert(p, ['networkID']);
		return lishNetworks.exists(p.networkID);
	}
	async function add(p: { network: LISHNetworkConfig }) {
		assert(p, ['network']);
		return lishNetworks.add(p.network);
	}
	async function update(p: { network: LISHNetworkConfig }) {
		assert(p, ['network']);
		return lishNetworks.update(p.network);
	}
	async function del(p: { networkID: string }) {
		assert(p, ['networkID']);
		return lishNetworks.delete(p.networkID);
	}
	async function addIfNotExists(p: { network: LISHNetworkDefinition }) {
		assert(p, ['network']);
		return lishNetworks.addIfNotExists(p.network);
	}
	async function importNetworks(p: { networks: LISHNetworkDefinition[] }) {
		assert(p, ['networks']);
		return lishNetworks.importNetworks(p.networks);
	}
	async function setAll(p: { networks: LISHNetworkConfig[] }) {
		assert(p, ['networks']);
		await lishNetworks.setAll(p.networks);
		return true;
	}
	return { getAll, get, exists, add, update, delete: del, addIfNotExists, import: importNetworks, setAll };
}
