import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Ed25519PrivateKey } from '@libp2p/interface';
import { initCatalogTables, ensureCatalogACL, getCatalogACL, getCatalogEntry, isTombstoned, updateCatalogACL } from '../../db/catalog.ts';
import { signCatalogOp } from '../catalog-signer.ts';
import { handleRemoteOp, validateFields, type ValidationResult } from '../catalog-validator.ts';
import type { HLC } from '../catalog-hlc.ts';
import type { SignedCatalogOp } from '../catalog-signer.ts';

let db: Database;
let ownerKey: Ed25519PrivateKey;
let moderatorKey: Ed25519PrivateKey;
let randomKey: Ed25519PrivateKey;

beforeEach(async () => {
	db = new Database(':memory:');
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA foreign_keys = ON');
	initCatalogTables(db);

	ownerKey = await generateKeyPair('Ed25519');
	moderatorKey = await generateKeyPair('Ed25519');
	randomKey = await generateKeyPair('Ed25519');

	ensureCatalogACL(db, 'net1', ownerKey.publicKey.toString());
	updateCatalogACL(db, 'net1', { moderators: [moderatorKey.publicKey.toString()] });
});

function makeClock(nodeID: string = 'test'): HLC {
	return { wallTime: Date.now(), logical: 0, nodeID };
}

async function signAdd(key: Ed25519PrivateKey, data: Record<string, unknown>, clock?: HLC) {
	return signCatalogOp(key, 'add', 'net1', data, clock ?? makeClock());
}

describe('handleRemoteOp — full validation chain', () => {
	test('valid add from moderator succeeds', async () => {
		const { op } = await signAdd(moderatorKey, {
			lishID: 'lish1', name: 'Test', publisherPeerID: moderatorKey.publicKey.toString(),
			publishedAt: '2026-01-01T00:00:00Z', chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 5000, fileCount: 3, manifestHash: 'abc',
		});
		const result = await handleRemoteOp(db, 'net1', op);
		expect(result.valid).toBe(true);
		const entry = getCatalogEntry(db, 'net1', 'lish1');
		expect(entry).not.toBeNull();
		expect(entry!.name).toBe('Test');
	});

	test('invalid signature rejected', async () => {
		const { op } = await signAdd(moderatorKey, { lishID: 'lish1' });
		op.payload.data = { lishID: 'TAMPERED' }; // break signature
		const result = await handleRemoteOp(db, 'net1', op);
		expect(result.valid).toBe(false);
		expect((result as { reason: string }).reason).toBe('INVALID_SIGNATURE');
	});

	test('unauthorized peer rejected (restricted mode)', async () => {
		const { op } = await signAdd(randomKey, { lishID: 'lish1' });
		const result = await handleRemoteOp(db, 'net1', op);
		expect(result.valid).toBe(false);
		expect((result as { reason: string }).reason).toBe('UNAUTHORIZED_ADD');
	});

	test('clock drift > 5 min rejected', async () => {
		const futureClock: HLC = { wallTime: Date.now() + 10 * 60 * 1000, logical: 0, nodeID: 'test' };
		const { op } = await signCatalogOp(moderatorKey, 'add', 'net1', { lishID: 'lish1' }, futureClock);
		const result = await handleRemoteOp(db, 'net1', op);
		expect(result.valid).toBe(false);
		expect((result as { reason: string }).reason).toBe('CLOCK_DRIFT_TOO_HIGH');
	});

	test('oversized name rejected', async () => {
		const bigName = 'x'.repeat(300);
		const { op } = await signAdd(moderatorKey, { lishID: 'lish1', name: bigName });
		const result = await handleRemoteOp(db, 'net1', op);
		expect(result.valid).toBe(false);
		expect((result as { reason: string }).reason).toBe('FIELD_TOO_LARGE_NAME');
	});

	test('replay rejected (HLC <= last seen)', async () => {
		// Use a high future clock so hlcTick increments logical, not wallTime
		const futureBase: HLC = { wallTime: Date.now() + 50_000, logical: 0, nodeID: 'test' };
		const { op: op1, updatedClock } = await signAdd(moderatorKey, { lishID: 'lish1' }, futureBase);
		// op1 has HLC = (futureBase.wallTime, 1, ...) since hlcTick increments logical
		await handleRemoteOp(db, 'net1', op1);

		// Sign op2 with same base clock — hlcTick gives same (wallTime, 1) = equal to op1's HLC
		const { op: op2 } = await signAdd(moderatorKey, { lishID: 'lish2' }, futureBase);
		const result = await handleRemoteOp(db, 'net1', op2);
		expect(result.valid).toBe(false);
		expect((result as { reason: string }).reason).toBe('REPLAY_DETECTED');
	});

	test('sequential ops from same peer accepted', async () => {
		let clock = makeClock();
		const { op: op1, updatedClock: clock2 } = await signAdd(moderatorKey, { lishID: 'lish1' }, clock);
		await handleRemoteOp(db, 'net1', op1);

		const { op: op2 } = await signAdd(moderatorKey, { lishID: 'lish2' }, clock2);
		const result = await handleRemoteOp(db, 'net1', op2);
		expect(result.valid).toBe(true);
	});
});

