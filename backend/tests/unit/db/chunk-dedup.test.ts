import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { addLISH, getAllChunkSlots, getMissingChunks, markChunkDownloaded } from '../../../src/db/lishs.ts';
import { createTestDB, createTestLISH } from '../helpers/fixtures.ts';
import type { LISHid, ChunkID } from '@shared';

const DUP = 'sha256:dddd000000000000000000000000000000000000000000000000000000000001' as ChunkID;
const UNIQ = 'sha256:eeee000000000000000000000000000000000000000000000000000000000002' as ChunkID;
const LISH_A = 'sha256:0009aabbccdd000000000000000000000000000000000000000000000000' as LISHid;
const LISH_B = 'sha256:000aaabbccdd000000000000000000000000000000000000000000000000' as LISHid;

describe('getAllChunkSlots — cross/intra-file checksum dedup (download corruption fix)', () => {
	let db: Database;
	beforeEach(() => {
		db = createTestDB();
	});

	it('returns every slot for a file with repeated identical chunks (Jiří "Chunks" shape)', () => {
		addLISH(db, createTestLISH({ id: LISH_A, files: [{ path: 'chunks.txt', size: 5 * 1048576, checksums: [DUP, DUP, DUP, DUP, DUP] }] }));
		const slots = getAllChunkSlots(db, LISH_A);
		expect(slots).toHaveLength(5);
		expect(slots.map(s => s.fileIndex)).toEqual([0, 0, 0, 0, 0]);
		expect(slots.map(s => s.chunkIndex)).toEqual([0, 1, 2, 3, 4]);
		expect(slots.every(s => s.checksum === DUP)).toBe(true);
	});

	it('marking a duplicated checksum once flips have=TRUE for ALL its slots (the behavior that requires write-to-all-offsets)', () => {
		addLISH(db, createTestLISH({ id: LISH_A, files: [{ path: 'chunks.txt', size: 5 * 1048576, checksums: [DUP, DUP, DUP, DUP, DUP] }] }));
		expect(getMissingChunks(db, LISH_A)).toHaveLength(5);
		markChunkDownloaded(db, LISH_A, DUP); // one download
		// All 5 slots are now "have" — so the downloader MUST have written all 5 offsets, else they are zero-filled.
		expect(getMissingChunks(db, LISH_A)).toHaveLength(0);
		// getAllChunkSlots still enumerates all 5 targets to write to.
		expect(getAllChunkSlots(db, LISH_A)).toHaveLength(5);
	});

	it('enumerates a checksum shared across multiple files with correct indexes', () => {
		addLISH(
			db,
			createTestLISH({
				id: LISH_B,
				files: [
					{ path: 'a.bin', size: 2 * 1048576, checksums: [UNIQ, DUP] },
					{ path: 'b.bin', size: 1048576, checksums: [DUP] },
				],
			})
		);
		const slots = getAllChunkSlots(db, LISH_B);
		expect(slots).toHaveLength(3);
		const dupSlots = slots.filter(s => s.checksum === DUP);
		expect(dupSlots).toEqual([
			{ fileIndex: 0, chunkIndex: 1, checksum: DUP },
			{ fileIndex: 1, chunkIndex: 0, checksum: DUP },
		]);
		// Downloading DUP once flips both shared slots; only the unique chunk stays missing.
		markChunkDownloaded(db, LISH_B, DUP);
		const missing = getMissingChunks(db, LISH_B);
		expect(missing).toHaveLength(1);
		expect(missing[0]?.chunkID).toBe(UNIQ);
	});

	it('returns empty for unknown LISH', () => {
		expect(getAllChunkSlots(db, 'ghost-lish' as LISHid)).toEqual([]);
	});
});
