import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Ed25519PrivateKey } from '@libp2p/interface';
import { initCatalogTables, ensureCatalogACL, getCatalogEntry, getEntryCount } from '../../../src/db/catalog.ts';
import { CatalogManager } from '../../../src/catalog/catalog-manager.ts';
import { buildSyncResponse, applySyncResponse, encodeSyncResponse, decodeSyncResponse, encodeSyncRequest, decodeSyncRequest } from '../../../src/catalog/catalog-sync.ts';
import type { SyncRequest } from '../../../src/catalog/catalog-sync.ts';

let ownerKey: Ed25519PrivateKey;
let ownerPeerID: string;

function createDB(): Database {
	const d = new Database(':memory:');
	d.run('PRAGMA journal_mode = WAL');
	d.run('PRAGMA foreign_keys = ON');
	initCatalogTables(d);
	return d;
}

function createManager(key: Ed25519PrivateKey, database: Database): CatalogManager {
	return new CatalogManager({
		db: database,
		getPrivateKey: () => key,
		getLocalPeerID: () => key.publicKey.toString(),
	});
}

beforeEach(async () => {
	ownerKey = await generateKeyPair('Ed25519');
	ownerPeerID = ownerKey.publicKey.toString();
});

describe('Bilateral Sync', () => {
	test('buildSyncResponse returns entries and tombstones since HLC', async () => {
		const db = createDB();
		const mgr = createManager(ownerKey, db);
		mgr.join('net1', ownerPeerID);

		await mgr.publish('net1', {
			lishID: 'a',
			name: 'Entry A',
			chunkSize: 1024,
			checksumAlgo: 'sha256',
			totalSize: 100,
			fileCount: 1,
			manifestHash: 'h1',
		});
		await mgr.publish('net1', {
			lishID: 'b',
			name: 'Entry B',
			chunkSize: 1024,
			checksumAlgo: 'sha256',
			totalSize: 200,
			fileCount: 1,
			manifestHash: 'h2',
		});

		const response = buildSyncResponse(db, 'net1', 0);
		expect(response.command).toBe('catalog_sync_res');
		expect(response.operations.length).toBe(2);
		expect(response.entryCount).toBe(2);
		expect(response.gcCutoff).toBeGreaterThan(0);
	});

	test('applySyncResponse stores entries on receiving peer', async () => {
		const dbA = createDB();
		const dbB = createDB();
		const mgrA = createManager(ownerKey, dbA);
		const mgrB = createManager(ownerKey, dbB);

		mgrA.join('net1', ownerPeerID);
		mgrB.join('net1', ownerPeerID);

		// Peer A publishes
		await mgrA.publish('net1', {
			lishID: 'sync-test',
			name: 'From Peer A',
			chunkSize: 1024,
			checksumAlgo: 'sha256',
			totalSize: 500,
			fileCount: 1,
			manifestHash: 'h1',
		});

		// Build sync response from A
		const response = buildSyncResponse(dbA, 'net1', 0);

		// Apply on B
		const applied = await applySyncResponse(dbB, 'net1', response);
		expect(applied).toBe(1);
		expect(getCatalogEntry(dbB, 'net1', 'sync-test')!.name).toBe('From Peer A');
	});

	test('delta sync — sinceHlcWall=0 gets all, high value gets none', async () => {
		const db = createDB();
		const mgr = createManager(ownerKey, db);
		mgr.join('net1', ownerPeerID);

		await mgr.publish('net1', {
			lishID: 'a',
			name: 'Entry A',
			chunkSize: 1024,
			checksumAlgo: 'sha256',
			totalSize: 100,
			fileCount: 1,
			manifestHash: 'h1',
		});
		await mgr.publish('net1', {
			lishID: 'b',
			name: 'Entry B',
			chunkSize: 1024,
			checksumAlgo: 'sha256',
			totalSize: 200,
			fileCount: 1,
			manifestHash: 'h2',
		});

		// All entries since 0
		const allResponse = buildSyncResponse(db, 'net1', 0);
		expect(allResponse.operations.length).toBe(2);

		// No entries since far future
		const noneResponse = buildSyncResponse(db, 'net1', Date.now() + 100_000);
		expect(noneResponse.operations.length).toBe(0);
	});

	test('sync includes tombstones', async () => {
		const db = createDB();
		const mgr = createManager(ownerKey, db);
		mgr.join('net1', ownerPeerID);

		await mgr.publish('net1', {
			lishID: 'to-remove',
			name: 'Temp',
			chunkSize: 1024,
			checksumAlgo: 'sha256',
			totalSize: 100,
			fileCount: 1,
			manifestHash: 'h1',
		});
		await mgr.remove('net1', 'to-remove');

		const response = buildSyncResponse(db, 'net1', 0);
		// Should include the tombstone signed_op
		expect(response.tombstoneCount).toBe(1);
		expect(response.operations.length).toBeGreaterThanOrEqual(1);
	});

	test('sync includes ACL info', async () => {
		const db = createDB();
		const mgr = createManager(ownerKey, db);
		mgr.join('net1', ownerPeerID);

		const response = buildSyncResponse(db, 'net1', 0);
		const acl = JSON.parse(response.aclJSON);
		expect(acl.owner).toBe(ownerPeerID);
	});

	test('CBOR encode/decode round-trip for SyncRequest', () => {
		const req: SyncRequest = {
			command: 'catalog_sync_req',
			requestID: crypto.randomUUID(),
			networkID: 'net-test',
			sinceHlcWall: 1773000000000,
		};
		const encoded = encodeSyncRequest(req);
		const decoded = decodeSyncRequest(encoded);
		expect(decoded.command).toBe(req.command);
		expect(decoded.networkID).toBe(req.networkID);
		expect(decoded.sinceHlcWall).toBe(req.sinceHlcWall);
	});

	test('CBOR encode/decode round-trip for SyncResponse', async () => {
		const db = createDB();
		const mgr = createManager(ownerKey, db);
		mgr.join('net1', ownerPeerID);

		await mgr.publish('net1', {
			lishID: 'cbor-sync',
			name: 'CBOR Sync Test',
			chunkSize: 1024,
			checksumAlgo: 'sha256',
			totalSize: 100,
			fileCount: 1,
			manifestHash: 'h1',
		});

		const response = buildSyncResponse(db, 'net1', 0);
		const encoded = encodeSyncResponse(response);
		const decoded = decodeSyncResponse(encoded);

		expect(decoded.command).toBe('catalog_sync_res');
		expect(decoded.operations.length).toBe(1);
		expect(decoded.entryCount).toBe(1);
	});

	test('full sync flow: peer A → build response → encode → decode → apply on peer B', async () => {
		const dbA = createDB();
		const dbB = createDB();
		const mgrA = createManager(ownerKey, dbA);
		const mgrB = createManager(ownerKey, dbB);

		mgrA.join('net1', ownerPeerID);
		mgrB.join('net1', ownerPeerID);

		// Peer A has 5 entries
		for (let i = 0; i < 5; i++) {
			await mgrA.publish('net1', {
				lishID: `e${i}`,
				name: `Entry ${i}`,
				chunkSize: 1024,
				checksumAlgo: 'sha256',
				totalSize: 100,
				fileCount: 1,
				manifestHash: `h${i}`,
			});
		}

		// Full sync flow
		const response = buildSyncResponse(dbA, 'net1', 0);
		const wire = encodeSyncResponse(response);
		const received = decodeSyncResponse(wire);
		const applied = await applySyncResponse(dbB, 'net1', received);

		expect(applied).toBe(5);
		expect(getEntryCount(dbB, 'net1')).toBe(5);

		for (let i = 0; i < 5; i++) {
			expect(getCatalogEntry(dbB, 'net1', `e${i}`)!.name).toBe(`Entry ${i}`);
		}
	});

	test('sync response includes ACL state for peer setup', async () => {
		const dbA = createDB();
		const mgrA = createManager(ownerKey, dbA);
		mgrA.join('net1', ownerPeerID);

		const modKey = await generateKeyPair('Ed25519');
		await mgrA.grantRole('net1', modKey.publicKey.toString(), 'moderator');

		const response = buildSyncResponse(dbA, 'net1', 0);
		const acl = JSON.parse(response.aclJSON);
		expect(acl.owner).toBe(ownerPeerID);
		expect(acl.moderators).toContain(modKey.publicKey.toString());
	});

	test('applySyncResponse with owner entries on fresh peer', async () => {
		const dbA = createDB();
		const dbB = createDB();
		const mgrA = createManager(ownerKey, dbA);

		mgrA.join('net1', ownerPeerID);

		// Owner publishes directly (no moderator needed — owner has all permissions)
		await mgrA.publish('net1', {
			lishID: 'owner-entry',
			name: 'By Owner',
			chunkSize: 1024,
			checksumAlgo: 'sha256',
			totalSize: 100,
			fileCount: 1,
			manifestHash: 'h1',
		});

		const response = buildSyncResponse(dbA, 'net1', 0);

		// Peer B sets up ACL from sync response, then applies ops
		ensureCatalogACL(dbB, 'net1', ownerPeerID);
		const applied = await applySyncResponse(dbB, 'net1', response);
		expect(applied).toBe(1);
		expect(getCatalogEntry(dbB, 'net1', 'owner-entry')!.name).toBe('By Owner');
	});
});

