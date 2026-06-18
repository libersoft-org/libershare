import { type Database } from 'bun:sqlite';
import { type IStoredLISH, type IFileEntry, type IDirectoryEntry, type ILinkEntry, type ILISHSummary, type ILISHDetail, type LISHSortField, type SortOrder, type LISHid, type HashAlgorithm } from '@shared';
import { getVerificationProgress, getFileVerificationProgress } from './lishs-verification.ts';

interface LISHRow {
	id: number;
	lish_id: string;
	name: string | null;
	description: string | null;
	created: string | null;
	chunk_size: number;
	checksum_algo: string;
	directory: string | null;
	final_directory: string | null;
}

interface LISHFileRow {
	path: string;
	size: number;
	permissions: string | null;
	modified: string | null;
	created: string | null;
}

function buildStoredLISH(db: Database, row: LISHRow): IStoredLISH {
	const files = getFilesWithChecksums(db, row.id);
	const directories = getDirectories(db, row.id);
	const links = getLinks(db, row.id);
	const chunks = getHaveChunksList(db, row.id);

	return {
		id: row.lish_id,
		name: row.name ?? undefined,
		description: row.description ?? undefined,
		created: row.created ?? '',
		chunkSize: row.chunk_size,
		checksumAlgo: row.checksum_algo as HashAlgorithm,
		...(row.directory != null ? { directory: row.directory } : {}),
		...(row.final_directory != null ? { finalDirectory: row.final_directory } : {}),
		...(files.length > 0 ? { files } : {}),
		...(directories.length > 0 ? { directories } : {}),
		...(links.length > 0 ? { links } : {}),
		...(chunks.length > 0 ? { chunks } : {}),
	};
}

function getFiles(db: Database, internalID: number): LISHFileRow[] {
	return db.query<LISHFileRow, [number]>('SELECT path, size, permissions, modified, created FROM lishs_files WHERE id_lishs = ? ORDER BY id').all(internalID);
}

function getFilesWithChecksums(db: Database, internalID: number): IFileEntry[] {
	const fileRows = db.query<{ id: number; path: string; size: number; permissions: string | null; modified: string | null; created: string | null }, [number]>('SELECT id, path, size, permissions, modified, created FROM lishs_files WHERE id_lishs = ? ORDER BY id').all(internalID);

	return fileRows.map(f => {
		const checksums = db
			.query<{ checksum: string }, [number]>('SELECT checksum FROM lishs_chunks WHERE id_lishs_files = ? ORDER BY id')
			.all(f.id)
			.map(c => c.checksum);

		return {
			path: f.path,
			size: f.size,
			...(f.permissions != null ? { permissions: f.permissions } : {}),
			...(f.modified != null ? { modified: f.modified } : {}),
			...(f.created != null ? { created: f.created } : {}),
			checksums,
		};
	});
}

function getDirectories(db: Database, internalID: number): IDirectoryEntry[] {
	return db
		.query<{ path: string; permissions: string | null; modified: string | null; created: string | null }, [number]>('SELECT path, permissions, modified, created FROM lishs_directories WHERE id_lishs = ? ORDER BY id')
		.all(internalID)
		.map(d => ({
			path: d.path,
			...(d.permissions != null ? { permissions: d.permissions } : {}),
			...(d.modified != null ? { modified: d.modified } : {}),
			...(d.created != null ? { created: d.created } : {}),
		}));
}

function getLinks(db: Database, internalID: number): ILinkEntry[] {
	return db
		.query<{ path: string; target: string; hardlink: number; modified: string | null; created: string | null }, [number]>('SELECT path, target, hardlink, modified, created FROM lishs_links WHERE id_lishs = ? ORDER BY id')
		.all(internalID)
		.map(l => ({
			path: l.path,
			target: l.target,
			...(l.hardlink === 1 ? { hardlink: true as const } : {}),
			...(l.modified != null ? { modified: l.modified } : {}),
			...(l.created != null ? { created: l.created } : {}),
		}));
}

