import { type Database } from 'bun:sqlite';
import { Mutex } from 'async-mutex';
import { Network, normalizeMultiaddrForCompare, type BootstrapDialResult } from '../protocol/network.ts';
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
 * What one convergence settled, as read from INSIDE that lishnet's own lock.
 *
 * Every field of it has to be sampled there. `async-mutex` hands the lock to the next
 * waiter synchronously on release, before the previous holder's `await` resumes — so a
 * caller that released the lock and then read `joinedNetworks` was describing the state
 * the NEXT transition had already moved to, and reported a leave for the join it had
 * itself just performed.
 */
interface ReconcileOutcome {
	/** Whether this convergence was the one that changed the join state. */
	transitioned: boolean;
	/** The join state as it stood when this convergence finished. */
	joined: boolean;
	/** Identity of the row this convergence actually converged on, if it still exists. */
	network?: { networkID: string; name: string };
}

/**
 * What one membership put on the running node, and whether the run that put it there
 * finished — see {@link Networks.appliedBootstrap}.
 */
interface InstalledBootstrap {
	/** The list the dials were started for: the cleanup baseline, whatever the run reached. */
	readonly addresses: string[];
	/** Whether a dial run walked this whole list. Until it has, the list is not converged. */
	complete: boolean;
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
	 * Held for the DATABASE phase only — see {@link inCatalog} and {@link reconcileLater}. It is
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
	 * The bootstrap list each JOINED lishnet has actually installed on the running node.
	 *
	 * The stored row says what the runtime should hold; nothing said what it does hold, so
	 * the cleanup of entries that left the list was computed from a `previous` its caller
	 * had captured — the row as it stood before one particular database write, which is not
	 * the same thing. Two writes over one lishnet then each cleaned up against their own
	 * snapshot, and a reconcile that threw or was skipped took its baseline with it, leaving
	 * addresses installed that no later delta would ever mention again.
	 *
	 * Per-run, like {@link joinedNetworks}: only a joined lishnet installs anything (the
	 * configured dials all run behind a membership), so an entry exists exactly while there
	 * is something to take back off.
	 *
	 * `addresses` is the CLEANUP baseline and is therefore recorded before the dials: any of
	 * them may have been installed by the time a run ends, so a leave has to be able to take
	 * all of them back off. It is not evidence that the dial loop ever reached them, which is
	 * what `complete` is for — see {@link BootstrapDialResult}. Read as convergence, a list of
	 * `[A, B]` whose run was cancelled after A left B undialed for the rest of the run: the
	 * next reconcile compared the desired list against itself, found no difference and did
	 * nothing.
	 */
	private readonly appliedBootstrap = new Map<string, InstalledBootstrap>();
	/**
	 * Every reconcile that has been RESERVED and not yet finished — the shutdown barrier.
	 *
	 * The catalog mutex guards the database phase only, so holding it says nothing about the
	 * runtime work already in flight: an operation could be between its two phases, queued on
	 * a per-lishnet lock, or half-way through a join or a leave when the node was stopped
	 * underneath it. Registration happens inside {@link reconcileLater}, synchronously, while
	 * the catalog is still held — which is what leaves no window between phase one and phase
	 * two for a stop to slip through.
	 */
	private readonly activeReconciles = new Set<Promise<unknown>>();

