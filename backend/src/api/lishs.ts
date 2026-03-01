import { type DataServer } from '../lish/data-server.ts';
import { type IStoredLISH, type ILISHSummary, type ILISHDetail, type CreateLISHResponse, type LISHSortField, type SortOrder, DEFAULT_ALGO } from '@shared';
import { createLISH } from '../lish/lish.ts';
import { DEFAULT_CHUNK_SIZE } from '@shared';
import { exportLISHToFile } from '../lish/lish-export.ts';
import { Utils } from '../utils.ts';
import { readdir, stat, access, unlink, rmdir } from 'fs/promises';
import { join } from 'path';
const assert = Utils.assertParams;
type EmitFn = (client: any, event: string, data: any) => void;
interface CreateLISHParams {
	name?: string;
	description?: string;
	dataPath: string;
	lishFile?: string;
	addToSharing?: boolean;
	chunkSize?: number;
	algorithm?: string;
	threads?: number;
	minifyJson?: boolean;
	compressGzip?: boolean;
}

interface LISHsHandlers {
	list: (p?: { sortBy?: LISHSortField; sortOrder?: SortOrder }) => ILISHSummary[];
	get: (p: { lishID: string }) => ILISHDetail | null;
	backup: () => IStoredLISH[];
	create: (p: CreateLISHParams, client: any) => Promise<CreateLISHResponse>;
	delete: (p: { lishID: string; deleteLISH: boolean; deleteData: boolean }) => Promise<boolean>;
}

function toSummary(lish: IStoredLISH): ILISHSummary {
	return {
		id: lish.id,
		name: lish.name,
		description: lish.description,
		created: lish.created,
		totalSize: lish.files?.reduce((sum, f) => sum + f.size, 0) ?? 0,
		fileCount: lish.files?.length ?? 0,
		directoryCount: lish.directories?.length ?? 0,
	};
}

function toDetail(lish: IStoredLISH): ILISHDetail {
	return {
		id: lish.id,
		name: lish.name,
		description: lish.description,
		created: lish.created,
		chunkSize: lish.chunkSize,
		checksumAlgo: lish.checksumAlgo,
		totalSize: lish.files?.reduce((sum, f) => sum + f.size, 0) ?? 0,
		fileCount: lish.files?.length ?? 0,
		directoryCount: lish.directories?.length ?? 0,
		directory: lish.directory,
		files: lish.files?.map(f => ({ path: f.path, size: f.size, permissions: f.permissions, modified: f.modified, created: f.created })) ?? [],
		directories: lish.directories ?? [],
		links: lish.links ?? [],
	};
}

/**
 * Delete only the files and empty directories that belong to a LISH structure.
 * Files not part of the LISH are left untouched.
 * Directories are removed only if they are empty after file deletion (deepest first).
 */
async function deleteLISHData(lish: IStoredLISH): Promise<void> {
	const baseDir = lish.directory!;
	// 1. Delete all files listed in the LISH
	let deletedFiles = 0;
	for (const file of lish.files ?? []) {
		const filePath = join(baseDir, file.path);
		try {
			await unlink(filePath);
			deletedFiles++;
		} catch (err: any) {
			if (err.code !== 'ENOENT') console.error(`Failed to delete file: ${filePath}`, err);
		}
	}
	// 2. Delete LISH directories if empty (deepest first)
	const dirs = (lish.directories ?? []).map(d => d.path).sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a));
	let deletedDirs = 0;
	for (const dir of dirs) {
		const dirPath = join(baseDir, dir);
		try {
			await rmdir(dirPath); // Fails if not empty — that's what we want
			deletedDirs++;
		} catch (err: any) {
			if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY') console.error(`Failed to delete directory: ${dirPath}`, err);
		}
	}
	console.log(`✓ LISH data deleted: ${deletedFiles} files, ${deletedDirs} directories removed`);
}

