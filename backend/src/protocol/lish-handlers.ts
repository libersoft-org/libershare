import { existsSync } from 'fs';
import { trace } from '../logger.ts';
import { type DataServer } from '../lish/data-server.ts';
import { LISH_PROTOCOL, LISHClient, type HaveChunks, isUploadEnabled, isUploadAdvertisable } from './lish-protocol.ts';
import { isBusy } from '../api/busy.ts';
import { type WantMessage } from './downloader.ts';
import { type IDialResult } from './network.ts';
import { type Libp2p } from 'libp2p';
import { MAX_SEARCH_ID_LENGTH, MAX_SEARCH_QUERY_LENGTH } from './constants.ts';

/**
 * Pubsub query: "Find LISHs whose name or ID matches `query`".
 * Sent by a peer that opened the "Browse network" page; received by every subscriber to the topic.
 * Match is case-insensitive substring on `id` and (if present) `name`.
 * Responses come back as unicast `searchResult` messages on the LISH protocol (see lish-protocol.ts).
 */
export interface SearchLishsMessage {
	type: 'searchLishs';
	searchID: string;
	query: string;
}

/** Returns true if a LISH should be included in search results (i.e. upload-advertised). */
export function isSearchAdvertisableLish(lish: import('@shared').IStoredLISH): boolean {
	return isUploadAdvertisable(lish.id);
}

/** Dependencies for LISHServingHandlers. Maps owned by Network are passed by reference. */
/** A search we have already answered, and every lishnet the same query reached us over. */
export interface SeenSearch {
	at: number;
	networks: Set<string>;
	/** How the FIRST copy was judged — see the branch note in handleSearchLishs. */
	wasDirect: boolean;
}

export interface LISHHandlersDeps {
	readonly dataServer: DataServer;
	/** Reference to Network's lastWantResponseTime Map — mutated in-place, owned by Network. */
	readonly lastWantResponseTime: Map<string, number>;
	/** Reference to Network's seenSearchIDs Map — mutated in-place, owned by Network. */
	readonly seenSearchIDs: Map<string, SeenSearch>;
	/** Minimum interval between two `have` responses sent to the same peer for the same LISH. */
	readonly wantResponseCooldownMs: number;
	/** Returns the current libp2p node (may be null if not started). */
	getNode(): Libp2p | null;
	/** Dial a peer by peerID and open the given protocol stream; `signal` cancels the dial. */
	dialByPeerId(peerID: string, protocol: string, signal?: AbortSignal): Promise<IDialResult>;
	/**
	 * Membership gate for a request that reached us over pubsub. gossipsub delivers a
	 * topic message because WE are subscribed, never because the publisher is, so the
	 * pubsub path needs the same lishnet-membership check the unicast path applies.
	 */
	canServePubsubRequestTo(peerID: string, treatAsDirect?: boolean): boolean;
	/** Whether we hold a direct connection to this peer right now. */
	isDirectPeer(peerID: string): boolean;
	/** Whether we are still joined to this specific lishnet. */
	isJoinedToLishnet(networkID: string): boolean;
}

/**
 * Handles incoming LISH-serving pubsub messages: `want` and `searchLishs`.
 * Extracted from Network to keep protocol/network.ts focused on connection management.
 */
export class LISHServingHandlers {
	private readonly deps: LISHHandlersDeps;
	/**
	 * The current run's replies: one signal that ends them all, and every reply still under
	 * way. Stop and reset abort the run and wait for its replies before the maps they write
	 * are cleared; a new run starts with its own, so a late reply of the old one can neither
	 * send nor write anything.
	 */
	private run = { abort: new AbortController(), replies: new Set<Promise<void>>() };

	constructor(deps: LISHHandlersDeps) {
		this.deps = deps;
	}

	/** Answer a `want` as part of the current run; nothing is admitted once the run is aborted. */
	dispatchWant(data: WantMessage, networkID: string, fromPeerID?: string): void {
		this.track('handleWant', signal => this.handleWant(data, networkID, fromPeerID, signal));
	}

