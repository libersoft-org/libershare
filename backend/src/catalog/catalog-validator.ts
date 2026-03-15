import type { Database } from 'bun:sqlite';
import { encode as cborEncode } from 'cbor-x';
import { verifyCatalogOp, type SignedCatalogOp } from './catalog-signer.ts';
import {
	upsertCatalogEntry,
	upsertTombstone,
	isTombstoned,
	getCatalogACL,
	updateCatalogACL,
	getVectorClock,
	updateVectorClock,
	getEntryCount,
	type CatalogEntryInput,
} from '../db/catalog.ts';
import { RATE_LIMITS } from './catalog-rate-limiter.ts';

const MAX_DRIFT = 5 * 60 * 1000; // 5 minutes

const FIELD_LIMITS = {
	name: 256,
	description: 4096,
	tags: 10,
	tagLength: 32,
	contentType: 32,
} as const;

export type ValidationResult =
	| { valid: true }
	| { valid: false; reason: string };

export function validateFields(op: SignedCatalogOp): ValidationResult {
	const data = op.payload.data;
	if (typeof data['name'] === 'string' && Buffer.byteLength(data['name']) > FIELD_LIMITS.name) {
		return { valid: false, reason: 'FIELD_TOO_LARGE_NAME' };
	}
	if (typeof data['description'] === 'string' && Buffer.byteLength(data['description']) > FIELD_LIMITS.description) {
		return { valid: false, reason: 'FIELD_TOO_LARGE_DESCRIPTION' };
	}
	if (typeof data['contentType'] === 'string' && Buffer.byteLength(data['contentType']) > FIELD_LIMITS.contentType) {
		return { valid: false, reason: 'FIELD_TOO_LARGE_CONTENT_TYPE' };
	}
	if (Array.isArray(data['tags'])) {
		if (data['tags'].length > FIELD_LIMITS.tags) {
			return { valid: false, reason: 'TOO_MANY_TAGS' };
		}
		for (const tag of data['tags']) {
			if (typeof tag !== 'string' || Buffer.byteLength(tag) > FIELD_LIMITS.tagLength) {
				return { valid: false, reason: 'TAG_TOO_LARGE' };
			}
		}
	}
	return { valid: true };
}

function isOwnerOrAdmin(peerID: string, owner: string, admins: string[]): boolean {
	return peerID === owner || admins.includes(peerID);
}

function isOwnerOrAdminOrModerator(peerID: string, owner: string, admins: string[], moderators: string[]): boolean {
	return peerID === owner || admins.includes(peerID) || moderators.includes(peerID);
}

export function checkACL(db: Database, networkID: string, op: SignedCatalogOp): ValidationResult {
	const acl = getCatalogACL(db, networkID);
	if (!acl) return { valid: false, reason: 'NO_ACL' };

	const { type } = op.payload;
	const signer = op.signer;

	switch (type) {
		case 'add': {
			if (acl.restrict_writes && !isOwnerOrAdminOrModerator(signer, acl.owner, acl.admins, acl.moderators)) {
				return { valid: false, reason: 'UNAUTHORIZED_ADD' };
			}
			break;
		}
		case 'update':
		case 'remove': {
			if (!isOwnerOrAdminOrModerator(signer, acl.owner, acl.admins, acl.moderators)) {
				return { valid: false, reason: `UNAUTHORIZED_${type.toUpperCase()}` };
			}
			break;
		}
		case 'acl_grant':
		case 'acl_revoke': {
			const role = op.payload.data['role'] as string | undefined;
			if (role === 'admin') {
				if (signer !== acl.owner) {
					return { valid: false, reason: 'ONLY_OWNER_CAN_MANAGE_ADMINS' };
				}
			} else if (role === 'moderator') {
				if (!isOwnerOrAdmin(signer, acl.owner, acl.admins)) {
					return { valid: false, reason: 'UNAUTHORIZED_ACL_CHANGE' };
				}
			} else {
				return { valid: false, reason: 'INVALID_ROLE' };
			}
			break;
		}
	}

	return { valid: true };
}

export function checkVectorClock(db: Database, networkID: string, op: SignedCatalogOp): ValidationResult {
	const lastSeen = getVectorClock(db, networkID, op.signer);
	if (lastSeen) {
		const incoming = op.payload.hlc;
		// Compare only wallTime and logical — nodeID is irrelevant for anti-replay
		if (incoming.wallTime < lastSeen.hlc_wall
			|| (incoming.wallTime === lastSeen.hlc_wall && incoming.logical <= lastSeen.hlc_logical)) {
			return { valid: false, reason: 'REPLAY_DETECTED' };
		}
	}
	return { valid: true };
}