describe('Bilateral Sync: ACL delegation replay', () => {
	test('late joiner learns delegated roles via sync and accepts delegated content', async () => {
		const adminKey = await generateKeyPair('Ed25519');
		const adminPeerID = adminKey.publicKey.toString();

		// Source node: owner grants admin to another peer, admin publishes an entry.
		const srcDB = createDB();
		const ownerMgr = createManager(ownerKey, srcDB);
		ownerMgr.join('net1', ownerPeerID);
		await ownerMgr.grantRole('net1', adminPeerID, 'admin');

		const adminMgr = createManager(adminKey, srcDB);
		adminMgr.join('net1', ownerPeerID);
		await adminMgr.publish('net1', {
			lishID: 'delegated-entry',
			name: 'Published By Delegated Admin',
			chunkSize: 1024,
			checksumAlgo: 'sha256',
			totalSize: 100,
			fileCount: 1,
			manifestHash: 'h-delegated',
		});

		// Late joiner: fresh DB, ACL knows only the owner, writes restricted.
		const lateDB = createDB();
		ensureCatalogACL(lateDB, 'net1', ownerPeerID);

		const response = buildSyncResponse(srcDB, 'net1', 0);
		const applied = await applySyncResponse(lateDB, 'net1', response);

		// Both the ACL grant and the delegated entry must have been accepted.
		expect(applied).toBeGreaterThanOrEqual(2);
		const entry = getCatalogEntry(lateDB, 'net1', 'delegated-entry');
		expect(entry).not.toBeNull();
		expect(entry!.publisher_peer_id).toBe(adminPeerID);

		const { getCatalogACL } = await import('../../../src/db/catalog.ts');
		const lateACL = getCatalogACL(lateDB, 'net1');
		expect(lateACL!.admins).toContain(adminPeerID);
	});

	test('sync response survives wire encode/decode with ACL ops included', async () => {
		const modKey = await generateKeyPair('Ed25519');
		const modPeerID = modKey.publicKey.toString();

		const srcDB = createDB();
		const ownerMgr = createManager(ownerKey, srcDB);
		ownerMgr.join('net1', ownerPeerID);
		await ownerMgr.grantRole('net1', modPeerID, 'moderator');

		const wire = encodeSyncResponse(buildSyncResponse(srcDB, 'net1', 0));
		const decoded = decodeSyncResponse(wire);

		const lateDB = createDB();
		ensureCatalogACL(lateDB, 'net1', ownerPeerID);
		const applied = await applySyncResponse(lateDB, 'net1', decoded);
		expect(applied).toBeGreaterThanOrEqual(1);

		const { getCatalogACL } = await import('../../../src/db/catalog.ts');
		expect(getCatalogACL(lateDB, 'net1')!.moderators).toContain(modPeerID);
	});
});
