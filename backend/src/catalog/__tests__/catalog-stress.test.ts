import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Ed25519PrivateKey } from '@libp2p/interface';
import { initCatalogTables, ensureCatalogACL, listCatalogEntries, getCatalogEntry, deleteTombstonesOlderThan } from '../../db/catalog.ts';
import { signCatalogOp } from '../catalog-signer.ts';
import { handleRemoteOp } from '../catalog-validator.ts';
import type { HLC } from '../catalog-hlc.ts';

let db: Database;
let ownerKey: Ed25519PrivateKey;

beforeEach(async () => {
	db = new Database(':memory:');
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA foreign_keys = ON');
	initCatalogTables(db);
	ownerKey = await generateKeyPair('Ed25519');
	ensureCatalogACL(db, 'net1', ownerKey.publicKey.toString());
});

function clock(): HLC {
	return { wallTime: Date.now(), logical: 0, nodeID: 'stress' };
}

describe('Stress: Bulk operations', () => {
	test('100 entries from single moderator', async () => {
		const mod = await generateKeyPair('Ed25519');
		const { op: g } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod.publicKey.toString(),
		}, clock());
		await handleRemoteOp(db, 'net1', g);

		let modClock = clock();
		for (let i = 0; i < 100; i++) {
			const { op, updatedClock } = await signCatalogOp(mod, 'add', 'net1', {
				lishID: `bulk-${i}`, name: `Entry ${i}`, description: `Description for entry ${i}`,
				publisherPeerID: mod.publicKey.toString(), publishedAt: new Date().toISOString(),
				chunkSize: 1024, checksumAlgo: 'sha256', totalSize: i * 100, fileCount: 1,
				manifestHash: `hash-${i}`, tags: ['bulk', `group-${i % 5}`],
			}, modClock);
			modClock = updatedClock;
			const result = await handleRemoteOp(db, 'net1', op);
			expect(result.valid).toBe(true);
		}

		const entries = listCatalogEntries(db, 'net1', 200);
		expect(entries.length).toBe(100);
	});

	test('10 moderators each publish 10 entries', async () => {
		const mods: Ed25519PrivateKey[] = [];
		let oClock = clock();
		for (let i = 0; i < 10; i++) {
			const mod = await generateKeyPair('Ed25519');
			mods.push(mod);
			const { op, updatedClock } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
				role: 'moderator', delegatee: mod.publicKey.toString(),
			}, oClock);
			oClock = updatedClock;
			await handleRemoteOp(db, 'net1', op);
		}

		for (let m = 0; m < 10; m++) {
			let mClock = clock();
			for (let i = 0; i < 10; i++) {
				const { op, updatedClock } = await signCatalogOp(mods[m]!, 'add', 'net1', {
					lishID: `mod${m}-entry${i}`, name: `Mod${m} Entry${i}`,
					publisherPeerID: mods[m]!.publicKey.toString(), publishedAt: new Date().toISOString(),
					chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 500, fileCount: 1,
					manifestHash: `hash-m${m}-e${i}`,
				}, mClock);
				mClock = updatedClock;
				await handleRemoteOp(db, 'net1', op);
			}
		}

		expect(listCatalogEntries(db, 'net1', 200).length).toBe(100);
	});
});

describe('Stress: Rapid updates to same entry', () => {
	test('50 updates to same entry — last one wins', async () => {
		const mod = await generateKeyPair('Ed25519');
		const { op: g } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod.publicKey.toString(),
		}, clock());
		await handleRemoteOp(db, 'net1', g);

		let modClock = clock();
		for (let i = 0; i < 50; i++) {
			const { op, updatedClock } = await signCatalogOp(mod, i === 0 ? 'add' : 'update', 'net1', {
				lishID: 'rapid', name: `Version ${i}`,
				publisherPeerID: mod.publicKey.toString(), publishedAt: new Date().toISOString(),
				chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 1000 + i, fileCount: 1,
				manifestHash: 'hash-rapid',
			}, modClock);
			modClock = updatedClock;
			await handleRemoteOp(db, 'net1', op);
		}

		const entry = getCatalogEntry(db, 'net1', 'rapid');
		expect(entry!.name).toBe('Version 49');
	});
});

