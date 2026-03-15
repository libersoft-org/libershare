import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Ed25519PrivateKey } from '@libp2p/interface';
import { initCatalogTables } from '../../db/catalog.ts';
import { CatalogManager } from '../catalog-manager.ts';
import type { SignedCatalogOp } from '../catalog-signer.ts';

let db: Database;
let ownerKey: Ed25519PrivateKey;
let ownerPeerID: string;

function createManager(key: Ed25519PrivateKey, database?: Database): CatalogManager {
	const d = database ?? db;
	return new CatalogManager({
		db: d,
		getPrivateKey: () => key,
		getLocalPeerID: () => key.publicKey.toString(),
	});
}

beforeEach(async () => {
	db = new Database(':memory:');
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA foreign_keys = ON');
	initCatalogTables(db);
	ownerKey = await generateKeyPair('Ed25519');
	ownerPeerID = ownerKey.publicKey.toString();
});

describe('CatalogManager: Join/Leave', () => {
	test('join creates ACL and registers network', () => {
		const mgr = createManager(ownerKey);
		mgr.join('net1', ownerPeerID);
		expect(mgr.isJoined('net1')).toBe(true);
		expect(mgr.getJoinedNetworks()).toEqual(['net1']);
		const acl = mgr.getAccess('net1');
		expect(acl!.owner).toBe(ownerPeerID);
	});

	test('leave removes network', () => {
		const mgr = createManager(ownerKey);
		mgr.join('net1', ownerPeerID);
		mgr.leave('net1');
		expect(mgr.isJoined('net1')).toBe(false);
	});

	test('double join is idempotent', () => {
		const mgr = createManager(ownerKey);
		mgr.join('net1', ownerPeerID);
		mgr.join('net1', ownerPeerID);
		expect(mgr.getJoinedNetworks().length).toBe(1);
	});

	test('operations on unjoined network throw', () => {
		const mgr = createManager(ownerKey);
		expect(() => mgr.list('net1')).toThrow('not joined');
	});
});

describe('CatalogManager: Publish flow', () => {
	test('owner publishes entry, can list and get', async () => {
		const mgr = createManager(ownerKey);
		mgr.join('net1', ownerPeerID);

		await mgr.publish('net1', {
			lishID: 'lish-1',
			name: 'Ubuntu 24.04',
			description: 'Desktop ISO',
			chunkSize: 1048576,
			checksumAlgo: 'sha256',
			totalSize: 4_500_000_000,
			fileCount: 1,
			manifestHash: 'sha256:abc',
			contentType: 'software',
			tags: ['linux', 'ubuntu'],
		});

		const entries = mgr.list('net1');
		expect(entries.length).toBe(1);
		expect(entries[0]!.name).toBe('Ubuntu 24.04');

		const entry = mgr.get('net1', 'lish-1');
		expect(entry).not.toBeNull();
		expect(entry!.total_size).toBe(4_500_000_000);
	});

	test('moderator publishes after being granted role', async () => {
		const modKey = await generateKeyPair('Ed25519');
		const ownerMgr = createManager(ownerKey);
		const modMgr = createManager(modKey);

		ownerMgr.join('net1', ownerPeerID);
		modMgr.join('net1', ownerPeerID);

		// Owner grants moderator
		await ownerMgr.grantRole('net1', modKey.publicKey.toString(), 'moderator');

		// Moderator publishes
		await modMgr.publish('net1', {
			lishID: 'lish-mod',
			name: 'Fedora 41',
			chunkSize: 1024,
			checksumAlgo: 'sha256',
			totalSize: 3000,
			fileCount: 1,
			manifestHash: 'hash-fed',
		});

		// Both managers see the entry (shared DB)
		expect(ownerMgr.list('net1').length).toBe(1);
		expect(modMgr.get('net1', 'lish-mod')!.name).toBe('Fedora 41');
	});
});

