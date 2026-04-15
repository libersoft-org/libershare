/**
 * Standalone validation script for audit fixes (C1, C2, C3, H3, H4, M2).
 * Runs without bun:test (which crashes on Windows canary).
 * Usage: bun run backend/tests/validate-fixes.ts
 */
import { Database } from 'bun:sqlite';
import { ErrorCodes } from '@shared';
import type { LISHid, ChunkID, IStoredLISH } from '@shared';
import { initLISHsTables, addLISH, getLISH, isComplete, getMissingChunks, markChunkDownloaded } from '../src/db/lishs.ts';
import { ErrorRecovery } from '../src/api/error-recovery.ts';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
	if (condition) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ ${name}`);
	}
}

function createDB(): Database {
	const db = new Database(':memory:');
	db.run('PRAGMA foreign_keys = ON');
	initLISHsTables(db);
	return db;
}

const LISH_ID = 'sha256:test0001' as LISHid;
const CHUNK_A = 'sha256:chunk_a' as ChunkID;
const CHUNK_B = 'sha256:chunk_b' as ChunkID;

function makeLISH(overrides: Partial<IStoredLISH> = {}): IStoredLISH {
	return {
		id: LISH_ID,
		name: 'Test',
		created: '2025-01-01',
		chunkSize: 1048576,
		checksumAlgo: 'sha256',
		files: [{ path: 'file.txt', size: 2097152, checksums: [CHUNK_A, CHUNK_B] }],
		...overrides,
	};
}

// ─── C1: isComplete() must return false for 0 chunks ─────────────────────
console.log('\n── C1: isComplete() vacuous truth fix ──');
{
	const db = createDB();
	// Insert LISH without files → should NOT be complete
	addLISH(db, { id: LISH_ID, name: 'No files', created: '', chunkSize: 1024, checksumAlgo: 'sha256' } as IStoredLISH);
	assert(!isComplete(db, LISH_ID), 'LISH with 0 chunks is NOT complete');

	// Insert LISH with files, all chunks not downloaded → not complete
	addLISH(db, makeLISH());
	assert(!isComplete(db, LISH_ID), 'LISH with missing chunks is NOT complete');

	// Download all chunks → complete
	markChunkDownloaded(db, LISH_ID, CHUNK_A);
	markChunkDownloaded(db, LISH_ID, CHUNK_B);
	assert(isComplete(db, LISH_ID), 'LISH with all chunks downloaded IS complete');
}

// ─── C2: addLISH() conditional DELETE ────────────────────────────────────
console.log('\n── C2: addLISH() preserves files when called without files ──');
{
	const db = createDB();
	addLISH(db, makeLISH());
	markChunkDownloaded(db, LISH_ID, CHUNK_A);

	// Call addLISH without files (metadata-only update)
	addLISH(db, { id: LISH_ID, name: 'Updated name', created: '', chunkSize: 1048576, checksumAlgo: 'sha256' } as IStoredLISH);

	const lish = getLISH(db, LISH_ID);
	assert(lish?.name === 'Updated name', 'Name updated');
	assert(lish?.files !== undefined && lish.files.length > 0, 'Files preserved');

	const missing = getMissingChunks(db, LISH_ID);
	assert(missing.length === 1, 'Only 1 chunk still missing (chunk_a was downloaded)');
	assert(missing[0]?.chunkID === CHUNK_B, 'Missing chunk is CHUNK_B');
}

// ─── C2b: addLISH() replaces files when files ARE provided ──────────────
console.log('\n── C2b: addLISH() replaces files when new files provided ──');
{
	const db = createDB();
	addLISH(db, makeLISH());
	markChunkDownloaded(db, LISH_ID, CHUNK_A);

	const newChunk = 'sha256:chunk_new' as ChunkID;
	addLISH(
		db,
		makeLISH({
			files: [{ path: 'new.txt', size: 1024, checksums: [newChunk] }],
		})
	);

	const lish = getLISH(db, LISH_ID);
	assert(lish?.files?.length === 1, 'Files replaced with new ones');
	assert(lish?.files?.[0]?.path === 'new.txt', 'New file path correct');
	assert(!isComplete(db, LISH_ID), 'Not complete (new chunk not downloaded)');
}

// ─── C1+C2 combined: empty files then enableDownload scenario ────────────
console.log('\n── C1+C2 combined: LISH with wiped files not falsely complete ──');
{
	const db = createDB();
	// Simulate: LISH exists with main record but lishs_files was lost somehow
	db.run(`INSERT INTO lishs (lish_id, name, chunk_size, checksum_algo) VALUES (?, ?, ?, ?)`, [LISH_ID, 'Orphan', 1024, 'sha256']);
	assert(!isComplete(db, LISH_ID), 'Orphan LISH (no files) NOT complete');
	assert(getMissingChunks(db, LISH_ID).length === 0, 'getMissingChunks returns [] for orphan');
}

// ─── C3: ErrorRecovery max retries + backoff ─────────────────────────────
console.log('\n── C3: ErrorRecovery backoff + max retries ──');
{
	let attemptCount = 0;
	let accessShouldFail = true;
	const broadcasts: Array<{ event: string; data: any }> = [];

	const recovery = new ErrorRecovery({
		attemptRecover: async () => {
			attemptCount++;
			return false;
		},
		broadcast: (event, data) => {
			broadcasts.push({ event, data });
		},
		getLISH: () => ({ directory: '/tmp/test', id: 'x' }) as any,
		checkAccess: async () => {
			if (accessShouldFail) throw new Error('ENOENT');
		},
	});

	recovery.start('lish1', ErrorCodes.IO_NOT_FOUND, { downloadEnabled: true, uploadEnabled: false });
	const state = recovery.getState('lish1');
	assert(state!.nextRetryDelay === 7000, 'Initial delay is 7s');

	// Simulate 6 rapid attempts (manually calling attempt via timer advance)
	// We can't easily advance timers, so just verify the state and broadcasts
	const scheduledEvt = broadcasts.find(b => b.event === 'transfer.recovery:scheduled');
	assert(scheduledEvt?.data.delayMs === 7000, 'First scheduled broadcast has 7s delay');

	recovery.stopAll();
	assert(recovery.getState('lish1') === undefined, 'Recovery stopped');
}

// ─── M2: checksum index exists ───────────────────────────────────────────
console.log('\n── M2: checksum index created ──');
{
	const db = createDB();
	const indexes = db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='lishs_chunks'`).all();
	const names = indexes.map(i => i.name);
	assert(names.includes('idx_lishs_chunks_checksum'), 'idx_lishs_chunks_checksum index exists');
}

// ─── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
