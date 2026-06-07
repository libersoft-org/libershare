import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initLISHsTables } from '../../../src/db/lishs.ts';
import { initLISHnetsTables } from '../../../src/db/lishnets.ts';
import { clearLishData, clearLishnetData } from '../../../src/db/database.ts';

function freshDB(): Database {
	const db = new Database(':memory:');
	db.run('PRAGMA foreign_keys = ON');
	initLISHsTables(db);
	initLISHnetsTables(db);
	return db;
}

function insertLish(db: Database, lishID: string): number {
	return Number(db.run('INSERT INTO lishs (lish_id, chunk_size, checksum_algo) VALUES (?, ?, ?)', [lishID, 1024, 'sha256']).lastInsertRowid);
}

function insertNet(db: Database, networkID: string): number {
	return Number(db.run('INSERT INTO lishnets (lishnet_id, name) VALUES (?, ?)', [networkID, 'N']).lastInsertRowid);
}

function rowCount(db: Database, table: string): number {
	return (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

// The factory reset "downloads" / "networks" categories empty their tables. Because
// the tables use INTEGER PRIMARY KEY AUTOINCREMENT, a plain DELETE leaves the running
// counter in sqlite_sequence untouched — so the clear functions also wipe the sequence
// to give a clean-install-like reset. These tests pin that behaviour.
describe('clearLishData', () => {
	it('empties the lishs table', () => {
		const db = freshDB();
		insertLish(db, 'a');
		insertLish(db, 'b');
		clearLishData(db);
		expect(rowCount(db, 'lishs')).toBe(0);
	});

	it('resets the AUTOINCREMENT counter so new ids start at 1', () => {
		const db = freshDB();
		insertLish(db, 'a');
		insertLish(db, 'b');
		expect(insertLish(db, 'c')).toBe(3); // counter advanced to 3
		clearLishData(db);
		expect(insertLish(db, 'd')).toBe(1); // reset — would be 4 without the sqlite_sequence wipe
	});
});

describe('clearLishnetData', () => {
	it('empties the lishnets table', () => {
		const db = freshDB();
		insertNet(db, 'n1');
		clearLishnetData(db);
		expect(rowCount(db, 'lishnets')).toBe(0);
	});

	it('resets the AUTOINCREMENT counter so new ids start at 1', () => {
		const db = freshDB();
		insertNet(db, 'n1');
		expect(insertNet(db, 'n2')).toBe(2);
		clearLishnetData(db);
		expect(insertNet(db, 'n3')).toBe(1);
	});
});
