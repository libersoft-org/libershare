import { Database } from 'bun:sqlite';
import type { LISHid, ChunkID, IStoredLISH } from '@shared';
import { initLISHsTables, addLISH } from '../../../src/db/lishs.ts';

export const TEST_LISH_ID: LISHid = 'test-lish-abc123';
export const TEST_LISH_ID_2: LISHid = 'test-lish-def456';

/**
 * Three chunk IDs spread across two files:
 *   file[0] "docs/readme.txt"  → chunk[0], chunk[1]
 *   file[1] "data/archive.bin" → chunk[2]
 */
export const TEST_CHUNK_IDS: [ChunkID, ChunkID, ChunkID] = [
	'sha256:aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222cc',
	'sha256:bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222cccc3333dd',
	'sha256:cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222cccc3333dddd4444ee',
];

/** Create a minimal IStoredLISH with two files and three chunks. */
export function createTestLISH(overrides?: Partial<IStoredLISH>): IStoredLISH {
	const [c0, c1, c2] = TEST_CHUNK_IDS;
	return {
		id: TEST_LISH_ID,
		name: 'Test LISH',
		description: 'A test dataset',
		created: '2024-01-01T00:00:00Z',
		chunkSize: 1048576,
		checksumAlgo: 'sha256',
		files: [
			{
				path: 'docs/readme.txt',
				size: 2097152,
				checksums: [c0, c1],
			},
			{
				path: 'data/archive.bin',
				size: 1048576,
				checksums: [c2],
			},
		],
		...overrides,
	};
}

/** Open an in-memory SQLite database with the LISH schema initialised. */
export function createTestDB(): Database {
	const db = new Database(':memory:');
	db.run('PRAGMA foreign_keys = ON');
	initLISHsTables(db);
	return db;
}

/** Insert a LISH into db. Defaults to createTestLISH() with no chunks downloaded. */
export function populateTestDB(db: Database, lish?: IStoredLISH): void {
	addLISH(db, lish ?? createTestLISH());
}