export function initLISHsHandlers(dataServer: DataServer, emit: EmitFn): LISHsHandlers {
	function list(p?: { sortBy?: LISHSortField; sortOrder?: SortOrder }): ILISHSummary[] {
		const summaries = dataServer.list().map(toSummary);
		if (p?.sortBy) {
			const sortBy = p.sortBy;
			const dir = (p.sortOrder ?? 'asc') === 'desc' ? -1 : 1;
			summaries.sort((a, b) => {
				const va = a[sortBy];
				const vb = b[sortBy];
				if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb) * dir;
				if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
				return 0;
			});
		} else if (p?.sortOrder === 'desc') {
			summaries.reverse();
		}
		return summaries;
	}

	function get(p: { lishID: string }): ILISHDetail | null {
		assert(p, ['lishID']);
		const lish = dataServer.get(p.lishID);
		return lish ? toDetail(lish) : null;
	}

	function backup(): IStoredLISH[] {
		return dataServer.list();
	}

	async function create(p: CreateLISHParams, client: any): Promise<CreateLISHResponse> {
		assert(p, ['dataPath']);
		const addToSharing = p.addToSharing ?? false;
		const algorithm = p.algorithm ?? DEFAULT_ALGO;
		const chunkSize = p.chunkSize ?? DEFAULT_CHUNK_SIZE;
		const threads = p.threads ?? 0; // 0 = all CPU threads
		const minifyJson = p.minifyJson ?? false;
		const compressGzip = p.compressGzip ?? false;
		// TODO: check that dataPath is not already in datasets.
		const dataPath = Utils.expandHome(p.dataPath);
		// Check that the path exists and is not an empty directory
		const dataPathStat = await stat(dataPath);
		if (dataPathStat.isDirectory()) {
			const entries = await readdir(dataPath);
			if (entries.length === 0) throw new Error('Directory is empty - nothing to create LISH from');
		}
		console.log(`Creating LISH from: ${dataPath}, lishFile=${p.lishFile}, addToSharing=${addToSharing}, name=${p.name}, description=${p.description}`);
		// 1. Create the LISH structure
		const lish: IStoredLISH = await createLISH(dataPath, p.name, chunkSize, algorithm as any, threads, p.description, info => {
			emit(client, 'lishs.create:progress', info);
		});
		// 2. Export to .lish(.gz) file if requested
		let resultLISHFile: string | undefined;
		if (p.lishFile) {
			let lishFilePath = Utils.expandHome(p.lishFile);
			// If the path is a directory, use [lish-id].lish(.gz) as filename
			try {
				const fileStat = await stat(lishFilePath);
				if (fileStat.isDirectory()) {
					const ext = compressGzip ? '.lish.gz' : '.lish';
					let candidate = join(lishFilePath, lish.id + ext);
					// Handle unlikely collision: append numeric suffix
					let suffix = 1;
					while (true) {
						try {
							await access(candidate);
							candidate = join(lishFilePath, lish.id + '-' + suffix + ext);
							suffix++;
						} catch {
							break; // Path doesn't exist — use it
						}
					}
					lishFilePath = candidate;
				}
			} catch {
				// Path doesn't exist yet — treat as a file path
			}
			await exportLISHToFile(lish, lishFilePath, minifyJson, compressGzip);
			resultLISHFile = lishFilePath;
		}
		// 3. Save to data-server if requested
		if (addToSharing) {
			lish.directory = dataPath;
			if (lish.files) lish.chunks = lish.files.flatMap(f => f.checksums);
			await dataServer.add(lish);
			console.log(`✓ Dataset imported: ${lish.id}`);
		}
		return { lishID: lish.id, lishFile: resultLISHFile };
	}

	async function del(p: { lishID: string; deleteLISH: boolean; deleteData: boolean }): Promise<boolean> {
		assert(p, ['lishID']);
		const lish = dataServer.get(p.lishID);
		if (!lish) return false;
		// Delete LISH data files selectively
		if (p.deleteData && lish.directory) await deleteLISHData(lish);
		// Delete LISH from storage if requested
		if (p.deleteLISH) {
			const deleted = await dataServer.delete(p.lishID);
			if (deleted) console.log(`✓ LISH deleted: ${p.lishID}`);
			return deleted;
		}
		return true;
	}

	return { list, get, backup, create, delete: del };
}
