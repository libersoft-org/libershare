import { Database } from 'bun:sqlite';
import type { IStoredLISH, LISHid, ChunkID } from '@shared';
import { initLISHsTables, addLISH } from '../../../src/db/lishs.ts';

export const TEST_LISH_ID = 'sha256:0001aabbccdd000000000000000000000000000000000000000000000000' as LISHid;
export const TEST_LISH_ID_2 = 'sha256:0002aabbccdd000000000000000000000000000000000000000000000000' as LISHid;

export const TEST_CHUNK_IDS: [ChunkID, ChunkID, ChunkID] = ['sha256:aaaa000000000000000000000000000000000000000000000000000000000001' as ChunkID, 'sha256:aaaa000000000000000000000000000000000000000000000000000000000002' as ChunkID, 'sha256:aaaa000000000000000000000000000000000000000000000000000000000003' as ChunkID];

/** Default test LISH: 2 files with 3 chunks total. */
function defaultTestLISH(): IStoredLISH {
	return {
		id: TEST_LISH_ID,
		name: 'Test LISH',
		description: 'A test dataset',
		created: '2025-01-01T00:00:00.000Z',
		chunkSize: 1048576,
		checksumAlgo: 'sha256',
		files: [
			{ path: 'docs/readme.txt', size: 2097152, checksums: [TEST_CHUNK_IDS[0], TEST_CHUNK_IDS[1]] },
			{ path: 'data/archive.bin', size: 1048576, checksums: [TEST_CHUNK_IDS[2]] },
		],
	};
}

/**
 * Create a test IStoredLISH by merging defaults with the provided overrides.
 * Accepts either an overrides object (with required id) or a plain LISHid string.
 */
export function createTestLISH(overrides: (Partial<IStoredLISH> & { id: LISHid }) | LISHid): IStoredLISH {
	const base = defaultTestLISH();
	if (typeof overrides === 'string') {
		return { ...base, id: overrides };
	}
	return { ...base, ...overrides };
}

/** Create an in-memory SQLite database with the LISH schema initialized. */
export function createTestDB(): Database {
	const db = new Database(':memory:');
	db.run('PRAGMA foreign_keys = ON');
	initLISHsTables(db);
	return db;
}

/** Insert TEST_LISH_ID with 2 files and 3 chunks into the database. */
export function populateTestDB(db: Database): void {
	addLISH(db, defaultTestLISH());
}
