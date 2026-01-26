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

// ============================================================================
// Storage Operations
// ============================================================================

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

// ============================================================================
// Validation & Parsing
// ============================================================================

/**
 * Validate and normalize a raw object into a LISHNetwork.
 * Returns null if validation fails.
 */
export function validateNetwork(obj: unknown): LISHNetwork | null {
	if (!obj || typeof obj !== 'object') return null;
	const parsed = obj as Record<string, unknown>;
	// Validate required fields:
	// - networkID: required, non-empty string
	// - name: required, non-empty string
	// - bootstrapPeers: optional, can be empty
	if (typeof parsed.networkID !== 'string' || !parsed.networkID.trim() || typeof parsed.name !== 'string' || !parsed.name.trim()) return null;
	const bootstrapPeers = Array.isArray(parsed.bootstrapPeers) ? (parsed.bootstrapPeers as string[]).filter(p => typeof p === 'string' && p.trim()) : [];
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
	networks: LISHNetwork[];
	error: 'INVALID_JSON' | 'INVALID_FORMAT' | 'NO_VALID_NETWORKS' | null;
}

export function parseNetworksFromJson(json: string): ParseNetworksResult {
	if (!json.trim()) {
		return { networks: [], error: 'INVALID_FORMAT' };
	}
	try {
		const parsed = JSON.parse(json);
		const networksToImport: LISHNetwork[] = [];
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
export function importNetworksFromJson(json: string): { imported: number; error: ParseNetworksResult['error'] } {
	const result = parseNetworksFromJson(json);
	if (result.error) {
		return { imported: 0, error: result.error };
	}
	let imported = 0;
	for (const network of result.networks) {
		if (addNetworkIfNotExists(network)) imported++;
	}
	return { imported, error: null };
}

/**
 * Export a single network to JSON string.
 */
export function exportNetworkToJson(networkID: string): string {
	const network = getNetworkById(networkID);
	return network ? JSON.stringify(network, null, '\t') : '';
}

/**
 * Export all networks to JSON string.
 */
export function exportAllNetworksToJson(): string {
	const networks = getNetworks();
	return JSON.stringify(networks, null, '\t');
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
 * Convert LISHNetwork to form data format.
 */
export function networkToFormData(network: LISHNetwork): NetworkFormData {
	return {
		id: network.networkID,
		name: network.name,
		description: network.description,
		bootstrapServers: network.bootstrapPeers.length > 0 ? [...network.bootstrapPeers] : [''],
	};
}

/**
 * Convert form data to LISHNetwork.
 */
export function formDataToNetwork(formData: NetworkFormData, existingNetwork?: LISHNetwork): LISHNetwork {
	return {
		version: 1,
		networkID: formData.id,
		name: formData.name,
		description: formData.description,
		bootstrapPeers: formData.bootstrapServers.filter(s => s.trim() !== ''),
		created: existingNetwork?.created || new Date().toISOString(),
	};
}

/**
 * Save or update a network from form data.
 */
export function saveNetworkFromForm(formData: NetworkFormData, existingNetworkId?: string): void {
	const network = formDataToNetwork(formData);
	if (existingNetworkId) {
		// Update existing - use original networkID for finding
		const networks = getNetworks();
		const index = networks.findIndex(n => n.networkID === existingNetworkId);
		if (index !== -1) {
			networks[index] = network;
			saveNetworks(networks);
		}
	} else {
		addNetwork(network);
	}
}

// ============================================================================
// Public Network List Fetching
// ============================================================================

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
export function getNetworkErrorMessage(errorCode: string, t: { settings?: { lishNetwork?: { errorInvalidFormat?: string; errorNoValidNetworks?: string; errorUrlRequired?: string } } }): string {
	switch (errorCode) {
		case 'INVALID_FORMAT':
		case 'INVALID_JSON':
			return t.settings?.lishNetwork?.errorInvalidFormat || 'Invalid format';
		case 'NO_VALID_NETWORKS':
			return t.settings?.lishNetwork?.errorNoValidNetworks || 'No valid networks found';
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
