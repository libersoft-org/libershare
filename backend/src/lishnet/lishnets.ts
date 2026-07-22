import { type Database } from 'bun:sqlite';
import { Network } from '../protocol/network.ts';
import { Utils } from '../utils.ts';
import { type DataServer } from '../lish/data-server.ts';
import { type Settings } from '../settings.ts';
import { type ILISHNetwork, type LISHNetworkConfig, type LISHNetworkDefinition, type PeerConnectionInfo, type IMeshHealth, type BootstrapStatus, CodedError, ErrorCodes } from '@shared';
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
	// Callback for bootstrap status changes
	private _onBootstrapStatusChange: ((networkID: string, status: BootstrapStatus) => void) | null = null;
	// Callback fired after a lishnet is left (topic unsubscribed). Lets higher
	// layers (e.g. transfer) stop downloads bound exclusively to that lishnet.
	private _onNetworkLeft: ((networkID: string) => void) | null = null;
	// Callback fired after a lishnet is (re-)joined in-process. Lets higher layers
	// resume downloads that were suspended when this lishnet was previously left.
	private _onNetworkJoined: ((networkID: string) => void) | null = null;

	constructor(db: Database, dataDir: string, dataServer: DataServer, settings: Settings) {
		this.db = db;
		this.network = new Network(dataDir, dataServer, settings);
		// Forward peer count changes from the network node
		this.network.onPeerCountChange = counts => {
			if (this._onPeerCountChange) this._onPeerCountChange(counts);
		};
		// Forward bootstrap status changes from the network node
		this.network.onBootstrapStatusChange = (networkID, status) => {
			if (this._onBootstrapStatusChange) this._onBootstrapStatusChange(networkID, status);
		};
	}

	/**
	 * Set a callback to be called when peer counts change for any joined lishnet.
	 */
	set onPeerCountChange(cb: ((counts: { networkID: string; count: number }[]) => void) | null) {
		this._onPeerCountChange = cb;
	}

	/**
	 * Set a callback to be called whenever the per-peer bootstrap status for
	 * any joined lishnet changes (dial pending → connected/error/mismatch/timeout).
	 */
	set onBootstrapStatusChange(cb: ((networkID: string, status: BootstrapStatus) => void) | null) {
		this._onBootstrapStatusChange = cb;
	}

	/**
	 * Set a callback fired right after a lishnet is left (its topic has been
	 * unsubscribed and removed from {@link joinedNetworks}). The callback runs
	 * synchronously from {@link leaveNetwork}; consumers should not assume any
	 * particular peer/connection state beyond "this lishnet is no longer joined".
	 */
	set onNetworkLeft(cb: ((networkID: string) => void) | null) {
		this._onNetworkLeft = cb;
	}

	/**
	 * Set a callback fired right after a lishnet is (re-)joined via {@link joinNetwork}
	 * (its topic subscribed and added to {@link joinedNetworks}). Lets higher layers
	 * (e.g. transfer) resume downloads that were suspended when the lishnet was
	 * previously left. NOT fired for the initial startup join — startup has its own
	 * auto-resume path.
	 */
	set onNetworkJoined(cb: ((networkID: string) => void) | null) {
		this._onNetworkJoined = cb;
	}

	init(): void {
		console.log('✓ Networks initialized');
	}

	/**
	 * Get the underlying libp2p node (for low-level event listening / stats).
	 */
	getLibp2pNode(): any {
		return this.network.getNode();
	}

	/**
	 * Start the shared libp2p node and join all enabled lishnets.
	 * The node always starts, even if no lishnets are enabled.
	 */
	async startEnabledNetworks(): Promise<void> {
		const enabled = this.getEnabled();

		// Start the node with no preset bootstrap list — bootstrap dials happen
		// per-network below via addBootstrapPeers so per-network status tracking
		// can record which specific peers connected / mismatched / timed out.
		// (Previous behaviour used a flat preset list that bypassed our tracking.)
		await this.network.start([]);

		// Subscribe to topics for all enabled lishnets and dial their bootstrap peers
		// with networkID context so bootstrap status counters get populated.
		for (const net of enabled) {
			this.network.subscribeTopic(net.networkID);
			this.joinedNetworks.add(net.networkID);
			if (net.bootstrapPeers.length > 0) {
				// Fire-and-forget so a slow / unreachable network does not delay startup of the others.
				this.network.addBootstrapPeers(net.bootstrapPeers, net.networkID, 'configured').catch(err => {
					console.error(`[Networks] addBootstrapPeers for ${net.networkID} failed:`, err?.message ?? err);
				});
			}
			console.log(`✓ Joined lishnet: ${net.name} (${net.networkID})`);
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
		if (net && net.bootstrapPeers.length > 0) await this.network.addBootstrapPeers(net.bootstrapPeers, id, 'configured');

		console.log(`✓ Joined lishnet: ${net?.name ?? id}`);

		// Notify higher layers (e.g. transfer) so downloads suspended when this
		// lishnet was last left can resume now that it is joined again.
		this._onNetworkJoined?.(id);
	}

	/**
	 * Leave a lishnet (unsubscribe from its topic).
	 */
	/** Peer IDs (the /p2p/<id> component) of a list of bootstrap multiaddr strings. */
	private static bootstrapPeerIDsOf(bootstrapPeers: string[]): string[] {
		const ids: string[] = [];
		for (const addr of bootstrapPeers) {
			// Relayed multiaddrs (.../p2p/<relay>/p2p-circuit/p2p/<target>) carry two
			// /p2p components; the bootstrap peer identity is the FINAL one (the target),
			// not the relay. Match all and take the last.
			const matches = [...addr.matchAll(/\/p2p\/([^/]+)/g)];
			const last = matches[matches.length - 1];
			if (last) ids.push(last[1]!);
		}
		return ids;
	}

	/** Configured-bootstrap peer IDs of a single network. */
	private configuredBootstrapPeerIDsOf(networkID: string): Set<string> {
		return new Set(Networks.bootstrapPeerIDsOf(this.get(networkID)?.bootstrapPeers ?? []));
	}

	/** Configured-bootstrap peer IDs of every joined network except `exceptID`. */
	private configuredBootstrapPeerIDsElsewhere(exceptID: string): Set<string> {
		const out = new Set<string>();
		for (const nid of this.joinedNetworks) {
			if (nid === exceptID) continue;
			for (const pid of Networks.bootstrapPeerIDsOf(this.get(nid)?.bootstrapPeers ?? [])) out.add(pid);
		}
		return out;
	}

	private async leaveNetwork(id: string): Promise<void> {
		if (!this.joinedNetworks.has(id)) return;

		// Snapshot the topic subscribers BEFORE unsubscribing — unsubscribeTopic
		// tears the topic out of pubsub, after which getTopicPeers(id) returns [].
		const leftPeers = this.network.getTopicPeers(id);

		this.network.unsubscribeTopic(id);
		this.joinedNetworks.delete(id);

		// Drop the exemption AND actively disconnect every configured bootstrap peer
		// exclusive to the left lishnet — including ones offline at leave time. Such
		// a peer never appears in leftPeers (the topic-subscriber snapshot), so the
		// content-peer loop below would miss it: its keep-alive tag would survive and
		// redial maintenance / ReconnectQueue would reconnect it within ~30s. After
		// pruning, isBootstrapOrRelayPeer is true only for an active circuit relay we
		// still depend on — keep those. disconnectPeer is a safe no-op hangUp for an
		// unconnected peer and always strips keep-alive + suppresses redial.
		const stillConfigured = this.configuredBootstrapPeerIDsElsewhere(id);
		for (const pid of this.configuredBootstrapPeerIDsOf(id)) {
			if (stillConfigured.has(pid)) continue;
			this.network.pruneConfiguredBootstrapPeer(pid);
			if (this.network.isBootstrapOrRelayPeer(pid)) continue;
			await this.network.disconnectPeer(pid);
		}

		// Disconnect peers that belonged exclusively to the lishnet we just left.
		// A peer is kept connected if it is still a subscriber of any OTHER joined
		// lishnet, or if it is a bootstrap/relay peer (shared infrastructure other
		// networks depend on). Everything else is a plain content peer with no
		// remaining reason to stay connected, so hang it up via the single
		// Network.disconnectPeer entry point (which also clears the keep-alive tag
		// so ReconnectQueue does not immediately re-dial it).
		const stillJoinedPeers = new Set<string>();
		for (const otherID of this.joinedNetworks) {
			for (const pid of this.network.getTopicPeers(otherID)) stillJoinedPeers.add(pid);
		}
		for (const pid of leftPeers) {
			if (stillJoinedPeers.has(pid)) continue;
			if (this.network.isBootstrapOrRelayPeer(pid)) continue;
			await this.network.disconnectPeer(pid);
		}

		const net = this.get(id);
		console.log(`✓ Left lishnet: ${net?.name ?? id}`);

		// Notify higher layers (e.g. transfer) so downloads bound exclusively to
		// this lishnet can be stopped.
		this._onNetworkLeft?.(id);
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
	getTopicPeersInfo(id: string): PeerConnectionInfo[] {
		return this.network.getTopicPeersInfo(id);
	}

	/**
	 * Pass-through to {@link Network.getMeshHealth} so the API surface can read
	 * the per-network gossipsub-mesh health snapshot (mesh size, time since
	 * the last graft/prune, median peer score).
	 */
	getMeshHealth(id: string): IMeshHealth {
		return this.network.getMeshHealth(id);
	}

	// Validate a raw network object into a LISHNetworkDefinition (without storing).
	validateNetwork(data: ILISHNetwork): LISHNetworkDefinition {
		if (!data.networkID || !data.name) throw new CodedError(ErrorCodes.NETWORK_INVALID);
		return {
			networkID: data.networkID,
			name: data.name,
			description: data.description || '',
			bootstrapPeers: Array.isArray(data.bootstrapPeers) ? data.bootstrapPeers.filter(p => typeof p === 'string' && p.trim()) : [],
			created: data.created || new Date().toISOString(),
		};
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

	/**
	 * Return per-peer bootstrap status for one network (or null if no dial
	 * attempts have been recorded since the node started or the entries were
	 * last updated).
	 */
	getBootstrapStatus(id: string): BootstrapStatus | null {
		return this.network.getBootstrapStatus(id);
	}

	/** Return per-peer bootstrap status for every network that has any tracked dials. */
	getAllBootstrapStatuses(): BootstrapStatus[] {
		return this.network.getAllBootstrapStatuses();
	}

	/**
	 * Replace the bootstrap peer list for an existing network. Resets the
	 * per-peer status entries that are no longer present in the new list, then
	 * (if the network is joined) re-dials the new entries so fresh status is
	 * recorded. Returns the updated config or null if the network is unknown.
	 */
	async updateBootstrapPeers(id: string, bootstrapPeers: string[]): Promise<LISHNetworkConfig | null> {
		const existing = this.get(id);
		if (!existing) return null;
		const cleaned = bootstrapPeers.filter(p => typeof p === 'string' && p.trim().length > 0);
		// Drop the bootstrap-exemption for peer IDs removed from this network's
		// config, unless still configured for another joined network. Prevents a
		// removed bootstrap entry from lingering as infrastructure that a later
		// leave-network would refuse to disconnect.
		const nextIDs = new Set(Networks.bootstrapPeerIDsOf(cleaned));
		const elsewhere = this.configuredBootstrapPeerIDsElsewhere(id);
		for (const pid of Networks.bootstrapPeerIDsOf(existing.bootstrapPeers)) {
			if (!nextIDs.has(pid) && !elsewhere.has(pid)) this.network.pruneConfiguredBootstrapPeer(pid);
		}
		const next: LISHNetworkConfig = { ...existing, bootstrapPeers: cleaned };
		updateLISHnet(this.db, next);
		this.network.pruneBootstrapStatus(id, cleaned);
		if (this.joinedNetworks.has(id) && cleaned.length > 0) {
			this.network.addBootstrapPeers(cleaned, id, 'configured').catch(err => {
				console.error(`[Networks] re-dial after updateBootstrapPeers failed:`, err?.message ?? err);
			});
		}
		return next;
	}
}
