import { getStorageValue, setStorageValue } from './localStorage.ts';
export interface LISHNetwork {
	version: number;
	networkID: string;
	name: string;
	description: string;
	bootstrapPeers: string[];
	created: string;
}
const STORAGE_KEY = 'lishNetworks';

export function getNetworks(): LISHNetwork[] {
	return getStorageValue<LISHNetwork[]>(STORAGE_KEY, []);
}

export function saveNetworks(networks: LISHNetwork[]): void {
	setStorageValue(STORAGE_KEY, networks);
}

export function getNetworkById(networkID: string): LISHNetwork | undefined {
	const networks = getNetworks();
	return networks.find(n => n.networkID === networkID);
}

export function addNetwork(network: LISHNetwork): void {
	const networks = getNetworks();
	networks.push(network);
	saveNetworks(networks);
}

export function updateNetwork(network: LISHNetwork): void {
	const networks = getNetworks();
	const index = networks.findIndex(n => n.networkID === network.networkID);
	if (index !== -1) {
		networks[index] = network;
		saveNetworks(networks);
	}
}

export function deleteNetwork(networkID: string): void {
	const networks = getNetworks();
	const filtered = networks.filter(n => n.networkID !== networkID);
	saveNetworks(filtered);
}
