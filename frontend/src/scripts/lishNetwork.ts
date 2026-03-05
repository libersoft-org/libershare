import { api } from './api.ts';
import { type LISHNetworkConfig, type LISHNetworkDefinition } from '@shared';

// Storage Operations (async, using backend API)

export async function getNetworks(): Promise<LISHNetworkConfig[]> {
	return api.lishnets.list();
}

export async function getNetworkById(networkID: string): Promise<LISHNetworkConfig | undefined> {
	return api.lishnets.get(networkID);
}

export async function addNetwork(network: LISHNetworkConfig): Promise<boolean> {
	return api.lishnets.add(network);
}

export async function updateNetwork(network: LISHNetworkConfig): Promise<boolean> {
	return api.lishnets.update(network);
}

export async function deleteNetwork(networkID: string): Promise<boolean> {
	return api.lishnets.delete(networkID);
}

export async function networkExists(networkID: string): Promise<boolean> {
	return api.lishnets.exists(networkID);
}

export async function addNetworkIfNotExists(network: LISHNetworkDefinition): Promise<boolean> {
	return api.lishnets.addIfNotExists(network);
}

export async function getExistingNetworkIDs(): Promise<Set<string>> {
	const networks = await getNetworks();
	return new Set(networks.map(n => n.networkID));
}

// Network Data Conversion (for AddEdit form)

export interface NetworkFormData {
	id: string;
	name: string;
	description: string;
	bootstrapServers: string[];
}

// Convert LISHNetworkConfig to form data format.
export function networkToFormData(network: LISHNetworkConfig): NetworkFormData {
	return {
		id: network.networkID,
		name: network.name,
		description: network.description,
		bootstrapServers: network.bootstrapPeers.length > 0 ? [...network.bootstrapPeers] : [''],
	};
}

//Convert form data to LISHNetworkConfig.
export function formDataToNetwork(formData: NetworkFormData, existingNetwork?: LISHNetworkConfig): LISHNetworkConfig {
	return {
		networkID: formData.id,
		name: formData.name,
		description: formData.description,
		bootstrapPeers: formData.bootstrapServers.filter(s => s.trim() !== ''),
		enabled: existingNetwork?.enabled || false,
		created: existingNetwork?.created || new Date().toISOString(),
	};
}

// Save or update a network from form data.
export async function saveNetworkFromForm(formData: NetworkFormData, existingNetworkID?: string): Promise<void> {
	const network = formDataToNetwork(formData);
	if (existingNetworkID) await updateNetwork(network);
	else await addNetwork(network);
}

// Public Network List Fetching

export interface FetchPublicNetworksResult {
	networks: LISHNetworkDefinition[];
	error: string | null;
}

export async function fetchPublicNetworks(url: string): Promise<FetchPublicNetworksResult> {
	try {
		const networks = await api.lishnets.parseFromURL(url);
		return { networks, error: null };
	} catch (e) {
		return { networks: [], error: e instanceof Error ? e.message : String(e) };
	}
}
