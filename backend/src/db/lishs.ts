import { type Database } from 'bun:sqlite';
import { type IStoredLISH, type IFileEntry, type IDirectoryEntry, type ILinkEntry, type ILISHSummary, type ILISHDetail, type LISHSortField, type SortOrder, type LISHid, type ChunkID, type HashAlgorithm } from '@shared';

export interface MissingChunk {
	fileIndex: number;
	chunkIndex: number;
	chunkID: ChunkID;
}

export function initLISHsTables(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS lishs (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			lish_id         TEXT NOT NULL UNIQUE,
			name            TEXT,
			description     TEXT,
			created         TIMESTAMP,
			added           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
			chunk_size      INTEGER NOT NULL,
			checksum_algo   TEXT NOT NULL,
			directory       TEXT
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS lishs_files (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			id_lishs        INTEGER NOT NULL REFERENCES lishs(id) ON DELETE CASCADE,
			path            TEXT NOT NULL,
			size            INTEGER NOT NULL,
			permissions     TEXT,
			modified        TIMESTAMP,
			created         TIMESTAMP
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS lishs_chunks (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			id_lishs_files  INTEGER NOT NULL REFERENCES lishs_files(id) ON DELETE CASCADE,
			checksum        TEXT NOT NULL,
			have            BOOL NOT NULL DEFAULT FALSE
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS lishs_directories (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			id_lishs        INTEGER NOT NULL REFERENCES lishs(id) ON DELETE CASCADE,
			path            TEXT NOT NULL,
			permissions     TEXT,
			modified        TIMESTAMP,
			created         TIMESTAMP
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS lishs_links (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			id_lishs        INTEGER NOT NULL REFERENCES lishs(id) ON DELETE CASCADE,
			path            TEXT NOT NULL,
			target          TEXT NOT NULL,
			hardlink        BOOL NOT NULL DEFAULT FALSE,
			modified        TIMESTAMP,
			created         TIMESTAMP
		)
	`);

	db.run('CREATE INDEX IF NOT EXISTS idx_lishs_files_id_lishs ON lishs_files(id_lishs)');
	db.run('CREATE INDEX IF NOT EXISTS idx_lishs_chunks_id_lishs_files ON lishs_chunks(id_lishs_files)');
	db.run('CREATE INDEX IF NOT EXISTS idx_lishs_directories_id_lishs ON lishs_directories(id_lishs)');
	db.run('CREATE INDEX IF NOT EXISTS idx_lishs_links_id_lishs ON lishs_links(id_lishs)');
}

function getInternalID(db: Database, lishID: LISHid): number | null {
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
		// Insert main record
		const result = db.run(
			`INSERT OR REPLACE INTO lishs (lish_id, name, description, created, chunk_size, checksum_algo, directory)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[lish.id, lish.name ?? null, lish.description ?? null, lish.created ?? null, lish.chunkSize, lish.checksumAlgo, lish.directory ?? null]
		);
		const internalID = Number(result.lastInsertRowid);

		// Delete existing child records (for upsert)
		db.run('DELETE FROM lishs_files WHERE id_lishs = ?', [internalID]);
		db.run('DELETE FROM lishs_directories WHERE id_lishs = ?', [internalID]);
		db.run('DELETE FROM lishs_links WHERE id_lishs = ?', [internalID]);

		// Insert files + chunks
		if (lish.files) {
			const haveChunks = new Set(lish.chunks ?? []);
			for (const file of lish.files) {
				const fileResult = db.run(
					`INSERT INTO lishs_files (id_lishs, path, size, permissions, modified, created)
					 VALUES (?, ?, ?, ?, ?, ?)`,
					[internalID, file.path, file.size, file.permissions ?? null, file.modified ?? null, file.created ?? null]
				);
				const fileId = Number(fileResult.lastInsertRowid);
				for (const checksum of file.checksums) {
					db.run('INSERT INTO lishs_chunks (id_lishs_files, checksum, have) VALUES (?, ?, ?)', [fileId, checksum, haveChunks.has(checksum) ? 1 : 0]);
				}
			}
		}

		// Insert directories
		if (lish.directories) {
			for (const dir of lish.directories) {
				db.run(
					`INSERT INTO lishs_directories (id_lishs, path, permissions, modified, created)
					 VALUES (?, ?, ?, ?, ?)`,
					[internalID, dir.path, dir.permissions ?? null, dir.modified ?? null, dir.created ?? null]
				);
			}
		}

		// Insert links
		if (lish.links) {
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

export function getLISH(db: Database, lishID: LISHid): IStoredLISH | null {
	const row = db.query<{ id: number; lish_id: string; name: string | null; description: string | null; created: string | null; chunk_size: number; checksum_algo: string; directory: string | null }, [string]>('SELECT id, lish_id, name, description, created, chunk_size, checksum_algo, directory FROM lishs WHERE lish_id = ?').get(lishID);
	if (!row) return null;
	return buildStoredLISH(db, row);
}

/**
 * Get a stored LISH with only the main record (no files/directories/links).
 * Used where only metadata fields are needed (e.g. chunk I/O that only needs directory + chunkSize).
 */
export function getLISHMeta(db: Database, lishID: LISHid): { internalID: number; lishID: string; chunkSize: number; checksumAlgo: HashAlgorithm; directory: string | null } | null {
	const row = db.query<{ id: number; lish_id: string; chunk_size: number; checksum_algo: string; directory: string | null }, [string]>('SELECT id, lish_id, chunk_size, checksum_algo, directory FROM lishs WHERE lish_id = ?').get(lishID);
	if (!row) return null;
	return { internalID: row.id, lishID: row.lish_id, chunkSize: row.chunk_size, checksumAlgo: row.checksum_algo as HashAlgorithm, directory: row.directory };
}

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
			COALESCE(d.dir_count, 0)   AS directory_count
		FROM lishs l
		LEFT JOIN (
			SELECT id_lishs, SUM(size) AS total_size, COUNT(*) AS file_count
			FROM lishs_files GROUP BY id_lishs
		) f ON f.id_lishs = l.id
		LEFT JOIN (
			SELECT id_lishs, COUNT(*) AS dir_count
			FROM lishs_directories GROUP BY id_lishs
		) d ON d.id_lishs = l.id
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
	}));
}

export function getLISHDetail(db: Database, lishID: LISHid): ILISHDetail | null {
	const row = db.query<{ id: number; lish_id: string; name: string | null; description: string | null; created: string | null; chunk_size: number; checksum_algo: string; directory: string | null }, [string]>('SELECT id, lish_id, name, description, created, chunk_size, checksum_algo, directory FROM lishs WHERE lish_id = ?').get(lishID);
	if (!row) return null;

	const files = getFiles(db, row.id);
	const directories = getDirectories(db, row.id);
	const links = getLinks(db, row.id);

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
		files: files.map(f => ({ path: f.path, size: f.size, permissions: f.permissions ?? undefined, modified: f.modified ?? undefined, created: f.created ?? undefined })),
		directories,
		links,
	};
}

