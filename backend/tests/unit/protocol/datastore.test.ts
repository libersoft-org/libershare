import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Key } from 'interface-datastore';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import { PeerRecord, RecordEnvelope } from '@libp2p/peer-record';
import { SqliteDatastore } from '../../../src/protocol/datastore.ts';
import { createEmptyPeerStore } from '../helpers/real-peer-store.ts';

// SqliteDatastore is tested by directly exercising its SQL statements against
// an in-memory database so no filesystem cleanup is needed.

const IDENTITY_KEY = '/local/privatekey';
const PEER_KEY_A = '/peers/12D3KooWTestPeerA/addrs';
const PEER_KEY_B = '/peers/12D3KooWTestPeerB/protos';
const OTHER_KEY = '/misc/somedata';

/**
 * Create a minimal in-memory datastore table and the two statement wrappers
 * that SqliteDatastore uses, without instantiating the class itself. This lets
 * us exercise the SQL predicates directly and keeps the tests free of file
 * system I/O (no WAL, no temp-dir cleanup).
 */
function freshDatastoreDB(): {
	db: Database;
	put: (key: string, value: string) => void;
	has: (key: string) => boolean;
	clear: () => void;
	clearPeerstore: () => void;
	allKeys: () => string[];
} {
	const db = new Database(':memory:');
	db.run(`
		CREATE TABLE datastore (
			key   TEXT PRIMARY KEY,
			value BLOB NOT NULL
		)
	`);

	return {
		db,
		put(key: string, value: string): void {
			db.run('INSERT OR REPLACE INTO datastore (key, value) VALUES (?, ?)', [key, Buffer.from(value)]);
		},
		has(key: string): boolean {
			return db.query('SELECT 1 FROM datastore WHERE key = ?').get(key) != null;
		},
		/** Mirrors SqliteDatastore.clear(): remove every entry. */
		clear(): void {
			db.run('DELETE FROM datastore');
		},
		/** Mirrors SqliteDatastore.clearPeerstore(): keep /local/* entries. */
		clearPeerstore(): void {
			db.run("DELETE FROM datastore WHERE key NOT LIKE '/local/%'");
		},
		allKeys(): string[] {
			return (db.query('SELECT key FROM datastore').all() as Array<{ key: string }>).map(r => r.key).sort();
		},
	};
}

describe('SqliteDatastore.clear (SQL predicate)', () => {
	it('removes every entry including the identity key', () => {
		const s = freshDatastoreDB();
		s.put(IDENTITY_KEY, 'ed25519-key-bytes');
		s.put(PEER_KEY_A, 'multiaddr-a');
		s.put(PEER_KEY_B, 'proto-b');
		expect(s.allKeys()).toHaveLength(3);
		s.clear();
		expect(s.allKeys()).toHaveLength(0);
	});

	it('is idempotent on an empty datastore', () => {
		const s = freshDatastoreDB();
		s.clear();
		expect(s.allKeys()).toHaveLength(0);
	});
});

describe('SqliteDatastore.clearPeerstore (SQL predicate)', () => {
	it('removes peerstore entries and preserves the identity key', () => {
		const s = freshDatastoreDB();
		s.put(IDENTITY_KEY, 'ed25519-key-bytes');
		s.put(PEER_KEY_A, 'multiaddr-a');
		s.put(PEER_KEY_B, 'proto-b');
		s.clearPeerstore();
		// Identity key must survive.
		expect(s.has(IDENTITY_KEY)).toBe(true);
		// Peerstore entries must be gone.
		expect(s.has(PEER_KEY_A)).toBe(false);
		expect(s.has(PEER_KEY_B)).toBe(false);
	});

	it('preserves all /local/* entries, not just the private key path', () => {
		const s = freshDatastoreDB();
		s.put('/local/privatekey', 'key-bytes');
		s.put('/local/otherlocal', 'some-local-data');
		s.put(PEER_KEY_A, 'multiaddr');
		s.clearPeerstore();
		expect(s.has('/local/privatekey')).toBe(true);
		expect(s.has('/local/otherlocal')).toBe(true);
		expect(s.has(PEER_KEY_A)).toBe(false);
	});

	it('also removes entries outside /local/* that are not under /peers/', () => {
		const s = freshDatastoreDB();
		s.put(IDENTITY_KEY, 'key-bytes');
		s.put(OTHER_KEY, 'misc');
		s.clearPeerstore();
		// /misc/somedata does not start with /local/ so it is wiped.
		expect(s.has(IDENTITY_KEY)).toBe(true);
		expect(s.has(OTHER_KEY)).toBe(false);
	});

	it('is safe when no peerstore entries exist', () => {
		const s = freshDatastoreDB();
		s.put(IDENTITY_KEY, 'key-bytes');
		s.clearPeerstore();
		expect(s.has(IDENTITY_KEY)).toBe(true);
		expect(s.allKeys()).toHaveLength(1);
	});

	it('is safe on a completely empty datastore', () => {
		const s = freshDatastoreDB();
		s.clearPeerstore();
		expect(s.allKeys()).toHaveLength(0);
	});
});