export async function handleRemoteOp(db: Database, networkID: string, op: SignedCatalogOp): Promise<ValidationResult> {
	// 1. SIGNATURE
	const sigValid = await verifyCatalogOp(op);
	if (!sigValid) {
		console.warn(`[Catalog] REJECTED: invalid signature from ${op.signer} on ${networkID}`);
		return { valid: false, reason: 'INVALID_SIGNATURE' };
	}

	// 2. ACL
	const aclResult = checkACL(db, networkID, op);
	if (!aclResult.valid) {
		console.warn(`[Catalog] REJECTED: ${(aclResult as { reason: string }).reason} — peer ${op.signer}, type ${op.payload.type}, network ${networkID}`);
		return aclResult;
	}

	// 3. DRIFT
	if (op.payload.hlc.wallTime > Date.now() + MAX_DRIFT) {
		console.warn(`[Catalog] REJECTED: clock drift from ${op.signer} — wallTime ${op.payload.hlc.wallTime} vs now ${Date.now()}`);
		return { valid: false, reason: 'CLOCK_DRIFT_TOO_HIGH' };
	}

	// 4. CONTENT
	const fieldsResult = validateFields(op);
	if (!fieldsResult.valid) return fieldsResult;

	// 4b. CATALOG SIZE LIMITS (only for add operations)
	if (op.payload.type === 'add') {
		const totalEntries = getEntryCount(db, networkID);
		if (totalEntries >= RATE_LIMITS.maxCatalogSize) {
			return { valid: false, reason: 'CATALOG_SIZE_LIMIT' };
		}
		const publisherCount = db.query<{ c: number }, [string, string]>(
			'SELECT COUNT(*) as c FROM catalog_entries WHERE network_id = ? AND publisher_peer_id = ?'
		).get(networkID, op.signer);
		if ((publisherCount?.c ?? 0) >= RATE_LIMITS.maxEntriesPerPublisher) {
			return { valid: false, reason: 'PUBLISHER_QUOTA_EXCEEDED' };
		}
	}

	// 5. ANTI-REPLAY
	const clockResult = checkVectorClock(db, networkID, op);
	if (!clockResult.valid) return clockResult;

	// ALL CHECKS PASSED — apply
	applyOp(db, networkID, op);

	// Update vector clock
	updateVectorClock(db, networkID, op.signer, op.payload.hlc.wallTime, op.payload.hlc.logical);

	return { valid: true };
}

function applyOp(db: Database, networkID: string, op: SignedCatalogOp): void {
	const { type, data, hlc } = op.payload;
	const signedOpBlob = cborEncode(op);

	switch (type) {
		case 'add':
		case 'update': {
			if (isTombstoned(db, networkID, data['lishID'] as string)) {
				return; // skip — entry is tombstoned
			}
			const entry: CatalogEntryInput = {
				network_id: networkID,
				lish_id: data['lishID'] as string,
				name: (data['name'] as string) ?? null,
				description: (data['description'] as string) ?? null,
				publisher_peer_id: (data['publisherPeerID'] as string) ?? op.signer,
				published_at: (data['publishedAt'] as string) ?? new Date().toISOString(),
				chunk_size: (data['chunkSize'] as number) ?? 0,
				checksum_algo: (data['checksumAlgo'] as string) ?? 'sha256',
				total_size: (data['totalSize'] as number) ?? 0,
				file_count: (data['fileCount'] as number) ?? 0,
				manifest_hash: (data['manifestHash'] as string) ?? '',
				content_type: (data['contentType'] as string) ?? null,
				tags: data['tags'] ? JSON.stringify(data['tags']) : null,
				last_edited_by: type === 'update' ? op.signer : null,
				hlc_wall: hlc.wallTime,
				hlc_logical: hlc.logical,
				hlc_node: hlc.nodeID,
				signed_op: signedOpBlob,
			};
			upsertCatalogEntry(db, entry);
			break;
		}
		case 'remove': {
			const lishID = data['lishID'] as string;
			upsertTombstone(db, {
				network_id: networkID,
				lish_id: lishID,
				removed_by: op.signer,
				removed_at: new Date().toISOString(),
				hlc_wall: hlc.wallTime,
				hlc_logical: hlc.logical,
				hlc_node: hlc.nodeID,
				signed_op: signedOpBlob,
			});
			// Remove entry from catalog (tombstone takes precedence)
			db.run('DELETE FROM catalog_entries WHERE network_id = ? AND lish_id = ?', [networkID, lishID]);
			break;
		}
		case 'acl_grant': {
			const acl = getCatalogACL(db, networkID);
			if (!acl) return;
			const role = data['role'] as string;
			const delegatee = data['delegatee'] as string;
			if (role === 'admin' && !acl.admins.includes(delegatee)) {
				updateCatalogACL(db, networkID, { admins: [...acl.admins, delegatee] });
			} else if (role === 'moderator' && !acl.moderators.includes(delegatee)) {
				updateCatalogACL(db, networkID, { moderators: [...acl.moderators, delegatee] });
			}
			break;
		}
		case 'acl_revoke': {
			const acl = getCatalogACL(db, networkID);
			if (!acl) return;
			const role = data['role'] as string;
			const delegatee = data['delegatee'] as string;
			if (role === 'admin') {
				const newAdmins = acl.admins.filter(a => a !== delegatee);
				// Cascading revocation: remove moderators granted by this admin
				updateCatalogACL(db, networkID, { admins: newAdmins });
			} else if (role === 'moderator') {
				updateCatalogACL(db, networkID, { moderators: acl.moderators.filter(m => m !== delegatee) });
			}
			break;
		}
	}
}
