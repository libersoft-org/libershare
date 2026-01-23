import { getStorageValue, setStorageValue } from './localStorage.ts';
export interface LISHNetwork {
	version: number;
	networkID: string;
	name: string;
	description: string;
	bootstrapPeers: string[];
	created: string;
}
export const DEFAULT_PUBLIC_LIST_URL = 'https://pastebin.com/raw/ez1S9WYk';
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

export function networkExists(networkID: string): boolean {
	const networks = getNetworks();
	return networks.some(n => n.networkID === networkID);
}

export function addNetworkIfNotExists(network: LISHNetwork): boolean {
	if (networkExists(network.networkID)) return false;
	addNetwork({
		...network,
		created: new Date().toISOString(),
	});
	return true;
}

export function getExistingNetworkIds(): Set<string> {
	const networks = getNetworks();
	return new Set(networks.map(n => n.networkID));
}

export interface FetchPublicNetworksResult {
	networks: LISHNetwork[];
	error: string | null;
}

export async function fetchPublicNetworks(url: string): Promise<FetchPublicNetworksResult> {
	try {
		// Use CORS proxy to bypass CORS restrictions
		const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
		const response = await fetch(proxyUrl);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = await response.json();
		// Validate the data - should be an array of networks
		if (!Array.isArray(data)) return { networks: [], error: 'INVALID_FORMAT' };
		// Validate each network has required fields
		const validNetworks: LISHNetwork[] = [];
		for (const item of data) {
			if (item.networkID && item.name && Array.isArray(item.bootstrapPeers)) {
				validNetworks.push({
					version: item.version || 1,
					networkID: item.networkID,
					name: item.name,
					description: item.description || '',
					bootstrapPeers: item.bootstrapPeers,
					created: item.created || new Date().toISOString(),
				});
			}
		}
		if (validNetworks.length === 0) return { networks: [], error: 'NO_VALID_NETWORKS' };
		return { networks: validNetworks, error: null };
	} catch (e) {
		return { networks: [], error: e instanceof Error ? e.message : String(e) };
	}
}
