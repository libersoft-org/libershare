import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LISHid } from '@shared';
import {
	addLISH,
	deleteLISH,
	lishExists,
	getLISH,
	getLISHMeta,
	getLISHDetail,
	listLISHSummaries,
	listAllStoredLISHs,
	isChunkDownloaded,
	markChunkDownloaded,
	isComplete,
	getHaveChunks,
	getMissingChunks,
	findChunkLocation,
	getVerificationProgress,
	getFileVerificationProgress,
	setUploadEnabled,
	setDownloadEnabled,
	getUploadEnabledLishs,
	getDownloadEnabledLishs,
	getFilesForVerification,
	markChunkVerified,
	markChunkFailed,
	resetVerification,
	isVerified,
} from '../../../src/db/lishs.ts';
import {
	TEST_LISH_ID,
	TEST_LISH_ID_2,
	TEST_CHUNK_IDS,
	createTestLISH,
	createTestDB,
	populateTestDB,
} from '../helpers/fixtures.ts';

// ---------------------------------------------------------------------------
// Test setup — fresh in-memory DB for every test
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(() => {
	db = createTestDB();
});

// ---------------------------------------------------------------------------
// addLISH / lishExists / getLISH / deleteLISH
// ---------------------------------------------------------------------------

describe('addLISH / lishExists', () => {
	it('reports false for an unknown LISH', () => {
		expect(lishExists(db, TEST_LISH_ID)).toBe(false);
	});

	it('reports true after inserting a LISH', () => {
		populateTestDB(db);
		expect(lishExists(db, TEST_LISH_ID)).toBe(true);
	});

	it('is idempotent (INSERT OR REPLACE does not throw)', () => {
		populateTestDB(db);
		populateTestDB(db); // second insert of same ID
		expect(lishExists(db, TEST_LISH_ID)).toBe(true);
	});

	it('round-trips name and description', () => {
		populateTestDB(db);
		const stored = getLISH(db, TEST_LISH_ID);
		expect(stored?.name).toBe('Test LISH');
		expect(stored?.description).toBe('A test dataset');
	});

	it('round-trips files and checksums', () => {
		populateTestDB(db);
		const stored = getLISH(db, TEST_LISH_ID);
		expect(stored?.files).toHaveLength(2);
		expect(stored?.files?.[0]?.checksums).toEqual([TEST_CHUNK_IDS[0], TEST_CHUNK_IDS[1]]);
		expect(stored?.files?.[1]?.checksums).toEqual([TEST_CHUNK_IDS[2]]);
	});

	it('returns null for getLISH when LISH is not found', () => {
		expect(getLISH(db, 'nonexistent-id' as LISHid)).toBeNull();
	});
});