function getHaveChunksList(db: Database, internalID: number): string[] {
	return db
		.query<{ checksum: string }, [number]>(
			`SELECT c.checksum FROM lishs_chunks c
		 JOIN lishs_files f ON f.id = c.id_lishs_files
		 WHERE f.id_lishs = ? AND c.have = TRUE
		 ORDER BY c.id`
		)
		.all(internalID)
		.map(r => r.checksum);
}

/** Returns the full stored LISH (including files, directories, links, have-chunks) or null. */
export function getLISH(db: Database, lishID: LISHid): IStoredLISH | null {
	const row = db.query<{ id: number; lish_id: string; name: string | null; description: string | null; created: string | null; chunk_size: number; checksum_algo: string; directory: string | null; final_directory: string | null }, [string]>('SELECT id, lish_id, name, description, created, chunk_size, checksum_algo, directory, final_directory FROM lishs WHERE lish_id = ?').get(lishID);
	if (!row) return null;
	return buildStoredLISH(db, row);
}

/**
 * Returns a lightweight metadata-only view of a LISH (no files/directories/links).
 * Used by callers that only need directory, chunkSize, and checksumAlgo (e.g. chunk I/O).
 */
export function getLISHMeta(db: Database, lishID: LISHid): { internalID: number; lishID: string; chunkSize: number; checksumAlgo: HashAlgorithm; directory: string | null } | null {
	const row = db.query<{ id: number; lish_id: string; chunk_size: number; checksum_algo: string; directory: string | null }, [string]>('SELECT id, lish_id, chunk_size, checksum_algo, directory FROM lishs WHERE lish_id = ?').get(lishID);
	if (!row) return null;
	return { internalID: row.id, lishID: row.lish_id, chunkSize: row.chunk_size, checksumAlgo: row.checksum_algo as HashAlgorithm, directory: row.directory };
}

/** Returns summary rows for all stored LISHs, with optional sorting. */
export function listLISHSummaries(db: Database, sortBy?: LISHSortField, sortOrder?: SortOrder): ILISHSummary[] {
	const dir = (sortOrder ?? 'asc') === 'desc' ? 'DESC' : 'ASC';
	let orderClause: string;
	switch (sortBy) {
		case 'name':
			orderClause = `l.name ${dir}`;
			break;
		case 'created':
			orderClause = `l.created ${dir}`;
			break;
		case 'totalSize':
			orderClause = `total_size ${dir}`;
			break;
		case 'fileCount':
			orderClause = `file_count ${dir}`;
			break;
		default:
			orderClause = sortOrder === 'desc' ? 'l.added DESC' : 'l.added ASC';
			break;
	}
	const rows = db
		.query<
			{
				lish_id: string;
				name: string | null;
				description: string | null;
				created: string | null;
				total_size: number;
				file_count: number;
				directory_count: number;
				verified_chunks: number;
				total_chunks: number;
				total_uploaded_bytes: number;
				total_downloaded_bytes: number;
				error_code: string | null;
				error_detail: string | null;
			},
			[]
		>(
			`
		SELECT
			l.lish_id,
			l.name,
			l.description,
			l.created,
			COALESCE(f.total_size, 0)  AS total_size,
			COALESCE(f.file_count, 0)  AS file_count,
			COALESCE(d.dir_count, 0)   AS directory_count,
			COALESCE(v.verified_chunks, 0) AS verified_chunks,
			COALESCE(v.total_chunks, 0)    AS total_chunks,
			l.total_uploaded_bytes,
			l.total_downloaded_bytes,
			l.error_code,
			l.error_detail
		FROM lishs l
		LEFT JOIN (
			SELECT id_lishs, SUM(size) AS total_size, COUNT(*) AS file_count
			FROM lishs_files GROUP BY id_lishs
		) f ON f.id_lishs = l.id
		LEFT JOIN (
			SELECT id_lishs, COUNT(*) AS dir_count
			FROM lishs_directories GROUP BY id_lishs
		) d ON d.id_lishs = l.id
		LEFT JOIN (
			SELECT f2.id_lishs,
				SUM(CASE WHEN c.have THEN 1 ELSE 0 END) AS verified_chunks,
				COUNT(*) AS total_chunks
			FROM lishs_chunks c
			JOIN lishs_files f2 ON f2.id = c.id_lishs_files
			GROUP BY f2.id_lishs
		) v ON v.id_lishs = l.id
		ORDER BY ${orderClause}
	`
		)
		.all();

	return rows.map(r => ({
		id: r.lish_id,
		name: r.name ?? undefined,
		description: r.description ?? undefined,
		created: r.created ?? '',
		totalSize: r.total_size,
		fileCount: r.file_count,
		directoryCount: r.directory_count,
		verifiedChunks: r.verified_chunks,
		totalChunks: r.total_chunks,
		totalUploadedBytes: r.total_uploaded_bytes,
		totalDownloadedBytes: r.total_downloaded_bytes,
		errorCode: r.error_code ?? undefined,
		errorDetail: r.error_detail ?? undefined,
	}));
}