describe('Edge case: Tombstone interactions', () => {
	test('remove then re-add with same lishID is blocked by tombstone', async () => {
		const mod = await generateKeyPair('Ed25519');
		const { op: g } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod.publicKey.toString(),
		}, clock());
		await handleRemoteOp(db, 'net1', g);

		let modClock = clock();
		// Add
		const { op: add1, updatedClock: c1 } = await signCatalogOp(mod, 'add', 'net1', {
			lishID: 'temp', name: 'Temporary',
			publisherPeerID: mod.publicKey.toString(), publishedAt: new Date().toISOString(),
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: 'h1',
		}, modClock);
		modClock = c1;
		await handleRemoteOp(db, 'net1', add1);

		// Remove
		const { op: rem, updatedClock: c2 } = await signCatalogOp(mod, 'remove', 'net1', { lishID: 'temp' }, modClock);
		modClock = c2;
		await handleRemoteOp(db, 'net1', rem);

		// Re-add — should be blocked by tombstone
		const { op: add2 } = await signCatalogOp(mod, 'add', 'net1', {
			lishID: 'temp', name: 'Revived',
			publisherPeerID: mod.publicKey.toString(), publishedAt: new Date().toISOString(),
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: 'h2',
		}, modClock);
		await handleRemoteOp(db, 'net1', add2);
		// Entry should NOT exist (tombstoned)
		expect(getCatalogEntry(db, 'net1', 'temp')).toBeNull();
	});

	test('tombstone GC allows re-add after expiry', async () => {
		const mod = await generateKeyPair('Ed25519');
		const { op: g } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod.publicKey.toString(),
		}, clock());
		await handleRemoteOp(db, 'net1', g);

		let modClock = clock();
		// Add then remove
		const { op: add1, updatedClock: c1 } = await signCatalogOp(mod, 'add', 'net1', {
			lishID: 'gc-test', name: 'To be GCd',
			publisherPeerID: mod.publicKey.toString(), publishedAt: new Date().toISOString(),
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: 'h1',
		}, modClock);
		modClock = c1;
		await handleRemoteOp(db, 'net1', add1);

		const { op: rem, updatedClock: c2 } = await signCatalogOp(mod, 'remove', 'net1', { lishID: 'gc-test' }, modClock);
		modClock = c2;
		await handleRemoteOp(db, 'net1', rem);

		// Manually set tombstone removed_at to 60 days ago for GC test
		db.run("UPDATE catalog_tombstones SET removed_at = datetime('now', '-60 days') WHERE lish_id = 'gc-test'");

		// GC tombstones older than 30 days
		const deleted = deleteTombstonesOlderThan(db, 'net1', 30);
		expect(deleted).toBe(1);

		// Now re-add should work
		const { op: add2 } = await signCatalogOp(mod, 'add', 'net1', {
			lishID: 'gc-test', name: 'Revived after GC',
			publisherPeerID: mod.publicKey.toString(), publishedAt: new Date().toISOString(),
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: 'h2',
		}, modClock);
		await handleRemoteOp(db, 'net1', add2);
		const entry = getCatalogEntry(db, 'net1', 'gc-test');
		expect(entry).not.toBeNull();
		expect(entry!.name).toBe('Revived after GC');
	});
});

describe('Edge case: Field size limits at boundary', () => {
	test('name at exactly 256 bytes passes', async () => {
		const mod = await generateKeyPair('Ed25519');
		const { op: g } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod.publicKey.toString(),
		}, clock());
		await handleRemoteOp(db, 'net1', g);

		const name256 = 'a'.repeat(256);
		const { op } = await signCatalogOp(mod, 'add', 'net1', {
			lishID: 'boundary', name: name256,
			publisherPeerID: mod.publicKey.toString(), publishedAt: new Date().toISOString(),
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: 'h1',
		}, clock());
		const result = await handleRemoteOp(db, 'net1', op);
		expect(result.valid).toBe(true);
	});

	test('name at 257 bytes fails', async () => {
		const mod = await generateKeyPair('Ed25519');
		const { op: g } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod.publicKey.toString(),
		}, clock());
		await handleRemoteOp(db, 'net1', g);

		const name257 = 'a'.repeat(257);
		const { op } = await signCatalogOp(mod, 'add', 'net1', {
			lishID: 'too-big', name: name257,
		}, clock());
		const result = await handleRemoteOp(db, 'net1', op);
		expect(result.valid).toBe(false);
	});

	test('exactly 10 tags passes, 11 tags fails', async () => {
		const mod = await generateKeyPair('Ed25519');
		const { op: g } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod.publicKey.toString(),
		}, clock());
		await handleRemoteOp(db, 'net1', g);

		const tags10 = Array.from({ length: 10 }, (_, i) => `tag${i}`);
		let modClock = clock();
		const { op: op10, updatedClock } = await signCatalogOp(mod, 'add', 'net1', {
			lishID: 'tags10', name: 'Ten tags', tags: tags10,
			publisherPeerID: mod.publicKey.toString(), publishedAt: new Date().toISOString(),
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: 'h1',
		}, modClock);
		modClock = updatedClock;
		expect((await handleRemoteOp(db, 'net1', op10)).valid).toBe(true);

		const tags11 = Array.from({ length: 11 }, (_, i) => `tag${i}`);
		const { op: op11 } = await signCatalogOp(mod, 'add', 'net1', {
			lishID: 'tags11', name: 'Eleven tags', tags: tags11,
		}, modClock);
		expect((await handleRemoteOp(db, 'net1', op11)).valid).toBe(false);
	});
});

describe('Edge case: ACL cascading revocation', () => {
	test('revoking admin removes them but moderators stay (simplified model)', async () => {
		let oClock = clock();
		const admin = await generateKeyPair('Ed25519');
		const mod = await generateKeyPair('Ed25519');

		// Owner grants admin
		const { op: ga, updatedClock: c1 } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'admin', delegatee: admin.publicKey.toString(),
		}, oClock);
		oClock = c1;
		await handleRemoteOp(db, 'net1', ga);

		// Admin grants moderator
		const { op: gm } = await signCatalogOp(admin, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod.publicKey.toString(),
		}, clock());
		await handleRemoteOp(db, 'net1', gm);

		// Owner revokes admin
		const { op: ra } = await signCatalogOp(ownerKey, 'acl_revoke', 'net1', {
			role: 'admin', delegatee: admin.publicKey.toString(),
		}, oClock);
		await handleRemoteOp(db, 'net1', ra);

		const acl = await import('../../db/catalog.ts').then(m => m.getCatalogACL(db, 'net1'));
		expect(acl!.admins).not.toContain(admin.publicKey.toString());
		// Note: In current simplified model, moderators granted by revoked admin remain
		// Full cascading revocation would remove them too (Phase 4 enhancement)
		expect(acl!.moderators).toContain(mod.publicKey.toString());
	});
});