describe('CatalogManager: Update flow', () => {
	test('update changes metadata, preserves immutable fields', async () => {
		const mgr = createManager(ownerKey);
		mgr.join('net1', ownerPeerID);

		await mgr.publish('net1', {
			lishID: 'lish-u', name: 'Original Name',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 1000,
			fileCount: 1, manifestHash: 'hash-1',
		});

		await mgr.update('net1', 'lish-u', {
			name: 'Updated Name',
			description: 'Added description',
			tags: ['new-tag'],
		});

		const entry = mgr.get('net1', 'lish-u');
		expect(entry!.name).toBe('Updated Name');
		expect(entry!.description).toBe('Added description');
		expect(entry!.total_size).toBe(1000); // immutable — unchanged
		expect(entry!.last_edited_by).toBe(ownerPeerID);
	});

	test('update nonexistent entry throws', async () => {
		const mgr = createManager(ownerKey);
		mgr.join('net1', ownerPeerID);
		await expect(mgr.update('net1', 'nonexistent', { name: 'X' })).rejects.toThrow('not found');
	});
});

describe('CatalogManager: Remove flow', () => {
	test('remove creates tombstone, entry disappears', async () => {
		const mgr = createManager(ownerKey);
		mgr.join('net1', ownerPeerID);

		await mgr.publish('net1', {
			lishID: 'lish-r', name: 'To Remove',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 500,
			fileCount: 1, manifestHash: 'h1',
		});
		expect(mgr.get('net1', 'lish-r')).not.toBeNull();

		await mgr.remove('net1', 'lish-r');
		expect(mgr.get('net1', 'lish-r')).toBeNull();
		expect(mgr.list('net1').length).toBe(0);
	});
});

describe('CatalogManager: ACL management', () => {
	test('full chain: owner → admin → moderator', async () => {
		const adminKey = await generateKeyPair('Ed25519');
		const modKey = await generateKeyPair('Ed25519');

		const ownerMgr = createManager(ownerKey);
		const adminMgr = createManager(adminKey);

		ownerMgr.join('net1', ownerPeerID);
		adminMgr.join('net1', ownerPeerID);

		// Owner grants admin
		await ownerMgr.grantRole('net1', adminKey.publicKey.toString(), 'admin');
		let acl = ownerMgr.getAccess('net1');
		expect(acl!.admins).toContain(adminKey.publicKey.toString());

		// Admin grants moderator
		await adminMgr.grantRole('net1', modKey.publicKey.toString(), 'moderator');
		acl = ownerMgr.getAccess('net1');
		expect(acl!.moderators).toContain(modKey.publicKey.toString());

		// Owner revokes admin
		await ownerMgr.revokeRole('net1', adminKey.publicKey.toString(), 'admin');
		acl = ownerMgr.getAccess('net1');
		expect(acl!.admins).not.toContain(adminKey.publicKey.toString());
	});

	test('unauthorized grant throws', async () => {
		const randomKey = await generateKeyPair('Ed25519');
		const randomMgr = createManager(randomKey);
		randomMgr.join('net1', ownerPeerID);

		await expect(
			randomMgr.grantRole('net1', 'some-peer', 'admin')
		).rejects.toThrow('Grant failed');
	});
});

describe('CatalogManager: Search', () => {
	test('FTS search finds entries by name and description', async () => {
		const mgr = createManager(ownerKey);
		mgr.join('net1', ownerPeerID);

		for (const [id, name, desc] of [
			['a', 'Ubuntu Desktop', 'GNOME desktop environment'],
			['b', 'Fedora Server', 'Minimal server install'],
			['c', 'Arch Linux', 'Rolling release distro'],
		] as const) {
			await mgr.publish('net1', {
				lishID: id, name, description: desc,
				chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
				fileCount: 1, manifestHash: `h-${id}`,
			});
		}

		expect(mgr.search('net1', 'GNOME').length).toBe(1);
		expect(mgr.search('net1', 'server').length).toBe(1);
		expect(mgr.search('net1', '').length).toBe(3);
	});

	test('tag search with # prefix', async () => {
		const mgr = createManager(ownerKey);
		mgr.join('net1', ownerPeerID);

		await mgr.publish('net1', {
			lishID: 'x', name: 'Test',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1', tags: ['linux', 'iso'],
		});

		expect(mgr.search('net1', '#linux').length).toBe(1);
		expect(mgr.search('net1', '#windows').length).toBe(0);
	});
});

