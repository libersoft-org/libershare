import { api } from './api.ts';
import { type LISHNetworkConfig, type LISHNetworkDefinition } from '@libershare/shared';

export const DEFAULT_PUBLIC_LIST_URL = 'https://libershare.com/networks';

// ============================================================================
// Storage Operations (async, using backend API)
// ============================================================================

export async function getNetworks(): Promise<LISHNetworkConfig[]> {
	return api.lishNetworks.getAll();
}

export async function getNetworkById(networkID: string): Promise<LISHNetworkConfig | undefined> {
	return api.lishNetworks.get(networkID);
}

export async function addNetwork(network: LISHNetworkConfig): Promise<boolean> {
	return api.lishNetworks.add(network);
}

export async function updateNetwork(network: LISHNetworkConfig): Promise<boolean> {
	return api.lishNetworks.update(network);
}

export async function deleteNetwork(networkID: string): Promise<boolean> {
	return api.lishNetworks.delete(networkID);
}

export async function networkExists(networkID: string): Promise<boolean> {
	return api.lishNetworks.exists(networkID);
}

export async function addNetworkIfNotExists(network: LISHNetworkDefinition): Promise<boolean> {
	return api.lishNetworks.addIfNotExists(network);
}

export async function getExistingNetworkIds(): Promise<Set<string>> {
	const networks = await getNetworks();
	return new Set(networks.map(n => n.networkID));
}

// ============================================================================
// Validation & Parsing
// ============================================================================

/**
 * Validate and normalize a raw object into a LISHNetworkDefinition.
 * Returns null if validation fails.
 * Only picks whitelisted fields: version, networkID, key, name, description, bootstrapPeers, created.
 * The 'enabled' field is never imported — it's a storage-only concern.
 */
export function validateNetwork(obj: unknown): LISHNetworkDefinition | null {
	if (!obj || typeof obj !== 'object') return null;
	const parsed = obj as Record<string, unknown>;
	// Validate required fields:
	// - networkID: required, non-empty string
	// - name: required, non-empty string
	// - bootstrapPeers: optional, can be empty
	if (typeof parsed.networkID !== 'string' || !parsed.networkID.trim() || typeof parsed.name !== 'string' || !parsed.name.trim()) return null;
	const bootstrapPeers = Array.isArray(parsed.bootstrapPeers) ? (parsed.bootstrapPeers as string[]).filter(p => typeof p === 'string' && p.trim()) : [];
	// Only pick specific fields — 'enabled' is never part of a network definition
	return {
		version: (parsed.version as number) ?? 1,
		networkID: parsed.networkID.trim(),
		name: parsed.name.trim(),
		description: typeof parsed.description === 'string' ? parsed.description : '',
		bootstrapPeers,
		created: (parsed.created as string) ?? new Date().toISOString(),
	};
}

/**
 * Parse JSON string and extract valid networks.
 * Handles both single network and array of networks.
 */
export interface ParseNetworksResult {
	networks: LISHNetworkDefinition[];
	error: 'INVALID_JSON' | 'INVALID_FORMAT' | 'NO_VALID_NETWORKS' | null;
}

export function parseNetworksFromJson(json: string): ParseNetworksResult {
	if (!json.trim()) {
		return { networks: [], error: 'INVALID_FORMAT' };
	}
	try {
		const parsed = JSON.parse(json);
		const networksToImport: LISHNetworkDefinition[] = [];
		// Check if it's an array of networks or a single network
		if (Array.isArray(parsed)) {
			for (const item of parsed) {
				const network = validateNetwork(item);
				if (network) networksToImport.push(network);
			}
		} else {
			const network = validateNetwork(parsed);
			if (network) networksToImport.push(network);
		}
		if (networksToImport.length === 0) {
			return { networks: [], error: 'NO_VALID_NETWORKS' };
		}
		return { networks: networksToImport, error: null };
	} catch {
		return { networks: [], error: 'INVALID_JSON' };
	}
}

/**
 * Import networks from JSON string, adding only those that don't exist.
 * Returns count of successfully imported networks.
 */
export async function importNetworksFromJson(json: string): Promise<{ imported: number; error: ParseNetworksResult['error'] }> {
	const result = parseNetworksFromJson(json);
	if (result.error) {
		return { imported: 0, error: result.error };
	}
	const imported = await api.lishNetworks.import(result.networks);
	return { imported, error: null };
}

/**
 * Export a single network to JSON string (as LISHNetworkDefinition, without 'enabled').
 */
export async function exportNetworkToJson(networkID: string): Promise<string> {
	const network = await getNetworkById(networkID);
	if (!network) return '';
	const { enabled, ...definition } = network;
	return JSON.stringify(definition, null, '\t');
}

/**
 * Export all networks to JSON string (as LISHNetworkDefinition[], without 'enabled').
 */
export async function exportAllNetworksToJson(): Promise<string> {
	const networks = await getNetworks();
	const exportData = networks.map(({ enabled, ...definition }) => definition);
	return JSON.stringify(exportData, null, '\t');
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
		version: 1,
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
export async function saveNetworkFromForm(formData: NetworkFormData, existingNetworkId?: string): Promise<void> {
	const network = formDataToNetwork(formData);
	if (existingNetworkId) await updateNetwork(network);
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
		// Use backend API to bypass CORS restrictions
		const response = await api.fetchUrl(url);
		if (response.status !== 200) return { networks: [], error: `HTTP ${response.status}` };
		const data = JSON.parse(response.content);
		// Validate the data - should be an array of networks
		if (!Array.isArray(data)) return { networks: [], error: 'INVALID_FORMAT' };
		// Validate each network has required fields
		const validNetworks: LISHNetworkDefinition[] = [];
		for (const item of data) {
			const network = validateNetwork(item);
			if (network) validNetworks.push(network);
		}
		if (validNetworks.length === 0) return { networks: [], error: 'NO_VALID_NETWORKS' };
		return { networks: validNetworks, error: null };
	} catch (e) {
		return { networks: [], error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Get localized error message for network errors.
 */
export function getNetworkErrorMessage(errorCode: string, t: (key: string) => string): string {
	switch (errorCode) {
		case 'INVALID_FORMAT':
		case 'INVALID_JSON':
			return t('settings.lishNetwork.errorInvalidFormat');
		case 'NO_VALID_NETWORKS':
			return t('settings.lishNetwork.errorNoValidNetworks');
		default:
			return errorCode;
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
