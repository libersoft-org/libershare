import { ArrayStorage } from '../storage.ts';
import { type LISHNetworkConfig, type LISHNetworkDefinition } from '@shared';

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
	 * Add network definition if it doesn't exist (enabled defaults to false)
	 */
	addIfNotExists(network: LISHNetworkDefinition): boolean {
		if (this.exists(network.networkID)) return false;
		return this.add({ ...network, enabled: false });
	}

	/**
	 * Import multiple network definitions, adding only those that don't exist (enabled defaults to false)
	 */
	importNetworks(networks: LISHNetworkDefinition[]): number {
		let imported = 0;
		for (const network of networks) {
			if (this.addIfNotExists(network)) imported++;
		}
		return imported;
	}

	/**
	 * Replace all networks (for reordering)
	 */
	setAll(networks: LISHNetworkConfig[]): void {
		this.storage.setAll(networks);
	}
}