/** Returns detailed view of a LISH including file-level verification progress, or null. */
export function getLISHDetail(db: Database, lishID: LISHid): ILISHDetail | null {
	const row = db.query<{ id: number; lish_id: string; name: string | null; description: string | null; created: string | null; chunk_size: number; checksum_algo: string; directory: string | null; total_uploaded_bytes: number; total_downloaded_bytes: number }, [string]>('SELECT id, lish_id, name, description, created, chunk_size, checksum_algo, directory, total_uploaded_bytes, total_downloaded_bytes FROM lishs WHERE lish_id = ?').get(lishID);
	if (!row) return null;

	const files = getFiles(db, row.id);
	const directories = getDirectories(db, row.id);
	const links = getLinks(db, row.id);
	const vp = getVerificationProgress(db, lishID);
	const fileVP = getFileVerificationProgress(db, lishID);
	const fileVPMap = new Map(fileVP.map(f => [f.filePath, f]));

	return {
		id: row.lish_id,
		name: row.name ?? undefined,
		description: row.description ?? undefined,
		created: row.created ?? '',
		chunkSize: row.chunk_size,
		checksumAlgo: row.checksum_algo as HashAlgorithm,
		totalSize: files.reduce((sum, f) => sum + f.size, 0),
		fileCount: files.length,
		directoryCount: directories.length,
		directory: row.directory ?? undefined,
		files: files.map(f => {
			const fvp = fileVPMap.get(f.path);
			return { path: f.path, size: f.size, permissions: f.permissions ?? undefined, modified: f.modified ?? undefined, created: f.created ?? undefined, verifiedChunks: fvp?.verifiedChunks ?? 0, totalChunks: fvp?.totalChunks ?? 0 };
		}),
		directories,
		links,
		verifiedChunks: vp.verifiedChunks,
		totalChunks: vp.totalChunks,
		totalUploadedBytes: row.total_uploaded_bytes,
		totalDownloadedBytes: row.total_downloaded_bytes,
	};
}

/** Returns all stored LISHs in insertion order (for startup hydration). */
export function listAllStoredLISHs(db: Database): IStoredLISH[] {
	const rows = db.query<{ id: number; lish_id: string; name: string | null; description: string | null; created: string | null; chunk_size: number; checksum_algo: string; directory: string | null; final_directory: string | null }, []>('SELECT id, lish_id, name, description, created, chunk_size, checksum_algo, directory, final_directory FROM lishs ORDER BY added ASC').all();
	return rows.map(r => buildStoredLISH(db, r));
}

/** Returns LISHs that have a non-null directory (i.e. are bound to a local dataset path). */
export function getDatasets(db: Database): IStoredLISH[] {
	const rows = db.query<{ id: number; lish_id: string; name: string | null; description: string | null; created: string | null; chunk_size: number; checksum_algo: string; directory: string | null; final_directory: string | null }, []>('SELECT id, lish_id, name, description, created, chunk_size, checksum_algo, directory, final_directory FROM lishs WHERE directory IS NOT NULL ORDER BY added ASC').all();
	return rows.map(r => buildStoredLISH(db, r));
}
