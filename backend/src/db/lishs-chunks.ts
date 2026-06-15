import { type Database } from 'bun:sqlite';
import { type LISHid, type ChunkID } from '@shared';
import { getInternalID } from './lishs.ts';

export interface MissingChunk {
	fileIndex: number;
	chunkIndex: number;
	chunkID: ChunkID;
}

export function isChunkDownloaded(db: Database, lishID: LISHid, chunkID: ChunkID): boolean {
	const internalID = getInternalID(db, lishID);
	if (internalID === null) return false;
	const row = db
		.query<{ have: number }, [number, string]>(
			`SELECT c.have FROM lishs_chunks c
		 JOIN lishs_files f ON f.id = c.id_lishs_files
		 WHERE f.id_lishs = ? AND c.checksum = ?`
		)
		.get(internalID, chunkID);
	return row?.have === 1;
}

export function markChunkDownloaded(db: Database, lishID: LISHid, chunkID: ChunkID): void {
	const internalID = getInternalID(db, lishID);
	if (internalID === null) return;
	db.run(
		`UPDATE lishs_chunks SET have = TRUE
		 WHERE checksum = ? AND id_lishs_files IN (SELECT id FROM lishs_files WHERE id_lishs = ?)`,
		[chunkID, internalID]
	);
}

export function isComplete(db: Database, lishID: LISHid): boolean {
	const internalID = getInternalID(db, lishID);
	if (internalID === null) return false;
	const row = db
		.query<{ total: number; missing: number }, [number]>(
			`SELECT COUNT(*) as total, SUM(CASE WHEN c.have = FALSE THEN 1 ELSE 0 END) as missing FROM lishs_chunks c
		 JOIN lishs_files f ON f.id = c.id_lishs_files
		 WHERE f.id_lishs = ?`
		)
		.get(internalID);
	// 0 total chunks = not complete (prevents vacuous truth for LISHs with no files in DB)
	if ((row?.total ?? 0) === 0) return false;
	return (row?.missing ?? 1) === 0;
}

export function getHaveChunks(db: Database, lishID: LISHid): Set<ChunkID> | 'all' {
	const internalID = getInternalID(db, lishID);
	if (internalID === null) return new Set();

	const total = db
		.query<{ c: number }, [number]>(
			`SELECT COUNT(*) as c FROM lishs_chunks c
		 JOIN lishs_files f ON f.id = c.id_lishs_files
		 WHERE f.id_lishs = ?`
		)
		.get(internalID);

	const haveCount = db
		.query<{ c: number }, [number]>(
			`SELECT COUNT(*) as c FROM lishs_chunks c
		 JOIN lishs_files f ON f.id = c.id_lishs_files
		 WHERE f.id_lishs = ? AND c.have = TRUE`
		)
		.get(internalID);

	if ((total?.c ?? 0) > 0 && total?.c === haveCount?.c) return 'all';

	const rows = db
		.query<{ checksum: string }, [number]>(
			`SELECT c.checksum FROM lishs_chunks c
		 JOIN lishs_files f ON f.id = c.id_lishs_files
		 WHERE f.id_lishs = ? AND c.have = TRUE`
		)
		.all(internalID);
	return new Set(rows.map(r => r.checksum as ChunkID));
}

export function getMissingChunks(db: Database, lishID: LISHid): MissingChunk[] {
	const internalID = getInternalID(db, lishID);
	if (internalID === null) return [];

	// Get files in insertion order (by id) with their checksums
	const files = db.query<{ id: number; path: string }, [number]>('SELECT id, path FROM lishs_files WHERE id_lishs = ? ORDER BY id').all(internalID);

	const missing: MissingChunk[] = [];
	for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
		const file = files[fileIndex]!;
		const chunks = db.query<{ checksum: string; have: number }, [number]>('SELECT checksum, have FROM lishs_chunks WHERE id_lishs_files = ? ORDER BY id').all(file.id);
		for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
			const chunk = chunks[chunkIndex]!;
			if (!chunk.have) missing.push({ fileIndex, chunkIndex, chunkID: chunk.checksum as ChunkID });
		}
	}
	return missing;
}

/**
 * Every chunk slot (fileIndex, chunkIndex, checksum) for a LISH, in manifest order.
 * Mirrors getMissingChunks ordering so the indexes line up with DataServer.writeChunk.
 * Used so a downloaded chunk can be written to EVERY offset that shares its checksum —
 * markChunkDownloaded flips `have` for all matching slots, so any slot not also written
 * would be left zero-filled from allocation (silent corruption).
 */
export function getAllChunkSlots(db: Database, lishID: LISHid): Array<{ fileIndex: number; chunkIndex: number; checksum: ChunkID }> {
	const internalID = getInternalID(db, lishID);
	if (internalID === null) return [];
	const files = db.query<{ id: number }, [number]>('SELECT id FROM lishs_files WHERE id_lishs = ? ORDER BY id').all(internalID);
	const slots: Array<{ fileIndex: number; chunkIndex: number; checksum: ChunkID }> = [];
	for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
		const chunks = db.query<{ checksum: string }, [number]>('SELECT checksum FROM lishs_chunks WHERE id_lishs_files = ? ORDER BY id').all(files[fileIndex]!.id);
		for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) slots.push({ fileIndex, chunkIndex, checksum: chunks[chunkIndex]!.checksum as ChunkID });
	}
	return slots;
}

/**
 * Find which file a chunk belongs to and return its index info.
 * Used for reading/writing chunk data from/to disk.
 */
export function findChunkLocation(db: Database, lishID: LISHid, chunkID: ChunkID): { filePath: string; chunkIndex: number } | null {
	const internalID = getInternalID(db, lishID);
	if (internalID === null) return null;

	const files = db.query<{ id: number; path: string }, [number]>('SELECT id, path FROM lishs_files WHERE id_lishs = ? ORDER BY id').all(internalID);

	for (const file of files) {
		const chunks = db.query<{ checksum: string; have: number }, [number]>('SELECT checksum, have FROM lishs_chunks WHERE id_lishs_files = ? ORDER BY id').all(file.id);
		const chunkIndex = chunks.findIndex(c => c.checksum === chunkID);
		if (chunkIndex !== -1 && chunks[chunkIndex]!.have) return { filePath: file.path, chunkIndex };
	}
	return null;
}
