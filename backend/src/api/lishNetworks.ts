import { type LISHNetworkStorage } from '../lishnet/lishNetworkStorage.ts';
import { type LISHNetworkConfig, type LISHNetworkDefinition } from '@shared';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;

export function initLishNetworksHandlers(lishNetworks: LISHNetworkStorage) {
	function getAll(): LISHNetworkConfig[] {
		return lishNetworks.getAll();
	}
	function get(p: { networkID: string }): LISHNetworkConfig | undefined {
		assert(p, ['networkID']);
		return lishNetworks.get(p.networkID);
	}
	function exists(p: { networkID: string }): boolean {
		assert(p, ['networkID']);
		return lishNetworks.exists(p.networkID);
	}
	async function add(p: { network: LISHNetworkConfig }): Promise<boolean> {
		assert(p, ['network']);
		return lishNetworks.add(p.network);
	}
	async function update(p: { network: LISHNetworkConfig }): Promise<boolean> {
		assert(p, ['network']);
		return lishNetworks.update(p.network);
	}
	async function del(p: { networkID: string }): Promise<boolean> {
		assert(p, ['networkID']);
		return lishNetworks.delete(p.networkID);
	}
	async function addIfNotExists(p: { network: LISHNetworkDefinition }): Promise<boolean> {
		assert(p, ['network']);
		return lishNetworks.addIfNotExists(p.network);
	}
	async function importNetworks(p: { networks: LISHNetworkDefinition[] }): Promise<number> {
		assert(p, ['networks']);
		return lishNetworks.importNetworks(p.networks);
	}
	async function setAll(p: { networks: LISHNetworkConfig[] }): Promise<boolean> {
		assert(p, ['networks']);
		await lishNetworks.setAll(p.networks);
		return true;
	}
	return { getAll, get, exists, add, update, delete: del, addIfNotExists, import: importNetworks, setAll };
}