describe('deleteLISH', () => {
	it('returns false when LISH does not exist', () => {
		expect(deleteLISH(db, TEST_LISH_ID)).toBe(false);
	});

	it('returns true and removes the LISH', () => {
		populateTestDB(db);
		expect(deleteLISH(db, TEST_LISH_ID)).toBe(true);
		expect(lishExists(db, TEST_LISH_ID)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// getLISHMeta
// ---------------------------------------------------------------------------

describe('getLISHMeta', () => {
	it('returns null for unknown LISH', () => {
		expect(getLISHMeta(db, TEST_LISH_ID)).toBeNull();
	});

	it('returns correct metadata fields', () => {
		populateTestDB(db);
		const meta = getLISHMeta(db, TEST_LISH_ID);
		expect(meta).not.toBeNull();
		expect(meta?.lishID).toBe(TEST_LISH_ID);
		expect(meta?.chunkSize).toBe(1048576);
		expect(meta?.checksumAlgo).toBe('sha256');
		expect(meta?.directory).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// findChunkLocation
// ---------------------------------------------------------------------------

describe('findChunkLocation', () => {
	it('returns null for an unknown LISH', () => {
		expect(findChunkLocation(db, 'ghost-lish' as LISHid, TEST_CHUNK_IDS[0])).toBeNull();
	});

	it('returns null when chunk exists but have=FALSE', () => {
		populateTestDB(db);
		// nothing downloaded yet — have is FALSE for all chunks
		expect(findChunkLocation(db, TEST_LISH_ID, TEST_CHUNK_IDS[0])).toBeNull();
	});

	it('returns null for a completely unknown chunk ID', () => {
		populateTestDB(db);
		expect(findChunkLocation(db, TEST_LISH_ID, 'sha256:deadbeef' as LISHid)).toBeNull();
	});

	it('returns filePath and chunkIndex=0 after marking first chunk downloaded', () => {
		populateTestDB(db);
		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[0]);
		const loc = findChunkLocation(db, TEST_LISH_ID, TEST_CHUNK_IDS[0]);
		expect(loc).not.toBeNull();
		expect(loc?.filePath).toBe('docs/readme.txt');
		expect(loc?.chunkIndex).toBe(0);
	});

	it('returns chunkIndex=1 for second chunk in first file', () => {
		populateTestDB(db);
		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[1]);
		const loc = findChunkLocation(db, TEST_LISH_ID, TEST_CHUNK_IDS[1]);
		expect(loc?.filePath).toBe('docs/readme.txt');
		expect(loc?.chunkIndex).toBe(1);
	});

	it('returns correct file for chunk in second file', () => {
		populateTestDB(db);
		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[2]);
		const loc = findChunkLocation(db, TEST_LISH_ID, TEST_CHUNK_IDS[2]);
		expect(loc?.filePath).toBe('data/archive.bin');
		expect(loc?.chunkIndex).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// getMissingChunks
// ---------------------------------------------------------------------------

describe('getMissingChunks', () => {
	it('returns empty array for unknown LISH', () => {
		expect(getMissingChunks(db, 'ghost-lish' as LISHid)).toEqual([]);
	});

	it('all three chunks are missing initially', () => {
		populateTestDB(db);
		const missing = getMissingChunks(db, TEST_LISH_ID);
		expect(missing).toHaveLength(3);
	});

	it('missing list includes correct fileIndex and chunkIndex values', () => {
		populateTestDB(db);
		const missing = getMissingChunks(db, TEST_LISH_ID);
		// file[0] chunk[0]
		expect(missing[0]?.fileIndex).toBe(0);
		expect(missing[0]?.chunkIndex).toBe(0);
		expect(missing[0]?.chunkID).toBe(TEST_CHUNK_IDS[0]);
		// file[0] chunk[1]
		expect(missing[1]?.fileIndex).toBe(0);
		expect(missing[1]?.chunkIndex).toBe(1);
		expect(missing[1]?.chunkID).toBe(TEST_CHUNK_IDS[1]);
		// file[1] chunk[0]
		expect(missing[2]?.fileIndex).toBe(1);
		expect(missing[2]?.chunkIndex).toBe(0);
		expect(missing[2]?.chunkID).toBe(TEST_CHUNK_IDS[2]);
	});

	it('missing count decreases after one chunk is downloaded', () => {
		populateTestDB(db);
		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[0]);
		expect(getMissingChunks(db, TEST_LISH_ID)).toHaveLength(2);
	});

	it('returns empty array when all chunks are downloaded', () => {
		populateTestDB(db);
		for (const cid of TEST_CHUNK_IDS) markChunkDownloaded(db, TEST_LISH_ID, cid);
		expect(getMissingChunks(db, TEST_LISH_ID)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// markChunkDownloaded
// ---------------------------------------------------------------------------

describe('markChunkDownloaded', () => {
	it('no-ops gracefully for an unknown LISH', () => {
		expect(() => markChunkDownloaded(db, 'ghost-lish' as LISHid, TEST_CHUNK_IDS[0])).not.toThrow();
	});

	it('sets have=TRUE so isChunkDownloaded returns true', () => {
		populateTestDB(db);
		expect(isChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[0])).toBe(false);
		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[0]);
		expect(isChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[0])).toBe(true);
	});

	it('does not affect other chunks in the same LISH', () => {
		populateTestDB(db);
		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[0]);
		expect(isChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[1])).toBe(false);
		expect(isChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[2])).toBe(false);
	});

	it('reduces missing chunk count by one', () => {
		populateTestDB(db);
		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[1]);
		const missing = getMissingChunks(db, TEST_LISH_ID);
		const ids = missing.map(m => m.chunkID);
		expect(ids).not.toContain(TEST_CHUNK_IDS[1]);
		expect(missing).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// markChunkFailed (via getFilesForVerification internal IDs)
// ---------------------------------------------------------------------------

describe('markChunkFailed', () => {
	it('resets have=FALSE so chunk reappears in getMissingChunks', () => {
		populateTestDB(db);
		// Download then fail chunk[0]
		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[0]);
		expect(getMissingChunks(db, TEST_LISH_ID)).toHaveLength(2);

		const files = getFilesForVerification(db, TEST_LISH_ID);
		expect(files).not.toBeNull();
		const file0 = files![0]!;
		markChunkFailed(db, TEST_LISH_ID, file0.fileInternalID, 0);

		expect(isChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[0])).toBe(false);
		expect(getMissingChunks(db, TEST_LISH_ID)).toHaveLength(3);
	});

	it('no-ops silently for out-of-range chunkIndex', () => {
		populateTestDB(db);
		const files = getFilesForVerification(db, TEST_LISH_ID);
		const file0 = files![0]!;
		expect(() => markChunkFailed(db, TEST_LISH_ID, file0.fileInternalID, 999)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// isComplete
// ---------------------------------------------------------------------------

describe('isComplete', () => {
	it('returns false for unknown LISH', () => {
		expect(isComplete(db, 'ghost-lish' as LISHid)).toBe(false);
	});

	it('returns false when no chunks are downloaded', () => {
		populateTestDB(db);
		expect(isComplete(db, TEST_LISH_ID)).toBe(false);
	});

	it('returns false when only some chunks are downloaded', () => {
		populateTestDB(db);
		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[0]);
		expect(isComplete(db, TEST_LISH_ID)).toBe(false);
	});

	it('returns true when all chunks are downloaded', () => {
		populateTestDB(db);
		for (const cid of TEST_CHUNK_IDS) markChunkDownloaded(db, TEST_LISH_ID, cid);
		expect(isComplete(db, TEST_LISH_ID)).toBe(true);
	});

	it('returns true for a LISH with no files', () => {
		addLISH(db, createTestLISH({ id: TEST_LISH_ID_2, files: [] }));
		expect(isComplete(db, TEST_LISH_ID_2)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// getHaveChunks
// ---------------------------------------------------------------------------

describe('getHaveChunks', () => {
	it('returns empty Set for unknown LISH', () => {
		const result = getHaveChunks(db, 'ghost-lish' as LISHid);
		expect(result).toBeInstanceOf(Set);
		expect((result as Set<string>).size).toBe(0);
	});

	it('returns empty Set when nothing downloaded', () => {
		populateTestDB(db);
		const result = getHaveChunks(db, TEST_LISH_ID);
		expect(result).toBeInstanceOf(Set);
		expect((result as Set<string>).size).toBe(0);
	});

	it('returns Set with downloaded chunk IDs', () => {
		populateTestDB(db);
		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[0]);
		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[2]);
		const result = getHaveChunks(db, TEST_LISH_ID);
		expect(result).toBeInstanceOf(Set);
		const s = result as Set<string>;
		expect(s.has(TEST_CHUNK_IDS[0])).toBe(true);
		expect(s.has(TEST_CHUNK_IDS[1])).toBe(false);
		expect(s.has(TEST_CHUNK_IDS[2])).toBe(true);
	});

	it('returns "all" when every chunk is downloaded', () => {
		populateTestDB(db);
		for (const cid of TEST_CHUNK_IDS) markChunkDownloaded(db, TEST_LISH_ID, cid);
		expect(getHaveChunks(db, TEST_LISH_ID)).toBe('all');
	});
});

// ---------------------------------------------------------------------------
// resetVerification
// ---------------------------------------------------------------------------

describe('resetVerification', () => {
	it('no-ops gracefully for unknown LISH', () => {
		expect(() => resetVerification(db, 'ghost-lish' as LISHid)).not.toThrow();
	});

	it('resets all chunks to have=FALSE', () => {
		populateTestDB(db);
		for (const cid of TEST_CHUNK_IDS) markChunkDownloaded(db, TEST_LISH_ID, cid);
		expect(isComplete(db, TEST_LISH_ID)).toBe(true);

		resetVerification(db, TEST_LISH_ID);

		expect(isComplete(db, TEST_LISH_ID)).toBe(false);
		expect(getMissingChunks(db, TEST_LISH_ID)).toHaveLength(3);
	});

	it('does not affect a different LISH', () => {
		populateTestDB(db);
		addLISH(db, createTestLISH({ id: TEST_LISH_ID_2 }));
		for (const cid of TEST_CHUNK_IDS) markChunkDownloaded(db, TEST_LISH_ID_2, cid);

		resetVerification(db, TEST_LISH_ID);

		expect(isComplete(db, TEST_LISH_ID_2)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// getVerificationProgress
// ---------------------------------------------------------------------------

describe('getVerificationProgress', () => {
	it('returns zeros for unknown LISH', () => {
		const vp = getVerificationProgress(db, 'ghost-lish' as LISHid);
		expect(vp.verifiedChunks).toBe(0);
		expect(vp.totalChunks).toBe(0);
	});

	it('reports 0 verified and 3 total initially', () => {
		populateTestDB(db);
		const vp = getVerificationProgress(db, TEST_LISH_ID);
		expect(vp.verifiedChunks).toBe(0);
		expect(vp.totalChunks).toBe(3);
	});

	it('increments verifiedChunks as chunks are downloaded', () => {
		populateTestDB(db);
		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[0]);
		expect(getVerificationProgress(db, TEST_LISH_ID).verifiedChunks).toBe(1);

		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[1]);
		expect(getVerificationProgress(db, TEST_LISH_ID).verifiedChunks).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// getFileVerificationProgress
// ---------------------------------------------------------------------------

describe('getFileVerificationProgress', () => {
	it('returns empty array for unknown LISH', () => {
		expect(getFileVerificationProgress(db, 'ghost-lish' as LISHid)).toEqual([]);
	});

	it('returns one entry per file with correct totals', () => {
		populateTestDB(db);
		const fvp = getFileVerificationProgress(db, TEST_LISH_ID);
		expect(fvp).toHaveLength(2);
		expect(fvp[0]?.filePath).toBe('docs/readme.txt');
		expect(fvp[0]?.totalChunks).toBe(2);
		expect(fvp[0]?.verifiedChunks).toBe(0);
		expect(fvp[1]?.filePath).toBe('data/archive.bin');
		expect(fvp[1]?.totalChunks).toBe(1);
	});

	it('increments verifiedChunks for the correct file only', () => {
		populateTestDB(db);
		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[2]); // belongs to file[1]
		const fvp = getFileVerificationProgress(db, TEST_LISH_ID);
		expect(fvp[0]?.verifiedChunks).toBe(0);
		expect(fvp[1]?.verifiedChunks).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// markChunkVerified (sets have=TRUE by file internal ID + index)
// ---------------------------------------------------------------------------

describe('markChunkVerified', () => {
	it('sets have=TRUE and removes chunk from missing list', () => {
		populateTestDB(db);
		const files = getFilesForVerification(db, TEST_LISH_ID);
		expect(files).not.toBeNull();
		const file0 = files![0]!;
		markChunkVerified(db, TEST_LISH_ID, file0.fileInternalID, 0);
		expect(isChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[0])).toBe(true);
		expect(getMissingChunks(db, TEST_LISH_ID)).toHaveLength(2);
	});

	it('no-ops silently for out-of-range chunkIndex', () => {
		populateTestDB(db);
		const files = getFilesForVerification(db, TEST_LISH_ID);
		const file0 = files![0]!;
		expect(() => markChunkVerified(db, TEST_LISH_ID, file0.fileInternalID, 999)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// isVerified
// ---------------------------------------------------------------------------

describe('isVerified', () => {
	it('returns false for unknown LISH', () => {
		expect(isVerified(db, 'ghost-lish' as LISHid)).toBe(false);
	});

	it('returns false initially', () => {
		populateTestDB(db);
		expect(isVerified(db, TEST_LISH_ID)).toBe(false);
	});

	it('returns true when all chunks are marked have=TRUE', () => {
		populateTestDB(db);
		const files = getFilesForVerification(db, TEST_LISH_ID)!;
		for (const f of files) {
			for (let i = 0; i < f.checksums.length; i++) {
				markChunkVerified(db, TEST_LISH_ID, f.fileInternalID, i);
			}
		}
		expect(isVerified(db, TEST_LISH_ID)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// getFilesForVerification
// ---------------------------------------------------------------------------

describe('getFilesForVerification', () => {
	it('returns null for unknown LISH', () => {
		expect(getFilesForVerification(db, 'ghost-lish' as LISHid)).toBeNull();
	});

	it('returns array with one entry per file', () => {
		populateTestDB(db);
		const files = getFilesForVerification(db, TEST_LISH_ID);
		expect(files).toHaveLength(2);
	});

	it('each entry includes fileInternalID, path, and checksums', () => {
		populateTestDB(db);
		const files = getFilesForVerification(db, TEST_LISH_ID)!;
		expect(files[0]?.path).toBe('docs/readme.txt');
		expect(files[0]?.checksums).toEqual([TEST_CHUNK_IDS[0], TEST_CHUNK_IDS[1]]);
		expect(files[0]?.fileInternalID).toBeGreaterThan(0);
		expect(files[1]?.path).toBe('data/archive.bin');
		expect(files[1]?.checksums).toEqual([TEST_CHUNK_IDS[2]]);
	});
});

// ---------------------------------------------------------------------------
// listLISHSummaries
// ---------------------------------------------------------------------------

describe('listLISHSummaries', () => {
	it('returns empty array with no LISHs', () => {
		expect(listLISHSummaries(db)).toEqual([]);
	});

	it('returns one summary after insert', () => {
		populateTestDB(db);
		const summaries = listLISHSummaries(db);
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.id).toBe(TEST_LISH_ID);
		expect(summaries[0]?.fileCount).toBe(2);
		expect(summaries[0]?.totalChunks).toBe(3);
		expect(summaries[0]?.verifiedChunks).toBe(0);
	});

	it('reflects downloaded chunk in verifiedChunks', () => {
		populateTestDB(db);
		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[0]);
		const summary = listLISHSummaries(db)[0]!;
		expect(summary.verifiedChunks).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// getLISHDetail
// ---------------------------------------------------------------------------

describe('getLISHDetail', () => {
	it('returns null for unknown LISH', () => {
		expect(getLISHDetail(db, 'ghost-lish' as LISHid)).toBeNull();
	});

	it('returns correct file and chunk counts', () => {
		populateTestDB(db);
		const detail = getLISHDetail(db, TEST_LISH_ID);
		expect(detail?.fileCount).toBe(2);
		expect(detail?.totalChunks).toBe(3);
		expect(detail?.verifiedChunks).toBe(0);
	});

	it('includes per-file verified chunk counts', () => {
		populateTestDB(db);
		markChunkDownloaded(db, TEST_LISH_ID, TEST_CHUNK_IDS[2]);
		const detail = getLISHDetail(db, TEST_LISH_ID)!;
		const file1 = detail.files.find(f => f.path === 'data/archive.bin');
		expect(file1?.verifiedChunks).toBe(1);
		expect(file1?.totalChunks).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// listAllStoredLISHs
// ---------------------------------------------------------------------------

describe('listAllStoredLISHs', () => {
	it('returns empty array with no data', () => {
		expect(listAllStoredLISHs(db)).toEqual([]);
	});

	it('returns both LISHs after two inserts', () => {
		populateTestDB(db);
		addLISH(db, createTestLISH({ id: TEST_LISH_ID_2, name: 'Second LISH' }));
		const all = listAllStoredLISHs(db);
		expect(all).toHaveLength(2);
		const ids = all.map(l => l.id);
		expect(ids).toContain(TEST_LISH_ID);
		expect(ids).toContain(TEST_LISH_ID_2);
	});
});

// ---------------------------------------------------------------------------
// addLISH upsert — preserves upload_enabled / download_enabled (M1 fix)
// ---------------------------------------------------------------------------

describe('addLISH – upsert preserves enabled flags', () => {
	let db: Database;

	beforeEach(() => {
		db = createTestDB();
		populateTestDB(db);
	});

	it('re-adding same LISH preserves upload_enabled=TRUE', () => {
		setUploadEnabled(db, TEST_LISH_ID, true);
		expect(getUploadEnabledLishs(db).has(TEST_LISH_ID)).toBe(true);

		// Re-add (simulates manifest update from peer)
		const lish = getLISH(db, TEST_LISH_ID)!;
		addLISH(db, lish);

		expect(getUploadEnabledLishs(db).has(TEST_LISH_ID)).toBe(true);
	});

	it('re-adding same LISH preserves download_enabled=TRUE', () => {
		setDownloadEnabled(db, TEST_LISH_ID, true);
		expect(getDownloadEnabledLishs(db).has(TEST_LISH_ID)).toBe(true);

		const lish = getLISH(db, TEST_LISH_ID)!;
		addLISH(db, lish);

		expect(getDownloadEnabledLishs(db).has(TEST_LISH_ID)).toBe(true);
	});

	it('re-adding same LISH preserves both flags simultaneously', () => {
		setUploadEnabled(db, TEST_LISH_ID, true);
		setDownloadEnabled(db, TEST_LISH_ID, true);

		const lish = getLISH(db, TEST_LISH_ID)!;
		addLISH(db, lish);

		expect(getUploadEnabledLishs(db).has(TEST_LISH_ID)).toBe(true);
		expect(getDownloadEnabledLishs(db).has(TEST_LISH_ID)).toBe(true);
	});

	it('re-adding LISH with updated name preserves enabled flags', () => {
		setUploadEnabled(db, TEST_LISH_ID, true);

		const lish = getLISH(db, TEST_LISH_ID)!;
		lish.name = 'Updated Name';
		addLISH(db, lish);

		expect(getUploadEnabledLishs(db).has(TEST_LISH_ID)).toBe(true);
		const updated = getLISH(db, TEST_LISH_ID)!;
		expect(updated.name).toBe('Updated Name');
	});

	it('new LISH gets default enabled=FALSE', () => {
		const newLish = createTestLISH('new-lish-id-999' as any);
		addLISH(db, newLish);

		expect(getUploadEnabledLishs(db).has('new-lish-id-999')).toBe(false);
		expect(getDownloadEnabledLishs(db).has('new-lish-id-999')).toBe(false);
	});

	it('disabled flags stay FALSE after re-add', () => {
		// Default is FALSE, don't change it
		const lish = getLISH(db, TEST_LISH_ID)!;
		addLISH(db, lish);

		expect(getUploadEnabledLishs(db).has(TEST_LISH_ID)).toBe(false);
		expect(getDownloadEnabledLishs(db).has(TEST_LISH_ID)).toBe(false);
	});

	it('LISH ID persists after upsert (no autoincrement change)', () => {
		const before = getLISH(db, TEST_LISH_ID);
		expect(before).not.toBeNull();

		const lish = before!;
		addLISH(db, lish);

		const after = getLISH(db, TEST_LISH_ID);
		expect(after).not.toBeNull();
		expect(after!.id).toBe(before!.id);
	});
});