	/** Answer a `searchLishs` as part of the current run. */
	dispatchSearch(data: SearchLishsMessage, networkID: string, fromPeerID?: string): void {
		this.track('handleSearchLishs', signal => this.handleSearchLishs(data, networkID, fromPeerID, signal));
	}

	private track(label: string, reply: (signal: AbortSignal) => Promise<void>): void {
		const run = this.run;
		if (run.abort.signal.aborted) return;
		const tracked: Promise<void> = reply(run.abort.signal)
			.catch(err => trace(`[NET] ${label} failed: ${err?.message ?? err}`))
			.finally(() => run.replies.delete(tracked));
		run.replies.add(tracked);
	}

	/** Abort the current run and wait until every reply it admitted has finished. */
	async drain(): Promise<void> {
		const run = this.run;
		run.abort.abort();
		while (run.replies.size > 0) await Promise.allSettled([...run.replies]);
	}

	/** Start admitting replies again, under a run of their own. */
	newRun(): void {
		if (this.run.abort.signal.aborted) this.run = { abort: new AbortController(), replies: new Set() };
	}

	/** Handle a `want` pubsub message from a remote peer requesting chunk metadata. */
	async handleWant(data: WantMessage, networkID: string, fromPeerID?: string, signal?: AbortSignal): Promise<void> {
		// Every LISH with upload on is offered in every lishnet we are joined to; who may ask is
		// decided by lishnet membership, not by the LISH.
		if (!fromPeerID) {
			trace(`[NET] want ignored: no verified sender peerID`);
			return;
		}
		if (!isUploadEnabled(data.lishID)) {
			trace(`[NET] want ignored: upload disabled for ${data.lishID.slice(0, 8)}`);
			return;
		}
		if (isBusy(data.lishID)) {
			trace(`[NET] want ignored: busy for ${data.lishID.slice(0, 8)}`);
			return;
		}
		// Per-(peer,lish) rate-limit: ignore want from same peer for same LISH within cooldown.
		// Without this, an aggressive (or buggy) peer could trigger many redundant HAVE responses.
		const key = `${fromPeerID}:${data.lishID}`;
		const last = this.deps.lastWantResponseTime.get(key);
		if (last !== undefined && Date.now() - last < this.deps.wantResponseCooldownMs) {
			trace(`[NET] want rate-limited: ${fromPeerID.slice(0, 12)} for ${data.lishID.slice(0, 8)} (cooldown)`);
			return;
		}
		void networkID;
		const lish = this.deps.dataServer.get(data.lishID);
		if (!lish) return;
		// Verify data directory exists on disk — prevents false-positive "have"
		// when DB says have=TRUE but files were lost (e.g. Docker rebuild without volume)
		if (!lish.directory || !existsSync(lish.directory)) {
			console.warn(`[NET] want ignored: data directory missing for ${data.lishID.slice(0, 8)} (${lish.directory ?? 'no dir'})`);
			return;
		}
		const haveChunks = this.deps.dataServer.getHaveChunks(data.lishID);
		if (haveChunks !== 'all' && haveChunks.size === 0) {
			trace(`[NET] no chunks for ${data.lishID.slice(0, 8)}`);
			return;
		}
		const node = this.deps.getNode();
		if (!node) return;
		const myAddrs = node.getMultiaddrs().map(ma => ma.toString());
		const chunksPayload: HaveChunks = haveChunks === 'all' ? 'all' : Array.from(haveChunks);
		console.debug(`[NET] sending unicast HAVE to ${fromPeerID.slice(0, 12)} for ${data.lishID.slice(0, 8)}, chunks=${chunksPayload === 'all' ? 'ALL' : chunksPayload.length}`);
		// Open a fresh LISH protocol stream to the requester and send the HAVE announcement.
		// Errors are traced (not thrown) — a single unreachable requester mustn't break our own subscription.
		let client: LISHClient | undefined;
		const onAbort = (): void => client?.abort(new Error('pubsub replies stopped'));
		signal?.addEventListener('abort', onAbort, { once: true });
		try {
			try {
				const { stream } = await this.deps.dialByPeerId(fromPeerID, LISH_PROTOCOL, signal);
				client = new LISHClient(stream);
				if (signal?.aborted) {
					client.abort(new Error('pubsub replies stopped'));
					return;
				}
				await client.announceHave(data.lishID, chunksPayload, myAddrs);
			} catch (err: any) {
				trace(`[NET] announceHave to ${fromPeerID.slice(0, 12)} failed: ${err?.message ?? err}`);
				await client?.close().catch(() => {});
				return;
			}
			await client.close().catch(() => {});
			// The run that sent it has ended: its maps belong to the next run now.
			if (signal?.aborted) return;
			// Record send time only after the announcement was sent; cleanup interval drains stale entries.
			this.deps.lastWantResponseTime.set(key, Date.now());
		} finally {
			signal?.removeEventListener('abort', onAbort);
		}
	}

