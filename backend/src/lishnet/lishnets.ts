import { type Database } from 'bun:sqlite';
import { Mutex } from 'async-mutex';
import { Network, normalizeMultiaddrForCompare } from '../protocol/network.ts';
import { Utils } from '../utils.ts';
import { type DataServer } from '../lish/data-server.ts';
import { type Settings } from '../settings.ts';
import { type ILISHNetwork, type LISHNetworkConfig, type LISHNetworkDefinition, type PeerConnectionInfo, type IMeshHealth, type BootstrapStatus, CodedError, ErrorCodes } from '@shared';
import { cleanBootstrapList, lishnetExists, getLISHnet, listLISHnets, listEnabledLISHnets, addLISHnet, updateLISHnet, deleteLISHnet, setLISHnetEnabled, addLISHnetIfNotExists, importLISHnets, upsertLISHnet, replaceLISHnets } from '../db/lishnets.ts';

/**
 * Manages lishnets (logical network groups) on top of a single shared Network (libp2p) node.
 * Each lishnet is represented as a pubsub topic on the shared node.
 */
export class Networks {
	private db: Database;
	private network: Network;

	// Track which lishnets are currently joined (subscribed)
	private joinedNetworks: Set<string> = new Set();

	/**
	 * One lock per lishnet, so join and leave of the SAME network never interleave.
	 *
	 * Both of them await for a long time — a join waits on bootstrap dials, a leave
	 * disconnects peers one at a time — while mutating `joinedNetworks`, the pubsub
	 * subscription and the redial suppression that the other one reads. Overlapping
	 * runs left those four disagreeing with the database and with each other.
	 */
	private readonly networkOperations = new Map<string, Mutex>();
	/**
	 * The revision of the LAST enable/disable requested for a network, bumped
	 * synchronously when the request arrives.
	 *
	 * The lock alone only orders the operations; it cannot tell a queued one that the
	 * user has since asked for the opposite. Each operation carries the revision it was
	 * created for and abandons itself — before it starts, after each await and before
	 * every callback — once a newer one exists. That is what keeps the callbacks, the
	 * subscription and the database describing the same, final, request.
	 */
	private readonly desiredRevisions = new Map<string, number>();
	/**
	 * The join/leave state last announced to higher layers, per lishnet.
	 *
	 * A superseded operation must not announce anything, but the one that settles the
	 * network must — and it can find the runtime already in the state it wanted, because
	 * an abandoned predecessor got part of the way there. Announcing the OUTCOME rather
	 * than the operation covers both: no event for a change that was undone before it
	 * settled, exactly one for a change that stuck. Unset reads as "not joined", and the
	 * startup join seeds it directly — startup itself stays silent (it has its own
	 * resume path) while a later disable still has a `true` to change away from.
	 */
	private readonly announcedJoined = new Map<string, boolean>();

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
			// Startup itself announces nothing, but a later disable has to have a joined
			// state to change away from — otherwise its leave looks like a no-op.
			this.announcedJoined.set(net.networkID, true);
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
		await this.reconcile(id, enabled);

