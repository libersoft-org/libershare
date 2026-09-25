import { describe, expect, it, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLISHsTables } from '../../../src/db/lishs-schema.ts';

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A database from before `final_directory` existed, with one row in it. */
async function olderDatabase(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'lish-schema-'));
	dirs.push(dir);
	const path = join(dir, 'old.db');
	const db = new Database(path);
	initLISHsTables(db);
	db.run('ALTER TABLE lishs DROP COLUMN final_directory');
	db.run("INSERT INTO lishs (lish_id, name, chunk_size, checksum_algo, upload_enabled) VALUES ('L1', 'kept', 1024, 'sha256', 1)");
	db.close();
	return path;
}

function columns(db: Database): string[] {
	return db.query<{ name: string }, []>('PRAGMA table_info(lishs)').all().map(c => c.name);
}

describe('initLISHsTables migrates from the actual schema', () => {
	it('adds only the missing column and keeps existing rows and values', async () => {
		const db = new Database(await olderDatabase());
		try {
			initLISHsTables(db);
			expect(columns(db)).toContain('final_directory');
			const row = db.query<{ name: string; upload_enabled: number; final_directory: string | null }, []>('SELECT name, upload_enabled, final_directory FROM lishs').get();
			expect(row).toEqual({ name: 'kept', upload_enabled: 1, final_directory: null });
			// Idempotent on an up-to-date schema.
			initLISHsTables(db);
		} finally {
			db.close();
		}
	});

	it('a database it cannot write fails the start instead of passing as "column exists"', async () => {
		const db = new Database(await olderDatabase(), { readonly: true });
		try {
			expect(() => initLISHsTables(db)).toThrow();
			expect(columns(db)).not.toContain('final_directory');
		} finally {
			db.close();
		}
	});
});
