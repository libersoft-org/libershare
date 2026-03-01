import { type Database } from 'bun:sqlite';
import { Network } from '../protocol/network.ts';
import { Utils } from '../utils.ts';
import { type DataServer } from '../lish/data-server.ts';
import { type Settings } from '../settings.ts';
import { type ILISHNetwork, type LISHNetworkConfig, type LISHNetworkDefinition } from '@shared';
import { lishnetExists, getLISHnet, listLISHnets, listEnabledLISHnets, addLISHnet, updateLISHnet, deleteLISHnet, setLISHnetEnabled, addLISHnetIfNotExists, importLISHnets, upsertLISHnet, replaceLISHnets } from '../db/lishnets.ts';

/**
 * Manages lishnets (logical network groups) on top of a single shared Network (libp2p) node.
 * Each lishnet is represented as a pubsub topic on the shared node.
 */
export class Networks {
	private db: Database;
	private network: Network;

	// Track which lishnets are currently joined (subscribed)
	private joinedNetworks: Set<string> = new Set();

	// Callback for peer count changes
	private _onPeerCountChange: ((counts: { networkID: string; count: number }[]) => void) | null = null;

	constructor(db: Database, dataDir: string, dataServer: DataServer, settings: Settings, enablePink: boolean = false) {
		this.db = db;
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
		console.log('✓ Networks initialized');
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
		for (const net of enabled) {
			this.network.subscribeTopic(net.networkID);
			this.joinedNetworks.add(net.networkID);
			console.log(`✓ Joined lishnet: ${net.name} (${net.networkID})`);
		}
	}

	/**
	 * Enable/disable a lishnet. Starts the node if needed, subscribes/unsubscribes topics.
	 */
	async setEnabled(id: string, enabled: boolean): Promise<boolean> {
		if (!lishnetExists(this.db, id)) return false;

		setLISHnetEnabled(this.db, id, enabled);

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
			console.log(`LISH network ${id} is already joined`);
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

		const net = this.get(id);
		if (net && net.bootstrapPeers.length > 0) {
			await this.network.addBootstrapPeers(net.bootstrapPeers);
		}

		console.log(`✓ Joined lishnet: ${net?.name ?? id}`);
	}

	/**
	 * Leave a lishnet (unsubscribe from its topic).
	 */
	private async leaveNetwork(id: string): Promise<void> {
		if (!this.joinedNetworks.has(id)) return;

		this.network.unsubscribeTopic(id);
		this.joinedNetworks.delete(id);

		const net = this.get(id);
		console.log(`✓ Left lishnet: ${net?.name ?? id}`);
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
	 * Collect and deduplicate bootstrap peers from a set of network configs.
	 */
	private collectBootstrapPeers(configs: LISHNetworkConfig[]): string[] {
		const allPeers: string[] = [];
		for (const config of configs) {
			allPeers.push(...config.bootstrapPeers);
		}
		return [...new Set(allPeers)];
	}

	async importFromLISHnet(data: ILISHNetwork, enabled: boolean = false): Promise<LISHNetworkConfig> {
		const config: LISHNetworkConfig = {
			networkID: data.networkID,
			name: data.name,
			description: data.description || '',
			bootstrapPeers: data.bootstrapPeers,
			enabled,
			created: data.created || new Date().toISOString(),
		};
		upsertLISHnet(this.db, config.networkID, config.name, config.description, config.bootstrapPeers, config.enabled, config.created);
		return config;
	}

	async importFromJson(jsonString: string, enabled: boolean = false): Promise<LISHNetworkConfig> {
		const data: ILISHNetwork = Utils.safeJsonParse<ILISHNetwork>(jsonString, 'network JSON import');
		const config = await this.importFromLISHnet(data, enabled);
		if (enabled) await this.joinNetwork(config.networkID);
		return config;
	}

	async importFromFile(filePath: string, enabled: boolean = false): Promise<LISHNetworkConfig> {
		const file = Bun.file(filePath);
		const content = await file.text();
		return await this.importFromJson(content, enabled);
	}

	get(id: string): LISHNetworkConfig | undefined {
		return getLISHnet(this.db, id);
	}

	list(): LISHNetworkConfig[] {
		return listLISHnets(this.db);
	}

	getEnabled(): LISHNetworkConfig[] {
		return listEnabledLISHnets(this.db);
	}

	add(network: LISHNetworkConfig): boolean {
		return addLISHnet(this.db, network);
	}

	update(network: LISHNetworkConfig): boolean {
		return updateLISHnet(this.db, network);
	}

	async delete(id: string): Promise<boolean> {
		await this.setEnabled(id, false);
		return deleteLISHnet(this.db, id);
	}

	exists(id: string): boolean {
		return lishnetExists(this.db, id);
	}

	addIfNotExists(network: LISHNetworkDefinition): boolean {
		return addLISHnetIfNotExists(this.db, network);
	}

	importNetworks(networks: LISHNetworkDefinition[]): number {
		return importLISHnets(this.db, networks);
	}

	replace(networks: LISHNetworkConfig[]): void {
		replaceLISHnets(this.db, networks);
	}
}
