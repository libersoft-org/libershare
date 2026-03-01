import { Database } from 'bun:sqlite';
import { join } from 'path';
import { initLISHsTables } from './lishs.ts';
const DB_FILENAME = 'libershare.db';
let db: Database;

export function openDatabase(dataDir: string): Database {
	const dbPath = join(dataDir, DB_FILENAME);
	db = new Database(dbPath);
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA foreign_keys = ON');
	console.log(`[DB] ${dbPath}`);
	initLISHsTables(db);
	return db;
}

export function getDatabase(): Database {
	return db;
}
