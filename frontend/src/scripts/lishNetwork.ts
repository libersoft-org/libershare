import { api } from './api.ts';
import { type LISHNetworkConfig, type LISHNetworkDefinition } from '@shared';

// ============================================================================
// Storage Operations (async, using backend API)
// ============================================================================

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

// ============================================================================
// Network Data Conversion (for AddEdit form)
// ============================================================================

export interface NetworkFormData {
	id: string;
	name: string;
	description: string;
	bootstrapServers: string[];
}

/**
 * Convert LISHNetworkConfig to form data format.
 */
export function networkToFormData(network: LISHNetworkConfig): NetworkFormData {
	return {
		id: network.networkID,
		name: network.name,
		description: network.description,
		bootstrapServers: network.bootstrapPeers.length > 0 ? [...network.bootstrapPeers] : [''],
	};
}

/**
 * Convert form data to LISHNetworkConfig.
 */
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

/**
 * Save or update a network from form data.
 */
export async function saveNetworkFromForm(formData: NetworkFormData, existingNetworkID?: string): Promise<void> {
	const network = formDataToNetwork(formData);
	if (existingNetworkID) await updateNetwork(network);
	else {
		await addNetwork(network);
	}
}

// ============================================================================
// Public Network List Fetching
// ============================================================================

export interface FetchPublicNetworksResult {
	networks: LISHNetworkDefinition[];
	error: string | null;
}

export async function fetchPublicNetworks(url: string): Promise<FetchPublicNetworksResult> {
	try {
		const networks = await api.lishnets.parseFromUrl(url);
		return { networks, error: null };
	} catch (e) {
		return { networks: [], error: e instanceof Error ? e.message : String(e) };
	}
}

// ============================================================================
// Form Field Mapping (for SettingsLISHNetworkAddEdit)
// ============================================================================

export type NetworkFormFieldType = 'name' | 'description' | 'autoGenerate' | 'networkID' | 'bootstrap' | 'save' | 'back';

export interface NetworkFormFieldInfo {
	type: NetworkFormFieldType;
	bootstrapIndex?: number;
}

/**
 * Get the form field type for a given index in the network add/edit form.
 * @param index - The current selected index
 * @param isEditing - Whether we're editing an existing network (no autoGenerate switch)
 * @param bootstrapServersCount - Number of bootstrap server inputs
 */
export function getNetworkFormFieldType(index: number, isEditing: boolean, bootstrapServersCount: number): NetworkFormFieldInfo {
	if (index === 0) return { type: 'name' };
	if (index === 1) return { type: 'description' };
	if (isEditing) {
		// When editing: no switch row, networkID at 2, bootstrap from 3
		if (index === 2) return { type: 'networkID' };
		if (index < 3 + bootstrapServersCount) return { type: 'bootstrap', bootstrapIndex: index - 3 };
		if (index === 3 + bootstrapServersCount) return { type: 'save' };
		return { type: 'back' };
	} else {
		// When adding: switch at 2, networkID at 3, bootstrap from 4
		if (index === 2) return { type: 'autoGenerate' };
		if (index === 3) return { type: 'networkID' };
		if (index < 4 + bootstrapServersCount) return { type: 'bootstrap', bootstrapIndex: index - 4 };
		if (index === 4 + bootstrapServersCount) return { type: 'save' };
		return { type: 'back' };
	}
}

/**
 * Get max column index for a bootstrap server row.
 * @param bootstrapIndex - Index of the bootstrap server
 * @param bootstrapServersCount - Total number of bootstrap servers
 */
export function getNetworkFormMaxColumn(bootstrapIndex: number, bootstrapServersCount: number): number {
	const isLast = bootstrapIndex === bootstrapServersCount - 1;
	const hasRemove = bootstrapServersCount > 1;
	if (isLast && hasRemove) return 2; // input, remove, add
	if (isLast || hasRemove) return 1; // input + one button
	return 0; // only input
}
