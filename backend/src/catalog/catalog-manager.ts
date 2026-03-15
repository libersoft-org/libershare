import type { Database } from 'bun:sqlite';
import type { Ed25519PrivateKey } from '@libp2p/interface';
import { signCatalogOp, type SignedCatalogOp } from './catalog-signer.ts';
import { handleRemoteOp } from './catalog-validator.ts';
import type { HLC } from './catalog-hlc.ts';
import {
	ensureCatalogACL,
	getCatalogACL,
	getCatalogEntry,
	listCatalogEntries,
	searchCatalog,
	getVectorClock,
	deleteTombstonesOlderThan,
	type CatalogEntryRow,
	type CatalogACLRow,
} from '../db/catalog.ts';

export interface CatalogManagerConfig {
	db: Database;
	getPrivateKey: () => Ed25519PrivateKey;
	getLocalPeerID: () => string;
	broadcast?: ((networkID: string, op: SignedCatalogOp) => void) | undefined;
	emitEvent?: ((event: string, data: any) => void) | undefined;
}

interface JoinedNetwork {
	localClock: HLC;
	ownerPeerID: string;
}

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

	join(networkID: string, ownerPeerID: string): void {
		if (this.joined.has(networkID)) return;
		ensureCatalogACL(this.db, networkID, ownerPeerID);

		const peerID = this.getLocalPeerID();
		const lastClock = getVectorClock(this.db, networkID, peerID);

		this.joined.set(networkID, {
			localClock: lastClock
				? { wallTime: Math.max(lastClock.hlc_wall, Date.now()), logical: lastClock.hlc_logical, nodeID: peerID }
				: { wallTime: Date.now(), logical: 0, nodeID: peerID },
			ownerPeerID,
		});
	}

	leave(networkID: string): void {
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

	async publish(networkID: string, data: {
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
	}): Promise<void> {
		const net = this.getNetwork(networkID);
		const privateKey = this.getPrivateKey();

		const { op, updatedClock } = await signCatalogOp(
			privateKey, 'add', networkID,
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
			net.localClock,
		);
		net.localClock = updatedClock;

		const result = await handleRemoteOp(this.db, networkID, op);
		if (!result.valid) throw new Error(`Publish failed: ${(result as { reason: string }).reason}`);

		this.broadcastFn?.(networkID, op);
		this.emitEventFn?.('catalog:updated', { networkID, entry: getCatalogEntry(this.db, networkID, data.lishID) });
	}

	async update(networkID: string, lishID: string, fields: {
		name?: string;
		description?: string;
		contentType?: string;
		tags?: string[];
	}): Promise<void> {
		const net = this.getNetwork(networkID);
		const privateKey = this.getPrivateKey();

		const existing = getCatalogEntry(this.db, networkID, lishID);
		if (!existing) throw new Error(`Entry not found: ${lishID}`);

		const { op, updatedClock } = await signCatalogOp(
			privateKey, 'update', networkID,
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
				tags: fields.tags ?? (existing.tags ? JSON.parse(existing.tags) : undefined),
			},
			net.localClock,
		);
		net.localClock = updatedClock;

		const result = await handleRemoteOp(this.db, networkID, op);
		if (!result.valid) throw new Error(`Update failed: ${(result as { reason: string }).reason}`);

		this.broadcastFn?.(networkID, op);
		this.emitEventFn?.('catalog:updated', { networkID, entry: getCatalogEntry(this.db, networkID, lishID) });
	}

	async remove(networkID: string, lishID: string): Promise<void> {
		const net = this.getNetwork(networkID);
		const privateKey = this.getPrivateKey();

		const { op, updatedClock } = await signCatalogOp(
			privateKey, 'remove', networkID, { lishID }, net.localClock,
		);
		net.localClock = updatedClock;

		const result = await handleRemoteOp(this.db, networkID, op);
		if (!result.valid) throw new Error(`Remove failed: ${(result as { reason: string }).reason}`);

		this.broadcastFn?.(networkID, op);
		this.emitEventFn?.('catalog:removed', { networkID, lishID });
	}

	async grantRole(networkID: string, delegatee: string, role: 'admin' | 'moderator'): Promise<void> {
		const net = this.getNetwork(networkID);
		const privateKey = this.getPrivateKey();

		const { op, updatedClock } = await signCatalogOp(
			privateKey, 'acl_grant', networkID,
			{ role, delegatee }, net.localClock,
		);
		net.localClock = updatedClock;

		const result = await handleRemoteOp(this.db, networkID, op);
		if (!result.valid) throw new Error(`Grant failed: ${(result as { reason: string }).reason}`);

		this.broadcastFn?.(networkID, op);
		this.emitEventFn?.('catalog:acl', { networkID, access: getCatalogACL(this.db, networkID) });
	}

	async revokeRole(networkID: string, delegatee: string, role: 'admin' | 'moderator'): Promise<void> {
		const net = this.getNetwork(networkID);
		const privateKey = this.getPrivateKey();

		const { op, updatedClock } = await signCatalogOp(
			privateKey, 'acl_revoke', networkID,
			{ role, delegatee }, net.localClock,
		);
		net.localClock = updatedClock;

		const result = await handleRemoteOp(this.db, networkID, op);
		if (!result.valid) throw new Error(`Revoke failed: ${(result as { reason: string }).reason}`);

		this.broadcastFn?.(networkID, op);
		this.emitEventFn?.('catalog:acl', { networkID, access: getCatalogACL(this.db, networkID) });
	}

	async applyRemoteOp(networkID: string, op: SignedCatalogOp): Promise<boolean> {
		if (!this.joined.has(networkID)) return false;
		const result = await handleRemoteOp(this.db, networkID, op);
		return result.valid;
	}

	gcTombstones(networkID: string, days: number = 30): number {
		return deleteTombstonesOlderThan(this.db, networkID, days);
	}
}
