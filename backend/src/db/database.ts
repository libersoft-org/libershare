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
 * Remove every row from all persistent tables. `ON DELETE CASCADE` clears the
 * lishs_* children and lishnets_peers, so deleting the two parent tables is
 * enough. On-disk LISH data files are NOT touched — this only wipes DB records.
 * Used by the factory reset.
 */
export function clearAllData(database: Database): void {
	database.transaction(() => {
		database.run('DELETE FROM lishs');
		database.run('DELETE FROM lishnets');
	})();
}