// The block above exercises the SQL predicate in isolation. This block drives the
// REAL SqliteDatastore class against an on-disk SQLite file (its actual put/get/has
// and clearPeerstore methods, WAL and all), so a regression in the class itself —
// not just the predicate string — would be caught.
describe('SqliteDatastore.clearPeerstore (real class, on-disk DB)', () => {
	function tmpDatastore(): { ds: SqliteDatastore; dir: string } {
		const dir = mkdtempSync(join(tmpdir(), 'lish-ds-'));
		const ds = new SqliteDatastore(join(dir, 'datastore'));
		ds.open();
		return { ds, dir };
	}
	function cleanup(ds: SqliteDatastore, dir: string): void {
		ds.close();
		// Windows briefly locks the WAL/SHM files after close, so the temp dir may
		// fail to remove. The assertions have already run, so ignore cleanup errors.
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* leave the temp dir — does not affect the test outcome */
		}
	}

	it('wipes peer records but preserves the identity key (byte-for-byte)', () => {
		const { ds, dir } = tmpDatastore();
		const identity = new Key('/local/privatekey') as any;
		const peerA = new Key('/peers/12D3KooWTestA/addrs') as any;
		const peerB = new Key('/peers/12D3KooWTestB/protos') as any;
		ds.put(identity, new Uint8Array([1, 2, 3]));
		ds.put(peerA, new Uint8Array([4, 5, 6]));
		ds.put(peerB, new Uint8Array([7, 8, 9]));

		ds.clearPeerstore();

		expect(ds.has(identity)).toBe(true);
		expect(ds.has(peerA)).toBe(false);
		expect(ds.has(peerB)).toBe(false);
		// Identity bytes must survive untouched, not merely exist.
		expect(Array.from(ds.get(identity))).toEqual([1, 2, 3]);
		cleanup(ds, dir);
	});

	it('clear() wipes the identity key too (contrast with clearPeerstore)', () => {
		const { ds, dir } = tmpDatastore();
		const identity = new Key('/local/privatekey') as any;
		ds.put(identity, new Uint8Array([1]));
		ds.put(new Key('/peers/x/addrs') as any, new Uint8Array([2]));

		ds.clear();

		expect(ds.has(identity)).toBe(false);
		cleanup(ds, dir);
	});

	it('clearIdentityKey removes only the private key and preserves peer records', async () => {
		const { ds, dir } = tmpDatastore();
		const identity = new Key(IDENTITY_KEY) as any;
		const peer = new Key(PEER_KEY_A) as any;
		ds.put(identity, new Uint8Array([1, 2, 3]));
		ds.put(peer, new Uint8Array([4, 5, 6]));
		ds.close();

		await clearIdentityKey(dir);

		const reopened = new SqliteDatastore(join(dir, 'datastore'));
		reopened.open();
		expect(reopened.has(identity)).toBe(false);
		expect(reopened.has(peer)).toBe(true);
		expect(Array.from(reopened.get(peer))).toEqual([4, 5, 6]);
		cleanup(reopened, dir);
	});
});

/**
 * What libp2p does with a peer it has never stored, over the datastore PRODUCTION uses.
 *
 * The peer-store is not consistent about how it recognises "not stored": some paths accept
 * `code === 'ERR_NOT_FOUND'`, others test only `name === 'NotFoundError'`. A missing key
 * that raises only the code turns the ordinary first-contact branch into a failure, and no
 * test over `MemoryDatastore` can catch it — that one raises the canonical error already.
 */
describe('peer-store over a real SqliteDatastore — a peer it has never stored', () => {
	const UNKNOWN = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';

	function tmpPeerStore(): { store: any; ds: SqliteDatastore; dir: string } {
		const dir = mkdtempSync(join(tmpdir(), 'lish-ps-'));
		const ds = new SqliteDatastore(join(dir, 'datastore'));
		ds.open();
		return { store: createEmptyPeerStore(ds), ds, dir };
	}
	function cleanup(ds: SqliteDatastore, dir: string): void {
		ds.close();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* Windows holds the WAL briefly after close; the assertions have already run */
		}
	}

	it('answers has() with false instead of rethrowing', async () => {
		const { store, ds, dir } = tmpPeerStore();
		expect(await store.has(peerIdFromString(UNKNOWN))).toBe(false);
		cleanup(ds, dir);
	});

	it('accepts the first signed peer record of an unknown peer', async () => {
		const { store, ds, dir } = tmpPeerStore();
		const privateKey = await generateKeyPair('Ed25519');
		const peerId = peerIdFromPrivateKey(privateKey);
		const record = new PeerRecord({ peerId, multiaddrs: [multiaddr('/ip4/203.0.113.51/tcp/9090')] });
		const envelope = await RecordEnvelope.seal(record, privateKey);
		expect(await store.consumePeerRecord(envelope.marshal().subarray())).toBe(true);
		expect((await store.get(peerId)).addresses.map((a: any) => a.multiaddr.toString())).toEqual(['/ip4/203.0.113.51/tcp/9090']);
		cleanup(ds, dir);
	});

	/** The require-existing write has no record to build on, so it must refuse outright. */
	it('refuses a require-existing write for a peer with no record', async () => {
		const { store, ds, dir } = tmpPeerStore();
		const pid = peerIdFromString(UNKNOWN);
		await expect(store.store.patchExisting(pid, { addresses: [] })).rejects.toThrow('was removed while its record was being updated');
		expect(await store.has(pid)).toBe(false);
		cleanup(ds, dir);
	});
});
