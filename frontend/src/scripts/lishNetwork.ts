import { api } from './api.ts';
import { type LISHNetworkConfig, type LISHNetworkDefinition, type NetworkMutationResponse } from '@shared';
import { translateError, tt } from './language.ts';
import { addNotification } from './notifications.ts';

// Storage Operations (async, using backend API)

export async function getNetworks(): Promise<LISHNetworkConfig[]> {
	return api.lishnets.list();
}

export async function getNetworkByID(networkID: string): Promise<LISHNetworkConfig | undefined> {
	return api.lishnets.get(networkID);
}

export async function addNetwork(network: LISHNetworkConfig): Promise<boolean> {
	return reportMutation(await api.lishnets.addDetailed(network), tt('settings.lishNetwork.networkAdded', { name: network.name }));
}

export async function updateNetwork(network: LISHNetworkConfig): Promise<boolean> {
	return reportMutation(await api.lishnets.updateDetailed(network), tt('settings.lishNetwork.networkUpdated', { name: network.name }));
}

export async function deleteNetwork(networkID: string): Promise<boolean> {
	return reportMutation(await api.lishnets.deleteDetailed(networkID), null);
}

export async function networkExists(networkID: string): Promise<boolean> {
	return api.lishnets.exists(networkID);
}

export async function addNetworkIfNotExists(network: LISHNetworkDefinition): Promise<boolean> {
	return reportMutation(await api.lishnets.addIfNotExistsDetailed(network), tt('settings.lishNetwork.networkAdded', { name: network.name }));
}

/** Save the whole list (order, enabled flags); warns when the running node has not caught up. */
export async function replaceNetworks(networks: LISHNetworkConfig[]): Promise<boolean> {
	return reportMutation(await api.lishnets.replaceDetailed(networks), null);
}

/** Switch a network on or off; warns when the change was saved but the node has not applied it. */
export async function setNetworkEnabled(networkID: string, enabled: boolean): Promise<boolean> {
	const result = await api.lishnets.setEnabled(networkID, enabled);
	if (result.stored === false) return false;
	if (!result.applied) addNotification(tt('settings.lishNetwork.savedNotApplied'), 'warning');
	return true;
}

/**
 * Save a network's bootstrap list and hand back the stored config — also when the node has not
 * applied it yet, which is then said in a warning.
 */
export async function updateNetworkBootstrapPeers(networkID: string, bootstrapPeers: string[]): Promise<LISHNetworkConfig | null> {
	const response = await api.lishnets.updateBootstrapPeersDetailed(networkID, bootstrapPeers);
	return reportMutation(response, null) ? response.value : null;
}

/**
 * Tell the user what a network write did and return whether it was saved. Saved but not applied
 * is a warning, not a success; an older server's plain answer says only that it was saved.
 */
function reportMutation<T>(response: NetworkMutationResponse<T>, success: string | null): boolean {
	if ('legacy' in response) {
		if (!response.value) return false;
		addNotification(tt('settings.lishNetwork.savedUnconfirmed'), 'warning');
		return true;
	}
	if (!response.stored) return false;
	if (!response.applied) addNotification(tt('settings.lishNetwork.savedNotApplied'), 'warning');
	else if (success) addNotification(success, 'success');
	return true;
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
		return { networks: [], error: translateError(e) };
	}
}
