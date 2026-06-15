import { type Database } from 'bun:sqlite';
import { type LISHid } from '@shared';
import { getInternalID } from './lishs-schema.ts';

export interface VerificationProgress {
	verifiedChunks: number;
	totalChunks: number;
}

export interface FileVerificationProgress {
	filePath: string;
	verifiedChunks: number;
	totalChunks: number;
}

export function getVerificationProgress(db: Database, lishID: LISHid): VerificationProgress {
	const internalID = getInternalID(db, lishID);
	if (internalID === null) return { verifiedChunks: 0, totalChunks: 0 };
	const row = db
		.query<{ total: number; verified: number }, [number]>(
			`SELECT COUNT(*) as total, SUM(CASE WHEN c.have THEN 1 ELSE 0 END) as verified
		 FROM lishs_chunks c
		 JOIN lishs_files f ON f.id = c.id_lishs_files
		 WHERE f.id_lishs = ?`
		)
		.get(internalID);
	return { verifiedChunks: row?.verified ?? 0, totalChunks: row?.total ?? 0 };
}

export function getFileVerificationProgress(db: Database, lishID: LISHid): FileVerificationProgress[] {
	const internalID = getInternalID(db, lishID);
	if (internalID === null) return [];
	return db
		.query<{ path: string; total: number; verified: number }, [number]>(
			`SELECT f.path, COUNT(*) as total, SUM(CASE WHEN c.have THEN 1 ELSE 0 END) as verified
		 FROM lishs_chunks c
		 JOIN lishs_files f ON f.id = c.id_lishs_files
		 WHERE f.id_lishs = ?
		 GROUP BY f.id
		 ORDER BY f.id`
		)
		.all(internalID)
		.map(r => ({ filePath: r.path, verifiedChunks: r.verified, totalChunks: r.total }));
}

export function markChunkVerified(db: Database, chunkRowID: number): void {
	db.run('UPDATE lishs_chunks SET have = TRUE WHERE id = ?', [chunkRowID]);
}

export function markChunkFailed(db: Database, chunkRowID: number): void {
	db.run('UPDATE lishs_chunks SET have = FALSE WHERE id = ?', [chunkRowID]);
}

/** Batch-mark all chunks of a single file as failed (e.g. whole file missing on disk). */
export function markAllFileChunksFailed(db: Database, fileInternalID: number): void {
	db.run('UPDATE lishs_chunks SET have = FALSE WHERE id_lishs_files = ?', [fileInternalID]);
}

export function resetVerification(db: Database, lishID: LISHid): void {
	const internalID = getInternalID(db, lishID);
	if (internalID === null) return;
	db.run(
		`UPDATE lishs_chunks SET have = FALSE
		 WHERE id_lishs_files IN (SELECT id FROM lishs_files WHERE id_lishs = ?)`,
		[internalID]
	);
}

/** Reset have=FALSE for all chunks of a specific file (by internal file ID). Returns count of reset chunks. */
export function resetFileChunks(db: Database, fileInternalID: number): number {
	const result = db.run('UPDATE lishs_chunks SET have = FALSE WHERE id_lishs_files = ?', [fileInternalID]);
	return result.changes;
}

/** Get internal DB file ID by LISH ID and file index (positional order). */
export function getFileInternalID(db: Database, lishID: LISHid, fileIndex: number): number | null {
	const internalID = getInternalID(db, lishID);
	if (internalID === null) return null;
	const files = db.query<{ id: number }, [number]>('SELECT id FROM lishs_files WHERE id_lishs = ? ORDER BY id').all(internalID);
	return files[fileIndex]?.id ?? null;
}

export function isVerified(db: Database, lishID: LISHid): boolean {
	const internalID = getInternalID(db, lishID);
	if (internalID === null) return false;
	const row = db
		.query<{ total: number; unverified: number }, [number]>(
			`SELECT COUNT(*) as total, SUM(CASE WHEN c.have = FALSE THEN 1 ELSE 0 END) as unverified FROM lishs_chunks c
		 JOIN lishs_files f ON f.id = c.id_lishs_files
		 WHERE f.id_lishs = ?`
		)
		.get(internalID);
	if ((row?.total ?? 0) === 0) return false;
	return (row?.unverified ?? 1) === 0;
}

/**
 * Get files with their internal IDs, chunk checksums and chunk row IDs, for verification.
 * Chunk row IDs are used to perform O(1) mark updates without re-scanning chunks per update.
 */
export function getFilesForVerification(db: Database, lishID: LISHid): Array<{ fileInternalID: number; path: string; checksums: string[]; chunkRowIDs: number[] }> | null {
	const internalID = getInternalID(db, lishID);
	if (internalID === null) return null;
	const files = db.query<{ id: number; path: string }, [number]>('SELECT id, path FROM lishs_files WHERE id_lishs = ? ORDER BY id').all(internalID);
	return files.map(f => {
		const rows = db.query<{ id: number; checksum: string }, [number]>('SELECT id, checksum FROM lishs_chunks WHERE id_lishs_files = ? ORDER BY id').all(f.id);
		return { fileInternalID: f.id, path: f.path, checksums: rows.map(r => r.checksum), chunkRowIDs: rows.map(r => r.id) };
	});
}
