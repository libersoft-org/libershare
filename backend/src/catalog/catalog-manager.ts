import type { Database } from 'bun:sqlite';
import type { Ed25519PrivateKey } from '@libp2p/interface';
import { signCatalogOp, type SignedCatalogOp } from './catalog-signer.ts';
import { handleRemoteOp } from './catalog-validator.ts';
import { hlcMerge, type HLC } from './catalog-hlc.ts';
import { ensureCatalogACL, getCatalogACL, getCatalogEntry, listCatalogEntries, searchCatalog, getVectorClock, getAllVectorClocks, deleteTombstonesOlderThan, getEntryCount, getTombstoneCount, type CatalogEntryRow, type CatalogACLRow } from '../db/catalog.ts';

/** Constructor dependencies. Key and peer ID are lazy accessors because the libp2p node starts after the manager is built. */
export interface CatalogManagerConfig {
	db: Database;
	getPrivateKey: () => Ed25519PrivateKey;
	getLocalPeerID: () => string;
	broadcast?: ((networkID: string, op: SignedCatalogOp) => void) | undefined;
	emitEvent?: ((event: string, data: any) => void) | undefined;
}

/** Drop storage-only columns (signed_op blob, internal HLC parts) before an entry leaves through an event. */
function toPublicEntry(row: CatalogEntryRow | null): Omit<CatalogEntryRow, 'signed_op' | 'hlc_logical' | 'hlc_node' | 'id'> | null {
	if (!row) return null;
	const { signed_op: _blob, hlc_logical: _l, hlc_node: _n, id: _id, ...publicRow } = row;
	return publicRow;
}

