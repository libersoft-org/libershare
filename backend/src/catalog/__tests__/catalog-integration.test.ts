import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Ed25519PrivateKey } from '@libp2p/interface';
import { initCatalogTables, getCatalogEntry, listCatalogEntries, isTombstoned, getCatalogACL, ensureCatalogACL, searchCatalog, getDeltaEntries, getVectorClock } from '../../db/catalog.ts';
import { signCatalogOp } from '../catalog-signer.ts';
import { handleRemoteOp } from '../catalog-validator.ts';
import { hlcTick, type HLC } from '../catalog-hlc.ts';

let db: Database;
let ownerKey: Ed25519PrivateKey;
let admin1Key: Ed25519PrivateKey;
let mod1Key: Ed25519PrivateKey;
let mod2Key: Ed25519PrivateKey;
let randomPeer: Ed25519PrivateKey;

beforeEach(async () => {
	db = new Database(':memory:');
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA foreign_keys = ON');
	initCatalogTables(db);

	ownerKey = await generateKeyPair('Ed25519');
	admin1Key = await generateKeyPair('Ed25519');
	mod1Key = await generateKeyPair('Ed25519');
	mod2Key = await generateKeyPair('Ed25519');
	randomPeer = await generateKeyPair('Ed25519');

	ensureCatalogACL(db, 'net1', ownerKey.publicKey.toString());
});

function clock(nodeID: string = 'test'): HLC {
	return { wallTime: Date.now(), logical: 0, nodeID };
}

describe('E2E: Full lifecycle — publish, update, remove', () => {
	test('owner sets up ACL, moderator publishes, updates, and removes', async () => {
		let ownerClock = clock();

		// 1. Owner grants admin
		const { op: grantAdmin, updatedClock: c1 } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'admin', delegatee: admin1Key.publicKey.toString(),
		}, ownerClock);
		ownerClock = c1;
		expect((await handleRemoteOp(db, 'net1', grantAdmin)).valid).toBe(true);

		// 2. Admin grants moderator
		let adminClock = clock();
		const { op: grantMod, updatedClock: c2 } = await signCatalogOp(admin1Key, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod1Key.publicKey.toString(),
		}, adminClock);
		adminClock = c2;
		expect((await handleRemoteOp(db, 'net1', grantMod)).valid).toBe(true);

		// Verify ACL
		const acl = getCatalogACL(db, 'net1');
		expect(acl!.admins).toContain(admin1Key.publicKey.toString());
		expect(acl!.moderators).toContain(mod1Key.publicKey.toString());

		// 3. Moderator publishes entry
		let modClock = clock();
		const { op: addOp, updatedClock: c3 } = await signCatalogOp(mod1Key, 'add', 'net1', {
			lishID: 'lish-ubuntu',
			name: 'Ubuntu 24.04 LTS',
			description: 'Official Ubuntu desktop ISO',
			publisherPeerID: mod1Key.publicKey.toString(),
			publishedAt: '2026-03-15T10:00:00Z',
			chunkSize: 1048576,
			checksumAlgo: 'sha256',
			totalSize: 4_500_000_000,
			fileCount: 1,
			manifestHash: 'sha256:abcdef123456',
			contentType: 'software',
			tags: ['linux', 'ubuntu', 'iso'],
		}, modClock);
		modClock = c3;
		expect((await handleRemoteOp(db, 'net1', addOp)).valid).toBe(true);

		// Verify entry stored
		const entry = getCatalogEntry(db, 'net1', 'lish-ubuntu');
		expect(entry).not.toBeNull();
		expect(entry!.name).toBe('Ubuntu 24.04 LTS');
		expect(entry!.total_size).toBe(4_500_000_000);

		// 4. Moderator updates metadata
		const { op: updateOp, updatedClock: c4 } = await signCatalogOp(mod1Key, 'update', 'net1', {
			lishID: 'lish-ubuntu',
			name: 'Ubuntu 24.04.1 LTS',
			description: 'Updated point release',
			publisherPeerID: mod1Key.publicKey.toString(),
			publishedAt: '2026-03-15T10:00:00Z',
			chunkSize: 1048576,
			checksumAlgo: 'sha256',
			totalSize: 4_600_000_000,
			fileCount: 1,
			manifestHash: 'sha256:abcdef123456',
			contentType: 'software',
			tags: ['linux', 'ubuntu', 'iso', 'lts'],
		}, modClock);
		modClock = c4;
		expect((await handleRemoteOp(db, 'net1', updateOp)).valid).toBe(true);

		const updated = getCatalogEntry(db, 'net1', 'lish-ubuntu');
		expect(updated!.name).toBe('Ubuntu 24.04.1 LTS');
		expect(updated!.last_edited_by).toBe(mod1Key.publicKey.toString());

		// 5. Moderator removes entry
		const { op: removeOp } = await signCatalogOp(mod1Key, 'remove', 'net1', { lishID: 'lish-ubuntu' }, modClock);
		expect((await handleRemoteOp(db, 'net1', removeOp)).valid).toBe(true);
		expect(isTombstoned(db, 'net1', 'lish-ubuntu')).toBe(true);
	});
});

