import { type Database } from 'bun:sqlite';
import { type IStoredLISH, type LISHid } from '@shared';

// Schema/DDL + migrations live in lishs-schema.ts; re-exported via the barrel below.
export * from './lishs-schema.ts';

// Chunk operations live in lishs-chunks.ts; re-exported via this barrel.
export * from './lishs-chunks.ts';

// Verification operations live in lishs-verification.ts; re-exported via this barrel.
export * from './lishs-verification.ts';

// Read queries and row mappers live in lishs-queries.ts; re-exported via this barrel.
export * from './lishs-queries.ts';

/**
 * Resolves the internal autoincrement row id for a LISH by its public LISHid.
 * Shared enabler used by the LISH query/mutation functions to scope child-table
 * lookups. Returns null when no LISH with the given id exists.
 */
export function getInternalID(db: Database, lishID: LISHid): number | null {
	const row = db.query<{ id: number }, [string]>('SELECT id FROM lishs WHERE lish_id = ?').get(lishID);
	return row?.id ?? null;
}

// -- Public API --

export function lishExists(db: Database, lishID: LISHid): boolean {
	const row = db.query<{ c: number }, [string]>('SELECT COUNT(*) as c FROM lishs WHERE lish_id = ?').get(lishID);
	return (row?.c ?? 0) > 0;
}

export function addLISH(db: Database, lish: IStoredLISH): void {
	const tx = db.transaction(() => {
		// Upsert main record — preserves upload_enabled/download_enabled on conflict
		db.run(
			`INSERT INTO lishs (lish_id, name, description, created, chunk_size, checksum_algo, directory, final_directory)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(lish_id) DO UPDATE SET
			   name = excluded.name,
			   description = excluded.description,
			   created = excluded.created,
			   chunk_size = excluded.chunk_size,
			   checksum_algo = excluded.checksum_algo,
			   directory = excluded.directory,
			   final_directory = excluded.final_directory`,
			[lish.id, lish.name ?? null, lish.description ?? null, lish.created ?? null, lish.chunkSize, lish.checksumAlgo, lish.directory ?? null, lish.finalDirectory ?? null]
		);
		const internalID = getInternalID(db, lish.id as LISHid)!;

		// Replace child records only when replacement data is provided (prevents wiping download progress)
		if (lish.files) {
			db.run('DELETE FROM lishs_files WHERE id_lishs = ?', [internalID]);
			const haveChunks = new Set(lish.chunks ?? []);
			for (const file of lish.files) {
				const fileResult = db.run(
					`INSERT INTO lishs_files (id_lishs, path, size, permissions, modified, created)
					 VALUES (?, ?, ?, ?, ?, ?)`,
					[internalID, file.path, file.size, file.permissions ?? null, file.modified ?? null, file.created ?? null]
				);
				const fileID = Number(fileResult.lastInsertRowid);
				for (const checksum of file.checksums) db.run('INSERT INTO lishs_chunks (id_lishs_files, checksum, have) VALUES (?, ?, ?)', [fileID, checksum, haveChunks.has(checksum) ? 1 : 0]);
			}
		}

		if (lish.directories) {
			db.run('DELETE FROM lishs_directories WHERE id_lishs = ?', [internalID]);
			for (const dir of lish.directories) {
				db.run(
					`INSERT INTO lishs_directories (id_lishs, path, permissions, modified, created)
					 VALUES (?, ?, ?, ?, ?)`,
					[internalID, dir.path, dir.permissions ?? null, dir.modified ?? null, dir.created ?? null]
				);
			}
		}

		if (lish.links) {
			db.run('DELETE FROM lishs_links WHERE id_lishs = ?', [internalID]);
			for (const link of lish.links) {
				db.run(
					`INSERT INTO lishs_links (id_lishs, path, target, hardlink, modified, created)
					 VALUES (?, ?, ?, ?, ?, ?)`,
					[internalID, link.path, link.target, link.hardlink ? 1 : 0, link.modified ?? null, link.created ?? null]
				);
			}
		}
	});
	tx();
}

export function deleteLISH(db: Database, lishID: LISHid): boolean {
	const result = db.run('DELETE FROM lishs WHERE lish_id = ?', [lishID]);
	return result.changes > 0;
}

export function updateLISHDirectory(db: Database, lishID: LISHid, directory: string): boolean {
	const result = db.run('UPDATE lishs SET directory = ? WHERE lish_id = ?', [directory, lishID]);
	return result.changes > 0;
}

export function updateLISHFinalDirectory(db: Database, lishID: LISHid, finalDirectory: string | null): boolean {
	const result = db.run('UPDATE lishs SET final_directory = ? WHERE lish_id = ?', [finalDirectory, lishID]);
	return result.changes > 0;
}

// Enabled-flag, transfer-stat, and error-state persistence live in lishs-flags.ts; re-exported via this barrel.
export * from './lishs-flags.ts';
