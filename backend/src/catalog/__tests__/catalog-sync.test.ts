import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Ed25519PrivateKey } from '@libp2p/interface';
import { initCatalogTables, ensureCatalogACL, getCatalogEntry, listCatalogEntries, getEntryCount, getTombstoneCount } from '../../db/catalog.ts';
import { CatalogManager } from '../catalog-manager.ts';
import { buildSyncResponse, applySyncResponse, encodeSyncResponse, decodeSyncResponse, encodeSyncRequest, decodeSyncRequest } from '../catalog-sync.ts';
import type { SyncRequest } from '../catalog-sync.ts';

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
			lishID: 'a', name: 'Entry A', chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 100, fileCount: 1, manifestHash: 'h1',
		});
		await mgr.publish('net1', {
			lishID: 'b', name: 'Entry B', chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 200, fileCount: 1, manifestHash: 'h2',
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
			lishID: 'sync-test', name: 'From Peer A', chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 500, fileCount: 1, manifestHash: 'h1',
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
			lishID: 'a', name: 'Entry A', chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 100, fileCount: 1, manifestHash: 'h1',
		});
		await mgr.publish('net1', {
			lishID: 'b', name: 'Entry B', chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 200, fileCount: 1, manifestHash: 'h2',
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
			lishID: 'to-remove', name: 'Temp', chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 100, fileCount: 1, manifestHash: 'h1',
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
			lishID: 'cbor-sync', name: 'CBOR Sync Test', chunkSize: 1024, checksumAlgo: 'sha256',
			totalSize: 100, fileCount: 1, manifestHash: 'h1',
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
				lishID: `e${i}`, name: `Entry ${i}`, chunkSize: 1024, checksumAlgo: 'sha256',
				totalSize: 100, fileCount: 1, manifestHash: `h${i}`,
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
});
