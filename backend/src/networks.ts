import { type ILISHNetwork } from './makenet.ts';
import { Network } from './network.ts';
import { type DataServer } from './data-server.ts';
import { type NetworkDefinition, type LISHNetworkConfig } from '@libershare/shared';
import { LISHNetworkStorage } from './lishNetworkStorage.ts';

export { type NetworkDefinition };

/**
 * Convert LISHNetworkConfig to NetworkDefinition (used by Network/libp2p).
 */
function toNetworkDef(config: LISHNetworkConfig): NetworkDefinition {
	return {
		id: config.networkID,
		version: config.version,
		key: config.key,
		name: config.name,
		description: config.description || null,
		bootstrap_peers: config.bootstrapPeers,
		enabled: config.enabled,
	};
}

export class Networks {
	private storage: LISHNetworkStorage;
	private dataDir: string;
	private dataServer: DataServer;
	private enablePink: boolean;
	private liveNetworks: Map<string, Network> = new Map();

	constructor(storage: LISHNetworkStorage, dataDir: string, dataServer: DataServer, enablePink: boolean = false) {
		this.storage = storage;
		this.dataDir = dataDir;
		this.dataServer = dataServer;
		this.enablePink = enablePink;
	}

	init(): void {
		console.log('✓ Networks initialized (using lishnets.json)');
	}

	async startEnabledNetworks(): Promise<void> {
		const enabled = this.getEnabled();
		for (const def of enabled) {
			await this.startNetwork(def.id);
		}
	}

	async startNetwork(id: string): Promise<Network | null> {
		if (this.liveNetworks.has(id)) {
			console.log(`Network ${id} is already running`);
			return this.liveNetworks.get(id)!;
		}
		const def = this.get(id);
		if (!def) {
			console.log(`Network ${id} not found`);
			return null;
		}
		const network = new Network(this.dataDir, this.dataServer, this.enablePink, def);
		try {
			await network.start();
		} catch (error: any) {
			console.log(`⚠️  Failed to start network "${def.name}" (${id}): ${error.message}`);
			return null;
		}
		this.liveNetworks.set(id, network);
		console.log(`✓ Started network: ${def.name} (${id})`);
		return network;
	}

	async stopNetwork(id: string): Promise<void> {
		const network = this.liveNetworks.get(id);
		if (network) {
			await network.stop();
			this.liveNetworks.delete(id);
			console.log(`✓ Stopped network: ${id}`);
		}
	}

	async stopAllNetworks(): Promise<void> {
		for (const [id, network] of this.liveNetworks) {
			await network.stop();
			console.log(`✓ Stopped network: ${id}`);
		}
		this.liveNetworks.clear();
	}

	getLiveNetwork(id: string): Network | undefined {
		return this.liveNetworks.get(id);
	}

	getLiveNetworks(): Map<string, Network> {
		return this.liveNetworks;
	}

	importFromLishnet(data: ILISHNetwork, enabled: boolean = false): NetworkDefinition {
		const config: LISHNetworkConfig = {
			version: data.version,
			networkID: data.networkID,
			key: data.swarmKey,
			name: data.name,
			description: data.description || '',
			bootstrapPeers: data.bootstrapPeers,
			enabled,
			created: data.created || new Date().toISOString(),
		};
		// Upsert: update if exists, add if not
		if (this.storage.exists(config.networkID)) this.storage.update(config);
		else this.storage.add(config);
		return toNetworkDef(config);
	}

	async importFromJson(jsonString: string, enabled: boolean = false): Promise<NetworkDefinition> {
		const data: ILISHNetwork = JSON.parse(jsonString);
		const def = this.importFromLishnet(data, enabled);
		if (enabled) await this.startNetwork(def.id);
		return def;
	}

	async importFromFile(filePath: string, enabled: boolean = false): Promise<NetworkDefinition> {
		const file = Bun.file(filePath);
		const content = await file.text();
		return this.importFromJson(content, enabled);
	}

	async setEnabled(id: string, enabled: boolean): Promise<boolean> {
		const config = this.storage.get(id);
		if (!config) return false;
		config.enabled = enabled;
		this.storage.update(config);
		if (enabled) await this.startNetwork(id);
		else await this.stopNetwork(id);
		return true;
	}

	get(id: string): NetworkDefinition | null {
		const config = this.storage.get(id);
		if (!config) return null;
		return toNetworkDef(config);
	}

	getAll(): NetworkDefinition[] {
		return this.storage.getAll().map(toNetworkDef);
	}

	getEnabled(): NetworkDefinition[] {
		return this.storage
			.getAll()
			.filter(c => c.enabled)
			.map(toNetworkDef);
	}

	async delete(id: string): Promise<boolean> {
		await this.setEnabled(id, false);
		return this.storage.delete(id);
	}

	exists(id: string): boolean {
		return this.storage.exists(id);
	}
}
