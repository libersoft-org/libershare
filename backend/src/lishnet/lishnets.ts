import { type Database } from 'bun:sqlite';
import { Mutex } from 'async-mutex';
import { Network, normalizeMultiaddrForCompare } from '../protocol/network.ts';
import { Utils } from '../utils.ts';
import { type DataServer } from '../lish/data-server.ts';
import { type Settings } from '../settings.ts';
import { type ILISHNetwork, type LISHNetworkConfig, type LISHNetworkDefinition, type PeerConnectionInfo, type IMeshHealth, type BootstrapStatus, CodedError, ErrorCodes } from '@shared';
import { cleanBootstrapList, lishnetExists, getLISHnet, listLISHnets, listEnabledLISHnets, addLISHnet, updateLISHnet, deleteLISHnet, setLISHnetEnabled, addLISHnetIfNotExists, importLISHnets, upsertLISHnet, replaceLISHnets } from '../db/lishnets.ts';

/**
 * Outcome of {@link Networks.setEnabled}.
 *
 * A bare boolean could not say what happened. It meant "the network exists", and callers
 * read it as "your change was applied" — so a request superseded by a newer one, and an
 * idempotent one that changed nothing, both looked like a settled transition and made the
 * API broadcast a join or leave that had not occurred.
 */
export interface SetEnabledResult {
	/** Whether the lishnet exists at all. */
	found: boolean;
	/** Whether this call actually settled a change of join state. */
	transitioned: boolean;
	/** The join state the lishnet is in now, whoever settled it. */
	joined: boolean;
	/**
	 * Identity of the row as it stood inside the critical section, for the event the API
	 * broadcasts. The handler used to read the row itself before awaiting this call, which
	 * raced the catalog in both directions: a network still being added read as undefined
	 * and its join was never broadcast, and a rename queued ahead of the enable made the
	 * event carry the name the network no longer has.
	 */
	network?: { networkID: string; name: string };
}

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
	 * Taken by EVERY public write, before any per-ID lock.
	 *
	 * Two things need it. A multi-network write has to see a stable set of IDs while it
	 * decides what it is rewriting, so without this a network created between the snapshot
	 * and the write was rewritten out of existence behind the back of the add that was still
	 * joining it. And every writer must reach its database write in the order the requests
	 * arrived: `Mutex` dispatches its waiters first come, first served, and each public
	 * writer enqueues here before it awaits anything else, so one gate for everyone makes
	 * arrival order and write order the same.
	 *
	 * Held for the DATABASE phase only — see {@link inCatalog} and {@link reconcile}. It is
	 * never held while a per-ID lock is taken, so no cycle is possible.
	 */
	private readonly catalogMutex = new Mutex();
	/**
	 * The join/leave state last announced to higher layers, per lishnet.
	 *
	 * Two consecutive writes can both converge the same lishnet, and the second usually
	 * finds the runtime already where it wants it. Announcing the OUTCOME rather than the
	 * operation covers that: exactly one event per actual change, none for a write that
	 * changed nothing. Unset reads as "not joined", and the startup join seeds it directly —
	 * startup itself stays silent (it has its own resume path) while a later disable still
	 * has a `true` to change away from.
	 */
	private readonly announcedJoined = new Map<string, boolean>();

	/**
	 * True from the synchronous start of {@link stopAllNetworks} until the next
	 * {@link startEnabledNetworks}. Startup joins consult it because the node's own
	 * `isRunning()` cannot answer for the window before `stop()` has taken its mutex.
	 */
	private shuttingDown = false;

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
		this.shuttingDown = false;

		// Start the node with no preset bootstrap list — bootstrap dials happen
		// per-network below via addBootstrapPeers so per-network status tracking
		// can record which specific peers connected / mismatched / timed out.
		// (Previous behaviour used a flat preset list that bypassed our tracking.)
		await this.network.start([]);

		// The enabled list is read AFTER the start, not before it. Reading it first meant
		// startup worked from a snapshot taken before a long await: an API disable or
		// delete arriving during the start reconciled against a runtime that had joined
		// nothing yet — so it had nothing to leave — and then this loop subscribed the
		// network anyway, from a copy of a row that no longer said what it used to.
		// Under the catalog mutex for the whole loop, so no API write and no shutdown can
		// interleave with the networks coming up — see {@link catalogMutex}.
		await this.catalogMutex.runExclusive(async () => {
			for (const net of this.getEnabled()) {
				await this.operationLock(net.networkID).runExclusive(() => {
					// Re-read under the lock as well: an earlier network's turn is another await.
					const row = this.get(net.networkID);
					if (row?.enabled !== true) return;
					// A stop between the start above and this subscribe leaves the call a no-op on
					// a dead node, but `joinedNetworks` would still claim membership — the wrapper
					// reporting a joined network whose node is not running and whose topic is not
					// subscribed.
					if (!this.canJoin()) return;
					if (!this.network.subscribeTopic(row.networkID)) return;
					this.joinedNetworks.add(row.networkID);
					// Startup itself announces nothing, but a later disable has to have a joined
					// state to change away from — otherwise its leave looks like a no-op.
					this.announcedJoined.set(row.networkID, true);
					if (row.bootstrapPeers.length > 0) {
						// Fire-and-forget so a slow / unreachable network does not delay startup of the others.
						this.network.addBootstrapPeers(row.bootstrapPeers, row.networkID, 'configured').catch(err => {
							console.error(`[Networks] addBootstrapPeers for ${row.networkID} failed:`, err?.message ?? err);
						});
					}
					console.log(`✓ Joined lishnet: ${row.name} (${row.networkID})`);
				});
			}
		});
	}

	/**
	 * Whether a runtime join may go ahead right now.
	 *
	 * Both halves matter. `shuttingDown` is set synchronously by {@link stopAllNetworks},
	 * so it covers the window before `Network.stop()` has even reached its own mutex, in
	 * which `isRunning()` still answers true; `isRunning()` covers a node that is down for
	 * any other reason, including a stop whose teardown failed.
	 */
	private canJoin(): boolean {
		return !this.shuttingDown && this.network.isRunning();
	}

	/**
	 * Enable/disable a lishnet. Starts the node if needed, subscribes/unsubscribes topics.
	 */
	async setEnabled(id: string, enabled: boolean): Promise<SetEnabledResult> {
		const staged = await this.inCatalog(() => {
			if (!lishnetExists(this.db, id)) return undefined;
			const previous = this.get(id);
			setLISHnetEnabled(this.db, id, enabled);
			// Named from the row this write landed on, not from a read the caller took outside
			// the lock — see {@link SetEnabledResult.network}.
			return { previous, row: this.get(id) };
		});
		if (!staged) return { found: false, transitioned: false, joined: false };
		const transitioned = await this.reconcile(id, staged.previous);
		const result: SetEnabledResult = { found: true, transitioned, joined: this.joinedNetworks.has(id) };
		if (staged.row) result.network = { networkID: staged.row.networkID, name: staged.row.name };
		return result;
	}

	/**
	 * Phase one of every lishnet write: the DATABASE, under {@link catalogMutex} alone.
	 *
	 * `body` is synchronous and must not touch the network. The catalog used to be held for
	 * the runtime phase as well, and that phase is slow — a join awaits a sequential dial of
	 * every bootstrap address, seconds each, and a leave one hangUp per peer. Editing an
	 * unrelated lishnet, an add, a delete, an import, another replace, a shutdown and a
	 * factory reset all queued behind whichever single network happened to be dialing,
	 * which presented as a frozen shutdown.
	 */
	private async inCatalog<T>(body: () => T): Promise<T> {
		return await this.catalogMutex.runExclusive(async () => body());
	}

	/**
	 * Phase two: converge one lishnet's runtime on the row phase one left behind, under that
	 * lishnet's own lock and nothing else.
	 *
	 * Safe outside the catalog precisely because {@link reconcileLocked} takes its desired
	 * state from the database rather than from a value its caller captured: whichever
	 * reconcile holds the lock last converges on the row that was written last, whatever
	 * order the two finished their network work in.
	 */
	private async reconcile(id: string, previous: LISHNetworkConfig | undefined): Promise<boolean> {
		const transitioned = await this.operationLock(id).runExclusive(() => this.reconcileLocked(id, previous));
		this.forgetIfGone(id);
		return transitioned;
	}

	/**
	 * Drop the per-lishnet bookkeeping of a lishnet that no longer exists.
	 *
	 * {@link networkOperations} and {@link announcedJoined} are keyed by arbitrary network
	 * IDs and nothing used to remove an entry, so creating and deleting networks over a long
	 * uptime grew both without bound.
	 *
	 * Called with the lock already RELEASED, and only when nothing holds or waits on it —
	 * `isLocked()` covers both. Deleting a mutex somebody is queued on would hand the next
	 * caller a second, independent mutex for the same lishnet, which is worse than a leak.
	 */
	private forgetIfGone(id: string): void {
		// A lishnet still joined has runtime state to describe, however little the database
		// has left to say about it.
		if (this.get(id) !== undefined || this.joinedNetworks.has(id)) return;
		this.announcedJoined.delete(id);
		const lock = this.networkOperations.get(id);
		if (lock && !lock.isLocked()) this.networkOperations.delete(id);
	}

	/** The lock guarding one lishnet's whole transition — see {@link networkOperations}. */
	private operationLock(id: string): Mutex {
		let lock = this.networkOperations.get(id);
		if (!lock) {
			lock = new Mutex();
			this.networkOperations.set(id, lock);
		}
		return lock;
	}

	/**
	 * Bring the runtime in line with what the DATABASE now says about one lishnet.
	 *
	 * Every writer used to be responsible for this itself, and most of them simply were
	 * not: importing an already-joined network rewrote its bootstrap list in the database
	 * while the node went on dialing the old one, and importing an active network as
	 * disabled left it joined until the next restart.
	 *
	 * The stored row is the desired state and this converges on it. It is deliberately NOT
	 * handed the value its caller asked for: two writes over one lishnet serialise on its
	 * lock, and each converging on the row as it stands when its turn comes is what makes
	 * the last write the one that decides, whatever order the runtime work finishes in.
	 *
	 * An operation that starts also always finishes. It used to abandon itself as soon as a
	 * newer request had merely ARRIVED — which is not the same as a newer request having
	 * taken the work over. Two identical disables were enough: the first stopped half-way
	 * through its peer cleanup, and the second found the network already unsubscribed and
	 * returned at once, leaving the keep-alive tags, peerStore records and connections of a
	 * network nobody is in installed with nobody left to remove them. Finishing and then
	 * applying the next request costs one redundant pass over a rare user action.
	 *
	 * `previous` is the row as it was before the write. It says whether the bootstrap list
	 * moved, and a leave needs it because the cleanup has to run over the list the network
	 * was joined WITH, which the new row no longer holds — and may not exist at all.
	 *
	 * Callers hold the lishnet's operation lock. Returns whether this call settled an actual
	 * change of join state.
	 */
	private async reconcileLocked(id: string, previous: LISHNetworkConfig | undefined): Promise<boolean> {
		const next = this.get(id);
		const wantJoined = next?.enabled === true;
		const joined = this.joinedNetworks.has(id);
		const before = Networks.cleanBootstrapList(previous?.bootstrapPeers ?? []);
		const after = Networks.cleanBootstrapList(next?.bootstrapPeers ?? []);
		// A list change is picked up first so a network that is about to be joined is
		// joined against the pruned state — except when we are on our way OUT of it, where
		// the leave resets the whole status anyway and a dial would be pure waste.
		if (!(joined && !wantJoined) && before.join('\n') !== after.join('\n')) this.syncBootstrapRuntime(id, previous?.bootstrapPeers ?? [], after);
		if (joined !== wantJoined) {
			if (wantJoined) await this.joinNetwork(id);
			else await this.leaveNetwork(id, previous ? before : undefined);
		}
		return this.announce(id, this.joinedNetworks.has(id));
	}

	/**
	 * Tell higher layers about a settled join/leave, once per actual change. Returns whether
	 * this call was that change — the single source of truth for "something transitioned",
	 * which the API needs before it broadcasts a join or leave of its own.
	 *
	 * The observers run synchronously here, still under the lishnet's operation lock, so they
	 * stay in the order the transitions happened. What they may NOT do is change the outcome:
	 * the transfer-layer callbacks iterate downloaders and mutate them, and a throw used to
	 * come back out of the whole operation as a failed RPC — after the database and the
	 * runtime had already moved and `announcedJoined` already held the new state. Retrying
	 * the request then found nothing left to announce, so the observer was never re-run and
	 * the event never reached the client, for a network that really had joined or left.
	 */
	private announce(id: string, joined: boolean): boolean {
		if ((this.announcedJoined.get(id) ?? false) === joined) return false;
		this.announcedJoined.set(id, joined);
		try {
			if (joined) this._onNetworkJoined?.(id);
			else this._onNetworkLeft?.(id);
		} catch (err: any) {
			console.error(`[Networks] ${joined ? 'onNetworkJoined' : 'onNetworkLeft'} observer for ${id} threw:`, err?.message ?? err);
		}
		return true;
	}

	/**
	 * Join a lishnet (subscribe to its topic, add bootstrap peers).
	 *
	 * Announcing the join is {@link reconcileLocked}'s job, not this one's — see
	 * {@link announcedJoined} for why the outcome is what gets announced.
	 */
	private async joinNetwork(id: string): Promise<void> {
		if (this.joinedNetworks.has(id)) {
			console.log(`LISH network ${id} is already joined`);
			return;
		}

		// A join queued behind a slow operation can reach this point after the node has been
		// told to stop. subscribeTopic is then a logged no-op, and recording the ID anyway
		// left `joinedNetworks` claiming a membership with no subscription behind it — which
		// the next startup reads as "already joined" and skips.
		if (!this.canJoin()) {
			console.log(`Not joining lishnet ${id}: the node is not running`);
			return;
		}

		// Subscribe to the topic first (register interest), then dial bootstrap peers.
		// Note: the StreamStateError crash from gossipsub is caused by an internal
		// race condition when peers connect and disconnect rapidly (flapping).
		// Gossipsub reacts to peer:connect events and tries to send subscriptions
		// on a stream that may already be closing. This cannot be fixed by call
		// ordering — the process-level error handlers in app.ts are the safety net.
		if (!this.network.subscribeTopic(id)) {
			console.log(`Not joining lishnet ${id}: the topic subscription was refused`);
			return;
		}
		this.joinedNetworks.add(id);
		// Rejoin is an explicit "I want peers back" — lift the redial suppression for
		// THIS lishnet's left peers (bootstrap and content) so maintenance and discovery
		// may reconnect them. Scoped per-network: still-left lishnets stay suppressed.
		this.network.clearRedialSuppressionForNetwork(id);

		const net = this.get(id);
		if (net && net.bootstrapPeers.length > 0) await this.network.addBootstrapPeers(net.bootstrapPeers, id, 'configured');

		// The dials above take seconds. A node that went down during them owns neither the
		// subscription nor the connections this join was building, so the membership claim
		// has to go with it rather than survive into the next run.
		if (!this.canJoin()) {
			this.joinedNetworks.delete(id);
			console.log(`Abandoning join of lishnet ${id}: the node went down during its bootstrap dials`);
			return;
		}

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
	 * Leave a lishnet: unsubscribe its topic and undo everything the membership installed.
	 *
	 * Runs to completion once it has started. The loops below used to check whether a newer
	 * request had arrived and return if so, which left the cleanup half-done for a successor
	 * that then had nothing to do — see {@link reconcileLocked}.
	 */
	private async leaveNetwork(id: string, outgoingBootstrap?: string[]): Promise<void> {
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
		// Set before anything is awaited — `Network.stop()` does not reach its own mutex
		// until the next microtask, so `isRunning()` alone still reads true for a moment
		// and a startup loop in that moment would subscribe onto a node about to die.
		this.shuttingDown = true;
		// The catalog mutex covers the DATABASE phase of every writer, not their network
		// work, so it is `shuttingDown` — set above, before anything is awaited — that keeps
		// a join out of the way: {@link canJoin} is consulted before the subscribe and again
		// after the bootstrap dials, so a join running concurrently with this either never
		// subscribes or drops the membership claim it was building. What the mutex adds is
		// that no new row can be written, and no reconcile started, from the moment the node
		// begins to go down.
		await this.catalogMutex.runExclusive(async () => {
			// Cleared only once the node is provably down. Discarding the membership first
			// meant a stop that failed — leaving the node alive and the wrapper `failed` —
			// still left this layer claiming it was in no lishnet and had announced nothing.
			// `leaveNetwork()` begins with "not joined, nothing to do", so disabling one of
			// those networks afterwards wrote `enabled=false` and then unsubscribed nothing,
			// disconnected nobody and dropped no keep-alive tag, while the node went on
			// subscribed to the topic.
			await this.network.stop();
			// Per-run, like `joinedNetworks` itself. Surviving a stop left the map claiming
			// networks were still announced as joined, so after a restart a network that came
			// back disabled never produced the "left" event its subscribers were waiting for,
			// and a rejoin of one that had been announced before the stop produced no event
			// either — the runtime had changed and nobody was told.
			this.joinedNetworks.clear();
			this.announcedJoined.clear();
			console.log('✓ All lishnets left and node stopped');
		});
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
		// An upsert can bring a network into existence — see {@link catalogMutex}.
		const previous = await this.inCatalog(() => {
			const row = this.get(config.networkID);
			upsertLISHnet(this.db, config.networkID, config.name, config.description, config.bootstrapPeers, config.enabled, config.created);
			return row;
		});
		await this.reconcile(config.networkID, previous);
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
		const ok = await this.inCatalog(() => addLISHnet(this.db, network));
		// A network added as enabled has to be joined, not merely written down. An add of one
		// that already exists writes nothing and reconciles nothing: it used to claim a
		// revision anyway on the way in, which cancelled a queued enable of that very network
		// — a request that changed nothing discarding one that meant something.
		if (ok) await this.reconcile(network.networkID, undefined);
		return ok;
	}

	async update(network: LISHNetworkConfig): Promise<boolean> {
		// Row read and write in ONE critical section. With the read outside it, a toggle
		// could slip between the two and be overwritten by a row this edit had already read.
		const staged = await this.inCatalog(() => {
			const existing = this.get(network.networkID);
			// Store the cleaned list, not the raw one: blank rows from the form would
			// otherwise be persisted while the runtime worked from the filtered copy, and
			// the two would disagree about what this network's bootstrap list even is.
			const cleaned = Networks.cleanBootstrapList(network.bootstrapPeers ?? []);
			return updateLISHnet(this.db, { ...network, bootstrapPeers: cleaned }) ? { existing } : undefined;
		});
		if (!staged) return false;
		// The general edit form carries the bootstrap list AND the enabled flag, so this path
		// can change either one. Without the runtime reconciliation the edit would reach only
		// the database and the live node would keep dialing the previous list — or stay in a
		// network the edit had just disabled — until restart.
		await this.reconcile(network.networkID, staged.existing);
		return true;
	}

	/**
	 * Delete a lishnet: drop the row, then leave it.
	 *
	 * The row goes first so the reconcile converges on the only desired state a deleted
	 * lishnet has — no row, therefore not joined — and an enable arriving during the leave
	 * finds no row and answers "not found" instead of rejoining a deleted network. Both
	 * halves used to be separate lock acquisitions with the row write LAST, which let that
	 * enable rejoin the topic between them and then watch the delete remove the row
	 * underneath it: subscribed, in `joinedNetworks`, and nothing in the database to explain
	 * either.
	 */
	async delete(id: string): Promise<boolean> {
		const staged = await this.inCatalog(() => {
			if (!lishnetExists(this.db, id)) return undefined;
			const previous = this.get(id);
			deleteLISHnet(this.db, id);
			return { previous };
		});
		if (!staged) return false;
		await this.reconcile(id, staged.previous);
		return true;
	}

	exists(id: string): boolean {
		return lishnetExists(this.db, id);
	}

	/**
	 * Add one definition if it does not exist yet. Nothing to reconcile — the writer inserts
	 * it DISABLED — but the insert itself still belongs under {@link catalogMutex}: it went
	 * straight to the database, so a `replace()` that had already read the catalog could
	 * delete the row this had just reported as added, and the ID set `replace()` computes
	 * its affected list from moved underneath it.
	 */
	async addIfNotExists(network: LISHNetworkDefinition): Promise<boolean> {
		return await this.inCatalog(() => addLISHnetIfNotExists(this.db, network));
	}

	/**
	 * Add every definition that does not exist yet, as one batch under the catalog mutex.
	 * Nothing to reconcile: the underlying writer skips networks that already exist and
	 * inserts new ones DISABLED, so no network's runtime state can change here — but see
	 * {@link addIfNotExists} for why the write is still not the caller's to do unlocked.
	 */
	async importNetworks(networks: LISHNetworkDefinition[]): Promise<number> {
		return await this.inCatalog(() => importLISHnets(this.db, networks));
	}

	/**
	 * Replace the whole stored list (used for reordering). Every network the write touched
	 * is reconciled afterwards, including ones it dropped: a wholesale rewrite can enable,
	 * disable, re-list or delete anything, and a deleted network that is still joined would
	 * otherwise stay in its topic with no row left to explain it.
	 */
	async replace(networks: LISHNetworkConfig[]): Promise<void> {
		// Snapshot and rewrite in one critical section, so the list this reconciles against
		// is exactly the list it replaced. Reading it outside meant a network created while
		// we waited was rewritten out of existence behind the back of the add that was still
		// joining it.
		const before = await this.inCatalog(() => {
			const rows = new Map(this.list().map(n => [n.networkID, n]));
			replaceLISHnets(this.db, networks);
			return rows;
		});
		// One lishnet at a time, each under its own lock and none of them under the catalog.
		// Reconciling the whole set under the global lock meant a rewrite of a long list held
		// it across every affected network's dials and disconnects in turn.
		for (const id of new Set([...before.keys(), ...networks.map(n => n.networkID)])) await this.reconcile(id, before.get(id));
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
		const staged = await this.inCatalog(() => {
			const existing = this.get(id);
			if (!existing) return undefined;
			const next: LISHNetworkConfig = { ...existing, bootstrapPeers: Networks.cleanBootstrapList(bootstrapPeers) };
			// Persist first and believe the answer. Switching the runtime over after a failed
			// write would leave the node dialing a list the database never accepted, and the
			// old one would come back at the next restart with nothing to explain the change.
			if (!updateLISHnet(this.db, next)) throw new CodedError(ErrorCodes.NETWORK_NOT_FOUND, id);
			return { existing, next };
		});
		if (!staged) return null;
		await this.reconcile(id, staged.existing);
		return staged.next;
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
