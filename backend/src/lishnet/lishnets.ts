import { type Database } from 'bun:sqlite';
import { Network } from '../protocol/network.ts';
import { Utils } from '../utils.ts';
import { type DataServer } from '../lish/data-server.ts';
import { type Settings } from '../settings.ts';
import { type ILISHNetwork, type LISHNetworkConfig, type LISHNetworkDefinition, CodedError, ErrorCodes } from '@shared';
import { type CatalogManager } from '../catalog/catalog-manager.ts';
import { SYNC_PROTOCOL, buildSyncResponse, applySyncResponse, encodeSyncRequest, decodeSyncRequest, encodeSyncResponse, decodeSyncResponse, type SyncRequest } from '../catalog/catalog-sync.ts';
import { decode } from 'it-length-prefixed';
import { Uint8ArrayList } from 'uint8arraylist';
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

	// Catalog manager (set after construction via setCatalogManager)
	private catalogManager: CatalogManager | null = null;

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

	setCatalogManager(cm: CatalogManager): void {
		this.catalogManager = cm;
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
			// Join catalog if network has ownerPeerID (graceful — errors never block)
			if (this.catalogManager && net.ownerPeerID) {
				try {
					this.catalogManager.join(net.networkID, net.ownerPeerID);
					await this.registerCatalogHandler(net.networkID);
				} catch (err) { console.warn(`[Catalog] Failed to join catalog for ${net.networkID}:`, (err as Error).message); }
			}
		}
	}

	/**
	 * Enable/disable a lishnet. Starts the node if needed, subscribes/unsubscribes topics.
	 */
	async setEnabled(id: string, enabled: boolean): Promise<boolean> {
		if (!lishnetExists(this.db, id)) return false;

		setLISHnetEnabled(this.db, id, enabled);

		if (enabled) await this.joinNetwork(id);
		else await this.leaveNetwork(id);

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
		if (net && net.bootstrapPeers.length > 0) await this.network.addBootstrapPeers(net.bootstrapPeers);

		console.log(`✓ Joined lishnet: ${net?.name ?? id}`);

		// Join catalog if network has ownerPeerID (graceful — errors never block file sharing)
		if (this.catalogManager && net?.ownerPeerID) {
			try {
				this.catalogManager.join(id, net.ownerPeerID);
				await this.registerCatalogHandler(id);
			} catch (err) {
				console.warn(`[Catalog] Failed to join catalog for ${id}:`, (err as Error).message);
			}
		}
	}

	private catalogSyncRegistered = false;

	private async registerCatalogHandler(networkID: string): Promise<void> {
		// GossipSub handler for live catalog_op messages
		await this.network.subscribe(`lish/${networkID}`, async (msg: Record<string, any>) => {
			if (msg['type'] === 'catalog_op' && this.catalogManager) {
				if (msg['version'] !== undefined && msg['version'] !== 1) return;
				try {
					await this.catalogManager.applyRemoteOp(networkID, msg as any);
				} catch (err) {
					console.warn(`[Catalog] Error applying remote op for ${networkID}:`, (err as Error).message);
				}
			}
		});

		// Register bilateral sync protocol handler (once for all networks)
		if (!this.catalogSyncRegistered) {
			this.catalogSyncRegistered = true;
			await this.network.registerStreamHandler(SYNC_PROTOCOL, async (stream) => {
				try {
					const decoder = decode(stream);
					const msg = await decoder.next();
					if (msg.done || !msg.value) { await stream.close(); return; }
					const raw = msg.value instanceof Uint8ArrayList ? msg.value.subarray() : msg.value;
					const req = decodeSyncRequest(new Uint8Array(raw));
					console.log(`[CatalogSync] Received sync request for ${req.networkID} since ${req.sinceHlcWall}`);
					const response = buildSyncResponse(this.db, req.networkID, req.sinceHlcWall);
					console.log(`[CatalogSync] Sending ${response.operations.length} operations, ${response.entryCount} entries`);
					const encoded = encodeSyncResponse(response);
					const { encode: lpEncode } = await import('it-length-prefixed');
					for await (const chunk of lpEncode([encoded])) stream.send(chunk);
					await stream.close();
				} catch (err) {
					console.warn('[CatalogSync] Error handling sync request:', (err as Error).message);
					stream.abort(err instanceof Error ? err : new Error(String(err)));
				}
			});
			console.log(`✓ Registered ${SYNC_PROTOCOL} protocol handler`);
		}

		// Request sync from connected peers (catch up on missed history)
		this.requestCatalogSync(networkID);
	}

	private async requestCatalogSync(networkID: string): Promise<void> {
		if (!this.catalogManager) return;
		const syncStatus = this.catalogManager.getSyncStatus(networkID);
		const peers = this.network.getTopicPeers(networkID);
		if (peers.length === 0) {
			// No peers yet — retry after a delay
			setTimeout(() => this.requestCatalogSync(networkID), 5000);
			return;
		}
		for (const peerID of peers) {
			try {
				console.log(`[CatalogSync] Requesting sync from peer ${peerID.slice(0, 20)}...`);
				const stream = await this.network.dialProtocolByPeerId(peerID, SYNC_PROTOCOL);
				const req: SyncRequest = {
					command: 'catalog_sync_req',
					requestID: crypto.randomUUID(),
					networkID,
					sinceHlcWall: 0, // full sync
				};
				const { encode: lpEncode } = await import('it-length-prefixed');
				for await (const chunk of lpEncode([encodeSyncRequest(req)])) stream.send(chunk);
				// Read response
				const decoder = decode(stream);
				const msg = await decoder.next();
				if (!msg.done && msg.value) {
					const raw = msg.value instanceof Uint8ArrayList ? msg.value.subarray() : msg.value;
					const response = decodeSyncResponse(new Uint8Array(raw));
					const applied = await applySyncResponse(this.db, networkID, response);
					console.log(`[CatalogSync] Applied ${applied}/${response.operations.length} ops from peer (${response.entryCount} entries, ${response.tombstoneCount} tombstones)`);
					if (applied > 0) {
						this.catalogManager.emitSyncComplete(networkID, applied);
					}
				}
				await stream.close();
				break; // one successful sync is enough
			} catch (err) {
				console.warn(`[CatalogSync] Failed to sync from peer ${peerID.slice(0, 20)}:`, (err as Error).message);
			}
		}
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

		if (this.catalogManager) {
			this.catalogManager.leave(id);
		}
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
		if (!this.network.isRunning()) throw new CodedError(ErrorCodes.NETWORK_NOT_RUNNING);
		return this.network;
	}

	/**
	 * Check if a lishnet is currently joined.
	 */
	isJoined(id: string): boolean {
		return this.joinedNetworks.has(id);
	}

	getFirstJoinedNetworkID(): string | undefined {
		return this.joinedNetworks.values().next().value;
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
		for (const config of configs) allPeers.push(...config.bootstrapPeers);
		return [...new Set(allPeers)];
	}

	// Validate a raw network object into a LISHNetworkDefinition (without storing).
	validateNetwork(data: ILISHNetwork): LISHNetworkDefinition {
		if (!data.networkID || !data.name) throw new CodedError(ErrorCodes.NETWORK_INVALID);
		const def: LISHNetworkDefinition = {
			networkID: data.networkID,
			name: data.name,
			description: data.description || '',
			bootstrapPeers: Array.isArray(data.bootstrapPeers) ? data.bootstrapPeers.filter(p => typeof p === 'string' && p.trim()) : [],
			created: data.created || new Date().toISOString(),
		};
		if (data.ownerPeerID) {
			if (!data.ownerPeerID.startsWith('12D3KooW')) {
				console.warn(`[Networks] Invalid ownerPeerID format: ${data.ownerPeerID} (expected Ed25519 PeerID starting with 12D3KooW)`);
			} else {
				def.ownerPeerID = data.ownerPeerID;
			}
		}
		return def;
	}

	async importFromLISHnet(data: ILISHNetwork, enabled: boolean = false): Promise<LISHNetworkConfig> {
		const definition = this.validateNetwork(data);
		const config: LISHNetworkConfig = { ...definition, enabled };
		upsertLISHnet(this.db, config.networkID, config.name, config.description, config.bootstrapPeers, config.enabled, config.created);
		if (enabled) await this.joinNetwork(config.networkID);
		return config;
	}

	// Parse JSON string and return validated network definitions (without storing).
	parseFromJSON(jsonString: string): LISHNetworkDefinition[] {
		const data = Utils.safeJSONParse<unknown>(jsonString, 'network JSON import');
		const items = Array.isArray(data) ? data : [data];
		const results: LISHNetworkDefinition[] = [];
		for (const item of items) results.push(this.validateNetwork(item as ILISHNetwork));
		if (results.length === 0) throw new CodedError(ErrorCodes.NO_VALID_NETWORKS);
		return results;
	}

	// Read a file and return validated network definitions (without storing).
	async parseFromFile(filePath: string): Promise<LISHNetworkDefinition[]> {
		const content = await Utils.readFileCompressed(filePath);
		return this.parseFromJSON(content);
	}

	/**
	 * Fetch a URL and return validated network definitions (without storing).
	 */
	async parseFromURL(url: string): Promise<LISHNetworkDefinition[]> {
		const content = await Utils.fetchURL(url);
		return this.parseFromJSON(content);
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
		// Auto-assign ownerPeerID to local peer if creating new network without one
		if (!network.ownerPeerID && this.network.isRunning()) {
			try {
				const nodeInfo = this.network.getNodeInfo();
				if (nodeInfo?.peerID) {
					network = { ...network, ownerPeerID: nodeInfo.peerID };
				}
			} catch { /* network not started yet */ }
		}
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