export function listAllStoredLISHs(db: Database): IStoredLISH[] {
	const rows = db.query<{ id: number; lish_id: string; name: string | null; description: string | null; created: string | null; chunk_size: number; checksum_algo: string; directory: string | null }, []>('SELECT id, lish_id, name, description, created, chunk_size, checksum_algo, directory FROM lishs ORDER BY added ASC').all();
	return rows.map(r => buildStoredLISH(db, r));
}

export function getDatasets(db: Database): IStoredLISH[] {
	const rows = db.query<{ id: number; lish_id: string; name: string | null; description: string | null; created: string | null; chunk_size: number; checksum_algo: string; directory: string | null }, []>('SELECT id, lish_id, name, description, created, chunk_size, checksum_algo, directory FROM lishs WHERE directory IS NOT NULL ORDER BY added ASC').all();
	return rows.map(r => buildStoredLISH(db, r));
}

// -- Chunk operations --

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
		.query<{ missing: number }, [number]>(
			`SELECT COUNT(*) as missing FROM lishs_chunks c
		 JOIN lishs_files f ON f.id = c.id_lishs_files
		 WHERE f.id_lishs = ? AND c.have = FALSE`
		)
		.get(internalID);
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
			if (!chunk.have) {
				missing.push({ fileIndex, chunkIndex, chunkID: chunk.checksum as ChunkID });
			}
		}
	}
	return missing;
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
		const chunks = db.query<{ checksum: string }, [number]>('SELECT checksum FROM lishs_chunks WHERE id_lishs_files = ? ORDER BY id').all(file.id);
		const chunkIndex = chunks.findIndex(c => c.checksum === chunkID);
		if (chunkIndex !== -1) {
			return { filePath: file.path, chunkIndex };
		}
	}
	return null;
}

// -- Internal helpers --

interface LISHRow {
	id: number;
	lish_id: string;
	name: string | null;
	description: string | null;
	created: string | null;
	chunk_size: number;
	checksum_algo: string;
	directory: string | null;
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
		...(files.length > 0 ? { files } : {}),
		...(directories.length > 0 ? { directories } : {}),
		...(links.length > 0 ? { links } : {}),
		...(chunks.length > 0 ? { chunks } : {}),
	};
}

function getFiles(db: Database, internalID: number): Array<{ path: string; size: number; permissions: string | null; modified: string | null; created: string | null }> {
	return db.query<{ path: string; size: number; permissions: string | null; modified: string | null; created: string | null }, [number]>('SELECT path, size, permissions, modified, created FROM lishs_files WHERE id_lishs = ? ORDER BY id').all(internalID);
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
