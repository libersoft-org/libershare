import { ArrayStorage } from './storage.ts';
export interface LISHNetworkConfig {
	version: number;
	networkID: string;
	name: string;
	description: string;
	bootstrapPeers: string[];
	created: string;
}

/**
 * Storage for user-configured LISH networks.
 * These are networks that the user has added/imported (separate from running network instances).
 */
export class LISHNetworkStorage {
	private storage: ArrayStorage<LISHNetworkConfig>;

	constructor(dataDir: string) {
		this.storage = new ArrayStorage(dataDir, 'lishnets.json', 'networkID');
	}

	getAll(): LISHNetworkConfig[] {
		return this.storage.getAll();
	}

	get(networkID: string): LISHNetworkConfig | undefined {
		return this.storage.get(networkID);
	}

	exists(networkID: string): boolean {
		return this.storage.exists(networkID);
	}

	add(network: LISHNetworkConfig): boolean {
		// Generate networkID if empty (auto-generate mode)
		if (!network.networkID) network = { ...network, networkID: crypto.randomUUID() };
		return this.storage.add(network);
	}

	update(network: LISHNetworkConfig): boolean {
		return this.storage.update(network);
	}

	delete(networkID: string): boolean {
		return this.storage.delete(networkID);
	}

	/**
	 * Add network if it doesn't exist
	 */
	addIfNotExists(network: Omit<LISHNetworkConfig, 'created'> & { created?: string }): boolean {
		if (this.exists(network.networkID)) return false;
		return this.add({
			...network,
			created: network.created ?? new Date().toISOString(),
		});
	}

	/**
	 * Import multiple networks, adding only those that don't exist
	 */
	importNetworks(networks: LISHNetworkConfig[]): number {
		let imported = 0;
		for (const network of networks) {
			if (this.addIfNotExists(network)) imported++;
		}
		return imported;
	}

	/**
	 * Get all network IDs
	 */
	getNetworkIds(): string[] {
		return this.getAll().map(n => n.networkID);
	}

	/**
	 * Replace all networks (for reordering)
	 */
	setAll(networks: LISHNetworkConfig[]): void {
		this.storage.setAll(networks);
	}
}
