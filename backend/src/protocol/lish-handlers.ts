import { existsSync } from 'fs';
import { trace } from '../logger.ts';
import { type DataServer } from '../lish/data-server.ts';
import { LISH_PROTOCOL, LISHClient, type HaveChunks, isUploadEnabled, isUploadAdvertisable } from './lish-protocol.ts';
import { isBusy } from '../api/busy.ts';
import { type WantMessage } from './downloader.ts';
import { type IDialResult } from './network.ts';
import { type Libp2p } from 'libp2p';

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
export interface LISHHandlersDeps {
	readonly dataServer: DataServer;
	/** Reference to Network's lastWantResponseTime Map — mutated in-place, owned by Network. */
	readonly lastWantResponseTime: Map<string, number>;
	/** Reference to Network's seenSearchIDs Map — mutated in-place, owned by Network. */
	readonly seenSearchIDs: Map<string, number>;
	/** Minimum interval between two `have` responses sent to the same peer for the same LISH. */
	readonly wantResponseCooldownMs: number;
	/** Returns the current libp2p node (may be null if not started). */
	getNode(): Libp2p | null;
	/** Dial a peer by peerID and open the given protocol stream. */
	dialByPeerId(peerID: string, protocol: string): Promise<IDialResult>;
}

/**
 * Handles incoming LISH-serving pubsub messages: `want` and `searchLishs`.
 * Extracted from Network to keep protocol/network.ts focused on connection management.
 */
export class LISHServingHandlers {
	private readonly deps: LISHHandlersDeps;

	constructor(deps: LISHHandlersDeps) {
		this.deps = deps;
	}

	/** Handle a `want` pubsub message from a remote peer requesting chunk metadata. */
	async handleWant(data: WantMessage, networkID: string, fromPeerID?: string): Promise<void> {
		// TODO(out of scope): enforce per-network ACL here — only answer a
		// WANT if `data.lishID` is actually shared into `networkID`. Today we
		// answer based solely on global upload-enabled state, so a peer on ANY
		// joined lishnet can pull any LISH we upload. Implementing this needs a
		// LISH↔networkIDs mapping in the DB which does not yet exist; until then
		// the topic membership is the only (coarse) access boundary.
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
		// Networks, by referenced networkID, are also checked: the seeder must belong to the same LISH net.
		// (networkID currently unused beyond routing; future: verify lish.networkIDs.includes(networkID).)
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
		try {
			const { stream } = await this.deps.dialByPeerId(fromPeerID, LISH_PROTOCOL);
			client = new LISHClient(stream);
			await client.announceHave(data.lishID, chunksPayload, myAddrs);
		} catch (err: any) {
			trace(`[NET] announceHave to ${fromPeerID.slice(0, 12)} failed: ${err?.message ?? err}`);
			await client?.close().catch(() => {});
			return;
		}
		await client.close().catch(() => {});
		// Record send time only after the announcement was sent; cleanup interval drains stale entries.
		this.deps.lastWantResponseTime.set(key, Date.now());
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
	 */
	async handleSearchLishs(data: SearchLishsMessage, networkID: string, fromPeerID?: string): Promise<void> {
		// TODO(out of scope): scope search results to LISHs actually shared
		// into `networkID` (hence the explicit `void networkID` below — the param
		// is received but not yet used for filtering). Blocked on the same missing
		// LISH↔networkIDs DB mapping as handleWant's ACL TODO.
		void networkID;
		if (!fromPeerID) {
			trace(`[NET] searchLishs ignored: no verified sender peerID`);
			return;
		}
		if (typeof data.searchID !== 'string' || typeof data.query !== 'string') return;
		// Empty / overly long queries are dropped — a defensive bound; UI input is much shorter.
		if (data.query.length === 0 || data.query.length > 256) return;
		// Don't reply to our own broadcast (we're a subscriber to the topic too).
		const node = this.deps.getNode();
		if (node && fromPeerID === node.peerId.toString()) return;
		// Dedup: same searchID arriving multiple times from gossipsub mesh — answer at most once.
		const lastSeen = this.deps.seenSearchIDs.get(data.searchID);
		if (lastSeen !== undefined) return;
		this.deps.seenSearchIDs.set(data.searchID, Date.now());
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
		try {
			const { stream } = await this.deps.dialByPeerId(fromPeerID, LISH_PROTOCOL);
			client = new LISHClient(stream);
			await client.sendSearchResult(data.searchID, matches);
		} catch (err: any) {
			trace(`[NET] sendSearchResult to ${fromPeerID.slice(0, 12)} failed: ${err?.message ?? err}`);
		}
		await client?.close().catch(() => {});
	}
}
