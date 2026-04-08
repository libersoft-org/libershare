import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	initCatalogTables,
	upsertCatalogEntry,
	getCatalogEntry,
	listCatalogEntries,
	upsertTombstone,
	isTombstoned,
	getCatalogACL,
	ensureCatalogACL,
	updateCatalogACL,
	getVectorClock,
	updateVectorClock,
	searchCatalog,
	deleteTombstonesOlderThan,
	getDeltaEntries,
	type CatalogEntryInput,
} from '../../db/catalog.ts';

let db: Database;

beforeEach(() => {
	db = new Database(':memory:');
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA foreign_keys = ON');
	initCatalogTables(db);
});

const makeEntry = (overrides: Partial<CatalogEntryInput> = {}): CatalogEntryInput => ({
	network_id: 'net1',
	lish_id: 'lish1',
	name: 'Test',
	description: 'A test',
	publisher_peer_id: 'peer1',
	published_at: '2026-01-01T00:00:00Z',
	chunk_size: 1024,
	checksum_algo: 'sha256',
	total_size: 5000,
	file_count: 3,
	manifest_hash: 'abc123',
	content_type: 'software',
	tags: '["linux"]',
	last_edited_by: null,
	hlc_wall: 1000,
	hlc_logical: 0,
	hlc_node: 'peer1',
	signed_op: new Uint8Array([1, 2, 3]),
	...overrides,
});

describe('schema', () => {
	test('creates all tables', () => {
		const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
		const names = tables.map(t => t.name);
		expect(names).toContain('catalog_entries');
		expect(names).toContain('catalog_tombstones');
		expect(names).toContain('catalog_acl');
		expect(names).toContain('catalog_clocks');
	});
});

describe('upsertCatalogEntry — LWW merge', () => {
	test('inserts new entry', () => {
		upsertCatalogEntry(db, makeEntry());
		const entry = getCatalogEntry(db, 'net1', 'lish1');
		expect(entry).not.toBeNull();
		expect(entry!.name).toBe('Test');
	});

	test('higher HLC overwrites existing', () => {
		upsertCatalogEntry(db, makeEntry());
		upsertCatalogEntry(db, makeEntry({ name: 'Updated', hlc_wall: 2000, signed_op: new Uint8Array([4, 5]) }));
		const entry = getCatalogEntry(db, 'net1', 'lish1');
		expect(entry!.name).toBe('Updated');
	});

	test('lower HLC is rejected', () => {
		upsertCatalogEntry(db, makeEntry({ hlc_wall: 2000 }));
		upsertCatalogEntry(db, makeEntry({ name: 'Old', hlc_wall: 500, signed_op: new Uint8Array([4, 5]) }));
		const entry = getCatalogEntry(db, 'net1', 'lish1');
		expect(entry!.name).toBe('Test');
	});

	test('same wallTime — higher logical wins', () => {
		upsertCatalogEntry(db, makeEntry({ hlc_logical: 1 }));
		upsertCatalogEntry(db, makeEntry({ name: 'Logical', hlc_logical: 2, signed_op: new Uint8Array([4, 5]) }));
		const entry = getCatalogEntry(db, 'net1', 'lish1');
		expect(entry!.name).toBe('Logical');
	});

	test('same wallTime and logical — nodeID tiebreak', () => {
		upsertCatalogEntry(db, makeEntry({ hlc_node: 'A' }));
		upsertCatalogEntry(db, makeEntry({ name: 'NodeB', hlc_node: 'B', signed_op: new Uint8Array([4, 5]) }));
		const entry = getCatalogEntry(db, 'net1', 'lish1');
		expect(entry!.name).toBe('NodeB');
	});

	test('listCatalogEntries returns all entries for network', () => {
		upsertCatalogEntry(db, makeEntry({ lish_id: 'a', hlc_wall: 100 }));
		upsertCatalogEntry(db, makeEntry({ lish_id: 'b', hlc_wall: 200 }));
		upsertCatalogEntry(db, makeEntry({ lish_id: 'c', network_id: 'net2', hlc_wall: 300 }));
		const entries = listCatalogEntries(db, 'net1');
		expect(entries.length).toBe(2);
	});
});

describe('tombstones', () => {
	test('insert and check', () => {
		upsertTombstone(db, {
			network_id: 'net1', lish_id: 'lish1', removed_by: 'peer1',
			removed_at: '2026-01-01T00:00:00Z',
			hlc_wall: 1000, hlc_logical: 0, hlc_node: 'peer1',
			signed_op: new Uint8Array([1]),
		});
		expect(isTombstoned(db, 'net1', 'lish1')).toBe(true);
		expect(isTombstoned(db, 'net1', 'lish2')).toBe(false);
	});

	test('GC deletes old tombstones', () => {
		upsertTombstone(db, {
			network_id: 'net1', lish_id: 'lish1', removed_by: 'peer1',
			removed_at: '2025-01-01T00:00:00Z',
			hlc_wall: 1000, hlc_logical: 0, hlc_node: 'peer1',
			signed_op: new Uint8Array([1]),
		});
		const deleted = deleteTombstonesOlderThan(db, 'net1', 30);
		expect(deleted).toBe(1);
		expect(isTombstoned(db, 'net1', 'lish1')).toBe(false);
	});
});