describe('E2E: Multi-peer catalog with search', () => {
	test('multiple moderators publish, search works across entries', async () => {
		// Setup: owner grants two moderators
		let ownerClock = clock();
		const { op: g1, updatedClock: oc1 } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod1Key.publicKey.toString(),
		}, ownerClock);
		ownerClock = oc1;
		await handleRemoteOp(db, 'net1', g1);

		const { op: g2 } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod2Key.publicKey.toString(),
		}, ownerClock);
		await handleRemoteOp(db, 'net1', g2);

		// Mod1 publishes 3 entries
		let m1Clock = clock();
		for (const [id, name, desc, tags] of [
			['fedora', 'Fedora Workstation 41', 'GNOME desktop environment', ['linux', 'fedora']],
			['debian', 'Debian 13 Trixie', 'Stable Debian release', ['linux', 'debian']],
			['arch', 'Arch Linux 2026.03', 'Rolling release', ['linux', 'arch']],
		] as const) {
			const { op, updatedClock } = await signCatalogOp(mod1Key, 'add', 'net1', {
				lishID: id, name, description: desc, tags: [...tags],
				publisherPeerID: mod1Key.publicKey.toString(), publishedAt: new Date().toISOString(),
				chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 1000, fileCount: 1, manifestHash: `hash-${id}`,
			}, m1Clock);
			m1Clock = updatedClock;
			expect((await handleRemoteOp(db, 'net1', op)).valid).toBe(true);
		}

		// Mod2 publishes 2 entries
		let m2Clock = clock();
		for (const [id, name, desc, tags] of [
			['ubuntu', 'Ubuntu 24.04', 'Desktop ISO', ['linux', 'ubuntu']],
			['windows', 'Windows 11', 'Microsoft OS', ['windows']],
		] as const) {
			const { op, updatedClock } = await signCatalogOp(mod2Key, 'add', 'net1', {
				lishID: id, name, description: desc, tags: [...tags],
				publisherPeerID: mod2Key.publicKey.toString(), publishedAt: new Date().toISOString(),
				chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 2000, fileCount: 1, manifestHash: `hash-${id}`,
			}, m2Clock);
			m2Clock = updatedClock;
			expect((await handleRemoteOp(db, 'net1', op)).valid).toBe(true);
		}

		// List all — should have 5 entries
		const all = listCatalogEntries(db, 'net1');
		expect(all.length).toBe(5);

		// FTS search
		const gnomeResults = searchCatalog(db, 'net1', 'GNOME');
		expect(gnomeResults.length).toBe(1);
		expect(gnomeResults[0]!.name).toBe('Fedora Workstation 41');

		// Tag search
		const linuxResults = searchCatalog(db, 'net1', '#linux');
		expect(linuxResults.length).toBe(4); // all except windows

		// Delta sync — entries after hlc_wall=0 should return all
		const allDelta = getDeltaEntries(db, 'net1', 0);
		expect(allDelta.length).toBe(5);

		// Delta after highest HLC should return none
		const newest = all[0]!; // highest hlc_wall (sorted DESC)
		const noneDelta = getDeltaEntries(db, 'net1', newest.hlc_wall);
		expect(noneDelta.length).toBe(0);
	});
});