describe('ACL operations', () => {
	test('owner can grant admin', async () => {
		const newAdmin = await generateKeyPair('Ed25519');
		const { op } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'admin', delegatee: newAdmin.publicKey.toString(),
		}, makeClock());
		const result = await handleRemoteOp(db, 'net1', op);
		expect(result.valid).toBe(true);
		const acl = getCatalogACL(db, 'net1');
		expect(acl!.admins).toContain(newAdmin.publicKey.toString());
	});

	test('admin can grant moderator', async () => {
		// First make an admin
		const adminKey = await generateKeyPair('Ed25519');
		const { op: grantOp, updatedClock } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'admin', delegatee: adminKey.publicKey.toString(),
		}, makeClock());
		await handleRemoteOp(db, 'net1', grantOp);

		// Admin grants moderator
		const newMod = await generateKeyPair('Ed25519');
		const { op: modOp } = await signCatalogOp(adminKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: newMod.publicKey.toString(),
		}, makeClock());
		const result = await handleRemoteOp(db, 'net1', modOp);
		expect(result.valid).toBe(true);
		const acl = getCatalogACL(db, 'net1');
		expect(acl!.moderators).toContain(newMod.publicKey.toString());
	});

	test('moderator cannot grant roles (anti-escalation)', async () => {
		const newMod = await generateKeyPair('Ed25519');
		const { op } = await signCatalogOp(moderatorKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: newMod.publicKey.toString(),
		}, makeClock());
		const result = await handleRemoteOp(db, 'net1', op);
		expect(result.valid).toBe(false);
		expect((result as { reason: string }).reason).toBe('UNAUTHORIZED_ACL_CHANGE');
	});

	test('owner can revoke admin', async () => {
		const adminKey = await generateKeyPair('Ed25519');
		// Grant admin
		const { op: grantOp, updatedClock } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'admin', delegatee: adminKey.publicKey.toString(),
		}, makeClock());
		await handleRemoteOp(db, 'net1', grantOp);

		// Revoke admin
		const { op: revokeOp } = await signCatalogOp(ownerKey, 'acl_revoke', 'net1', {
			role: 'admin', delegatee: adminKey.publicKey.toString(),
		}, updatedClock);
		const result = await handleRemoteOp(db, 'net1', revokeOp);
		expect(result.valid).toBe(true);
		const acl = getCatalogACL(db, 'net1');
		expect(acl!.admins).not.toContain(adminKey.publicKey.toString());
	});
});

describe('remove operations', () => {
	test('moderator can remove entry', async () => {
		// Add entry first
		const clock = makeClock();
		const { op: addOp, updatedClock } = await signAdd(moderatorKey, {
			lishID: 'lish1', name: 'Test', publisherPeerID: moderatorKey.publicKey.toString(),
		}, clock);
		await handleRemoteOp(db, 'net1', addOp);

		// Remove it
		const { op: removeOp } = await signCatalogOp(moderatorKey, 'remove', 'net1', { lishID: 'lish1' }, updatedClock);
		const result = await handleRemoteOp(db, 'net1', removeOp);
		expect(result.valid).toBe(true);
		expect(isTombstoned(db, 'net1', 'lish1')).toBe(true);
	});

	test('add after tombstone is skipped', async () => {
		// Tombstone first
		const clock = makeClock();
		const { op: removeOp, updatedClock } = await signCatalogOp(moderatorKey, 'remove', 'net1', { lishID: 'lish1' }, clock);
		await handleRemoteOp(db, 'net1', removeOp);

		// Try to add — should be skipped (tombstoned)
		const { op: addOp } = await signAdd(moderatorKey, { lishID: 'lish1', name: 'Revived' }, updatedClock);
		await handleRemoteOp(db, 'net1', addOp);
		const entry = getCatalogEntry(db, 'net1', 'lish1');
		expect(entry).toBeNull(); // not added because tombstoned
	});
});

describe('validateFields', () => {
	test('valid fields pass', () => {
		const op = { payload: { data: { name: 'OK', description: 'Fine', tags: ['a', 'b'] } } } as unknown as SignedCatalogOp;
		expect(validateFields(op).valid).toBe(true);
	});

	test('too many tags rejected', () => {
		const tags = Array.from({ length: 15 }, (_, i) => `tag${i}`);
		const op = { payload: { data: { tags } } } as unknown as SignedCatalogOp;
		const result = validateFields(op);
		expect(result.valid).toBe(false);
		expect((result as { reason: string }).reason).toBe('TOO_MANY_TAGS');
	});
});

describe('open mode', () => {
	test('any peer can add in open mode', async () => {
		updateCatalogACL(db, 'net1', { restrict_writes: 0 });
		const { op } = await signAdd(randomKey, { lishID: 'lish1', name: 'Open' });
		const result = await handleRemoteOp(db, 'net1', op);
		expect(result.valid).toBe(true);
	});
});