	/**
	 * Handle an incoming pubsub `searchLishs` query from a peer browsing the network.
	 * - Iterates locally shared (upload-enabled) LISHs
	 * - Filters by case-insensitive substring on `id` and `name`
	 * - If at least one match → opens a fresh LISH protocol stream to the requester and sends `searchResult`
	 * Empty result → no response (saves a stream open for non-matching peers).
	 *
	 * `seenSearchIDs` deduplicates queries arriving multiple times via the gossipsub mesh
	 * (same query can hit the same node from several peering paths).
	 *
	 * Answering requires the same lishnet membership the unicast `getLishs` gate demands:
	 * this returns the very same catalog rows, so leaving it ungated would make that gate
	 * decorative for anyone willing to publish on the topic instead of dialing us.
	 */
	async handleSearchLishs(data: SearchLishsMessage, networkID: string, fromPeerID?: string, signal?: AbortSignal): Promise<void> {
		// Results are every LISH we share, the same in every lishnet we are joined to.
		// `networkID` matters for something narrower: the request arrived over this lishnet,
		// so leaving that lishnet ends it.
		if (!fromPeerID) {
			trace(`[NET] searchLishs ignored: no verified sender peerID`);
			return;
		}
		if (typeof data.searchID !== 'string' || typeof data.query !== 'string') return;
		// The searchID becomes a key in seenSearchIDs and is echoed back in the response,
		// so an unbounded one is attacker-controlled memory we hold for the dedup window.
		if (data.searchID.length === 0 || data.searchID.length > MAX_SEARCH_ID_LENGTH) return;
		// Empty / overly long queries are dropped — a defensive bound; UI input is much shorter.
		if (data.query.length === 0 || data.query.length > MAX_SEARCH_QUERY_LENGTH) return;
		// Don't reply to our own broadcast (we're a subscriber to the topic too).
		const node = this.deps.getNode();
		if (node && fromPeerID === node.peerId.toString()) return;
		// Dedup: the same query arriving multiple times from the gossipsub mesh — answer at most
		// once. Keyed by SENDER as well as searchID: the id is the sender's own choice, so a
		// shared key would let any peer reach into someone else's entry — burning the id before
		// the real search arrives, or adding a lishnet to it and so widening the window the
		// leave-check below is there to close.
		//
		// The lishnets it arrived over are all recorded, because one search is broadcast on
		// every joined topic and the same query legitimately reaches us once per shared
		// lishnet. Keeping only the first would let leaving THAT one lishnet bury a request
		// that also arrived over a lishnet we are still in.
		const dedupKey = `${fromPeerID}\u0000${data.searchID}`;
		const seen = this.deps.seenSearchIDs.get(dedupKey);
		// Which branch to judge on. Opening the reply stream makes an indirect publisher a
		// direct neighbour, so a LATER copy of a query already in flight would be judged as
		// direct and refused for a membership its branch never required — and refused before
		// its lishnet was recorded, losing the one still-valid route to it. The sender's
		// standing has not changed; only our own dial has. So a copy is judged the way the
		// first copy was, and only a first copy consults the live connection.
		const wasDirect = seen?.wasDirect ?? this.deps.isDirectPeer(fromPeerID);
		if (!this.deps.canServePubsubRequestTo(fromPeerID, wasDirect)) {
			trace(`[NET] searchLishs from ${fromPeerID.slice(0, 12)} refused: no shared joined lishnet`);
			return;
		}
		if (seen !== undefined) {
			seen.networks.add(networkID);
			return;
		}
		const arrivedOver = new Set<string>([networkID]);
		const entry: SeenSearch = { at: Date.now(), networks: arrivedOver, wasDirect };
		this.deps.seenSearchIDs.set(dedupKey, entry);
		const q = data.query.toLowerCase();
		const matches: Array<{ id: string; name?: string; totalSize?: number }> = [];
		for (const lish of this.deps.dataServer.list()) {
			if (!isSearchAdvertisableLish(lish)) continue;
			const idLower = lish.id.toLowerCase();
			const nameLower = lish.name?.toLowerCase() ?? '';
			if (!idLower.includes(q) && !nameLower.includes(q)) continue;
			const totalSize = (lish.files ?? []).reduce((sum: number, f: { size: number }) => sum + f.size, 0);
			const entry: { id: string; name?: string; totalSize?: number } = { id: lish.id, totalSize };
			if (lish.name !== undefined) entry.name = lish.name;
			matches.push(entry);
		}
		if (matches.length === 0) return;
		trace(`[NET] searchLishs ${data.searchID.slice(0, 8)} from ${fromPeerID.slice(0, 12)}: ${matches.length} match(es)`);
		let client: LISHClient | undefined;
		const onAbort = (): void => client?.abort(new Error('pubsub replies stopped'));
		signal?.addEventListener('abort', onAbort, { once: true });
		try {
			const { stream } = await this.deps.dialByPeerId(fromPeerID, LISH_PROTOCOL, signal);
			client = new LISHClient(stream);
			if (signal?.aborted) {
				client.abort(new Error('pubsub replies stopped'));
				return;
			}
			// Opening the stream takes time, and the peer can leave inside it. The rows were
			// gathered under a permission it no longer has, so ask again before they go out —
			// judged on the same branch it was admitted on.
			// Leaving the lishnets the request came in over ends that request, whatever OTHER
			// lishnets we are in: an indirect publisher proved membership of none of them, and
			// a direct one's standing elsewhere is a different conversation than this one. Any
			// one of the lishnets it did arrive over still carries it, including copies that
			// landed while this reply was connecting.
			if (![...arrivedOver].some(n => this.deps.isJoinedToLishnet(n)) || !this.deps.canServePubsubRequestTo(fromPeerID, wasDirect)) {
				trace(`[NET] searchLishs to ${fromPeerID.slice(0, 12)} dropped: access withdrawn while connecting`);
				// Forgotten, not just dropped: the dedup entry means "already answered", and this
				// query was not. A later copy of the same search — over a lishnet we are still in,
				// arriving after this one died — has to be able to earn its own answer.
				// Only our own entry: a newer copy may own the slot by now.
				if (this.deps.seenSearchIDs.get(dedupKey) === entry) this.deps.seenSearchIDs.delete(dedupKey);
				client.abort(new Error('listing access withdrawn'));
				return;
			}
			await client.sendSearchResult(data.searchID, matches);
		} catch (err: any) {
			trace(`[NET] sendSearchResult to ${fromPeerID.slice(0, 12)} failed: ${err?.message ?? err}`);
		}
		try {
			// Still abortable: a graceful close can wait on the transport, and a stop must not.
			await client?.close().catch(() => {});
		} finally {
			signal?.removeEventListener('abort', onAbort);
		}
	}
}