describe('ACL', () => {
	test('ensures default ACL on first call', () => {
		ensureCatalogACL(db, 'net1', 'ownerPeer');
		const acl = getCatalogACL(db, 'net1');
		expect(acl).not.toBeNull();
		expect(acl!.owner).toBe('ownerPeer');
		expect(acl!.admins).toEqual([]);
		expect(acl!.moderators).toEqual([]);
		expect(acl!.restrict_writes).toBe(1);
	});

	test('update admins', () => {
		ensureCatalogACL(db, 'net1', 'ownerPeer');
		updateCatalogACL(db, 'net1', { admins: ['admin1', 'admin2'] });
		const acl = getCatalogACL(db, 'net1');
		expect(acl!.admins).toEqual(['admin1', 'admin2']);
	});

	test('update moderators', () => {
		ensureCatalogACL(db, 'net1', 'ownerPeer');
		updateCatalogACL(db, 'net1', { moderators: ['mod1'] });
		const acl = getCatalogACL(db, 'net1');
		expect(acl!.moderators).toEqual(['mod1']);
	});

	test('does not overwrite existing ACL', () => {
		ensureCatalogACL(db, 'net1', 'owner1');
		updateCatalogACL(db, 'net1', { admins: ['admin1'] });
		ensureCatalogACL(db, 'net1', 'owner2'); // should NOT overwrite
		const acl = getCatalogACL(db, 'net1');
		expect(acl!.owner).toBe('owner1');
		expect(acl!.admins).toEqual(['admin1']);
	});
});

describe('vector clocks', () => {
	test('get/set clock', () => {
		updateVectorClock(db, 'net1', 'peer1', 1000, 5);
		const clock = getVectorClock(db, 'net1', 'peer1');
		expect(clock).not.toBeNull();
		expect(clock!.hlc_wall).toBe(1000);
		expect(clock!.hlc_logical).toBe(5);
	});

	test('update replaces older clock', () => {
		updateVectorClock(db, 'net1', 'peer1', 1000, 5);
		updateVectorClock(db, 'net1', 'peer1', 2000, 0);
		const clock = getVectorClock(db, 'net1', 'peer1');
		expect(clock!.hlc_wall).toBe(2000);
	});

	test('different peers have separate clocks', () => {
		updateVectorClock(db, 'net1', 'peer1', 1000, 0);
		updateVectorClock(db, 'net1', 'peer2', 2000, 0);
		expect(getVectorClock(db, 'net1', 'peer1')!.hlc_wall).toBe(1000);
		expect(getVectorClock(db, 'net1', 'peer2')!.hlc_wall).toBe(2000);
	});
});

describe('FTS5 search', () => {
	test('finds entry by name', () => {
		upsertCatalogEntry(db, makeEntry({ name: 'Ubuntu ISO', lish_id: 'u1' }));
		const results = searchCatalog(db, 'net1', 'Ubuntu');
		expect(results.length).toBe(1);
		expect(results[0]!.name).toBe('Ubuntu ISO');
	});

	test('finds entry by description', () => {
		upsertCatalogEntry(db, makeEntry({ description: 'Workstation edition with GNOME', lish_id: 'f1' }));
		const results = searchCatalog(db, 'net1', 'GNOME');
		expect(results.length).toBe(1);
	});

	test('tag search with # prefix', () => {
		upsertCatalogEntry(db, makeEntry({ tags: '["linux","iso"]', lish_id: 't1' }));
		const results = searchCatalog(db, 'net1', '#linux');
		expect(results.length).toBe(1);
	});

	test('empty query returns all entries', () => {
		upsertCatalogEntry(db, makeEntry({ lish_id: 'a' }));
		upsertCatalogEntry(db, makeEntry({ lish_id: 'b', hlc_wall: 2000 }));
		const results = searchCatalog(db, 'net1', '');
		expect(results.length).toBe(2);
	});
});

describe('delta sync', () => {
	test('returns entries newer than given HLC', () => {
		upsertCatalogEntry(db, makeEntry({ lish_id: 'old', name: 'Old', hlc_wall: 500 }));
		upsertCatalogEntry(db, makeEntry({ lish_id: 'new', name: 'New', hlc_wall: 2000 }));
		const delta = getDeltaEntries(db, 'net1', 1000);
		expect(delta.length).toBe(1);
		expect(delta[0]!.lish_id).toBe('new');
	});
});
