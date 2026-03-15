import type { Database } from 'bun:sqlite';
import { encode, decode } from 'cbor-x';
import { type SignedCatalogOp } from './catalog-signer.ts';
import { handleRemoteOp } from './catalog-validator.ts';
import {
	getDeltaEntries,
	getDeltaTombstones,
	getAllVectorClocks,
	getCatalogACL,
	getEntryCount,
	getTombstoneCount,
} from '../db/catalog.ts';

const SYNC_PROTOCOL = '/lish/catalog-sync/1.0.0';

export { SYNC_PROTOCOL };

export interface SyncRequest {
	command: 'catalog_sync_req';
	requestID: string;
	networkID: string;
	sinceHlcWall: number;
}

export interface SyncResponse {
	command: 'catalog_sync_res';
	requestID: string;
	operations: Uint8Array[];
	aclJSON: string;
	vectorClocks: { peer_id: string; hlc_wall: number; hlc_logical: number }[];
	gcCutoff: number;
	entryCount: number;
	tombstoneCount: number;
}

export function buildSyncResponse(db: Database, networkID: string, sinceHlcWall: number): SyncResponse {
	const entries = getDeltaEntries(db, networkID, sinceHlcWall);
	const tombstones = getDeltaTombstones(db, networkID, sinceHlcWall);
	const acl = getCatalogACL(db, networkID);
	const clocks = getAllVectorClocks(db, networkID);

	// Collect signed_op blobs — raw bytes, no decode/re-encode
	const operations: Uint8Array[] = [];
	for (const entry of entries) {
		operations.push(new Uint8Array(entry.signed_op));
	}
	for (const tomb of tombstones) {
		operations.push(new Uint8Array(tomb.signed_op));
	}

	// GC cutoff: 30 days ago
	const gcCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

	return {
		command: 'catalog_sync_res',
		requestID: crypto.randomUUID(),
		operations,
		aclJSON: JSON.stringify(acl),
		vectorClocks: clocks.map(c => ({ peer_id: c.peer_id, hlc_wall: c.hlc_wall, hlc_logical: c.hlc_logical })),
		gcCutoff,
		entryCount: getEntryCount(db, networkID),
		tombstoneCount: getTombstoneCount(db, networkID),
	};
}

export async function applySyncResponse(db: Database, networkID: string, response: SyncResponse): Promise<number> {
	let applied = 0;
	for (const opBytes of response.operations) {
		try {
			const op = decode(Buffer.from(opBytes)) as SignedCatalogOp;
			const result = await handleRemoteOp(db, networkID, op);
			if (result.valid) applied++;
		} catch {
			// Skip malformed operations
		}
	}
	return applied;
}

export function encodeSyncRequest(req: SyncRequest): Uint8Array {
	return encode(req);
}

export function decodeSyncRequest(bytes: Uint8Array): SyncRequest {
	return decode(bytes) as SyncRequest;
}

export function encodeSyncResponse(res: SyncResponse): Uint8Array {
	return encode(res);
}

export function decodeSyncResponse(bytes: Uint8Array): SyncResponse {
	return decode(bytes) as SyncResponse;
}
