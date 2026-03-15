import type { Database } from 'bun:sqlite';

export interface CatalogEntryRow {
	id: number;
	network_id: string;
	lish_id: string;
	name: string | null;
	description: string | null;
	publisher_peer_id: string;
	published_at: string;
	chunk_size: number;
	checksum_algo: string;
	total_size: number;
	file_count: number;
	manifest_hash: string;
	content_type: string | null;
	tags: string | null;
	last_edited_by: string | null;
	hlc_wall: number;
	hlc_logical: number;
	hlc_node: string;
	signed_op: Uint8Array;
}

export interface CatalogEntryInput {
	network_id: string;
	lish_id: string;
	name: string | null;
	description: string | null;
	publisher_peer_id: string;
	published_at: string;
	chunk_size: number;
	checksum_algo: string;
	total_size: number;
	file_count: number;
	manifest_hash: string;
	content_type: string | null;
	tags: string | null;
	last_edited_by: string | null;
	hlc_wall: number;
	hlc_logical: number;
	hlc_node: string;
	signed_op: Uint8Array;
}

export interface TombstoneInput {
	network_id: string;
	lish_id: string;
	removed_by: string;
	removed_at: string;
	hlc_wall: number;
	hlc_logical: number;
	hlc_node: string;
	signed_op: Uint8Array;
}

export interface CatalogACLRow {
	network_id: string;
	owner: string;
	admins: string[];
	moderators: string[];
	restrict_writes: number;
}

export interface VectorClockRow {
	network_id: string;
	peer_id: string;
	hlc_wall: number;
	hlc_logical: number;
}

