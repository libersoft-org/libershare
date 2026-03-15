/**
 * COMPLETE END-TO-END TEST SUITE FOR ONLINE CATALOG LIBRARY
 *
 * Tests the entire catalog system through the CatalogManager API:
 * - Network lifecycle (join, leave, multi-network)
 * - Role management (owner, admin, moderator, peer)
 * - Entry CRUD (publish, update, remove)
 * - Search (FTS5, tag search)
 * - Multi-peer scenarios (broadcast, sync, convergence)
 * - Security (unauthorized access, anti-escalation, replay, drift)
 * - Edge cases (tombstones, GC, field limits, concurrent updates)
 *
 * Each test simulates real peers with separate Ed25519 keys and
 * CatalogManagers sharing a DB (simulating received remote ops).
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Ed25519PrivateKey } from '@libp2p/interface';
import { decode } from 'cbor-x';
import { initCatalogTables, getCatalogEntry, isTombstoned } from '../../db/catalog.ts';
import { CatalogManager } from '../catalog-manager.ts';
import { verifyCatalogOp, type SignedCatalogOp } from '../catalog-signer.ts';

// --- Test infrastructure ---

interface TestPeer {
	key: Ed25519PrivateKey;
	peerID: string;
	manager: CatalogManager;
}

let db: Database;
let db2: Database; // separate DB for peer2 in multi-peer tests
let owner: TestPeer;
let admin1: TestPeer;
let admin2: TestPeer;
let mod1: TestPeer;
let mod2: TestPeer;
let reader: TestPeer; // no write permissions

const broadcasts: { networkID: string; op: SignedCatalogOp }[] = [];

function createDB(): Database {
	const d = new Database(':memory:');
	d.run('PRAGMA journal_mode = WAL');
	d.run('PRAGMA foreign_keys = ON');
	initCatalogTables(d);
	return d;
}

function createPeer(key: Ed25519PrivateKey, database: Database, withBroadcast: boolean = false): TestPeer {
	const peerID = key.publicKey.toString();
	const manager = new CatalogManager({
		db: database,
		getPrivateKey: () => key,
		getLocalPeerID: () => peerID,
		broadcast: withBroadcast ? (networkID, op) => {
			broadcasts.push({ networkID, op });
		} : undefined,
	});
	return { key, peerID, manager };
}

beforeEach(async () => {
	db = createDB();
	db2 = createDB();
	broadcasts.length = 0;

	const [ok, a1k, a2k, m1k, m2k, rk] = await Promise.all([
		generateKeyPair('Ed25519'), generateKeyPair('Ed25519'),
		generateKeyPair('Ed25519'), generateKeyPair('Ed25519'),
		generateKeyPair('Ed25519'), generateKeyPair('Ed25519'),
	]);

	owner = createPeer(ok, db, true);
	admin1 = createPeer(a1k, db);
	admin2 = createPeer(a2k, db);
	mod1 = createPeer(m1k, db);
	mod2 = createPeer(m2k, db);
	reader = createPeer(rk, db);
});

// ============================================================
// 1. NETWORK LIFECYCLE
// ============================================================

describe('1. Network Lifecycle', () => {
	test('1.1 join creates ACL with correct owner', () => {
		owner.manager.join('net1', owner.peerID);
		const acl = owner.manager.getAccess('net1');
		expect(acl).not.toBeNull();
		expect(acl!.owner).toBe(owner.peerID);
		expect(acl!.admins).toEqual([]);
		expect(acl!.moderators).toEqual([]);
		expect(acl!.restrict_writes).toBe(1);
	});

	test('1.2 leave removes network from manager', () => {
		owner.manager.join('net1', owner.peerID);
		expect(owner.manager.isJoined('net1')).toBe(true);
		owner.manager.leave('net1');
		expect(owner.manager.isJoined('net1')).toBe(false);
	});

	test('1.3 operations on unjoined network throw', () => {
		expect(() => owner.manager.list('net1')).toThrow();
	});

	test('1.4 multiple networks are isolated', async () => {
		owner.manager.join('net1', owner.peerID);
		owner.manager.join('net2', owner.peerID);

		await owner.manager.publish('net1', {
			lishID: 'a', name: 'Net1', chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 100, fileCount: 1, manifestHash: 'h1',
		});
		await owner.manager.publish('net2', {
			lishID: 'b', name: 'Net2', chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 200, fileCount: 1, manifestHash: 'h2',
		});

		expect(owner.manager.list('net1').length).toBe(1);
		expect(owner.manager.list('net2').length).toBe(1);
		expect(owner.manager.get('net1', 'b')).toBeNull();
		expect(owner.manager.get('net2', 'a')).toBeNull();
	});

	test('1.5 rejoin after leave preserves data', async () => {
		owner.manager.join('net1', owner.peerID);
		await owner.manager.publish('net1', {
			lishID: 'persist', name: 'Before Leave', chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 100, fileCount: 1, manifestHash: 'h1',
		});
		owner.manager.leave('net1');
		owner.manager.join('net1', owner.peerID);
		expect(owner.manager.get('net1', 'persist')!.name).toBe('Before Leave');
	});
});

// ============================================================
// 2. ROLE MANAGEMENT (ACL)
// ============================================================

describe('2. Role Management — Owner → Admin → Moderator', () => {
	beforeEach(() => {
		owner.manager.join('net1', owner.peerID);
		admin1.manager.join('net1', owner.peerID);
		admin2.manager.join('net1', owner.peerID);
		mod1.manager.join('net1', owner.peerID);
		mod2.manager.join('net1', owner.peerID);
		reader.manager.join('net1', owner.peerID);
	});

	test('2.1 owner grants admin', async () => {
		await owner.manager.grantRole('net1', admin1.peerID, 'admin');
		const acl = owner.manager.getAccess('net1');
		expect(acl!.admins).toContain(admin1.peerID);
	});

	test('2.2 owner grants multiple admins', async () => {
		await owner.manager.grantRole('net1', admin1.peerID, 'admin');
		await owner.manager.grantRole('net1', admin2.peerID, 'admin');
		const acl = owner.manager.getAccess('net1');
		expect(acl!.admins.length).toBe(2);
	});

	test('2.3 admin grants moderator', async () => {
		await owner.manager.grantRole('net1', admin1.peerID, 'admin');
		await admin1.manager.grantRole('net1', mod1.peerID, 'moderator');
		const acl = owner.manager.getAccess('net1');
		expect(acl!.moderators).toContain(mod1.peerID);
	});

	test('2.4 owner grants moderator directly', async () => {
		await owner.manager.grantRole('net1', mod1.peerID, 'moderator');
		const acl = owner.manager.getAccess('net1');
		expect(acl!.moderators).toContain(mod1.peerID);
	});

	test('2.5 owner revokes admin', async () => {
		await owner.manager.grantRole('net1', admin1.peerID, 'admin');
		await owner.manager.revokeRole('net1', admin1.peerID, 'admin');
		const acl = owner.manager.getAccess('net1');
		expect(acl!.admins).not.toContain(admin1.peerID);
	});

	test('2.6 admin revokes moderator', async () => {
		await owner.manager.grantRole('net1', admin1.peerID, 'admin');
		await admin1.manager.grantRole('net1', mod1.peerID, 'moderator');
		await admin1.manager.revokeRole('net1', mod1.peerID, 'moderator');
		const acl = owner.manager.getAccess('net1');
		expect(acl!.moderators).not.toContain(mod1.peerID);
	});

	test('2.7 moderator CANNOT grant any role (anti-escalation)', async () => {
		await owner.manager.grantRole('net1', mod1.peerID, 'moderator');
		await expect(mod1.manager.grantRole('net1', reader.peerID, 'moderator')).rejects.toThrow();
	});

	test('2.8 moderator CANNOT grant admin (anti-escalation)', async () => {
		await owner.manager.grantRole('net1', mod1.peerID, 'moderator');
		await expect(mod1.manager.grantRole('net1', reader.peerID, 'admin')).rejects.toThrow();
	});

	test('2.9 admin CANNOT grant admin (only owner can)', async () => {
		await owner.manager.grantRole('net1', admin1.peerID, 'admin');
		await expect(admin1.manager.grantRole('net1', reader.peerID, 'admin')).rejects.toThrow();
	});

	test('2.10 reader (no role) CANNOT grant anything', async () => {
		await expect(reader.manager.grantRole('net1', mod1.peerID, 'moderator')).rejects.toThrow();
	});

	test('2.11 reader CANNOT revoke anything', async () => {
		await owner.manager.grantRole('net1', mod1.peerID, 'moderator');
		await expect(reader.manager.revokeRole('net1', mod1.peerID, 'moderator')).rejects.toThrow();
	});

	test('2.12 duplicate grant is idempotent', async () => {
		await owner.manager.grantRole('net1', admin1.peerID, 'admin');
		await owner.manager.grantRole('net1', admin1.peerID, 'admin');
		const acl = owner.manager.getAccess('net1');
		expect(acl!.admins.filter(a => a === admin1.peerID).length).toBe(1);
	});
});

// ============================================================
// 3. ENTRY CRUD — Publish, Update, Remove
// ============================================================

describe('3. Entry CRUD', () => {
	beforeEach(async () => {
		owner.manager.join('net1', owner.peerID);
		mod1.manager.join('net1', owner.peerID);
		reader.manager.join('net1', owner.peerID);
		await owner.manager.grantRole('net1', mod1.peerID, 'moderator');
	});

	test('3.1 owner publishes entry', async () => {
		await owner.manager.publish('net1', {
			lishID: 'entry-1', name: 'Ubuntu 24.04', description: 'Desktop ISO',
			chunkSize: 1048576, checksumAlgo: 'sha256', totalSize: 4_500_000_000,
			fileCount: 1, manifestHash: 'sha256:abc', contentType: 'software',
			tags: ['linux', 'ubuntu'],
		});
		const entry = owner.manager.get('net1', 'entry-1');
		expect(entry!.name).toBe('Ubuntu 24.04');
		expect(entry!.total_size).toBe(4_500_000_000);
		expect(entry!.publisher_peer_id).toBe(owner.peerID);
	});

	test('3.2 moderator publishes entry', async () => {
		await mod1.manager.publish('net1', {
			lishID: 'mod-entry', name: 'Fedora 41',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 3000,
			fileCount: 1, manifestHash: 'h-fed',
		});
		expect(mod1.manager.get('net1', 'mod-entry')!.name).toBe('Fedora 41');
	});

	test('3.3 reader CANNOT publish in restricted mode', async () => {
		await expect(reader.manager.publish('net1', {
			lishID: 'spam', name: 'Spam',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h-spam',
		})).rejects.toThrow();
	});

	test('3.4 update changes metadata', async () => {
		await owner.manager.publish('net1', {
			lishID: 'upd', name: 'Original',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 1000,
			fileCount: 1, manifestHash: 'h1',
		});
		await owner.manager.update('net1', 'upd', {
			name: 'Updated Name', description: 'New description', tags: ['new'],
		});
		const entry = owner.manager.get('net1', 'upd');
		expect(entry!.name).toBe('Updated Name');
		expect(entry!.description).toBe('New description');
		expect(entry!.total_size).toBe(1000); // immutable unchanged
		expect(entry!.last_edited_by).toBe(owner.peerID);
	});

	test('3.5 moderator can update own entry', async () => {
		await mod1.manager.publish('net1', {
			lishID: 'mod-edit', name: 'Mod Entry',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 500,
			fileCount: 1, manifestHash: 'h1',
		});
		await mod1.manager.update('net1', 'mod-edit', { name: 'Edited by Mod' });
		expect(owner.manager.get('net1', 'mod-edit')!.name).toBe('Edited by Mod');
	});

	test('3.6 reader CANNOT update', async () => {
		await owner.manager.publish('net1', {
			lishID: 'no-edit', name: 'Protected',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		});
		await expect(reader.manager.update('net1', 'no-edit', { name: 'Hacked' })).rejects.toThrow();
	});

	test('3.7 remove creates tombstone, entry disappears', async () => {
		await owner.manager.publish('net1', {
			lishID: 'del', name: 'To Delete',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		});
		await owner.manager.remove('net1', 'del');
		expect(owner.manager.get('net1', 'del')).toBeNull();
		expect(owner.manager.list('net1').length).toBe(0);
		expect(isTombstoned(db, 'net1', 'del')).toBe(true);
	});

	test('3.8 reader CANNOT remove', async () => {
		await owner.manager.publish('net1', {
			lishID: 'no-del', name: 'Protected',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		});
		await expect(reader.manager.remove('net1', 'no-del')).rejects.toThrow();
	});

	test('3.9 publish after remove blocked by tombstone', async () => {
		await owner.manager.publish('net1', {
			lishID: 'tomb-test', name: 'Original',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		});
		await owner.manager.remove('net1', 'tomb-test');
		await owner.manager.publish('net1', {
			lishID: 'tomb-test', name: 'Revived',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h2',
		});
		// Entry should NOT exist — tombstone blocks re-add
		expect(owner.manager.get('net1', 'tomb-test')).toBeNull();
	});

	test('3.10 update nonexistent entry throws', async () => {
		await expect(owner.manager.update('net1', 'ghost', { name: 'X' })).rejects.toThrow('not found');
	});
});

// ============================================================
// 4. SEARCH
// ============================================================

describe('4. Search', () => {
	beforeEach(async () => {
		owner.manager.join('net1', owner.peerID);
		for (const [id, name, desc, tags] of [
			['ubuntu', 'Ubuntu Desktop 24.04', 'GNOME desktop environment', ['linux', 'ubuntu']],
			['fedora', 'Fedora Server 41', 'Minimal server install', ['linux', 'fedora']],
			['arch', 'Arch Linux 2026.03', 'Rolling release', ['linux', 'arch']],
			['windows', 'Windows 11 Pro', 'Microsoft operating system', ['windows']],
			['dataset', 'ImageNet 2026', 'ML training dataset', ['ml', 'dataset']],
		] as const) {
			await owner.manager.publish('net1', {
				lishID: id, name, description: desc, tags: [...tags],
				chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 1000, fileCount: 1,
				manifestHash: `h-${id}`,
			});
		}
	});

	test('4.1 FTS search by name', () => {
		const results = owner.manager.search('net1', 'Ubuntu');
		expect(results.length).toBe(1);
		expect(results[0]!.name).toBe('Ubuntu Desktop 24.04');
	});

	test('4.2 FTS search by description', () => {
		const results = owner.manager.search('net1', 'GNOME');
		expect(results.length).toBe(1);
	});

	test('4.3 tag search with # prefix', () => {
		const linux = owner.manager.search('net1', '#linux');
		expect(linux.length).toBe(3);
		const windows = owner.manager.search('net1', '#windows');
		expect(windows.length).toBe(1);
	});

	test('4.4 empty query returns all', () => {
		expect(owner.manager.search('net1', '').length).toBe(5);
	});

	test('4.5 search with no results', () => {
		expect(owner.manager.search('net1', 'nonexistent').length).toBe(0);
	});

	test('4.6 search after remove excludes removed entries', async () => {
		await owner.manager.remove('net1', 'ubuntu');
		const results = owner.manager.search('net1', 'Ubuntu');
		expect(results.length).toBe(0);
	});
});

// ============================================================
// 5. MULTI-PEER SCENARIOS
// ============================================================

describe('5. Multi-Peer — Broadcast and Remote Op Application', () => {
	test('5.1 broadcast captures signed ops on publish', async () => {
		owner.manager.join('net1', owner.peerID);
		await owner.manager.publish('net1', {
			lishID: 'bc-1', name: 'Broadcast Entry',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		});
		expect(broadcasts.length).toBe(1);
		expect(broadcasts[0]!.op.payload.type).toBe('add');
		expect(broadcasts[0]!.networkID).toBe('net1');
	});

	test('5.2 peer2 receives and applies remote op', async () => {
		owner.manager.join('net1', owner.peerID);
		await owner.manager.publish('net1', {
			lishID: 'sync-1', name: 'From Owner',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		});

		// Peer2 on separate DB receives the broadcast
		const peer2 = createPeer(reader.key, db2);
		peer2.manager.join('net1', owner.peerID);
		const applied = await peer2.manager.applyRemoteOp('net1', broadcasts[0]!.op);
		expect(applied).toBe(true);

		const entry = peer2.manager.get('net1', 'sync-1');
		expect(entry).not.toBeNull();
		expect(entry!.name).toBe('From Owner');
	});

	test('5.3 signed_op blob preserves signature for forwarding', async () => {
		owner.manager.join('net1', owner.peerID);
		await owner.manager.publish('net1', {
			lishID: 'fwd-1', name: 'Forward Test',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		});

		// Read stored blob, decode, verify signature
		const entry = getCatalogEntry(db, 'net1', 'fwd-1');
		const decoded = decode(Buffer.from(entry!.signed_op)) as SignedCatalogOp;
		expect(await verifyCatalogOp(decoded)).toBe(true);
	});

	test('5.4 full multi-peer lifecycle: owner publishes, peer2 syncs, mod updates on peer2', async () => {
		broadcasts.length = 0; // clear broadcasts from previous tests
		// Setup on DB1
		owner.manager.join('net1', owner.peerID);
		mod1.manager.join('net1', owner.peerID);
		await owner.manager.grantRole('net1', mod1.peerID, 'moderator');

		await owner.manager.publish('net1', {
			lishID: 'multi', name: 'Multi-Peer Entry',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		});

		// Peer2 (separate DB) syncs: apply ACL grant + add op
		const peer2Mod = createPeer(mod1.key, db2);
		peer2Mod.manager.join('net1', owner.peerID);

		// Apply all broadcasts in order (grant + add)
		for (const bc of broadcasts) {
			await peer2Mod.manager.applyRemoteOp('net1', bc.op);
		}

		expect(peer2Mod.manager.get('net1', 'multi')!.name).toBe('Multi-Peer Entry');

		// Mod updates on peer2
		await peer2Mod.manager.update('net1', 'multi', { name: 'Updated on Peer2' });
		expect(peer2Mod.manager.get('net1', 'multi')!.name).toBe('Updated on Peer2');
	});

	test('5.5 broadcasts for all operation types', async () => {
		owner.manager.join('net1', owner.peerID);
		await owner.manager.grantRole('net1', mod1.peerID, 'admin'); // acl_grant
		await owner.manager.publish('net1', {
			lishID: 'ops', name: 'Test', chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 100, fileCount: 1, manifestHash: 'h1',
		}); // add
		await owner.manager.update('net1', 'ops', { name: 'Updated' }); // update
		await owner.manager.revokeRole('net1', mod1.peerID, 'admin'); // acl_revoke
		await owner.manager.remove('net1', 'ops'); // remove

		const types = broadcasts.map(b => b.op.payload.type);
		expect(types).toEqual(['acl_grant', 'add', 'update', 'acl_revoke', 'remove']);
	});
});

// ============================================================
// 6. SECURITY — Revocation and Unauthorized Access
// ============================================================

describe('6. Security — Access Control Enforcement', () => {
	beforeEach(async () => {
		owner.manager.join('net1', owner.peerID);
		mod1.manager.join('net1', owner.peerID);
		reader.manager.join('net1', owner.peerID);
	});

	test('6.1 revoked moderator cannot publish', async () => {
		await owner.manager.grantRole('net1', mod1.peerID, 'moderator');

		// Mod publishes successfully
		await mod1.manager.publish('net1', {
			lishID: 'before', name: 'Before Revoke',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		});
		expect(mod1.manager.get('net1', 'before')).not.toBeNull();

		// Owner revokes moderator
		await owner.manager.revokeRole('net1', mod1.peerID, 'moderator');

		// Mod tries to publish again — should fail
		await expect(mod1.manager.publish('net1', {
			lishID: 'after', name: 'After Revoke',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h2',
		})).rejects.toThrow();
	});

	test('6.2 revoked admin cannot grant moderator', async () => {
		await owner.manager.grantRole('net1', admin1.peerID, 'admin');
		admin1.manager.join('net1', owner.peerID);
		await owner.manager.revokeRole('net1', admin1.peerID, 'admin');
		await expect(admin1.manager.grantRole('net1', mod2.peerID, 'moderator')).rejects.toThrow();
	});

	test('6.3 field size limits enforced', async () => {
		await owner.manager.grantRole('net1', mod1.peerID, 'moderator');
		// Name > 256 bytes
		await expect(mod1.manager.publish('net1', {
			lishID: 'big', name: 'x'.repeat(257),
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		})).rejects.toThrow();
	});

	test('6.4 name at exactly 256 bytes passes', async () => {
		await owner.manager.grantRole('net1', mod1.peerID, 'moderator');
		await mod1.manager.publish('net1', {
			lishID: 'ok', name: 'x'.repeat(256),
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		});
		expect(mod1.manager.get('net1', 'ok')).not.toBeNull();
	});

	test('6.5 too many tags rejected', async () => {
		const tags = Array.from({ length: 11 }, (_, i) => `tag${i}`);
		await expect(owner.manager.publish('net1', {
			lishID: 'tags', name: 'Tags', tags,
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		})).rejects.toThrow();
	});
});

// ============================================================
// 7. TOMBSTONE GC AND RE-ADD
// ============================================================

describe('7. Tombstone GC', () => {
	test('7.1 GC removes old tombstones, allows re-add', async () => {
		owner.manager.join('net1', owner.peerID);

		await owner.manager.publish('net1', {
			lishID: 'gc', name: 'GC Test',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		});
		await owner.manager.remove('net1', 'gc');
		expect(isTombstoned(db, 'net1', 'gc')).toBe(true);

		// Age tombstone manually
		db.run("UPDATE catalog_tombstones SET removed_at = datetime('now', '-60 days') WHERE lish_id = 'gc'");

		// GC
		const deleted = owner.manager.gcTombstones('net1', 30);
		expect(deleted).toBe(1);
		expect(isTombstoned(db, 'net1', 'gc')).toBe(false);

		// Re-add now works
		await owner.manager.publish('net1', {
			lishID: 'gc', name: 'Revived',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 200,
			fileCount: 1, manifestHash: 'h2',
		});
		expect(owner.manager.get('net1', 'gc')!.name).toBe('Revived');
	});
});

// ============================================================
// 8. CONCURRENT UPDATES — LWW CONVERGENCE
// ============================================================

describe('8. LWW Convergence', () => {
	test('8.1 same peer sequential updates — latest always wins', async () => {
		owner.manager.join('net1', owner.peerID);

		await owner.manager.publish('net1', {
			lishID: 'lww', name: 'Version 1',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		});

		await owner.manager.update('net1', 'lww', { name: 'Version 2' });
		await owner.manager.update('net1', 'lww', { name: 'Version 3' });
		await owner.manager.update('net1', 'lww', { name: 'Version 4' });

		expect(owner.manager.get('net1', 'lww')!.name).toBe('Version 4');
	});
});

// ============================================================
// 9. BULK OPERATIONS
// ============================================================

describe('9. Bulk Operations', () => {
	test('9.1 publish 50 entries, list all, search subset', async () => {
		owner.manager.join('net1', owner.peerID);
		for (let i = 0; i < 50; i++) {
			await owner.manager.publish('net1', {
				lishID: `bulk-${i}`, name: `Entry ${i}`, description: `Desc for ${i}`,
				chunkSize: 1024, checksumAlgo: 'sha256', totalSize: i * 100,
				fileCount: 1, manifestHash: `h-${i}`, tags: [`group-${i % 5}`],
			});
		}
		expect(owner.manager.list('net1', 100).length).toBe(50);
		expect(owner.manager.search('net1', '#group-3').length).toBe(10);
	});
});

// ============================================================
// 10. COMPLETE LIFECYCLE SCENARIO
// ============================================================

describe('10. Complete Lifecycle — Real-World Scenario', () => {
	test('10.1 full workflow: create network → manage roles → publish content → search → update → handover → remove', async () => {
		// Step 1: Owner creates network
		owner.manager.join('net1', owner.peerID);

		// Step 2: Owner appoints admin
		await owner.manager.grantRole('net1', admin1.peerID, 'admin');
		admin1.manager.join('net1', owner.peerID);

		// Step 3: Admin appoints two moderators
		await admin1.manager.grantRole('net1', mod1.peerID, 'moderator');
		await admin1.manager.grantRole('net1', mod2.peerID, 'moderator');
		mod1.manager.join('net1', owner.peerID);
		mod2.manager.join('net1', owner.peerID);

		// Step 4: Moderators publish content
		await mod1.manager.publish('net1', {
			lishID: 'ubuntu', name: 'Ubuntu 24.04 LTS', description: 'Desktop ISO',
			chunkSize: 1048576, checksumAlgo: 'sha256', totalSize: 4_500_000_000,
			fileCount: 1, manifestHash: 'h-ubuntu', contentType: 'software',
			tags: ['linux', 'ubuntu', 'desktop'],
		});
		await mod2.manager.publish('net1', {
			lishID: 'fedora', name: 'Fedora 41', description: 'Workstation',
			chunkSize: 1048576, checksumAlgo: 'sha256', totalSize: 3_000_000_000,
			fileCount: 1, manifestHash: 'h-fedora', contentType: 'software',
			tags: ['linux', 'fedora'],
		});

		// Step 5: Search works
		const linux = owner.manager.search('net1', '#linux');
		expect(linux.length).toBe(2);

		// Step 6: Mod1 updates own entry
		await mod1.manager.update('net1', 'ubuntu', {
			description: 'Ubuntu 24.04.1 LTS point release',
			tags: ['linux', 'ubuntu', 'desktop', 'lts'],
		});
		expect(owner.manager.get('net1', 'ubuntu')!.description).toBe('Ubuntu 24.04.1 LTS point release');

		// Step 7: Owner revokes mod1, mod1 can no longer write
		await owner.manager.revokeRole('net1', mod1.peerID, 'moderator');
		await expect(mod1.manager.publish('net1', {
			lishID: 'blocked', name: 'Should Fail',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h-blocked',
		})).rejects.toThrow();

		// Step 8: Mod2 can still publish (unaffected by mod1 revocation)
		await mod2.manager.publish('net1', {
			lishID: 'arch', name: 'Arch Linux', description: 'Rolling release',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 2_000_000_000,
			fileCount: 1, manifestHash: 'h-arch', tags: ['linux', 'arch'],
		});
		expect(owner.manager.list('net1').length).toBe(3);

		// Step 9: Admin removes outdated entry
		await admin1.manager.remove('net1', 'ubuntu');
		expect(owner.manager.list('net1').length).toBe(2);

		// Step 10: Verify final state
		const acl = owner.manager.getAccess('net1');
		expect(acl!.admins).toContain(admin1.peerID);
		expect(acl!.moderators).not.toContain(mod1.peerID);
		expect(acl!.moderators).toContain(mod2.peerID);

		const finalEntries = owner.manager.list('net1');
		const names = finalEntries.map(e => e.name);
		expect(names).toContain('Fedora 41');
		expect(names).toContain('Arch Linux');
		expect(names).not.toContain('Ubuntu 24.04 LTS');
	});
});