describe('E2E: Concurrent updates — LWW resolution', () => {
	test('two moderators update same entry — higher HLC wins', async () => {
		// Setup
		let ownerClock = clock();
		const { op: g1, updatedClock: oc1 } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod1Key.publicKey.toString(),
		}, ownerClock);
		ownerClock = oc1;
		await handleRemoteOp(db, 'net1', g1);

		const { op: g2 } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod2Key.publicKey.toString(),
		}, ownerClock);
		await handleRemoteOp(db, 'net1', g2);

		// Mod1 adds entry
		let m1Clock = clock();
		const { op: addOp, updatedClock: m1c2 } = await signCatalogOp(mod1Key, 'add', 'net1', {
			lishID: 'shared', name: 'Original', publisherPeerID: mod1Key.publicKey.toString(),
			publishedAt: new Date().toISOString(), chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 1000, fileCount: 1, manifestHash: 'hash1',
		}, m1Clock);
		m1Clock = m1c2;
		await handleRemoteOp(db, 'net1', addOp);

		// Mod1 updates with lower future HLC
		const earlyFuture: HLC = { wallTime: Date.now() + 10_000, logical: 0, nodeID: 'test' };
		const { op: updateA } = await signCatalogOp(mod1Key, 'update', 'net1', {
			lishID: 'shared', name: 'Update A', publisherPeerID: mod1Key.publicKey.toString(),
			publishedAt: new Date().toISOString(), chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 1000, fileCount: 1, manifestHash: 'hash1',
		}, earlyFuture);

		// Mod2 updates with higher future HLC
		const laterFuture: HLC = { wallTime: Date.now() + 20_000, logical: 0, nodeID: 'test' };
		const { op: updateB } = await signCatalogOp(mod2Key, 'update', 'net1', {
			lishID: 'shared', name: 'Update B', publisherPeerID: mod1Key.publicKey.toString(),
			publishedAt: new Date().toISOString(), chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 1000, fileCount: 1, manifestHash: 'hash1',
		}, laterFuture);

		// Apply in WRONG order — B first, then A
		await handleRemoteOp(db, 'net1', updateB);
		await handleRemoteOp(db, 'net1', updateA);

		// B should win (higher HLC), regardless of application order
		const entry = getCatalogEntry(db, 'net1', 'shared');
		expect(entry!.name).toBe('Update B');
	});
});

describe('E2E: Security — unauthorized actions blocked', () => {
	test('random peer cannot publish in restricted mode', async () => {
		const { op } = await signCatalogOp(randomPeer, 'add', 'net1', {
			lishID: 'spam', name: 'Spam entry',
		}, clock());
		const result = await handleRemoteOp(db, 'net1', op);
		expect(result.valid).toBe(false);
	});

	test('moderator cannot grant admin role', async () => {
		// Grant mod first
		const { op: g } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod1Key.publicKey.toString(),
		}, clock());
		await handleRemoteOp(db, 'net1', g);

		// Mod tries to make themselves admin
		const { op: escalate } = await signCatalogOp(mod1Key, 'acl_grant', 'net1', {
			role: 'admin', delegatee: mod1Key.publicKey.toString(),
		}, clock());
		const result = await handleRemoteOp(db, 'net1', escalate);
		expect(result.valid).toBe(false);
	});

	test('revoked moderator writes are rejected', async () => {
		let ownerClock = clock();
		// Grant moderator
		const { op: grant, updatedClock: oc2 } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod1Key.publicKey.toString(),
		}, ownerClock);
		ownerClock = oc2;
		await handleRemoteOp(db, 'net1', grant);

		// Mod publishes
		let modClock = clock();
		const { op: add, updatedClock: mc2 } = await signCatalogOp(mod1Key, 'add', 'net1', {
			lishID: 'valid-entry', name: 'Before revoke',
			publisherPeerID: mod1Key.publicKey.toString(), publishedAt: new Date().toISOString(),
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 1000, fileCount: 1, manifestHash: 'h1',
		}, modClock);
		modClock = mc2;
		await handleRemoteOp(db, 'net1', add);
		expect(getCatalogEntry(db, 'net1', 'valid-entry')).not.toBeNull();

		// Owner revokes moderator
		const { op: revoke } = await signCatalogOp(ownerKey, 'acl_revoke', 'net1', {
			role: 'moderator', delegatee: mod1Key.publicKey.toString(),
		}, ownerClock);
		await handleRemoteOp(db, 'net1', revoke);

		// Mod tries to publish again — should fail
		const { op: add2 } = await signCatalogOp(mod1Key, 'add', 'net1', {
			lishID: 'after-revoke', name: 'After revoke',
		}, modClock);
		const result = await handleRemoteOp(db, 'net1', add2);
		expect(result.valid).toBe(false);
	});
});