	/**
	 * A stop has been ASKED for — set synchronously by {@link stopAllNetworks}, cleared by
	 * the next successful {@link startEnabledNetworks}.
	 *
	 * Only ever an intent. Runtime work still under way consults it so it does not build
	 * anything new on a node about to go down — {@link canJoin} needs it because the node's
	 * own `isRunning()` cannot answer for the window before `stop()` has taken its mutex.
	 * It deliberately does NOT gate admission; see {@link reconcileAdmissionClosed}.
	 */
	private stopRequested = false;
	/**
	 * No further convergence may be RESERVED — set inside the stop's own catalog section.
	 *
	 * Set from the intent instead, it closed the door ahead of writers that were already
	 * queued on the catalog: such a writer reached its database write before the stop reached
	 * the catalog at all, and {@link reconcileLater} then handed it neither a reservation nor
	 * a ticket, so the barrier had nothing to drain and its row never reached the runtime.
	 * Set here, every writer that got the catalog first is drained, and only writers that
	 * arrive after the stop's catalog section are deferred — by which point the drain has
	 * finished and no convergence can be in flight, which is what makes {@link currentState}
	 * a stable answer for them.
	 */
	private reconcileAdmissionClosed = false;

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
			// Admission reopens HERE, on a node observed running while the catalog is held, and
			// never on the strength of `start()` having returned. A stop that arrives during the
			// start takes the free catalog first, closes the door and drains, then blocks in
			// `Network.stop()` behind the start's own lifecycle mutex — so it finishes AFTER the
			// start it overtook. Reopening on the return would hand every later write a runtime
			// that had just been torn down, and report it as converged: the failure the stop's
			// own error path exists to prevent, arriving through the start door instead.
			//
			// Reopening here rather than before the catalog also closes the window in which a
			// writer got in between the two and joined a lishnet this loop then subscribed a
			// second time.
			if (!this.network.isRunning()) {
				console.log('Not joining any lishnet: the node is no longer running by the time startup reached them');
				return;
			}
			this.stopRequested = false;
			this.reconcileAdmissionClosed = false;
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
					const configured = Networks.cleanBootstrapList(row.bootstrapPeers);
					// The startup join installs this list just as {@link joinNetwork} does, so it
					// has to record it the same way or the first leave of the run finds nothing to
					// take back off — see {@link appliedBootstrap}.
					const installed = this.beginBootstrapInstall(row.networkID, configured);
					if (configured.length > 0) {
						// Fire-and-forget so a slow / unreachable network does not delay startup of the others.
						this.network.addBootstrapPeers(configured, row.networkID, 'configured').then(
							result => Networks.finishBootstrapInstall(installed, result),
							err => console.error(`[Networks] addBootstrapPeers for ${row.networkID} failed:`, err?.message ?? err)
						);
					}
					console.log(`✓ Joined lishnet: ${row.name} (${row.networkID})`);
				});
			}
		});
	}

	/**
	 * Whether a runtime join may go ahead right now.
	 *
	 * Both halves matter. `stopRequested` is set synchronously by {@link stopAllNetworks},
	 * so it covers the window before `Network.stop()` has even reached its own mutex, in
	 * which `isRunning()` still answers true; `isRunning()` covers a node that is down for
	 * any other reason, including a stop whose teardown failed.
	 */
	private canJoin(): boolean {
		return !this.stopRequested && this.network.isRunning();
	}

	/**
	 * Enable/disable a lishnet. Starts the node if needed, subscribes/unsubscribes topics.
	 */
	async setEnabled(id: string, enabled: boolean): Promise<SetEnabledResult> {
		const staged = await this.inCatalog(() => {
			if (!lishnetExists(this.db, id)) return undefined;
			setLISHnetEnabled(this.db, id, enabled);
			// Named from the row this write landed on, not from a read the caller took outside
			// the lock — see {@link SetEnabledResult.network}.
			return { row: this.get(id), job: this.reconcileLater(id) };
		});
		if (!staged) return { found: false, transitioned: false, joined: false };
		const outcome = await staged.job;
		// Everything transition-related comes out of the outcome, which was assembled under
		// the lishnet's lock. Nothing here may re-read the runtime: by now the next waiter
		// has had the lock, so a second look answers for its transition, not for this one.
		const result: SetEnabledResult = { found: true, transitioned: outcome.transitioned, joined: outcome.joined };
		// The row the convergence worked from, so the event carries the name the transition
		// actually used rather than a snapshot a queued rename has since replaced. A row that
		// no longer exists falls back to the one this call's own catalog phase wrote — there
		// is no later truth to name it by.
		const named = outcome.network ?? staged.row;
		if (named) result.network = { networkID: named.networkID, name: named.name };
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
	 * Reserve phase two for one lishnet and hand back the outcome it will settle.
	 *
	 * MUST be called synchronously from inside an {@link inCatalog} body, and that is the
	 * whole point of it. `Mutex.acquire()` enqueues its waiter synchronously, so calling it
	 * while the catalog is held puts this lishnet's runtime work in the per-ID queue in
	 * CATALOG order — the same order the database was written in.
	 *
	 * Taking the lock after the catalog was released did not order anything. Whoever reached
	 * `runExclusive` first won, so a newer single-network write could converge before an
	 * older `replace()` that had already rewritten the same row: the newer one computed its
	 * bootstrap delta from the row the older one had written, never learned about the list
	 * before that, and left the older addresses installed on the node with the API reporting
	 * success. `replace()` reserves every network it touches before it lets go of the
	 * catalog, so nothing can slip in front of it on any of them.
	 *
	 * The reservation is also the shutdown's ticket — see {@link activeReconciles}. Both the
	 * enqueue and the registration are synchronous, and both happen in the same catalog
	 * section as the database write, so every write admitted after the last stop closed its
	 * door is known to the barrier from the moment it happened.
	 */
	private reconcileLater(id: string): Promise<ReconcileOutcome> {
		// {@link stopAllNetworks} closes the door here — from inside its own catalog section,
		// see {@link reconcileAdmissionClosed} — and drains what is already through it. A
		// convergence reserved now would work on a node that is down or terminally failed;
		// the database write it belongs to stands and the next start converges on it.
		if (this.reconcileAdmissionClosed) {
			this.forgetIfGone(id);
			return Promise.resolve(this.currentState(id));
		}
		const reservation = this.operationLock(id).acquire();
		const job = (async () => {
			const release = await reservation;
			try {
				return await this.reconcileLocked(id);
			} finally {
				release();
				this.forgetIfGone(id);
			}
		})();
		// A caller with several jobs awaits them one at a time, so a later one can settle
		// while an earlier is still being awaited. Attaching this here — synchronously, at
		// creation — is what keeps that from surfacing as an unhandled rejection; the caller
		// still sees the failure when its own await reaches that job, and the barrier below
		// waits on something that cannot reject.
		const settled = job.catch(() => {});
		this.activeReconciles.add(settled);
		void settled.then(() => this.activeReconciles.delete(settled));
		return job;
	}

	/**
	 * The lishnet as it stands right now, for a convergence that was never run.
	 *
	 * Read without the per-lishnet lock, which is only sound where it is used: the single
	 * caller holds the catalog with admission already closed, so the drain has finished and
	 * nothing can reserve a convergence that would move `joinedNetworks` underneath it.
	 */
	private currentState(id: string): ReconcileOutcome {
		const row = this.get(id);
		const outcome: ReconcileOutcome = { transitioned: false, joined: this.joinedNetworks.has(id) };
		if (row) outcome.network = { networkID: row.networkID, name: row.name };
		return outcome;
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

	/**
	 * Record the list a dial run is about to install and hand back the entry it reports to.
	 *
	 * An empty list is converged as soon as it is recorded: there is nothing to walk, and no
	 * dial will ever be started to say so.
	 */
	private beginBootstrapInstall(id: string, addresses: string[]): InstalledBootstrap {
		const entry: InstalledBootstrap = { addresses, complete: addresses.length === 0 };
		this.appliedBootstrap.set(id, entry);
		return entry;
	}

	/**
	 * Record that a dial run walked its whole list.
	 *
	 * Written to the entry that run STARTED with, never to whatever the map holds now: a run
	 * whose list has since been replaced is reporting about a list nothing reads any more, and
	 * writing `complete` from it would declare the new list converged on the strength of the
	 * old one's dials.
	 */
	private static finishBootstrapInstall(entry: InstalledBootstrap, result: BootstrapDialResult): void {
		if (result === 'completed') entry.complete = true;
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
	 * The bootstrap side converges {@link appliedBootstrap} — what this membership really put
	 * on the node — onto the stored row, rather than a `previous` row its caller captured.
	 * Only a lishnet we are IN has anything installed, so a change of list matters only while
	 * joined: a join installs the current list itself, and a leave takes back exactly what is
	 * recorded as installed.
	 *
	 * A list that has not been walked to the end is re-run even when it is IDENTICAL to the
	 * stored one. Equality of the two lists says the node was asked for the right addresses,
	 * not that anything was ever dialed for the later ones — a run cancelled by a shutdown, or
	 * one that rejected part-way, leaves exactly that: the right list, half of it attempted.
	 *
	 * Callers hold the lishnet's operation lock, and the whole outcome is assembled before it
	 * is released — see {@link ReconcileOutcome}.
	 */
	private async reconcileLocked(id: string): Promise<ReconcileOutcome> {
		const next = this.get(id);
		const wantJoined = next?.enabled === true;
		const joined = this.joinedNetworks.has(id);
		const entry = this.appliedBootstrap.get(id);
		const installed = entry?.addresses ?? [];
		const after = Networks.cleanBootstrapList(next?.bootstrapPeers ?? []);
		// Only for a membership that stays: a leave resets the whole status anyway and a dial
		// on the way out is pure waste, and a join has nothing installed yet to reconcile.
		if (joined && wantJoined && (installed.join('\n') !== after.join('\n') || entry?.complete === false)) this.syncBootstrapRuntime(id, installed, after);
		if (joined !== wantJoined) {
			if (wantJoined) await this.joinNetwork(id);
			else await this.leaveNetwork(id, installed);
		}
		const settled = this.joinedNetworks.has(id);
		const outcome: ReconcileOutcome = { transitioned: this.announce(id, settled), joined: settled };
		if (next) outcome.network = { networkID: next.networkID, name: next.name };
		return outcome;
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
		const configured = Networks.cleanBootstrapList(net?.bootstrapPeers ?? []);
		// Recorded BEFORE the dials, not after them: a dial that lands installs its address
		// whether or not the loop ever reaches the end, so an abandoned or failed run must
		// still leave a leave with something to clean up — see {@link appliedBootstrap}.
		const installed = this.beginBootstrapInstall(id, configured);
		if (configured.length > 0) Networks.finishBootstrapInstall(installed, await this.network.addBootstrapPeers(configured, id, 'configured'));

		// The dials above take seconds. A node that went DOWN during them owns neither the
		// subscription nor the connections this join was building, so the membership claim
		// has to go with it rather than survive into the next run.
		//
		// The question here is the node, not {@link canJoin}: a stop that has merely been
		// ASKED for is not a stop that happened. Answering the intent discarded the claim
		// before the stop was even attempted — and a stop that then failed left the node
		// alive, subscribed, and with nothing recording that we are in this lishnet, so the
		// next disable found "not joined, nothing to do" and unsubscribed nobody. The stop
		// waits for this operation and clears the membership itself once the node is
		// provably down; see {@link stopAllNetworks}.
		if (!this.network.isRunning()) {
			this.joinedNetworks.delete(id);
			this.appliedBootstrap.delete(id);
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
	private async leaveNetwork(id: string, outgoingBootstrap: string[]): Promise<void> {
		if (!this.joinedNetworks.has(id)) return;

		// The list this membership INSTALLED, not whatever the database holds now. Every
		// caller on the disable path writes the row before the runtime catches up — an edit
		// that swaps the bootstraps and disables in one go, or a `replace()`/`delete()` that
		// removes the row outright — so reading the row here cleaned up the INCOMING list (or
		// nothing at all) and left the outgoing addresses installed: still exempt from
		// eviction, still redialled.
		const outgoing = Networks.cleanBootstrapList(outgoingBootstrap);
		// One epoch for the whole leave. `disconnectPeer` defaults it per call, so a leave
		// parked inside the first peer's hangUp used to pick up the CURRENT run for the next
		// peer — surviving a stop and a start and then tearing down peers of a node that had
		// never heard of this lishnet.
		const epoch = this.network.getRunEpoch();

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
		// Nothing of this membership is installed from here on — the cleanup below works from
		// the local copy, and a reconcile that runs after it must not find a stale claim.
		this.appliedBootstrap.delete(id);
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
			await this.network.disconnectPeer(pid, id, epoch);
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
			await this.network.disconnectPeer(pid, id, epoch);
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
		this.stopRequested = true;
		// The door is closed from INSIDE the catalog, not here: a writer already queued on
		// the catalog reaches its database write before this call reaches the catalog at
		// all, and it has to get its reservation so the drain below covers it — see
		// {@link reconcileAdmissionClosed}. Everything through that door is in
		// {@link activeReconciles} and is waited for below, so the node is stopped with no
		// join or leave still holding a subscription, a peer or a dial.
		await this.catalogMutex.runExclusive(async () => {
			this.reconcileAdmissionClosed = true;
			// A join parked on a sequential walk of unreachable bootstrap addresses would hold
			// the drain for one connection timeout per address, and a leave parked on the hangUp
			// of an unresponsive peer would hold it with no deadline at all. Cancelling first is
			// what keeps waiting for them from presenting as a frozen shutdown.
			this.network.cancelRunOperations();
			await this.drainReconciles();
			// Cleared only once the node is provably down. Discarding the membership first
			// meant a stop that failed — leaving the node alive and the wrapper `failed` —
			// still left this layer claiming it was in no lishnet and had announced nothing.
			// `leaveNetwork()` begins with "not joined, nothing to do", so disabling one of
			// those networks afterwards wrote `enabled=false` and then unsubscribed nothing,
			// disconnected nobody and dropped no keep-alive tag, while the node went on
			// subscribed to the topic.
			try {
				await this.network.stop();
			} catch (err) {
				// Admission stays CLOSED, and the membership below stays untouched.
				//
				// Reopening it assumed a failed stop leaves an operable node. It never does:
				// `Network.stop()` leaves the instance `failed`, which refuses `start()` and
				// reads as not running, and its dial controller stays aborted with no path to a
				// fresh one — so a bootstrap change admitted after this would be written to the
				// database, reach `addBootstrapPeers()`, end on the aborted controller and
				// report success for a runtime that never converged. A retried stop is the only
				// thing that can still make progress, and only where the failure was in the
				// cleanup AFTER libp2p went down; see {@link Network.isStopTerminal}.
				const terminal = this.network.isStopTerminal();
				console.error(`[Networks] the node could not be stopped (${terminal ? 'terminal — the process must be restarted' : 'cleanup incomplete — the stop can be retried'}); lishnet writes are stored but no longer reach the runtime`);
				throw err;
			}
			// Per-run, like `joinedNetworks` itself. Surviving a stop left the map claiming
			// networks were still announced as joined, so after a restart a network that came
			// back disabled never produced the "left" event its subscribers were waiting for,
			// and a rejoin of one that had been announced before the stop produced no event
			// either — the runtime had changed and nobody was told.
			this.joinedNetworks.clear();
			this.announcedJoined.clear();
			// Per-run for the same reason: a stopped node holds none of the bootstrap state
			// these lists describe, and the next run installs its own.
			this.appliedBootstrap.clear();
			console.log('✓ All lishnets left and node stopped');
		});
	}

	/**
	 * Wait for every convergence that was reserved before the door closed.
	 *
	 * One pass is enough: a job is registered when its slot is RESERVED, not when it starts
	 * running, so the queued ones are in the set too and no new entry can appear while the
	 * catalog is held. The promises waited on never reject — see {@link reconcileLater}.
	 *
	 * The wait has no timeout and does not need one, because the work it waits for has been
	 * cancelled first: both halves of a convergence — the bootstrap dials of a join and the
	 * per-peer teardown of a leave — end on this run's abort rather than on a deadline of
	 * their own, so nothing is left that can outlive it. A timeout instead of cancelling
	 * would be the worse answer: the abandoned reconcile would still be running, and would
	 * come back to a stopped node or a new run's state.
	 */
	private async drainReconciles(): Promise<void> {
		if (this.activeReconciles.size === 0) return;
		console.log(`Waiting for ${this.activeReconciles.size} lishnet operation(s) to finish before stopping the node`);
		await Promise.all([...this.activeReconciles]);
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
		const job = await this.inCatalog(() => {
			upsertLISHnet(this.db, config.networkID, config.name, config.description, config.bootstrapPeers, config.enabled, config.created);
			return this.reconcileLater(config.networkID);
		});
		await job;
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
		// A network added as enabled has to be joined, not merely written down. An add of one
		// that already exists writes nothing and reconciles nothing: it used to claim a
		// revision anyway on the way in, which cancelled a queued enable of that very network
		// — a request that changed nothing discarding one that meant something.
		const job = await this.inCatalog(() => (addLISHnet(this.db, network) ? this.reconcileLater(network.networkID) : undefined));
		if (!job) return false;
		await job;
		return true;
	}

	async update(network: LISHNetworkConfig): Promise<boolean> {
		// Row read and write in ONE critical section. With the read outside it, a toggle
		// could slip between the two and be overwritten by a row this edit had already read.
		// The general edit form carries the bootstrap list AND the enabled flag, so this path
		// can change either one. Without the runtime reconciliation the edit would reach only
		// the database and the live node would keep dialing the previous list — or stay in a
		// network the edit had just disabled — until restart.
		const job = await this.inCatalog(() => {
			// Store the cleaned list, not the raw one: blank rows from the form would
			// otherwise be persisted while the runtime worked from the filtered copy, and
			// the two would disagree about what this network's bootstrap list even is.
			const cleaned = Networks.cleanBootstrapList(network.bootstrapPeers ?? []);
			return updateLISHnet(this.db, { ...network, bootstrapPeers: cleaned }) ? this.reconcileLater(network.networkID) : undefined;
		});
		if (!job) return false;
		await job;
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
		const job = await this.inCatalog(() => {
			if (!lishnetExists(this.db, id)) return undefined;
			deleteLISHnet(this.db, id);
			return this.reconcileLater(id);
		});
		if (!job) return false;
		await job;
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
		// Every affected network's turn is reserved before the catalog is released, so a
		// single-network write issued after this one cannot converge ahead of it on any of
		// them — see {@link reconcileLater}.
		const jobs = await this.inCatalog(() => {
			const rows = new Map(this.list().map(n => [n.networkID, n]));
			replaceLISHnets(this.db, networks);
			return [...new Set([...rows.keys(), ...networks.map(n => n.networkID)])].map(id => this.reconcileLater(id));
		});
		// One lishnet at a time, each under its own lock and none of them under the catalog.
		// Reconciling the whole set under the global lock meant a rewrite of a long list held
		// it across every affected network's dials and disconnects in turn.
		for (const job of jobs) await job;
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
			return { next, job: this.reconcileLater(id) };
		});
		if (!staged) return null;
		await staged.job;
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
	 *
	 * `installedPeers` is what this membership put on the node, taken from
	 * {@link appliedBootstrap}, and the new list replaces it there. Only a joined lishnet
	 * gets here, so the dial below always runs and the record always describes something
	 * real.
	 */
	private syncBootstrapRuntime(id: string, installed: string[], cleaned: string[]): void {
		const nextIDs = new Set(Networks.bootstrapPeerIDsOf(cleaned));
		const elsewhere = this.configuredBootstrapPeerIDsElsewhere(id);
		for (const pid of Networks.bootstrapPeerIDsOf(installed)) {
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
		const dropped = Networks.cleanBootstrapList(installed).filter(a => !keptAddresses.has(normalizeMultiaddrForCompare(a)) && !elsewhereAddresses.has(normalizeMultiaddrForCompare(a)));
		this.network.pruneBootstrapAddresses(dropped);
		this.network.pruneBootstrapStatus(id, cleaned);
		const entry = this.beginBootstrapInstall(id, cleaned);
		if (this.joinedNetworks.has(id) && cleaned.length > 0) {
			this.network.addBootstrapPeers(cleaned, id, 'configured').then(
				result => Networks.finishBootstrapInstall(entry, result),
				err => console.error(`[Networks] bootstrap re-dial after config change failed:`, err?.message ?? err)
			);
		}
	}
}
