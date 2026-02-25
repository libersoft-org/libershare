import { Network } from '../protocol/network.ts';
import { Utils } from '../utils.ts';
import { type DataServer } from '../lish/data-server.ts';
import { type Settings } from '../settings.ts';
import { type ILISHNetwork, type NetworkDefinition, type LISHNetworkConfig } from '@shared';
import { LISHNetworkStorage } from './lishNetworkStorage.ts';

export { type NetworkDefinition };

/**
 * Convert LISHNetworkConfig to NetworkDefinition (used by API layer).
 */
function toNetworkDef(config: LISHNetworkConfig): NetworkDefinition {
	return {
		id: config.networkID,
		version: config.version,
		name: config.name,
		description: config.description || null,
		bootstrap_peers: config.bootstrapPeers,
		enabled: config.enabled,
	};
}

/**
 * Manages lishnets (logical network groups) on top of a single shared Network (libp2p) node.
 * Each lishnet is represented as a pubsub topic on the shared node.
 */
export class Networks {
	private storage: LISHNetworkStorage;
	private dataDir: string;
	private dataServer: DataServer;
	private enablePink: boolean;
	private network: Network;

	// Track which lishnets are currently joined (subscribed)
	private joinedNetworks: Set<string> = new Set();

	// Callback for peer count changes
	private _onPeerCountChange: ((counts: { networkID: string; count: number }[]) => void) | null = null;

	constructor(storage: LISHNetworkStorage, dataDir: string, dataServer: DataServer, settings: Settings, enablePink: boolean = false) {
		this.storage = storage;
		this.dataDir = dataDir;
		this.dataServer = dataServer;
		this.enablePink = enablePink;
		this.network = new Network(dataDir, dataServer, settings, enablePink);
		// Forward peer count changes from the network node
		this.network.onPeerCountChange = counts => {
			if (this._onPeerCountChange) this._onPeerCountChange(counts);
		};
	}

	/**
	 * Set a callback to be called when peer counts change for any joined lishnet.
	 */
	set onPeerCountChange(cb: ((counts: { networkID: string; count: number }[]) => void) | null) {
		this._onPeerCountChange = cb;
	}

	init(): void {
		console.log('✓ Networks initialized (using lishnets.json)');
	}

	/**
	 * Start the shared libp2p node and join all enabled lishnets.
	 * The node always starts, even if no lishnets are enabled.
	 */
	async startEnabledNetworks(): Promise<void> {
		const enabled = this.getEnabled();

		// Collect bootstrap peers from all enabled lishnets (may be empty)
		const bootstrapPeers = this.collectBootstrapPeers(enabled);

		// Always start the node
		await this.network.start(bootstrapPeers);

		// Subscribe to topics for all enabled lishnets
		for (const def of enabled) {
			this.network.subscribeTopic(def.id);
			this.joinedNetworks.add(def.id);
			console.log(`✓ Joined lishnet: ${def.name} (${def.id})`);
		}
	}

	/**
	 * Enable/disable a lishnet. Starts the node if needed, subscribes/unsubscribes topics.
	 */
	async setEnabled(id: string, enabled: boolean): Promise<boolean> {
		const config = this.storage.get(id);
		if (!config) return false;

		config.enabled = enabled;
		await this.storage.update(config);

		if (enabled) {
			await this.joinNetwork(id);
		} else {
			await this.leaveNetwork(id);
		}

		return true;
	}

	/**
	 * Join a lishnet (subscribe to its topic, add bootstrap peers).
	 */
	private async joinNetwork(id: string): Promise<void> {
		if (this.joinedNetworks.has(id)) {
			console.log(`Lishnet ${id} is already joined`);
			return;
		}

		// Subscribe to the topic first (register interest), then dial bootstrap peers.
		// Note: the StreamStateError crash from gossipsub is caused by an internal
		// race condition when peers connect and disconnect rapidly (flapping).
		// Gossipsub reacts to peer:connect events and tries to send subscriptions
		// on a stream that may already be closing. This cannot be fixed by call
		// ordering — the process-level error handlers in app.ts are the safety net.
		this.network.subscribeTopic(id);
		this.joinedNetworks.add(id);

		const def = this.get(id);
		if (def && def.bootstrap_peers.length > 0) {
			await this.network.addBootstrapPeers(def.bootstrap_peers);
		}

		console.log(`✓ Joined lishnet: ${def?.name ?? id}`);
	}

	/**
	 * Leave a lishnet (unsubscribe from its topic).
	 */
	private async leaveNetwork(id: string): Promise<void> {
		if (!this.joinedNetworks.has(id)) return;

		this.network.unsubscribeTopic(id);
		this.joinedNetworks.delete(id);

		const def = this.get(id);
		console.log(`✓ Left lishnet: ${def?.name ?? id}`);
	}

	/**
	 * Stop all networks and the shared node.
	 */
	async stopAllNetworks(): Promise<void> {
		this.joinedNetworks.clear();
		await this.network.stop();
		console.log('✓ All lishnets left and node stopped');
	}

	/**
	 * Get the shared Network instance (for API, downloads, etc.)
	 */
	getNetwork(): Network {
		return this.network;
	}

	/**
	 * Get the shared Network instance, throwing if it's not running.
	 * Use this in API handlers that require an active network.
	 */
	getRunningNetwork(): Network {
		if (!this.network.isRunning()) throw new Error('Network not running');
		return this.network;
	}

	/**
	 * Check if a lishnet is currently joined.
	 */
	isJoined(id: string): boolean {
		return this.joinedNetworks.has(id);
	}

	/**
	 * Get peers for a specific lishnet (topic subscribers).
	 */
	getTopicPeers(id: string): string[] {
		return this.network.getTopicPeers(id);
	}

	/**
	 * Get peers with connection type info for a specific lishnet.
	 */
	getTopicPeersInfo(id: string): { peerID: string; direct: number; relay: number }[] {
		return this.network.getTopicPeersInfo(id);
	}

	/**
	 * Collect and deduplicate bootstrap peers from a set of network definitions.
	 */
	private collectBootstrapPeers(defs: NetworkDefinition[]): string[] {
		const allPeers: string[] = [];
		for (const def of defs) {
			allPeers.push(...def.bootstrap_peers);
		}
		return [...new Set(allPeers)];
	}

	async importFromLishnet(data: ILISHNetwork, enabled: boolean = false): Promise<NetworkDefinition> {
		const config: LISHNetworkConfig = {
			version: data.version,
			networkID: data.networkID,
			name: data.name,
			description: data.description || '',
			bootstrapPeers: data.bootstrapPeers,
			enabled,
			created: data.created || new Date().toISOString(),
		};
		// Upsert: update if exists, add if not
		if (this.storage.exists(config.networkID)) await this.storage.update(config);
		else await this.storage.add(config);
		return toNetworkDef(config);
	}

	async importFromJson(jsonString: string, enabled: boolean = false): Promise<NetworkDefinition> {
		const data: ILISHNetwork = Utils.safeJsonParse<ILISHNetwork>(jsonString, 'network JSON import');
		const def = await this.importFromLishnet(data, enabled);
		if (enabled) await this.joinNetwork(def.id);
		return def;
	}

	async importFromFile(filePath: string, enabled: boolean = false): Promise<NetworkDefinition> {
		const file = Bun.file(filePath);
		const content = await file.text();
		return await this.importFromJson(content, enabled);
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
