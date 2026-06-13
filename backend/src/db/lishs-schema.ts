import { type Database } from 'bun:sqlite';

/**
 * Creates the LISH-related tables (lishs, lishs_files, lishs_chunks,
 * lishs_directories, lishs_links), applies idempotent column migrations to
 * pre-existing databases, and ensures the supporting indexes exist.
 */
export function initLISHsTables(db: Database): void {
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

	// Migration: add columns to existing databases
	try {
		db.run('ALTER TABLE lishs ADD COLUMN upload_enabled BOOL NOT NULL DEFAULT FALSE');
	} catch {
		/* already exists */
	}
	try {
		db.run('ALTER TABLE lishs ADD COLUMN download_enabled BOOL NOT NULL DEFAULT FALSE');
	} catch {
		/* already exists */
	}
	try {
		db.run('ALTER TABLE lishs ADD COLUMN total_uploaded_bytes INTEGER NOT NULL DEFAULT 0');
	} catch {
		/* already exists */
	}
	try {
		db.run('ALTER TABLE lishs ADD COLUMN total_downloaded_bytes INTEGER NOT NULL DEFAULT 0');
	} catch {
		/* already exists */
	}
	try {
		db.run('ALTER TABLE lishs ADD COLUMN error_code TEXT DEFAULT NULL');
	} catch {
		/* already exists */
	}
	try {
		db.run('ALTER TABLE lishs ADD COLUMN error_detail TEXT DEFAULT NULL');
	} catch {
		/* already exists */
	}
	try {
		db.run('ALTER TABLE lishs ADD COLUMN final_directory TEXT DEFAULT NULL');
	} catch {
		/* already exists */
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