		return true;
	}

	/** The lock guarding one lishnet's join/leave — see {@link networkOperations}. */
	private operationLock(id: string): Mutex {
		let lock = this.networkOperations.get(id);
		if (!lock) {
			lock = new Mutex();
			this.networkOperations.set(id, lock);
		}
		return lock;
	}

	/**
	 * Bring the runtime in line with a requested enabled state, serialised per lishnet.
	 *
	 * The revision is claimed SYNCHRONOUSLY, before anything is awaited, so the order in
	 * which requests arrive — not the order in which their dials happen to finish — is
	 * what decides the outcome. A request that has been overtaken by a newer one does
	 * nothing at all: three fast toggles cost one operation, the last one.
	 */
	private async reconcile(id: string, enabled: boolean, outgoingBootstrap?: string[]): Promise<void> {
		const revision = (this.desiredRevisions.get(id) ?? 0) + 1;
		this.desiredRevisions.set(id, revision);
		await this.operationLock(id).runExclusive(async () => {
			if (this.desiredRevisions.get(id) !== revision) return;
			if (enabled) await this.joinNetwork(id);
			else await this.leaveNetwork(id, revision, outgoingBootstrap);
			if (this.desiredRevisions.get(id) !== revision) return;
			this.announce(id, this.joinedNetworks.has(id));
		});
	}

	/**
	 * Bring the runtime in line with what the database now says about one lishnet.
	 *
	 * Every writer used to be responsible for this itself, and most of them simply were
	 * not: importing an already-joined network rewrote its bootstrap list in the database
	 * while the node went on dialing the old one, and importing an active network as
	 * disabled left it joined until the next restart. The decision is made from the
	 * RUNTIME state rather than the previous row, because that is what has to change.
	 *
	 * `previous` is the row as it was before the write, and is needed only to tell whether
	 * the bootstrap list moved.
	 */
	private async reconcileStored(id: string, previous: LISHNetworkConfig | undefined): Promise<void> {
		const next = this.get(id);
		const wantJoined = next?.enabled === true;
		const joined = this.joinedNetworks.has(id);
		const before = Networks.cleanBootstrapList(previous?.bootstrapPeers ?? []);
		const after = Networks.cleanBootstrapList(next?.bootstrapPeers ?? []);
		// A list change is picked up first so a network that is about to be joined is
		// joined against the pruned state — except when we are on our way OUT of it, where
		// the leave resets the whole status anyway and a dial would be pure waste.
		if (!(joined && !wantJoined) && before.join('\n') !== after.join('\n')) this.syncBootstrapRuntime(id, previous?.bootstrapPeers ?? [], after);
		// On the way out the leave does the whole cleanup, and it has to do it over the list
		// this network was joined WITH — `previous` — because the new row is already written.
		if (joined !== wantJoined) await this.reconcile(id, wantJoined, !wantJoined && previous ? before : undefined);
	}

	/** True while `revision` is still the newest request for this lishnet. */
	private isCurrentRevision(id: string, revision: number | undefined): boolean {
		return revision === undefined || this.desiredRevisions.get(id) === revision;
	}

	/** Tell higher layers about a settled join/leave, once per actual change. */
	private announce(id: string, joined: boolean): void {
		if ((this.announcedJoined.get(id) ?? false) === joined) return;
		this.announcedJoined.set(id, joined);
		if (joined) this._onNetworkJoined?.(id);
		else this._onNetworkLeft?.(id);
	}

	/**
	 * Join a lishnet (subscribe to its topic, add bootstrap peers).
	 *
	 * Announcing the join is {@link reconcile}'s job, not this one's — see
	 * {@link announcedJoined} for why the outcome is what gets announced.
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
		// Rejoin is an explicit "I want peers back" — lift the redial suppression for
		// THIS lishnet's left peers (bootstrap and content) so maintenance and discovery
		// may reconnect them. Scoped per-network: still-left lishnets stay suppressed.
		this.network.clearRedialSuppressionForNetwork(id);

		const net = this.get(id);
		if (net && net.bootstrapPeers.length > 0) await this.network.addBootstrapPeers(net.bootstrapPeers, id, 'configured');

		console.log(`✓ Joined lishnet: ${net?.name ?? id}`);
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

	/** Configured-bootstrap peer IDs of every joined network except `exceptID`. */
	/** Canonical bootstrap ADDRESSES configured for every joined network except `exceptID`. */
	private configuredBootstrapAddressesElsewhere(exceptID: string): Set<string> {
		const out = new Set<string>();
		for (const nid of this.joinedNetworks) {
			if (nid === exceptID) continue;
			for (const address of Networks.cleanBootstrapList(this.get(nid)?.bootstrapPeers ?? [])) out.add(normalizeMultiaddrForCompare(address));
		}
		return out;
	}

	private configuredBootstrapPeerIDsElsewhere(exceptID: string): Set<string> {
		const out = new Set<string>();
		for (const nid of this.joinedNetworks) {
			if (nid === exceptID) continue;
			for (const pid of Networks.bootstrapPeerIDsOf(this.get(nid)?.bootstrapPeers ?? [])) out.add(pid);
		}
		return out;
	}

	/**
	 * Leave a lishnet. `revision` is the disable request this leave belongs to; see
	 * {@link joinNetwork} for why the long loops below re-check it.
	 */
	private async leaveNetwork(id: string, revision?: number, outgoingBootstrap?: string[]): Promise<void> {
		if (!this.joinedNetworks.has(id)) return;

		// The list we are leaving, NOT whatever the database holds now. Every caller on the
		// disable path writes the row before the runtime catches up — an edit that swaps the
		// bootstraps and disables in one go, or a `replace()`/`delete()` that removes the row
		// outright — so re-reading here cleaned up the INCOMING list (or nothing at all) and
		// left the outgoing addresses installed: still exempt from eviction, still redialled.
		const outgoing = Networks.cleanBootstrapList(outgoingBootstrap ?? this.get(id)?.bootstrapPeers ?? []);

		// Snapshot the topic subscribers BEFORE unsubscribing — unsubscribeTopic
		// tears the topic out of pubsub, after which getTopicPeers(id) returns [].
		// Union with recently-seen members (TTL) so a content peer that is momentarily
		// disconnected at leave time — but still holds a peerStore entry — is also
		// suppressed; a live-subscriber-only snapshot would miss it and maintenance
		// could redial it back after we left.
		const leftPeers = new Set<string>(this.network.getTopicPeers(id));
		for (const pid of this.network.getRecentTopicMembers(id)) leftPeers.add(pid);

		this.network.unsubscribeTopic(id);
		this.joinedNetworks.delete(id);
		// Abandon any bootstrap job still walking this network's list — left half-way
		// through, it would keep dialing peers of a network we just left and clear the
		// redial suppression the loop below is about to apply — and drop the status rows
		// with it. Those rows describe a membership that has ended: keeping them meant a
		// later rejoin opened on the previous session's connected/error/discovered results
		// until fresh dials happened to overwrite each one. Reset publishes an empty list,
		// which is what the UI should show for a network this node is not in.
		this.network.resetBootstrapStatus(id);

		// Subscribers of any OTHER joined lishnet must stay connected (shared
		// infrastructure). Compute this set BEFORE the bootstrap cleanup so that loop
		// can skip them too — a bootstrap of the left net that also subscribes another
		// joined net would otherwise be hung up here.
		//
		// Widened by the same TTL as `leftPeers` above, and that symmetry is the
		// whole point: comparing a TTL-widened "leaving" set against a live-only
		// "staying" set makes a peer that belongs to BOTH look exclusive to the one
		// we left, purely because it happens to be disconnected at this moment. It
		// would then be hung up, purged and redial-suppressed despite our still
		// sharing a lishnet with it.
		const stillJoinedPeers = new Set<string>();
		for (const otherID of this.joinedNetworks) {
			for (const pid of this.network.getTopicPeers(otherID)) stillJoinedPeers.add(pid);
			for (const pid of this.network.getRecentTopicMembers(otherID)) stillJoinedPeers.add(pid);
		}

		// Drop the exemption AND actively disconnect every configured bootstrap peer
		// exclusive to the left lishnet — including ones offline at leave time. Such
		// a peer never appears in leftPeers (the topic-subscriber snapshot), so the
		// content-peer loop below would miss it: its keep-alive tag would survive and
		// redial maintenance / ReconnectQueue would reconnect it within ~30s. Keep it
		// if it still subscribes another joined lishnet, or if it is an active circuit
		// relay we depend on. disconnectPeer is a safe no-op hangUp for an unconnected
		// peer and always strips keep-alive + suppresses redial.
		// Address-level cleanup first, because the identity-level loop below cannot do it.
		// One peer can be configured in two networks under two DIFFERENT addresses; on
		// leaving the first, `stillConfigured` says the identity is in use elsewhere and
		// skips its cleanup entirely — so the left network's own address went on counting
		// as a configured bootstrap: force-dialed by the parked probe, exempt from the
		// stale sweep, and disagreeing with what the UI shows as configured.
		const configuredElsewhere = this.configuredBootstrapAddressesElsewhere(id);
		this.network.pruneBootstrapAddresses(outgoing.filter(address => !configuredElsewhere.has(normalizeMultiaddrForCompare(address))));

		const stillConfigured = this.configuredBootstrapPeerIDsElsewhere(id);
		for (const pid of new Set(Networks.bootstrapPeerIDsOf(outgoing))) {
			// Each disconnect awaits a hangUp and a peerStore delete, so a long list keeps
			// this loop running well past the point at which the user may have re-enabled
			// the lishnet. Every peer torn down after that belongs to the network we are
			// about to be back in.
			if (!this.isCurrentRevision(id, revision)) return;
			if (stillConfigured.has(pid)) continue;
			this.network.pruneConfiguredBootstrapPeer(pid);
			if (stillJoinedPeers.has(pid)) continue;
			if (this.network.isBootstrapOrRelayPeer(pid)) continue;
			await this.network.disconnectPeer(pid, id);
		}

		// Disconnect peers that belonged exclusively to the lishnet we just left.
		// A peer is kept connected if it is still a subscriber of any OTHER joined
		// lishnet, or if it is a bootstrap/relay peer (shared infrastructure other
		// networks depend on). Everything else is a plain content peer with no
		// remaining reason to stay connected, so hang it up via the single
		// Network.disconnectPeer entry point (which also clears the keep-alive tag
		// so ReconnectQueue does not immediately re-dial it).
		for (const pid of leftPeers) {
			if (!this.isCurrentRevision(id, revision)) return;
			if (stillJoinedPeers.has(pid)) continue;
			if (this.network.isBootstrapOrRelayPeer(pid)) continue;
			await this.network.disconnectPeer(pid, id);
		}

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
			// Cleaned here as well as on write: this shape is also handed straight back to the
			// caller as an import preview, and a preview that still shows the untrimmed value
			// describes something other than what would be stored.
			bootstrapPeers: Array.isArray(data.bootstrapPeers) ? cleanBootstrapList(data.bootstrapPeers) : [],
			created: data.created || new Date().toISOString(),
		};
	}

	async importFromLISHnet(data: ILISHNetwork, enabled: boolean = false): Promise<LISHNetworkConfig> {
		const definition = this.validateNetwork(data);
		const config: LISHNetworkConfig = { ...definition, enabled };
		const previous = this.get(config.networkID);
		upsertLISHnet(this.db, config.networkID, config.name, config.description, config.bootstrapPeers, config.enabled, config.created);
		await this.reconcileStored(config.networkID, previous);
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

	async add(network: LISHNetworkConfig): Promise<boolean> {
		const ok = addLISHnet(this.db, network);
		// A network added as enabled has to be joined, not merely written down.
		if (ok) await this.reconcileStored(network.networkID, undefined);
		return ok;
	}

	async update(network: LISHNetworkConfig): Promise<boolean> {
		const existing = this.get(network.networkID);
		// Store the cleaned list, not the raw one: blank rows from the form would
		// otherwise be persisted while the runtime worked from the filtered copy, and
		// the two would disagree about what this network's bootstrap list even is.
		const cleaned = Networks.cleanBootstrapList(network.bootstrapPeers ?? []);
		const ok = updateLISHnet(this.db, { ...network, bootstrapPeers: cleaned });
		// The general edit form carries the bootstrap list AND the enabled flag, so this
		// path can change either one. Without the runtime reconciliation the edit would
		// reach only the database and the live node would keep dialing the previous list —
		// or stay in a network the edit had just disabled — until restart.
		if (!ok) return ok;
		await this.reconcileStored(network.networkID, existing);
		return ok;
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

	/**
	 * Add every definition that does not exist yet. Nothing to reconcile: the underlying
	 * writer skips networks that already exist and inserts new ones DISABLED, so no
	 * network's runtime state can change here.
	 */
	importNetworks(networks: LISHNetworkDefinition[]): number {
		return importLISHnets(this.db, networks);
	}

	/**
	 * Replace the whole stored list (used for reordering). Every network the write touched
	 * is reconciled afterwards, including ones it dropped: a wholesale rewrite can enable,
	 * disable, re-list or delete anything, and a deleted network that is still joined would
	 * otherwise stay in its topic with no row left to explain it.
	 */
	async replace(networks: LISHNetworkConfig[]): Promise<void> {
		const before = new Map(this.list().map(n => [n.networkID, n]));
		replaceLISHnets(this.db, networks);
		for (const id of new Set([...before.keys(), ...networks.map(n => n.networkID)])) await this.reconcileStored(id, before.get(id));
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
		const cleaned = Networks.cleanBootstrapList(bootstrapPeers);
		const next: LISHNetworkConfig = { ...existing, bootstrapPeers: cleaned };
		// Persist first and believe the answer. Switching the runtime over after a failed
		// write would leave the node dialing a list the database never accepted, and the
		// old one would come back at the next restart with nothing to explain the change.
		if (!updateLISHnet(this.db, next)) throw new CodedError(ErrorCodes.NETWORK_NOT_FOUND, id);
		this.syncBootstrapRuntime(id, existing.bootstrapPeers, cleaned);
		return next;
	}

	/**
	 * The same normalisation the repository applies on write, for the comparisons here
	 * that have to speak about a list in the shape it will be stored in.
	 */
	private static cleanBootstrapList(peers: string[]): string[] {
		return cleanBootstrapList(peers);
	}

	/**
	 * Bring the running node in line with a network's new configured bootstrap list.
	 *
	 * Shared by the bootstrap-only editor and the general network edit form, because
	 * both can change that list and a change that reaches only the database leaves the
	 * live node working from the previous one until restart.
	 *
	 * Three things have to happen: peer IDs that left the list lose their
	 * bootstrap-exemption (unless another joined network still configures them, else a
	 * removed entry lingers as infrastructure a later leave refuses to disconnect),
	 * the status rows are pruned — which also invalidates any bootstrap job still
	 * walking the old list — and the new entries are dialed.
	 */
	private syncBootstrapRuntime(id: string, previousPeers: string[], cleaned: string[]): void {
		const nextIDs = new Set(Networks.bootstrapPeerIDsOf(cleaned));
		const elsewhere = this.configuredBootstrapPeerIDsElsewhere(id);
		for (const pid of Networks.bootstrapPeerIDsOf(previousPeers)) {
			if (!nextIDs.has(pid) && !elsewhere.has(pid)) this.network.pruneConfiguredBootstrapPeer(pid);
		}
		// Addresses that left the list while their peer ID stayed — the user edited a
		// host or port. The identity-level prune above cannot see those, so recovery
		// would go on dialing the address that was replaced.
		// Compare canonically, the same way the autodial list itself does. Raw string
		// equality would treat two spellings of one address (DNS case, IPv6 form) as
		// different entries here and as the same one during the prune below.
		const keptAddresses = new Set(cleaned.map(normalizeMultiaddrForCompare));
		const elsewhereAddresses = this.configuredBootstrapAddressesElsewhere(id);
		const dropped = Networks.cleanBootstrapList(previousPeers).filter(a => !keptAddresses.has(normalizeMultiaddrForCompare(a)) && !elsewhereAddresses.has(normalizeMultiaddrForCompare(a)));
		this.network.pruneBootstrapAddresses(dropped);
		this.network.pruneBootstrapStatus(id, cleaned);
		if (this.joinedNetworks.has(id) && cleaned.length > 0) {
			this.network.addBootstrapPeers(cleaned, id, 'configured').catch(err => {
				console.error(`[Networks] bootstrap re-dial after config change failed:`, err?.message ?? err);
			});
		}
	}
}
