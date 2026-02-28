import { ArrayStorage } from '../storage.ts';
import { type LISHNetworkConfig, type LISHNetworkDefinition } from '@shared';

/**
 * Storage for user-configured LISH networks.
 * These are networks that the user has added/imported (separate from running network instances).
 */
export class LISHnetStorage {
	private storage!: ArrayStorage<LISHNetworkConfig>;

	private constructor() {}

	static async create(dataDir: string): Promise<LISHnetStorage> {
		const instance = new LISHnetStorage();
		instance.storage = await ArrayStorage.create(dataDir, 'lishnets.json', 'networkID');
		return instance;
	}

	list(): LISHNetworkConfig[] {
		return this.storage.list();
	}

	get(networkID: string): LISHNetworkConfig | undefined {
		return this.storage.get(networkID);
	}

	exists(networkID: string): boolean {
		return this.storage.exists(networkID);
	}

	async add(network: LISHNetworkConfig): Promise<boolean> {
		// Generate networkID if empty (auto-generate mode)
		if (!network.networkID) network = { ...network, networkID: crypto.randomUUID() };
		return this.storage.add(network);
	}

	async update(network: LISHNetworkConfig): Promise<boolean> {
		return this.storage.update(network);
	}

	async delete(networkID: string): Promise<boolean> {
		return this.storage.delete(networkID);
	}

	/**
	 * Add network definition if it doesn't exist (enabled defaults to false)
	 */
	async addIfNotExists(network: LISHNetworkDefinition): Promise<boolean> {
		if (this.exists(network.networkID)) return false;
		return this.add({ ...network, enabled: false });
	}

	/**
	 * Import multiple network definitions, adding only those that don't exist (enabled defaults to false)
	 */
	async importNetworks(networks: LISHNetworkDefinition[]): Promise<number> {
		let imported = 0;
		for (const network of networks) {
			if (await this.addIfNotExists(network)) imported++;
		}
		return imported;
	}

	/**
	 * Replace all networks (for reordering)
	 */
	async setAll(networks: LISHNetworkConfig[]): Promise<void> {
		await this.storage.setAll(networks);
	}
}
