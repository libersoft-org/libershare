import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { decode } from 'cbor-x';
import { initCatalogTables, ensureCatalogACL, listCatalogEntries, getCatalogEntry } from '../../db/catalog.ts';
import { signCatalogOp, type SignedCatalogOp } from '../catalog-signer.ts';
import { handleRemoteOp } from '../catalog-validator.ts';
import type { HLC } from '../catalog-hlc.ts';

function createPeerDB(ownerPeerID: string): Database {
	const db = new Database(':memory:');
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA foreign_keys = ON');
	initCatalogTables(db);
	ensureCatalogACL(db, 'net1', ownerPeerID);
	return db;
}

function clock(): HLC {
	return { wallTime: Date.now(), logical: 0, nodeID: 'conv' };
}

describe('Convergence: Two peers reach same state', () => {
	test('ops from different authors in any order → same final state', async () => {
		const owner = await generateKeyPair('Ed25519');
		const mod1 = await generateKeyPair('Ed25519');
		const mod2 = await generateKeyPair('Ed25519');
		const ownerID = owner.publicKey.toString();

		// Grant both moderators
		const oClock = clock();
		const { op: g1, updatedClock: oClock2 } = await signCatalogOp(owner, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod1.publicKey.toString(),
		}, oClock);
		const { op: g2 } = await signCatalogOp(owner, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod2.publicKey.toString(),
		}, oClock2);

		// Each mod publishes different entries (different authors → no vector clock conflict)
		let m1Clock = clock();
		const mod1Ops: SignedCatalogOp[] = [];
		for (let i = 0; i < 3; i++) {
			const { op, updatedClock } = await signCatalogOp(mod1, 'add', 'net1', {
				lishID: `m1-${i}`, name: `Mod1 Entry ${i}`,
				publisherPeerID: mod1.publicKey.toString(), publishedAt: new Date().toISOString(),
				chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: `h1-${i}`,
			}, m1Clock);
			m1Clock = updatedClock;
			mod1Ops.push(op);
		}

		let m2Clock = clock();
		const mod2Ops: SignedCatalogOp[] = [];
		for (let i = 0; i < 2; i++) {
			const { op, updatedClock } = await signCatalogOp(mod2, 'add', 'net1', {
				lishID: `m2-${i}`, name: `Mod2 Entry ${i}`,
				publisherPeerID: mod2.publicKey.toString(), publishedAt: new Date().toISOString(),
				chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 200, fileCount: 1, manifestHash: `h2-${i}`,
			}, m2Clock);
			m2Clock = updatedClock;
			mod2Ops.push(op);
		}

		// Peer A: mod1 ops first, then mod2 ops
		const dbA = createPeerDB(ownerID);
		await handleRemoteOp(dbA, 'net1', g1);
		await handleRemoteOp(dbA, 'net1', g2);
		for (const op of mod1Ops) await handleRemoteOp(dbA, 'net1', op);
		for (const op of mod2Ops) await handleRemoteOp(dbA, 'net1', op);

		// Peer B: mod2 ops first, then mod1 ops (different order)
		const dbB = createPeerDB(ownerID);
		await handleRemoteOp(dbB, 'net1', g1);
		await handleRemoteOp(dbB, 'net1', g2);
		for (const op of mod2Ops) await handleRemoteOp(dbB, 'net1', op);
		for (const op of mod1Ops) await handleRemoteOp(dbB, 'net1', op);

		// Both should have same 5 entries
		const entriesA = listCatalogEntries(dbA, 'net1', 100);
		const entriesB = listCatalogEntries(dbB, 'net1', 100);
		expect(entriesA.length).toBe(5);
		expect(entriesB.length).toBe(5);

		// Compare each entry
		for (const id of ['m1-0', 'm1-1', 'm1-2', 'm2-0', 'm2-1']) {
			const a = getCatalogEntry(dbA, 'net1', id);
			const b = getCatalogEntry(dbB, 'net1', id);
			expect(a!.name).toBe(b!.name);
			expect(a!.hlc_wall).toBe(b!.hlc_wall);
		}
	});

	test('concurrent updates from two moderators → LWW converges', async () => {
		const owner = await generateKeyPair('Ed25519');
		const mod1 = await generateKeyPair('Ed25519');
		const mod2 = await generateKeyPair('Ed25519');
		const ownerID = owner.publicKey.toString();

		// Setup: owner grants both mods
		const oClock = clock();
		const { op: g1, updatedClock: oClock2 } = await signCatalogOp(owner, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod1.publicKey.toString(),
		}, oClock);
		const { op: g2 } = await signCatalogOp(owner, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod2.publicKey.toString(),
		}, oClock2);

		// Mod1 creates entry with lower HLC
		const lowFuture: HLC = { wallTime: Date.now() + 10_000, logical: 0, nodeID: 'conv' };
		const { op: mod1Add } = await signCatalogOp(mod1, 'add', 'net1', {
			lishID: 'shared', name: 'Mod1 Version',
			publisherPeerID: mod1.publicKey.toString(), publishedAt: new Date().toISOString(),
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: 'h1',
		}, lowFuture);

		// Mod2 creates same entry with higher HLC
		const highFuture: HLC = { wallTime: Date.now() + 20_000, logical: 0, nodeID: 'conv' };
		const { op: mod2Add } = await signCatalogOp(mod2, 'add', 'net1', {
			lishID: 'shared', name: 'Mod2 Version',
			publisherPeerID: mod2.publicKey.toString(), publishedAt: new Date().toISOString(),
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 200, fileCount: 1, manifestHash: 'h2',
		}, highFuture);

		// Peer A: sees mod1 first, then mod2
		const dbA = createPeerDB(ownerID);
		await handleRemoteOp(dbA, 'net1', g1);
		await handleRemoteOp(dbA, 'net1', g2);
		await handleRemoteOp(dbA, 'net1', mod1Add);
		await handleRemoteOp(dbA, 'net1', mod2Add);

		// Peer B: sees mod2 first, then mod1
		const dbB = createPeerDB(ownerID);
		await handleRemoteOp(dbB, 'net1', g1);
		await handleRemoteOp(dbB, 'net1', g2);
		await handleRemoteOp(dbB, 'net1', mod2Add);
		await handleRemoteOp(dbB, 'net1', mod1Add);

		// Both should converge on mod2's version (higher HLC)
		const a = getCatalogEntry(dbA, 'net1', 'shared');
		const b = getCatalogEntry(dbB, 'net1', 'shared');
		expect(a!.name).toBe('Mod2 Version');
		expect(b!.name).toBe('Mod2 Version');
		expect(a!.hlc_wall).toBe(b!.hlc_wall);
	});

	test('add then remove on both peers → both converge to tombstoned', async () => {
		const owner = await generateKeyPair('Ed25519');
		const mod = await generateKeyPair('Ed25519');
		const ownerID = owner.publicKey.toString();

		let oClock = clock();
		const { op: grant, } = await signCatalogOp(owner, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod.publicKey.toString(),
		}, oClock);

		let mClock = clock();
		const { op: addOp, updatedClock: mc1 } = await signCatalogOp(mod, 'add', 'net1', {
			lishID: 'to-delete', name: 'Will be removed',
			publisherPeerID: mod.publicKey.toString(), publishedAt: new Date().toISOString(),
			chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: 'h1',
		}, mClock);
		mClock = mc1;

		const { op: removeOp } = await signCatalogOp(mod, 'remove', 'net1', { lishID: 'to-delete' }, mClock);

		// Peer A: add then remove
		const dbA = createPeerDB(ownerID);
		await handleRemoteOp(dbA, 'net1', grant);
		await handleRemoteOp(dbA, 'net1', addOp);
		await handleRemoteOp(dbA, 'net1', removeOp);

		// Peer B: remove then add (out of order)
		const dbB = createPeerDB(ownerID);
		await handleRemoteOp(dbB, 'net1', grant);
		await handleRemoteOp(dbB, 'net1', removeOp);
		await handleRemoteOp(dbB, 'net1', addOp);

		// Both: entry should be gone (tombstoned)
		expect(getCatalogEntry(dbA, 'net1', 'to-delete')).toBeNull();
		expect(getCatalogEntry(dbB, 'net1', 'to-delete')).toBeNull();
	});

	test('delta sync: peer catches up by applying stored signed_ops', async () => {
		const owner = await generateKeyPair('Ed25519');
		const mod = await generateKeyPair('Ed25519');
		const ownerID = owner.publicKey.toString();

		// Peer A generates and stores ops
		const dbA = createPeerDB(ownerID);
		let oClock = clock();
		const { op: grant, } = await signCatalogOp(owner, 'acl_grant', 'net1', {
			role: 'moderator', delegatee: mod.publicKey.toString(),
		}, oClock);
		await handleRemoteOp(dbA, 'net1', grant);

		let mClock = clock();
		for (let i = 0; i < 3; i++) {
			const { op, updatedClock } = await signCatalogOp(mod, 'add', 'net1', {
				lishID: `sync-${i}`, name: `Sync Entry ${i}`,
				publisherPeerID: mod.publicKey.toString(), publishedAt: new Date().toISOString(),
				chunkSize: 1024, checksumAlgo: 'sha256', totalSize: 100, fileCount: 1, manifestHash: `h${i}`,
			}, mClock);
			mClock = updatedClock;
			await handleRemoteOp(dbA, 'net1', op);
		}

		// Peer B catches up by reading stored signed_op blobs from A
		// Sort by hlc_wall ASC to simulate proper bilateral sync order
		const dbB = createPeerDB(ownerID);
		await handleRemoteOp(dbB, 'net1', grant);

		const entriesA = listCatalogEntries(dbA, 'net1', 100);
		const sortedByHLC = [...entriesA].sort((a, b) => a.hlc_wall - b.hlc_wall || a.hlc_logical - b.hlc_logical);
		for (const entry of sortedByHLC) {
			const op = decode(Buffer.from(entry.signed_op)) as SignedCatalogOp;
			await handleRemoteOp(dbB, 'net1', op);
		}

		// B should have same entries as A
		const entriesB = listCatalogEntries(dbB, 'net1', 100);
		expect(entriesB.length).toBe(entriesA.length);

		for (const entry of entriesA) {
			const b = getCatalogEntry(dbB, 'net1', entry.lish_id);
			expect(b).not.toBeNull();
			expect(b!.name).toBe(entry.name);
		}
	});
});