export function initCatalogTables(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS catalog_entries (
			id                INTEGER PRIMARY KEY AUTOINCREMENT,
			network_id        TEXT NOT NULL,
			lish_id           TEXT NOT NULL,
			name              TEXT,
			description       TEXT,
			publisher_peer_id TEXT NOT NULL,
			published_at      TEXT NOT NULL,
			chunk_size        INTEGER NOT NULL,
			checksum_algo     TEXT NOT NULL,
			total_size        INTEGER NOT NULL,
			file_count        INTEGER NOT NULL,
			manifest_hash     TEXT NOT NULL,
			content_type      TEXT,
			tags              TEXT,
			last_edited_by    TEXT,
			hlc_wall          INTEGER NOT NULL,
			hlc_logical       INTEGER NOT NULL,
			hlc_node          TEXT NOT NULL,
			signed_op         BLOB NOT NULL,
			UNIQUE(network_id, lish_id)
		)
	`);
	db.run('CREATE INDEX IF NOT EXISTS idx_catalog_entries_network ON catalog_entries(network_id)');
	db.run('CREATE INDEX IF NOT EXISTS idx_catalog_entries_hlc ON catalog_entries(network_id, hlc_wall)');

	db.run(`
		CREATE TABLE IF NOT EXISTS catalog_tombstones (
			id                INTEGER PRIMARY KEY AUTOINCREMENT,
			network_id        TEXT NOT NULL,
			lish_id           TEXT NOT NULL,
			removed_by        TEXT NOT NULL,
			removed_at        TEXT NOT NULL,
			hlc_wall          INTEGER NOT NULL,
			hlc_logical       INTEGER NOT NULL,
			hlc_node          TEXT NOT NULL,
			signed_op         BLOB NOT NULL,
			UNIQUE(network_id, lish_id)
		)
	`);
	db.run('CREATE INDEX IF NOT EXISTS idx_catalog_tombstones_network ON catalog_tombstones(network_id)');

	db.run(`
		CREATE TABLE IF NOT EXISTS catalog_acl (
			network_id        TEXT PRIMARY KEY,
			owner             TEXT NOT NULL,
			admins            TEXT NOT NULL DEFAULT '[]',
			moderators        TEXT NOT NULL DEFAULT '[]',
			restrict_writes   INTEGER NOT NULL DEFAULT 1
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS catalog_clocks (
			network_id        TEXT NOT NULL,
			peer_id           TEXT NOT NULL,
			hlc_wall          INTEGER NOT NULL,
			hlc_logical       INTEGER NOT NULL,
			PRIMARY KEY(network_id, peer_id)
		)
	`);

	db.run(`
		CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
			name, description, tags,
			content=catalog_entries,
			content_rowid=id
		)
	`);
}

export function upsertCatalogEntry(db: Database, entry: CatalogEntryInput): void {
	const tx = db.transaction(() => {
		db.run(
			`INSERT INTO catalog_entries (network_id, lish_id, name, description,
				publisher_peer_id, published_at, chunk_size, checksum_algo,
				total_size, file_count, manifest_hash, content_type, tags,
				last_edited_by, hlc_wall, hlc_logical, hlc_node, signed_op)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(network_id, lish_id) DO UPDATE SET
				name = excluded.name,
				description = excluded.description,
				total_size = excluded.total_size,
				file_count = excluded.file_count,
				content_type = excluded.content_type,
				tags = excluded.tags,
				last_edited_by = excluded.last_edited_by,
				hlc_wall = excluded.hlc_wall,
				hlc_logical = excluded.hlc_logical,
				hlc_node = excluded.hlc_node,
				signed_op = excluded.signed_op
			WHERE excluded.hlc_wall > catalog_entries.hlc_wall
				OR (excluded.hlc_wall = catalog_entries.hlc_wall
					AND excluded.hlc_logical > catalog_entries.hlc_logical)
				OR (excluded.hlc_wall = catalog_entries.hlc_wall
					AND excluded.hlc_logical = catalog_entries.hlc_logical
					AND excluded.hlc_node > catalog_entries.hlc_node)`,
			[
				entry.network_id, entry.lish_id, entry.name, entry.description,
				entry.publisher_peer_id, entry.published_at, entry.chunk_size, entry.checksum_algo,
				entry.total_size, entry.file_count, entry.manifest_hash, entry.content_type, entry.tags,
				entry.last_edited_by, entry.hlc_wall, entry.hlc_logical, entry.hlc_node, entry.signed_op,
			]
		);

		// Sync FTS5 index
		const row = db.query<{ id: number }, [string, string]>(
			'SELECT id FROM catalog_entries WHERE network_id = ? AND lish_id = ?'
		).get(entry.network_id, entry.lish_id);
		if (row) {
			db.run('INSERT OR REPLACE INTO catalog_fts(rowid, name, description, tags) VALUES (?, ?, ?, ?)', [
				row.id, entry.name, entry.description, entry.tags,
			]);
		}
	});
	tx();
}

export function getCatalogEntry(db: Database, networkID: string, lishID: string): CatalogEntryRow | null {
	return db.query<CatalogEntryRow, [string, string]>(
		'SELECT * FROM catalog_entries WHERE network_id = ? AND lish_id = ?'
	).get(networkID, lishID);
}

export function listCatalogEntries(db: Database, networkID: string, limit: number = 100): CatalogEntryRow[] {
	return db.query<CatalogEntryRow, [string, number]>(
		'SELECT * FROM catalog_entries WHERE network_id = ? ORDER BY hlc_wall DESC LIMIT ?'
	).all(networkID, limit);
}

export function upsertTombstone(db: Database, tombstone: TombstoneInput): void {
	db.run(
		`INSERT INTO catalog_tombstones (network_id, lish_id, removed_by, removed_at,
			hlc_wall, hlc_logical, hlc_node, signed_op)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(network_id, lish_id) DO UPDATE SET
			removed_by = excluded.removed_by,
			removed_at = excluded.removed_at,
			hlc_wall = excluded.hlc_wall,
			hlc_logical = excluded.hlc_logical,
			hlc_node = excluded.hlc_node,
			signed_op = excluded.signed_op
		WHERE excluded.hlc_wall > catalog_tombstones.hlc_wall
			OR (excluded.hlc_wall = catalog_tombstones.hlc_wall
				AND excluded.hlc_logical > catalog_tombstones.hlc_logical)
			OR (excluded.hlc_wall = catalog_tombstones.hlc_wall
				AND excluded.hlc_logical = catalog_tombstones.hlc_logical
				AND excluded.hlc_node > catalog_tombstones.hlc_node)`,
		[
			tombstone.network_id, tombstone.lish_id, tombstone.removed_by, tombstone.removed_at,
			tombstone.hlc_wall, tombstone.hlc_logical, tombstone.hlc_node, tombstone.signed_op,
		]
	);
}

export function isTombstoned(db: Database, networkID: string, lishID: string): boolean {
	const row = db.query<{ id: number }, [string, string]>(
		'SELECT id FROM catalog_tombstones WHERE network_id = ? AND lish_id = ?'
	).get(networkID, lishID);
	return row !== null;
}

export function deleteTombstonesOlderThan(db: Database, networkID: string, days: number): number {
	const result = db.run(
		"DELETE FROM catalog_tombstones WHERE network_id = ? AND removed_at < datetime('now', ?)",
		[networkID, `-${days} days`]
	);
	return result.changes;
}

export function ensureCatalogACL(db: Database, networkID: string, ownerPeerID: string): void {
	db.run(
		`INSERT OR IGNORE INTO catalog_acl (network_id, owner, admins, moderators, restrict_writes)
		VALUES (?, ?, '[]', '[]', 1)`,
		[networkID, ownerPeerID]
	);
}

export function getCatalogACL(db: Database, networkID: string): CatalogACLRow | null {
	const row = db.query<{ network_id: string; owner: string; admins: string; moderators: string; restrict_writes: number }, [string]>(
		'SELECT * FROM catalog_acl WHERE network_id = ?'
	).get(networkID);
	if (!row) return null;
	return {
		network_id: row.network_id,
		owner: row.owner,
		admins: JSON.parse(row.admins) as string[],
		moderators: JSON.parse(row.moderators) as string[],
		restrict_writes: row.restrict_writes,
	};
}

export function updateCatalogACL(db: Database, networkID: string, changes: Partial<{ admins: string[]; moderators: string[]; restrict_writes: number }>): void {
	if (changes.admins !== undefined) {
		db.run('UPDATE catalog_acl SET admins = ? WHERE network_id = ?', [JSON.stringify(changes.admins), networkID]);
	}
	if (changes.moderators !== undefined) {
		db.run('UPDATE catalog_acl SET moderators = ? WHERE network_id = ?', [JSON.stringify(changes.moderators), networkID]);
	}
	if (changes.restrict_writes !== undefined) {
		db.run('UPDATE catalog_acl SET restrict_writes = ? WHERE network_id = ?', [changes.restrict_writes, networkID]);
	}
}

export function getVectorClock(db: Database, networkID: string, peerID: string): VectorClockRow | null {
	return db.query<VectorClockRow, [string, string]>(
		'SELECT * FROM catalog_clocks WHERE network_id = ? AND peer_id = ?'
	).get(networkID, peerID);
}

export function updateVectorClock(db: Database, networkID: string, peerID: string, hlcWall: number, hlcLogical: number): void {
	db.run(
		`INSERT INTO catalog_clocks (network_id, peer_id, hlc_wall, hlc_logical)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(network_id, peer_id) DO UPDATE SET
			hlc_wall = excluded.hlc_wall,
			hlc_logical = excluded.hlc_logical`,
		[networkID, peerID, hlcWall, hlcLogical]
	);
}

export function searchCatalog(db: Database, networkID: string, query: string, limit: number = 100): CatalogEntryRow[] {
	const q = query.trim();
	if (!q) return listCatalogEntries(db, networkID, limit);

	// Tag-only search: #linux → exact tag match via LIKE
	if (q.startsWith('#')) {
		const tag = q.slice(1).toLowerCase();
		return db.query<CatalogEntryRow, [string, string, number]>(
			`SELECT * FROM catalog_entries WHERE network_id = ? AND tags LIKE ? ORDER BY hlc_wall DESC LIMIT ?`
		).all(networkID, `%"${tag}"%`, limit);
	}

	// FTS5 fulltext search
	return db.query<CatalogEntryRow, [string, string, number]>(
		`SELECT e.* FROM catalog_entries e
		JOIN catalog_fts f ON e.id = f.rowid
		WHERE e.network_id = ? AND catalog_fts MATCH ?
		ORDER BY rank LIMIT ?`
	).all(networkID, q, limit);
}

export function getDeltaEntries(db: Database, networkID: string, sinceHlcWall: number): CatalogEntryRow[] {
	return db.query<CatalogEntryRow, [string, number]>(
		'SELECT * FROM catalog_entries WHERE network_id = ? AND hlc_wall > ? ORDER BY hlc_wall ASC'
	).all(networkID, sinceHlcWall);
}
