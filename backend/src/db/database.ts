import { Database } from 'bun:sqlite';
import { join } from 'path';
import { initLISHsTables } from './lishs.ts';
import { initLISHnetsTables } from './lishnets.ts';
const DB_FILENAME = 'libershare.db';
let db: Database;

export function openDatabase(dataDir: string): Database {
	const dbPath = join(dataDir, DB_FILENAME);
	db = new Database(dbPath);
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA foreign_keys = ON');
	console.log(`[DB] ${dbPath}`);
	initLISHsTables(db);
	initLISHnetsTables(db);
	return db;
}

export function getDatabase(): Database {
	return db;
}

/**
 * Remove every LISH row (and its `ON DELETE CASCADE` children: files, chunks,
 * directories, links). On-disk LISH data files are NOT touched. Used by the
 * factory reset "downloads" category.
 *
 * Runs in a transaction so the row delete and the AUTOINCREMENT counter reset
 * are atomic: `DELETE FROM` alone leaves `sqlite_sequence` untouched, so without
 * the second statement a post-reset DB would keep counting ids up from the old
 * max instead of starting fresh at 1 like a clean install.
 */
export function clearLishData(database: Database): void {
	const tx = database.transaction(() => {
		database.run('DELETE FROM lishs');
		database.run("DELETE FROM sqlite_sequence WHERE name IN ('lishs', 'lishs_files', 'lishs_chunks', 'lishs_directories', 'lishs_links')");
	});
	tx();
}

/**
 * Remove every lishnet row (and its cascade children: lishnets_peers). Used by
 * the factory reset "networks" category. Resets the AUTOINCREMENT counters in
 * the same transaction (see {@link clearLishData} for the rationale).
 */
export function clearLishnetData(database: Database): void {
	const tx = database.transaction(() => {
		database.run('DELETE FROM lishnets');
		database.run("DELETE FROM sqlite_sequence WHERE name IN ('lishnets', 'lishnets_peers')");
	});
	tx();
}
