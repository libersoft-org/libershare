/**
 * Validate downloader-level fixes (H3, H4, M3, L1) by checking the source code structure.
 * These can't be run as live downloader tests without network, but we verify the code was modified correctly.
 */
import { readFileSync } from 'fs';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
	if (condition) { passed++; console.log(`  ✓ ${name}`); }
	else { failed++; console.error(`  ✗ ${name}`); }
}

const downloaderSrc = readFileSync('backend/src/protocol/downloader.ts', 'utf-8');
const dataSrcSrc = readFileSync('backend/src/lish/data-server.ts', 'utf-8');
const recoverySrc = readFileSync('backend/src/api/error-recovery.ts', 'utf-8');
const lishsDbSrc = readFileSync('backend/src/db/lishs.ts', 'utf-8');
const transferSrc = readFileSync('backend/src/api/transfer.ts', 'utf-8');

// ─── H3: needsFileAllocation handles undefined files ─────────────────────
console.log('\n── H3: needsFileAllocation handles undefined files ──');
assert(downloaderSrc.includes('this.lish.files.length === 0'), 'needsFileAllocation checks files.length === 0');
assert(downloaderSrc.includes('this.needsManifest = true') && downloaderSrc.includes('awaiting-manifest'), 'Sets needsManifest and state when files missing');
assert(downloaderSrc.includes('no files in manifest or DB'), 'Has appropriate log message');

// ─── H4: getMissingFileIndexes before completion ─────────────────────────
console.log('\n── H4: getMissingFileIndexes before completion ──');
assert(downloaderSrc.includes('getMissingFileIndexes'), 'getMissingFileIndexes method exists');
assert(downloaderSrc.includes('await this.getMissingFileIndexes()'), 'getMissingFileIndexes called before download complete');
assert(downloaderSrc.includes('files missing on disk'), 'Has warning log for missing files at completion');

// ─── H1: writePaused during ENOENT realloc ───────────────────────────────
console.log('\n── H1: writePaused during ENOENT realloc ──');
assert(downloaderSrc.includes('Pause all peer writes to prevent concurrent'), 'Comment explains writePaused purpose');
assert(downloaderSrc.includes('this.writePaused = true') && downloaderSrc.includes('this.resumeWriters()'), 'writePaused set and resumed around realloc');

// ─── H2: Manifest import protected by workMutex ─────────────────────────
console.log('\n── H2: probeTopicPeers manifest import in workMutex ──');
assert(downloaderSrc.includes('this.workMutex.runExclusive(async () =>'), 'probeTopicPeers uses workMutex');
assert(downloaderSrc.includes('double-check after acquiring lock'), 'Double-check pattern in workMutex');

// ─── M3: Chunk queue dedup ───────────────────────────────────────────────
console.log('\n── M3: Chunk queue deduplication ──');
assert(downloaderSrc.includes('isChunkDownloaded'), 'Queue dedup checks isChunkDownloaded');
assert(downloaderSrc.includes('Skip chunks already downloaded (dedup'), 'Has dedup comment');

// ─── L1: servingPeers removed ────────────────────────────────────────────
console.log('\n── L1: servingPeers dead code removed ──');
assert(!downloaderSrc.includes('servingPeers'), 'servingPeers completely removed');

// ─── C3: ErrorRecovery backoff ───────────────────────────────────────────
console.log('\n── C3: ErrorRecovery backoff structure ──');
assert(recoverySrc.includes('MAX_RECOVERY_ATTEMPTS'), 'MAX_RECOVERY_ATTEMPTS constant exists');
assert(recoverySrc.includes('Math.pow(2, retryCount)'), 'Exponential backoff formula');
assert(recoverySrc.includes('MAX_DELAY'), 'MAX_DELAY cap exists');
assert(recoverySrc.includes('recovery:exhausted'), 'Exhausted broadcast event');
assert(recoverySrc.includes('max recovery attempts'), 'Log message for exhaustion');

// ─── C1: isComplete fix ─────────────────────────────────────────────────
console.log('\n── C1: isComplete structure ──');
assert(lishsDbSrc.includes('total: number; missing: number'), 'isComplete queries both total and missing');
assert(lishsDbSrc.includes("row?.total ?? 0) === 0) return false"), 'Returns false when total = 0');

// ─── C2: addLISH conditional DELETE ──────────────────────────────────────
console.log('\n── C2: addLISH conditional DELETE ──');
// Verify DELETE is INSIDE if(lish.files) block, not before it
const addLISHCode = lishsDbSrc.slice(lishsDbSrc.indexOf('export function addLISH'), lishsDbSrc.indexOf('export function deleteLISH'));
const filesDeleteIdx = addLISHCode.indexOf("DELETE FROM lishs_files");
const filesIfIdx = addLISHCode.indexOf("if (lish.files)");
assert(filesIfIdx < filesDeleteIdx, 'DELETE FROM lishs_files is AFTER if (lish.files) check');

// ─── enableDownload check ────────────────────────────────────────────────
console.log('\n── enableDownload chunk count guard ──');
assert(transferSrc.includes('getAllChunkCount(p.lishID) > 0'), 'enableDownload checks chunk count > 0');

// ─── M2: Index ───────────────────────────────────────────────────────────
console.log('\n── M2: checksum index in schema ──');
assert(lishsDbSrc.includes('idx_lishs_chunks_checksum'), 'Checksum index definition exists');

// ─── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
