import { type Networks } from '../lishnet/networks.ts';
import { type LISHNetworkConfig, type LISHNetworkDefinition } from '@shared';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;

export function initLishNetworksHandlers(networks: Networks) {
	function getAll(): LISHNetworkConfig[] {
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
	return { getAll, get, exists, add, update, delete: del, addIfNotExists, import: importNetworks, setAll };
}
