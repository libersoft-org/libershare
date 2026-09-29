import { type Database } from 'bun:sqlite';
import { type LISHid } from '@shared';

/** Columns added after the first release, in the order they were introduced. Fixed SQL. */
const LISHS_ADDED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
	['upload_enabled', 'BOOL NOT NULL DEFAULT FALSE'],
	['download_enabled', 'BOOL NOT NULL DEFAULT FALSE'],
	['total_uploaded_bytes', 'INTEGER NOT NULL DEFAULT 0'],
	['total_downloaded_bytes', 'INTEGER NOT NULL DEFAULT 0'],
	['error_code', 'TEXT DEFAULT NULL'],
	['error_detail', 'TEXT DEFAULT NULL'],
	['final_directory', 'TEXT DEFAULT NULL'],
];

/**
 * Creates the LISH-related tables (lishs, lishs_files, lishs_chunks,
 * lishs_directories, lishs_links), applies idempotent column migrations to
 * pre-existing databases, and ensures the supporting indexes exist. Every error propagates.
 */
export function initLISHsTables(db: Database): void {
	// One transaction: a failure leaves the schema exactly as it was, never half migrated.
	db.transaction(() => createLISHsSchema(db)).immediate();
}

function createLISHsSchema(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS lishs (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			lish_id         TEXT NOT NULL UNIQUE,
			name            TEXT,
			description     TEXT,
			created         TIMESTAMP,
			added           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
			chunk_size      INTEGER NOT NULL,
			checksum_algo   TEXT NOT NULL,
			directory       TEXT,
			upload_enabled  BOOL NOT NULL DEFAULT FALSE,
			download_enabled BOOL NOT NULL DEFAULT FALSE
		)
	`);

	// Migration: add the columns an older database lacks. Decided from the actual schema, not
	// by trying every ALTER and swallowing the error: a locked, read-only or corrupt database
	// fails the same way as "column already exists", and treating that as success started the
	// node on a schema it never checked.
	const present = new Set(
		db
			.query<{ name: string }, []>('PRAGMA table_info(lishs)')
			.all()
			.map(c => c.name)
	);
	for (const [column, definition] of LISHS_ADDED_COLUMNS) {
		if (present.has(column)) continue;
		try {
			db.run(`ALTER TABLE lishs ADD COLUMN ${column} ${definition}`);
		} catch (error) {
			throw new Error(`Cannot add column lishs.${column}: ${(error as Error).message}`, { cause: error });
		}
	}

	db.run(`
		CREATE TABLE IF NOT EXISTS lishs_files (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			id_lishs        INTEGER NOT NULL REFERENCES lishs(id) ON DELETE CASCADE,
			path            TEXT NOT NULL,
			size            INTEGER NOT NULL,
			permissions     TEXT,
			modified        TIMESTAMP,
			created         TIMESTAMP
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS lishs_chunks (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			id_lishs_files  INTEGER NOT NULL REFERENCES lishs_files(id) ON DELETE CASCADE,
			checksum        TEXT NOT NULL,
			have            BOOL NOT NULL DEFAULT FALSE
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS lishs_directories (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			id_lishs        INTEGER NOT NULL REFERENCES lishs(id) ON DELETE CASCADE,
			path            TEXT NOT NULL,
			permissions     TEXT,
			modified        TIMESTAMP,
			created         TIMESTAMP
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS lishs_links (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			id_lishs        INTEGER NOT NULL REFERENCES lishs(id) ON DELETE CASCADE,
			path            TEXT NOT NULL,
			target          TEXT NOT NULL,
			hardlink        BOOL NOT NULL DEFAULT FALSE,
			modified        TIMESTAMP,
			created         TIMESTAMP
		)
	`);

	db.run('CREATE INDEX IF NOT EXISTS idx_lishs_files_id_lishs ON lishs_files(id_lishs)');
	db.run('CREATE INDEX IF NOT EXISTS idx_lishs_chunks_id_lishs_files ON lishs_chunks(id_lishs_files)');
	db.run('CREATE INDEX IF NOT EXISTS idx_lishs_chunks_checksum ON lishs_chunks(checksum)');
	db.run('CREATE INDEX IF NOT EXISTS idx_lishs_directories_id_lishs ON lishs_directories(id_lishs)');
	db.run('CREATE INDEX IF NOT EXISTS idx_lishs_links_id_lishs ON lishs_links(id_lishs)');
}

/**
 * Resolves the internal autoincrement row id for a LISH by its public LISHid.
 * Lives with the schema (which owns the `lishs` table + its primary key) so the
 * chunk/verification modules can import it without a back-edge to the `lishs.ts`
 * barrel. Returns null when no LISH with the given id exists.
 */
export function getInternalID(db: Database, lishID: LISHid): number | null {
	const row = db.query<{ id: number }, [string]>('SELECT id FROM lishs WHERE lish_id = ?').get(lishID);
	return row?.id ?? null;
}