/** Parse the stored tags JSON column, treating corrupt data as "no tags" instead of throwing. */
function parseStoredTags(tagsJson: string | null): string[] | undefined {
	if (!tagsJson) return undefined;
	try {
		const parsed = JSON.parse(tagsJson);
		return Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

interface JoinedNetwork {
	localClock: HLC;
	ownerPeerID: string;
	gcTimer: ReturnType<typeof setInterval> | null;
	lastSyncAt: string | null;
	/** Authorization-rejected remote ops parked for retry after a later ACL grant lands (bounded). */
	parkedOps: SignedCatalogOp[];
}

/** Upper bound on parked out-of-order ops per network — flooding beyond this evicts oldest first. */
const MAX_PARKED_OPS = 32;

/**
 * Per-network catalog state machine: join/leave lifecycle, signed CRDT write
 * operations (publish/update/remove/ACL), and read access over the SQLite
 * store. Network transport is deliberately outside (see CatalogNet).
 */
export class CatalogManager {
	private readonly db: Database;
	private readonly getPrivateKey: () => Ed25519PrivateKey;
	private readonly getLocalPeerID: () => string;
	private readonly broadcastFn: ((networkID: string, op: SignedCatalogOp) => void) | null;
	private readonly emitEventFn: ((event: string, data: any) => void) | null;
	private joined: Map<string, JoinedNetwork> = new Map();

	constructor(config: CatalogManagerConfig) {
		this.db = config.db;
		this.getPrivateKey = config.getPrivateKey;
		this.getLocalPeerID = config.getLocalPeerID;
		this.broadcastFn = config.broadcast ?? null;
		this.emitEventFn = config.emitEvent ?? null;
	}

	/** Join a network's catalog: seed the ACL with the owner, restore the local HLC and start tombstone GC. */
	join(networkID: string, ownerPeerID: string): void {
		if (this.joined.has(networkID)) return;
		ensureCatalogACL(this.db, networkID, ownerPeerID);

		const peerID = this.getLocalPeerID();
		const lastClock = getVectorClock(this.db, networkID, peerID);

		const net: JoinedNetwork = {
			localClock: lastClock ? { wallTime: Math.max(lastClock.hlc_wall, Date.now()), logical: lastClock.hlc_logical, nodeID: peerID } : { wallTime: Date.now(), logical: 0, nodeID: peerID },
			ownerPeerID,
			gcTimer: null,
			lastSyncAt: null,
			parkedOps: [],
		};

		// Start tombstone GC timer (every 6 hours)
		net.gcTimer = setInterval(
			() => {
				try {
					const deleted = deleteTombstonesOlderThan(this.db, networkID, 30);
					if (deleted > 0) console.log(`[Catalog] GC: removed ${deleted} tombstones from ${networkID}`);
				} catch (err) {
					console.warn(`[Catalog] GC error for ${networkID}:`, (err as Error).message);
				}
			},
			6 * 60 * 60 * 1000
		); // 6 hours

		this.joined.set(networkID, net);
	}

	/** Leave a network's catalog and stop its GC timer. Stored entries stay in the DB. */
	leave(networkID: string): void {
		const net = this.joined.get(networkID);
		if (net?.gcTimer) clearInterval(net.gcTimer);
		this.joined.delete(networkID);
	}

	isJoined(networkID: string): boolean {
		return this.joined.has(networkID);
	}

	getJoinedNetworks(): string[] {
		return [...this.joined.keys()];
	}

	private getNetwork(networkID: string): JoinedNetwork {
		const net = this.joined.get(networkID);
		if (!net) throw new Error(`Catalog not joined: ${networkID}`);
		return net;
	}

	// --- Read operations ---

	list(networkID: string, limit: number = 100): CatalogEntryRow[] {
		this.getNetwork(networkID);
		return listCatalogEntries(this.db, networkID, limit);
	}

	get(networkID: string, lishID: string): CatalogEntryRow | null {
		this.getNetwork(networkID);
		return getCatalogEntry(this.db, networkID, lishID);
	}

	search(networkID: string, query: string, limit: number = 100): CatalogEntryRow[] {
		this.getNetwork(networkID);
		return searchCatalog(this.db, networkID, query, limit);
	}

	getAccess(networkID: string): CatalogACLRow | null {
		this.getNetwork(networkID);
		return getCatalogACL(this.db, networkID);
	}

	// --- Write operations ---

	async publish(
		networkID: string,
		data: {
			lishID: string;
			name?: string;
			description?: string;
			publisherPeerID?: string;
			publishedAt?: string;
			chunkSize: number;
			checksumAlgo: string;
			totalSize: number;
			fileCount: number;
			manifestHash: string;
			contentType?: string;
			tags?: string[];
		}
	): Promise<void> {
		const net = this.getNetwork(networkID);
		const privateKey = this.getPrivateKey();

		const { op, updatedClock } = await signCatalogOp(
			privateKey,
			'add',
			networkID,
			{
				lishID: data.lishID,
				name: data.name,
				description: data.description,
				publisherPeerID: data.publisherPeerID ?? this.getLocalPeerID(),
				publishedAt: data.publishedAt ?? new Date().toISOString(),
				chunkSize: data.chunkSize,
				checksumAlgo: data.checksumAlgo,
				totalSize: data.totalSize,
				fileCount: data.fileCount,
				manifestHash: data.manifestHash,
				contentType: data.contentType,
				tags: data.tags,
			},
			net.localClock
		);
		net.localClock = updatedClock;

		const result = await handleRemoteOp(this.db, networkID, op);
		if (!result.valid) throw new Error(`Publish failed: ${(result as { reason: string }).reason}`);

		this.broadcastFn?.(networkID, op);
		this.emitEventFn?.('catalog:updated', { networkID, entry: toPublicEntry(getCatalogEntry(this.db, networkID, data.lishID)) });
	}

	async update(
		networkID: string,
		lishID: string,
		fields: {
			name?: string;
			description?: string;
			contentType?: string;
			tags?: string[];
		}
	): Promise<void> {
		const net = this.getNetwork(networkID);
		const privateKey = this.getPrivateKey();

		const existing = getCatalogEntry(this.db, networkID, lishID);
		if (!existing) throw new Error(`Entry not found: ${lishID}`);

		const { op, updatedClock } = await signCatalogOp(
			privateKey,
			'update',
			networkID,
			{
				lishID,
				name: fields.name ?? existing.name,
				description: fields.description ?? existing.description,
				publisherPeerID: existing.publisher_peer_id,
				publishedAt: existing.published_at,
				chunkSize: existing.chunk_size,
				checksumAlgo: existing.checksum_algo,
				totalSize: existing.total_size,
				fileCount: existing.file_count,
				manifestHash: existing.manifest_hash,
				contentType: fields.contentType ?? existing.content_type,
				tags: fields.tags ?? parseStoredTags(existing.tags),
			},
			net.localClock
		);
		net.localClock = updatedClock;

		const result = await handleRemoteOp(this.db, networkID, op);
		if (!result.valid) throw new Error(`Update failed: ${(result as { reason: string }).reason}`);

		this.broadcastFn?.(networkID, op);
		this.emitEventFn?.('catalog:updated', { networkID, entry: toPublicEntry(getCatalogEntry(this.db, networkID, lishID)) });
	}

	async remove(networkID: string, lishID: string): Promise<void> {
		const net = this.getNetwork(networkID);
		const privateKey = this.getPrivateKey();

		const { op, updatedClock } = await signCatalogOp(privateKey, 'remove', networkID, { lishID }, net.localClock);
		net.localClock = updatedClock;

		const result = await handleRemoteOp(this.db, networkID, op);
		if (!result.valid) throw new Error(`Remove failed: ${(result as { reason: string }).reason}`);

		this.broadcastFn?.(networkID, op);
		this.emitEventFn?.('catalog:removed', { networkID, lishID });
	}

	async grantRole(networkID: string, delegatee: string, role: 'admin' | 'moderator'): Promise<void> {
		const net = this.getNetwork(networkID);
		const privateKey = this.getPrivateKey();

		const { op, updatedClock } = await signCatalogOp(privateKey, 'acl_grant', networkID, { role, delegatee }, net.localClock);
		net.localClock = updatedClock;

		const result = await handleRemoteOp(this.db, networkID, op);
		if (!result.valid) throw new Error(`Grant failed: ${(result as { reason: string }).reason}`);

		this.broadcastFn?.(networkID, op);
		this.emitEventFn?.('catalog:acl', { networkID, access: getCatalogACL(this.db, networkID) });
	}

	async revokeRole(networkID: string, delegatee: string, role: 'admin' | 'moderator'): Promise<void> {
		const net = this.getNetwork(networkID);
		const privateKey = this.getPrivateKey();

		const { op, updatedClock } = await signCatalogOp(privateKey, 'acl_revoke', networkID, { role, delegatee }, net.localClock);
		net.localClock = updatedClock;

		const result = await handleRemoteOp(this.db, networkID, op);
		if (!result.valid) throw new Error(`Revoke failed: ${(result as { reason: string }).reason}`);

		this.broadcastFn?.(networkID, op);
		this.emitEventFn?.('catalog:acl', { networkID, access: getCatalogACL(this.db, networkID) });
	}

	/** Validate and apply an op received from the network (GossipSub). Returns true when accepted. */
	async applyRemoteOp(networkID: string, op: SignedCatalogOp): Promise<boolean> {
		if (!this.joined.has(networkID)) return false;
		const result = await handleRemoteOp(this.db, networkID, op);
		if (result.valid) {
			const net = this.joined.get(networkID);
			if (net) {
				net.lastSyncAt = new Date().toISOString();
				// Merge the remote HLC so subsequent local ops stay LWW-competitive
				// against peers with fast clocks (within the drift tolerance).
				net.localClock = hlcMerge(net.localClock, op.payload.hlc);
			}
			// A newly applied ACL op may authorize ops that were rejected earlier
			// (GossipSub delivers out of order) — give the parked ones another go.
			if (op.payload.type === 'acl_grant' || op.payload.type === 'acl_revoke') await this.retryParkedOps(networkID);
			this.emitEventFn?.('catalog:sync', {
				networkID,
				newEntries: 1,
				phase: 'complete',
			});
		} else if (this.isAuthorizationFailure(result)) {
			// GossipSub does not guarantee ordering: "A grants moderator B" can
			// arrive before "owner grants admin A". Park authorization-rejected
			// ops (bounded) and retry them once a later ACL op lands.
			this.parkRejectedOp(networkID, op);
		}
		return result.valid;
	}

	private isAuthorizationFailure(result: { valid: boolean }): boolean {
		const reason = (result as { reason?: string }).reason ?? '';
		return reason.startsWith('UNAUTHORIZED') || reason === 'ONLY_OWNER_CAN_MANAGE_ADMINS';
	}

	private parkRejectedOp(networkID: string, op: SignedCatalogOp): void {
		const net = this.joined.get(networkID);
		if (!net) return;
		if (net.parkedOps.length >= MAX_PARKED_OPS) net.parkedOps.shift();
		net.parkedOps.push(op);
	}

	/** Re-apply parked ops until a pass makes no progress. Ops that succeed also merge their HLC. */
	private async retryParkedOps(networkID: string): Promise<void> {
		const net = this.joined.get(networkID);
		if (!net || net.parkedOps.length === 0) return;
		let progress = true;
		while (progress && net.parkedOps.length > 0) {
			progress = false;
			const remaining: SignedCatalogOp[] = [];
			for (const parked of net.parkedOps) {
				const result = await handleRemoteOp(this.db, networkID, parked);
				if (result.valid) {
					progress = true;
					net.localClock = hlcMerge(net.localClock, parked.payload.hlc);
				} else {
					remaining.push(parked);
				}
			}
			net.parkedOps = remaining;
		}
	}

	/** Record a completed bilateral sync and notify API subscribers. */
	emitSyncComplete(networkID: string, newEntries: number): void {
		const net = this.joined.get(networkID);
		if (net) {
			net.lastSyncAt = new Date().toISOString();
			// Bilateral sync applies ops outside this manager — catch the clock up
			// to the highest watermark stored during the sync.
			for (const clock of getAllVectorClocks(this.db, networkID)) {
				net.localClock = hlcMerge(net.localClock, { wallTime: clock.hlc_wall, logical: clock.hlc_logical, nodeID: clock.peer_id });
			}
		}
		this.emitEventFn?.('catalog:sync', { networkID, newEntries, phase: 'complete' });
	}

	/** Delete tombstones older than `days`. Returns the number of rows removed. */
	gcTombstones(networkID: string, days: number = 30): number {
		return deleteTombstonesOlderThan(this.db, networkID, days);
	}

	/** Entry/tombstone counts plus the time of the last applied remote op or sync. */
	getSyncStatus(networkID: string): { entryCount: number; tombstoneCount: number; lastSyncAt: string | null } {
		const net = this.getNetwork(networkID);
		return {
			entryCount: getEntryCount(this.db, networkID),
			tombstoneCount: getTombstoneCount(this.db, networkID),
			lastSyncAt: net.lastSyncAt,
		};
	}
}
