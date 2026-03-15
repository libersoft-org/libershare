import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Ed25519PrivateKey } from '@libp2p/interface';
import { encode, decode } from 'cbor-x';
import { initCatalogTables, ensureCatalogACL, getCatalogEntry } from '../../db/catalog.ts';
import { signCatalogOp, verifyCatalogOp, type SignedCatalogOp } from '../catalog-signer.ts';
import { handleRemoteOp } from '../catalog-validator.ts';
import type { HLC } from '../catalog-hlc.ts';

let db: Database;
let ownerKey: Ed25519PrivateKey;
let modKey: Ed25519PrivateKey;

beforeEach(async () => {
	db = new Database(':memory:');
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA foreign_keys = ON');
	initCatalogTables(db);

	ownerKey = await generateKeyPair('Ed25519');
	modKey = await generateKeyPair('Ed25519');

	ensureCatalogACL(db, 'net1', ownerKey.publicKey.toString());

	const { op: g } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
		role: 'moderator', delegatee: modKey.publicKey.toString(),
	}, { wallTime: Date.now(), logical: 0, nodeID: 'test' });
	await handleRemoteOp(db, 'net1', g);
});

describe('CBOR signed_op blob', () => {
	test('stored blob can be decoded back to valid SignedCatalogOp', async () => {
		let clock: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'test' };
		const { op } = await signCatalogOp(modKey, 'add', 'net1', {
			lishID: 'cbor-test', name: 'CBOR Test', description: 'Testing blob round-trip',
			publisherPeerID: modKey.publicKey.toString(), publishedAt: '2026-03-15T00:00:00Z',
			chunkSize: 2048, checksumAlgo: 'sha256', totalSize: 999, fileCount: 2,
			manifestHash: 'sha256:deadbeef', contentType: 'software', tags: ['test', 'cbor'],
		}, clock);

		await handleRemoteOp(db, 'net1', op);

		// Read the stored blob
		const entry = getCatalogEntry(db, 'net1', 'cbor-test');
		expect(entry).not.toBeNull();

		// Decode CBOR blob back to SignedCatalogOp
		const decoded = decode(Buffer.from(entry!.signed_op)) as SignedCatalogOp;
		expect(decoded.payload.type).toBe('add');
		expect(decoded.payload.networkID).toBe('net1');
		expect(decoded.signer).toBe(modKey.publicKey.toString());
		expect(decoded.keyType).toBe('Ed25519');

		// Verify the decoded op still has a valid signature
		const valid = await verifyCatalogOp(decoded);
		expect(valid).toBe(true);
	});

	test('blob bytes are not modified during storage/retrieval', async () => {
		const clock: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'test' };
		const { op } = await signCatalogOp(modKey, 'add', 'net1', {
			lishID: 'byte-check', name: 'Byte Check',
			publisherPeerID: modKey.publicKey.toString(), publishedAt: '2026-03-15T00:00:00Z',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1,
			manifestHash: 'h1',
		}, clock);

		// Encode manually to compare
		const originalBlob = encode(op);

		await handleRemoteOp(db, 'net1', op);

		const entry = getCatalogEntry(db, 'net1', 'byte-check');
		const storedBlob = Buffer.from(entry!.signed_op);

		// Bytes should be identical
		expect(storedBlob.length).toBe(originalBlob.length);
		expect(Buffer.compare(storedBlob, originalBlob)).toBe(0);
	});

	test('forwarding stored blob preserves signature validity', async () => {
		const clock: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'test' };
		const { op } = await signCatalogOp(modKey, 'add', 'net1', {
			lishID: 'forward-test', name: 'Forward Test',
			publisherPeerID: modKey.publicKey.toString(), publishedAt: '2026-03-15T00:00:00Z',
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1,
			manifestHash: 'h1',
		}, clock);

		await handleRemoteOp(db, 'net1', op);

		// Simulate bilateral sync: read blob, decode, verify on "remote peer"
		const entry = getCatalogEntry(db, 'net1', 'forward-test');
		const forwarded = decode(Buffer.from(entry!.signed_op)) as SignedCatalogOp;

		// Remote peer verifies
		expect(await verifyCatalogOp(forwarded)).toBe(true);

		// Remote peer stores in its own DB
		const db2 = new Database(':memory:');
		db2.run('PRAGMA journal_mode = WAL');
		initCatalogTables(db2);
		ensureCatalogACL(db2, 'net1', ownerKey.publicKey.toString());
		const { op: g } = await signCatalogOp(ownerKey, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: modKey.publicKey.toString(),
		}, { wallTime: Date.now(), logical: 0, nodeID: 'test2' });
		await handleRemoteOp(db2, 'net1', g);
		const result = await handleRemoteOp(db2, 'net1', forwarded);
		expect(result.valid).toBe(true);

		// Verify entry exists on "remote peer"
		const remoteEntry = getCatalogEntry(db2, 'net1', 'forward-test');
		expect(remoteEntry).not.toBeNull();
		expect(remoteEntry!.name).toBe('Forward Test');
	});

	test('multiple ops encoded/decoded correctly in batch', async () => {
		let clock: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'test' };
		const ops: SignedCatalogOp[] = [];

		for (let i = 0; i < 5; i++) {
			const { op, updatedClock } = await signCatalogOp(modKey, 'add', 'net1', {
				lishID: `batch-${i}`, name: `Batch ${i}`,
				publisherPeerID: modKey.publicKey.toString(), publishedAt: new Date().toISOString(),
				chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1,
				manifestHash: `h${i}`,
			}, clock);
			clock = updatedClock;
			ops.push(op);
			await handleRemoteOp(db, 'net1', op);
		}

		// Simulate delta sync: encode batch, decode, verify all
		const batch = ops.map(op => encode(op));
		const decoded = batch.map(b => decode(b) as SignedCatalogOp);

		for (const d of decoded) {
			expect(await verifyCatalogOp(d)).toBe(true);
		}
	});
});