describe('E2E: Vector clock persistence', () => {
	test('vector clock tracks per-peer HLC progress', async () => {
		// Setup moderator
		const { op: g } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod1Key.publicKey.toString(),
		}, clock());
		await handleRemoteOp(db, 'net1', g);

		// Mod publishes 3 entries sequentially
		let modClock = clock();
		for (let i = 0; i < 3; i++) {
			const { op, updatedClock } = await signCatalogOp(mod1Key, 'add', 'net1', {
				lishID: `entry-${i}`, name: `Entry ${i}`,
				publisherPeerID: mod1Key.publicKey.toString(), publishedAt: new Date().toISOString(),
				chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: `h${i}`,
			}, modClock);
			modClock = updatedClock;
			await handleRemoteOp(db, 'net1', op);
		}

		// Verify vector clock stores the latest HLC for mod1
		const vc = getVectorClock(db, 'net1', mod1Key.publicKey.toString());
		expect(vc).not.toBeNull();
		expect(vc!.hlc_wall).toBeGreaterThan(0);

		// Verify all 3 entries exist
		const entries = listCatalogEntries(db, 'net1');
		expect(entries.length).toBe(3);
	});
});

describe('E2E: Multi-network isolation', () => {
	test('entries in different networks are isolated', async () => {
		// Setup net1 and net2 with different owners
		const owner2 = await generateKeyPair('Ed25519');
		ensureCatalogACL(db, 'net2', owner2.publicKey.toString());

		// Grant mod1 on net1, mod2 on net2
		const { op: g1 } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod1Key.publicKey.toString(),
		}, clock());
		await handleRemoteOp(db, 'net1', g1);

		const { op: g2 } = await signCatalogOp(owner2, 'acl_grant', 'net2', {
			role: 'moderator', delegatee: mod2Key.publicKey.toString(),
		}, clock());
		await handleRemoteOp(db, 'net2', g2);

		// Publish in each network
		const { op: a1 } = await signCatalogOp(mod1Key, 'add', 'net1', {
			lishID: 'entry-net1', name: 'Net1 Entry',
			publisherPeerID: mod1Key.publicKey.toString(), publishedAt: new Date().toISOString(),
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: 'h1',
		}, clock());
		await handleRemoteOp(db, 'net1', a1);

		const { op: a2 } = await signCatalogOp(mod2Key, 'add', 'net2', {
			lishID: 'entry-net2', name: 'Net2 Entry',
			publisherPeerID: mod2Key.publicKey.toString(), publishedAt: new Date().toISOString(),
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 200, fileCount: 1, manifestHash: 'h2',
		}, clock());
		await handleRemoteOp(db, 'net2', a2);

		// Verify isolation
		expect(listCatalogEntries(db, 'net1').length).toBe(1);
		expect(listCatalogEntries(db, 'net2').length).toBe(1);
		expect(getCatalogEntry(db, 'net1', 'entry-net2')).toBeNull();
		expect(getCatalogEntry(db, 'net2', 'entry-net1')).toBeNull();

		// Mod1 cannot write in net2 (not authorized)
		const { op: cross } = await signCatalogOp(mod1Key, 'add', 'net2', {
			lishID: 'cross-write', name: 'Cross network',
		}, clock());
		const result = await handleRemoteOp(db, 'net2', cross);
		expect(result.valid).toBe(false);
	});
});
