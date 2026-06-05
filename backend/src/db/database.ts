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
 */
export function clearLishData(database: Database): void {
	database.run('DELETE FROM lishs');
}

/**
 * Remove every lishnet row (and its cascade children: lishnets_peers). Used by
 * the factory reset "networks" category.
 */
export function clearLishnetData(database: Database): void {
	database.run('DELETE FROM lishnets');
}
