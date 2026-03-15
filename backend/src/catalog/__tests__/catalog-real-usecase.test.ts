/**
 * REAL USE CASE TESTS
 *
 * Simulates actual user workflows — not unit testing isolated functions,
 * but full scenarios a real user would go through.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Ed25519PrivateKey } from '@libp2p/interface';
import { decode } from 'cbor-x';
import { initCatalogTables, getCatalogEntry, listCatalogEntries, isTombstoned, getCatalogACL, getEntryCount, searchCatalog } from '../../db/catalog.ts';
import { CatalogManager } from '../catalog-manager.ts';
import { buildSyncResponse, applySyncResponse, encodeSyncResponse, decodeSyncResponse } from '../catalog-sync.ts';
import { CatalogRateLimiter } from '../catalog-rate-limiter.ts';
import { computeManifestHash } from '../catalog-utils.ts';
import { verifyCatalogOp, type SignedCatalogOp } from '../catalog-signer.ts';

function createDB(): Database {
	const d = new Database(':memory:');
	d.run('PRAGMA journal_mode = WAL');
	d.run('PRAGMA foreign_keys = ON');
	initCatalogTables(d);
	return d;
}

function createManager(key: Ed25519PrivateKey, database: Database, broadcastLog?: { networkID: string; op: SignedCatalogOp }[]): CatalogManager {
	return new CatalogManager({
		db: database,
		getPrivateKey: () => key,
		getLocalPeerID: () => key.publicKey.toString(),
		broadcast: broadcastLog ? (networkID, op) => broadcastLog.push({ networkID, op }) : undefined,
	});
}

// ================================================================
// USE CASE 1: Community Linux ISO sharing network
// ================================================================
describe('Use Case: Linux ISO sharing community', () => {
	test('complete lifecycle — create network, invite team, publish ISOs, search, update, remove outdated', async () => {
		const db = createDB();
		const broadcasts: { networkID: string; op: SignedCatalogOp }[] = [];

		// Characters
		const alice = await generateKeyPair('Ed25519'); // network owner
		const bob = await generateKeyPair('Ed25519');   // admin
		const carol = await generateKeyPair('Ed25519'); // moderator (added by bob)
		const dave = await generateKeyPair('Ed25519');  // moderator (added by alice)
		const eve = await generateKeyPair('Ed25519');   // random user (no permissions)

		const aliceMgr = createManager(alice, db, broadcasts);
		const bobMgr = createManager(bob, db);
		const carolMgr = createManager(carol, db);
		const daveMgr = createManager(dave, db);
		const eveMgr = createManager(eve, db);

		const NET = 'linux-isos-2026';

		// Step 1: Alice creates the network
		aliceMgr.join(NET, alice.publicKey.toString());
		bobMgr.join(NET, alice.publicKey.toString());
		carolMgr.join(NET, alice.publicKey.toString());
		daveMgr.join(NET, alice.publicKey.toString());
		eveMgr.join(NET, alice.publicKey.toString());

		// Verify initial ACL
		const initialACL = aliceMgr.getAccess(NET);
		expect(initialACL!.owner).toBe(alice.publicKey.toString());
		expect(initialACL!.admins).toEqual([]);
		expect(initialACL!.moderators).toEqual([]);

		// Step 2: Alice appoints Bob as admin
		await aliceMgr.grantRole(NET, bob.publicKey.toString(), 'admin');
		expect(aliceMgr.getAccess(NET)!.admins).toContain(bob.publicKey.toString());

		// Step 3: Bob (as admin) appoints Carol and Dave as moderators
		await bobMgr.grantRole(NET, carol.publicKey.toString(), 'moderator');
		await bobMgr.grantRole(NET, dave.publicKey.toString(), 'moderator');
		const acl = aliceMgr.getAccess(NET);
		expect(acl!.moderators.length).toBe(2);

		// Step 4: Carol publishes Ubuntu
		const ubuntuManifest = { id: 'ubuntu-24', name: 'Ubuntu 24.04', files: [{ path: 'ubuntu.iso', size: 4_500_000_000 }] };
		await carolMgr.publish(NET, {
			lishID: 'ubuntu-24',
			name: 'Ubuntu 24.04 LTS Desktop',
			description: 'Official Ubuntu desktop ISO with GNOME',
			chunkSize: 4 * 1024 * 1024,
			checksumAlgo: 'sha256',
			totalSize: 4_500_000_000,
			fileCount: 1,
			manifestHash: computeManifestHash(ubuntuManifest),
			contentType: 'software',
			tags: ['linux', 'ubuntu', 'desktop', 'gnome'],
		});

		// Step 5: Dave publishes Fedora and Arch
		await daveMgr.publish(NET, {
			lishID: 'fedora-41',
			name: 'Fedora Workstation 41',
			description: 'Fedora with GNOME 47',
			chunkSize: 4 * 1024 * 1024,
			checksumAlgo: 'sha256',
			totalSize: 2_200_000_000,
			fileCount: 1,
			manifestHash: 'sha256:fedora41hash',
			contentType: 'software',
			tags: ['linux', 'fedora', 'gnome'],
		});

		await daveMgr.publish(NET, {
			lishID: 'arch-2026',
			name: 'Arch Linux 2026.03',
			description: 'Rolling release, minimal ISO',
			chunkSize: 4 * 1024 * 1024,
			checksumAlgo: 'sha256',
			totalSize: 850_000_000,
			fileCount: 1,
			manifestHash: 'sha256:archhash',
			contentType: 'software',
			tags: ['linux', 'arch', 'minimal'],
		});

		// Step 6: Verify catalog has 3 entries
		expect(getEntryCount(db, NET)).toBe(3);

		// Step 7: Search scenarios
		const gnomeResults = searchCatalog(db, NET, 'GNOME');
		expect(gnomeResults.length).toBe(2); // Ubuntu + Fedora

		const linuxTag = searchCatalog(db, NET, '#linux');
		expect(linuxTag.length).toBe(3);

		const minimalSearch = searchCatalog(db, NET, '#minimal');
		expect(minimalSearch.length).toBe(1);
		expect(minimalSearch[0]!.name).toBe('Arch Linux 2026.03');

		// Step 8: Carol updates Ubuntu (point release)
		await carolMgr.update(NET, 'ubuntu-24', {
			name: 'Ubuntu 24.04.1 LTS Desktop',
			description: 'Point release with security updates',
		});
		expect(getCatalogEntry(db, NET, 'ubuntu-24')!.name).toBe('Ubuntu 24.04.1 LTS Desktop');

		// Step 9: Eve (random user) tries to publish — REJECTED
		await expect(eveMgr.publish(NET, {
			lishID: 'malware',
			name: 'Totally Not Malware',
			chunkSize: 1024,
			checksumAlgo: 'sha256',
			totalSize: 100,
			fileCount: 1,
			manifestHash: 'sha256:evil',
		})).rejects.toThrow();

		// Step 10: Eve tries to remove Ubuntu — REJECTED
		await expect(eveMgr.remove(NET, 'ubuntu-24')).rejects.toThrow();

		// Step 11: Alice removes outdated Arch version
		await aliceMgr.remove(NET, 'arch-2026');
		expect(getCatalogEntry(db, NET, 'arch-2026')).toBeNull();
		expect(isTombstoned(db, NET, 'arch-2026')).toBe(true);
		expect(getEntryCount(db, NET)).toBe(2);

		// Step 12: Bob revokes Carol's moderator access
		await bobMgr.revokeRole(NET, carol.publicKey.toString(), 'moderator');

		// Step 13: Carol tries to publish after revocation — REJECTED
		await expect(carolMgr.publish(NET, {
			lishID: 'mint',
			name: 'Linux Mint',
			chunkSize: 1024,
			checksumAlgo: 'sha256',
			totalSize: 2_000_000_000,
			fileCount: 1,
			manifestHash: 'sha256:minthash',
		})).rejects.toThrow();

		// Step 14: Verify broadcasts were emitted for all owner operations
		expect(broadcasts.length).toBeGreaterThan(0);
		expect(broadcasts.some(b => b.op.payload.type === 'acl_grant')).toBe(true);

		// Step 15: Final state
		const finalEntries = listCatalogEntries(db, NET);
		expect(finalEntries.length).toBe(2);
		const names = finalEntries.map(e => e.name);
		expect(names).toContain('Ubuntu 24.04.1 LTS Desktop');
		expect(names).toContain('Fedora Workstation 41');
	});
});

// ================================================================
// USE CASE 2: Peer-to-peer catalog synchronization
// ================================================================
describe('Use Case: New peer joins and syncs catalog', () => {
	test('peer A has catalog, peer B joins and syncs everything', async () => {
		const dbA = createDB();
		const dbB = createDB();

		const owner = await generateKeyPair('Ed25519');
		const mod = await generateKeyPair('Ed25519');

		const mgrA = createManager(owner, dbA);
		mgrA.join('community', owner.publicKey.toString());
		await mgrA.grantRole('community', mod.publicKey.toString(), 'moderator');

		const modMgr = createManager(mod, dbA);
		modMgr.join('community', owner.publicKey.toString());

		// Mod publishes 10 entries on peer A
		for (let i = 0; i < 10; i++) {
			await modMgr.publish('community', {
				lishID: `item-${i}`,
				name: `Community Item ${i}`,
				description: `Shared content #${i}`,
				chunkSize: 1024 * 1024,
				checksumAlgo: 'sha256',
				totalSize: (i + 1) * 100_000_000,
				fileCount: i + 1,
				manifestHash: `sha256:item${i}hash`,
				tags: ['community', i % 2 === 0 ? 'even' : 'odd'],
			});
		}

		// Owner removes 2 entries
		await mgrA.remove('community', 'item-3');
		await mgrA.remove('community', 'item-7');

		expect(getEntryCount(dbA, 'community')).toBe(8);

		// Peer B joins — simulate bilateral sync
		const syncResponse = buildSyncResponse(dbA, 'community', 0);
		const wire = encodeSyncResponse(syncResponse);
		const received = decodeSyncResponse(wire);

		// Set up peer B — first apply ACL from sync response, then entries
		const mgrB = createManager(owner, dbB);
		mgrB.join('community', owner.publicKey.toString());

		// Apply ACL from sync (peer B needs to know about the moderator)
		const syncACL = JSON.parse(received.aclJSON);
		if (syncACL) {
			const { updateCatalogACL } = await import('../../db/catalog.ts');
			updateCatalogACL(dbB, 'community', {
				admins: syncACL.admins,
				moderators: syncACL.moderators,
			});
		}

		// Apply sync entries
		const applied = await applySyncResponse(dbB, 'community', received);
		expect(applied).toBeGreaterThanOrEqual(8);

		// Verify peer B has same data
		expect(getEntryCount(dbB, 'community')).toBe(8);

		// Verify search works on peer B
		// Remaining items: 0,1,2,4,5,6,8,9 (3 and 7 removed)
		// Even tagged: 0,2,4,6,8 = 5 items
		const evenItems = searchCatalog(dbB, 'community', '#even');
		expect(evenItems.length).toBe(5);

		// Verify specific entries
		expect(getCatalogEntry(dbB, 'community', 'item-0')!.name).toBe('Community Item 0');
		expect(getCatalogEntry(dbB, 'community', 'item-3')).toBeNull(); // was removed
		expect(getCatalogEntry(dbB, 'community', 'item-7')).toBeNull(); // was removed
	});
});

// ================================================================
// USE CASE 3: Concurrent editing by multiple moderators
// ================================================================
describe('Use Case: Multiple moderators editing concurrently', () => {
	test('two moderators work on same catalog simultaneously', async () => {
		const db = createDB();
		const owner = await generateKeyPair('Ed25519');
		const mod1 = await generateKeyPair('Ed25519');
		const mod2 = await generateKeyPair('Ed25519');

		const ownerMgr = createManager(owner, db);
		const mod1Mgr = createManager(mod1, db);
		const mod2Mgr = createManager(mod2, db);

		ownerMgr.join('shared', owner.publicKey.toString());
		mod1Mgr.join('shared', owner.publicKey.toString());
		mod2Mgr.join('shared', owner.publicKey.toString());

		await ownerMgr.grantRole('shared', mod1.publicKey.toString(), 'moderator');
		await ownerMgr.grantRole('shared', mod2.publicKey.toString(), 'moderator');

		// Both mods publish different entries simultaneously
		await Promise.all([
			mod1Mgr.publish('shared', {
				lishID: 'mod1-file', name: 'Mod1 Upload',
				chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 1000, fileCount: 1, manifestHash: 'h1',
			}),
			mod2Mgr.publish('shared', {
				lishID: 'mod2-file', name: 'Mod2 Upload',
				chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 2000, fileCount: 1, manifestHash: 'h2',
			}),
		]);

		expect(getEntryCount(db, 'shared')).toBe(2);

		// Mod1 updates their own entry
		await mod1Mgr.update('shared', 'mod1-file', { description: 'Updated by mod1' });

		// Mod2 publishes more
		await mod2Mgr.publish('shared', {
			lishID: 'mod2-file-2', name: 'Mod2 Second Upload',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 3000, fileCount: 2, manifestHash: 'h3',
			tags: ['important'],
		});

		expect(getEntryCount(db, 'shared')).toBe(3);

		// Owner removes mod2's first file
		await ownerMgr.remove('shared', 'mod2-file');
		expect(getEntryCount(db, 'shared')).toBe(2);

		// Search for important
		const important = searchCatalog(db, 'shared', '#important');
		expect(important.length).toBe(1);
		expect(important[0]!.name).toBe('Mod2 Second Upload');
	});
});

// ================================================================
// USE CASE 4: Rate limiting under attack
// ================================================================
describe('Use Case: Rate limiting prevents spam attack', () => {
	test('spammer moderator gets rate-limited after burst', async () => {
		const limiter = new CatalogRateLimiter();

		// Normal user — 5 ops
		for (let i = 0; i < 5; i++) {
			expect(limiter.check('normal-user')).toBe('allow');
		}

		// Spammer — burst 10 ops quickly
		for (let i = 0; i < 10; i++) {
			limiter.check('spammer');
		}
		// 11th should be rejected
		expect(limiter.check('spammer')).toBe('reject');

		// Normal user still works (independent limit)
		expect(limiter.check('normal-user')).toBe('allow');
	});
});

// ================================================================
// USE CASE 5: manifestHash integrity verification
// ================================================================
describe('Use Case: Manifest hash ensures content integrity', () => {
	test('hash matches for identical manifests regardless of field order', () => {
		const manifest1 = {
			id: 'ubuntu-24',
			name: 'Ubuntu 24.04',
			chunkSize: 4194304,
			checksumAlgo: 'sha256',
			files: [
				{ path: 'ubuntu-24.04-desktop-amd64.iso', size: 4500000000, checksums: ['abc', 'def'] },
			],
		};

		const manifest2 = {
			files: [
				{ path: 'ubuntu-24.04-desktop-amd64.iso', size: 4500000000, checksums: ['abc', 'def'] },
			],
			checksumAlgo: 'sha256',
			name: 'Ubuntu 24.04',
			id: 'ubuntu-24',
			chunkSize: 4194304,
		};

		expect(computeManifestHash(manifest1)).toBe(computeManifestHash(manifest2));
	});

	test('hash changes when manifest content differs', () => {
		const base = { id: 'test', files: [{ path: 'a.bin', size: 100 }] };
		const modified = { id: 'test', files: [{ path: 'a.bin', size: 101 }] };

		expect(computeManifestHash(base)).not.toBe(computeManifestHash(modified));
	});
});

// ================================================================
// USE CASE 6: Multi-network isolation — user has multiple communities
// ================================================================
describe('Use Case: User participates in multiple independent communities', () => {
	test('actions in one network do not affect another', async () => {
		const db = createDB();
		const user = await generateKeyPair('Ed25519');
		const mgr = createManager(user, db);

		// User owns two networks
		mgr.join('linux-fans', user.publicKey.toString());
		mgr.join('movie-club', user.publicKey.toString());

		// Publish in linux-fans
		await mgr.publish('linux-fans', {
			lishID: 'ubuntu', name: 'Ubuntu ISO',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 4_500_000_000,
			fileCount: 1, manifestHash: 'h1', contentType: 'software',
		});

		// Publish in movie-club
		await mgr.publish('movie-club', {
			lishID: 'movie1', name: 'Open Source Documentary',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 2_000_000_000,
			fileCount: 1, manifestHash: 'h2', contentType: 'video',
		});

		// Each network has only its own entries
		expect(getEntryCount(db, 'linux-fans')).toBe(1);
		expect(getEntryCount(db, 'movie-club')).toBe(1);

		// Search in linux-fans doesn't find movie
		expect(searchCatalog(db, 'linux-fans', 'Documentary').length).toBe(0);

		// Remove in one network doesn't affect other
		await mgr.remove('linux-fans', 'ubuntu');
		expect(getEntryCount(db, 'linux-fans')).toBe(0);
		expect(getEntryCount(db, 'movie-club')).toBe(1); // unchanged
	});
});

// ================================================================
// USE CASE 7: Signed operations are independently verifiable
// ================================================================
describe('Use Case: Third party can verify any catalog operation', () => {
	test('stored signed_op can be decoded and verified by anyone', async () => {
		const db = createDB();
		const owner = await generateKeyPair('Ed25519');
		const mgr = createManager(owner, db);
		mgr.join('verifiable', owner.publicKey.toString());

		await mgr.publish('verifiable', {
			lishID: 'proof',
			name: 'Cryptographically Signed Entry',
			chunkSize: 1024,
			checksumAlgo: 'sha256',
			totalSize: 999,
			fileCount: 1,
			manifestHash: 'sha256:proof',
		});

		// Any party can read the stored blob and verify
		const entry = getCatalogEntry(db, 'verifiable', 'proof');
		const op = decode(Buffer.from(entry!.signed_op)) as SignedCatalogOp;

		// Verify cryptographic signature
		expect(await verifyCatalogOp(op)).toBe(true);

		// Verify the signer matches
		expect(op.signer).toBe(owner.publicKey.toString());

		// Verify payload content
		expect(op.payload.type).toBe('add');
		expect(op.payload.networkID).toBe('verifiable');
		expect((op.payload.data as any).name).toBe('Cryptographically Signed Entry');

		// Tampering invalidates signature
		op.payload.data['name'] = 'TAMPERED';
		expect(await verifyCatalogOp(op)).toBe(false);
	});
});

// ================================================================
// USE CASE 8: Tombstone prevents re-adding deleted content
// ================================================================
describe('Use Case: Deleted content stays deleted until GC', () => {
	test('re-publish after delete is blocked, but works after GC', async () => {
		const db = createDB();
		const owner = await generateKeyPair('Ed25519');
		const mgr = createManager(owner, db);
		mgr.join('net', owner.publicKey.toString());

		// Publish and delete
		await mgr.publish('net', {
			lishID: 'temp', name: 'Temporary Content',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: 'h1',
		});
		await mgr.remove('net', 'temp');
		expect(getCatalogEntry(db, 'net', 'temp')).toBeNull();
		expect(isTombstoned(db, 'net', 'temp')).toBe(true);

		// Re-publish — blocked by tombstone
		await mgr.publish('net', {
			lishID: 'temp', name: 'Revived Content',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: 'h2',
		});
		expect(getCatalogEntry(db, 'net', 'temp')).toBeNull(); // still blocked

		// Simulate 60 days passing — GC tombstone
		db.run("UPDATE catalog_tombstones SET removed_at = datetime('now', '-60 days') WHERE lish_id = 'temp'");
		mgr.gcTombstones('net', 30);
		expect(isTombstoned(db, 'net', 'temp')).toBe(false);

		// Now re-publish works
		await mgr.publish('net', {
			lishID: 'temp', name: 'Revived After GC',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 200, fileCount: 1, manifestHash: 'h3',
		});
		expect(getCatalogEntry(db, 'net', 'temp')!.name).toBe('Revived After GC');
	});
});