describe('CatalogManager: Broadcast callback', () => {
	test('broadcast is called on publish, update, remove', async () => {
		const broadcasts: { networkID: string; type: string }[] = [];
		const mgr = new CatalogManager({
			db,
			getPrivateKey: () => ownerKey,
			getLocalPeerID: () => ownerPeerID,
			broadcast: (networkID, op) => {
				broadcasts.push({ networkID, type: op.payload.type });
			},
		});
		mgr.join('net1', ownerPeerID);

		await mgr.publish('net1', {
			lishID: 'bc', name: 'Broadcast Test',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		});
		await mgr.update('net1', 'bc', { name: 'Updated' });
		await mgr.remove('net1', 'bc');

		expect(broadcasts.length).toBe(3);
		expect(broadcasts[0]!.type).toBe('add');
		expect(broadcasts[1]!.type).toBe('update');
		expect(broadcasts[2]!.type).toBe('remove');
	});
});

describe('CatalogManager: Remote op application', () => {
	test('applyRemoteOp from another peer stores entry', async () => {
		const peer2Key = await generateKeyPair('Ed25519');

		// Manager 1 (owner) creates and publishes
		const mgr1 = createManager(ownerKey);
		mgr1.join('net1', ownerPeerID);

		let capturedOp: SignedCatalogOp | null = null;
		const mgr1WithBroadcast = new CatalogManager({
			db,
			getPrivateKey: () => ownerKey,
			getLocalPeerID: () => ownerPeerID,
			broadcast: (_nid, op) => { capturedOp = op; },
		});
		mgr1WithBroadcast.join('net1', ownerPeerID);

		await mgr1WithBroadcast.publish('net1', {
			lishID: 'remote-test', name: 'From Peer 1',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		});

		expect(capturedOp).not.toBeNull();

		// Manager 2 (different DB) receives the op
		const db2 = new Database(':memory:');
		db2.run('PRAGMA journal_mode = WAL');
		db2.run('PRAGMA foreign_keys = ON');
		initCatalogTables(db2);

		const mgr2 = createManager(peer2Key, db2);
		mgr2.join('net1', ownerPeerID);

		const applied = await mgr2.applyRemoteOp('net1', capturedOp!);
		expect(applied).toBe(true);

		const entry = mgr2.get('net1', 'remote-test');
		expect(entry).not.toBeNull();
		expect(entry!.name).toBe('From Peer 1');
	});
});

describe('CatalogManager: Multi-network', () => {
	test('publish to different networks independently', async () => {
		const owner2Key = await generateKeyPair('Ed25519');
		const mgr = createManager(ownerKey);
		mgr.join('net1', ownerPeerID);
		mgr.join('net2', ownerPeerID);

		await mgr.publish('net1', {
			lishID: 'a', name: 'Net1 Entry',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		});

		await mgr.publish('net2', {
			lishID: 'b', name: 'Net2 Entry',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 200,
			fileCount: 1, manifestHash: 'h2',
		});

		expect(mgr.list('net1').length).toBe(1);
		expect(mgr.list('net2').length).toBe(1);
		expect(mgr.get('net1', 'b')).toBeNull();
		expect(mgr.get('net2', 'a')).toBeNull();
	});
});

describe('CatalogManager: GC', () => {
	test('gcTombstones removes old tombstones', async () => {
		const mgr = createManager(ownerKey);
		mgr.join('net1', ownerPeerID);

		await mgr.publish('net1', {
			lishID: 'gc-entry', name: 'To GC',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100,
			fileCount: 1, manifestHash: 'h1',
		});
		await mgr.remove('net1', 'gc-entry');

		// Manually age the tombstone
		db.run("UPDATE catalog_tombstones SET removed_at = datetime('now', '-60 days') WHERE lish_id = 'gc-entry'");

		const deleted = mgr.gcTombstones('net1', 30);
		expect(deleted).toBe(1);
	});
});
