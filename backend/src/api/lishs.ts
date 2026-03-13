import { type DataServer } from '../lish/data-server.ts';
import { type ILISH, type IStoredLISH, type ILISHSummary, type ILISHDetail, type SuccessResponse, type CreateLISHResponse, type ImportLISHResponse, type LISHSortField, type SortOrder, type CompressionAlgorithm, DEFAULT_ALGO, sanitizeFilename, CodedError, ErrorCodes } from '@shared';
import { createLISH, exportLISHToFile, importLISHFromFile, parseLISHFromJSON, resetVerification, runVerification } from '../lish/lish.ts';
import { DEFAULT_CHUNK_SIZE } from '@shared';
import { Utils } from '../utils.ts';
import { mkdir, readdir, stat, access, unlink, rmdir } from 'fs/promises';
import { join } from 'path';
const assert = Utils.assertParams;
type EmitFn = (client: any, event: string, data: any) => void;
type BroadcastFn = (event: string, data: any) => void;
interface CreateLISHParams {
	name?: string;
	description?: string;
	dataPath: string;
	lishFile?: string;
	addToSharing?: boolean;
	chunkSize?: number;
	algorithm?: string;
	threads?: number;
	minifyJSON?: boolean;
	compress?: boolean;
	compressionAlgorithm?: CompressionAlgorithm;
}
interface ImportFromFileParams {
	filePath: string;
	downloadPath: string;
	overwrite?: boolean;
}
interface ImportFromJSONParams {
	json: string;
	downloadPath: string;
	overwrite?: boolean;
}
interface ImportFromURLParams {
	url: string;
	downloadPath: string;
	overwrite?: boolean;
}
interface ExportToFileParams {
	lishID: string;
	filePath: string;
	minifyJSON?: boolean;
	compress?: boolean;
	compressionAlgorithm?: CompressionAlgorithm;
}
interface ExportAllToFileParams {
	filePath: string;
	minifyJSON?: boolean;
	compress?: boolean;
	compressionAlgorithm?: CompressionAlgorithm;
}
interface LISHsHandlers {
	list: (p?: { sortBy?: LISHSortField; sortOrder?: SortOrder }) => ILISHSummary[];
	get: (p: { lishID: string }) => ILISHDetail | null;
	exportToFile: (p: ExportToFileParams) => Promise<SuccessResponse>;
	exportAllToFile: (p: ExportAllToFileParams) => Promise<SuccessResponse>;
	backup: () => IStoredLISH[];
	create: (p: CreateLISHParams, client: any) => Promise<CreateLISHResponse>;
	delete: (p: { lishID: string; deleteLISH: boolean; deleteData: boolean }) => Promise<boolean>;
	importFromFile: (p: ImportFromFileParams) => Promise<ImportLISHResponse>;
	importFromJSON: (p: ImportFromJSONParams) => Promise<ImportLISHResponse>;
	importFromURL: (p: ImportFromURLParams) => Promise<ImportLISHResponse>;
	parseFromFile: (p: { filePath: string }) => Promise<ILISH[]>;
	parseFromJSON: (p: { json: string }) => ILISH[];
	parseFromURL: (p: { url: string }) => Promise<ILISH[]>;
	verify: (p: { lishID: string }) => Promise<SuccessResponse>;
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
	// 3. Delete the base directory itself if empty
	try {
		await rmdir(baseDir);
		console.log(`✓ Base directory removed: ${baseDir}`);
	} catch (err: any) {
		if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY') console.error(`Failed to delete base directory: ${baseDir}`, err);
	}
}

export function initLISHsHandlers(dataServer: DataServer, emit: EmitFn, broadcast: BroadcastFn): LISHsHandlers {
	function list(p?: { sortBy?: LISHSortField; sortOrder?: SortOrder }): ILISHSummary[] {
		return dataServer.listSummaries(p?.sortBy, p?.sortOrder);
	}

	function get(p: { lishID: string }): ILISHDetail | null {
		assert(p, ['lishID']);
		return dataServer.getDetail(p.lishID);
	}

	async function exportToFile(p: ExportToFileParams): Promise<SuccessResponse> {
		assert(p, ['lishID', 'filePath']);
		const lish = dataServer.get(p.lishID);
		if (!lish) throw new CodedError(ErrorCodes.LISH_NOT_FOUND, p.lishID);
		const { directory, chunks, ...exportData } = lish;
		await Utils.writeJSONToFile(exportData, p.filePath, p.minifyJSON, p.compress, p.compressionAlgorithm);
		console.log(`✓ LISH exported to: ${p.filePath}`);
		return { success: true };
	}

	async function exportAllToFile(p: ExportAllToFileParams): Promise<SuccessResponse> {
		assert(p, ['filePath']);
		const lishs = dataServer.list();
		if (lishs.length === 0) throw new CodedError(ErrorCodes.NO_LISHS);
		const exportData: ILISH[] = lishs.map(lish => {
			const { directory, chunks, ...data } = lish;
			return data;
		});
		await Utils.writeJSONToFile(exportData, p.filePath, p.minifyJSON, p.compress, p.compressionAlgorithm);
		console.log(`✓ All LISHs exported to: ${p.filePath}`);
		return { success: true };
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
		const minifyJSON = p.minifyJSON ?? false;
		const compress = p.compress ?? false;
		const compressionAlgorithm = p.compressionAlgorithm ?? 'gzip';
		// TODO: check that dataPath is not already in datasets.
		const dataPath = Utils.expandHome(p.dataPath);
		// Check that the path exists and is not an empty directory
		const dataPathStat = await stat(dataPath);
		if (dataPathStat.isDirectory()) {
			const entries = await readdir(dataPath);
			if (entries.length === 0) throw new CodedError(ErrorCodes.DIRECTORY_EMPTY);
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
					const ext = compress ? '.lish.gz' : '.lish';
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
			await exportLISHToFile(lish, lishFilePath, minifyJSON, compress, compressionAlgorithm);
			resultLISHFile = lishFilePath;
		}
		// 3. Save to data-server if requested
		if (addToSharing) {
			lish.directory = dataPath;
			dataServer.add(lish);
			console.log(`✓ Dataset imported: ${lish.id}`);
			broadcast('lishs:add', dataServer.getDetail(lish.id));
			startVerification(lish.id);
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
			const deleted = dataServer.delete(p.lishID);
			if (deleted) {
				console.log(`✓ LISH deleted: ${p.lishID}`);
				broadcast('lishs:remove', { lishID: p.lishID });
			}
			return deleted;
		}
		return true;
	}

	async function importCommon(lish: ILISH, downloadPath: string, overwrite: boolean): Promise<ImportLISHResponse> {
		const existing = dataServer.get(lish.id);
		if (existing && !overwrite) throw new CodedError(ErrorCodes.LISH_ALREADY_EXISTS, lish.id);
		if (existing) dataServer.delete(lish.id);
		const dirName = sanitizeFilename(lish.name || lish.id) || lish.id;
		const directory = join(Utils.expandHome(downloadPath), dirName);
		await mkdir(directory, { recursive: true });
		const storedLISH: IStoredLISH = {
			...lish,
			directory,
		};
		dataServer.add(storedLISH);
		console.log(`✓ LISH imported: ${lish.id}`);
		broadcast('lishs:add', dataServer.getDetail(lish.id));
		startVerification(lish.id);
		return { lishID: lish.id, directory };
	}

	async function importFromFile(p: ImportFromFileParams): Promise<ImportLISHResponse> {
		assert(p, ['filePath', 'downloadPath']);
		const lishs = await importLISHFromFile(Utils.expandHome(p.filePath));
		let lastResponse!: ImportLISHResponse;
		for (const lish of lishs) {
			lastResponse = await importCommon(lish, p.downloadPath, p.overwrite ?? false);
		}
		return lastResponse;
	}

	async function importFromJSON(p: ImportFromJSONParams): Promise<ImportLISHResponse> {
		assert(p, ['json', 'downloadPath']);
		const lishs = parseLISHFromJSON(p.json);
		let lastResponse!: ImportLISHResponse;
		for (const lish of lishs) lastResponse = await importCommon(lish, p.downloadPath, p.overwrite ?? false);
		return lastResponse;
	}

	async function importFromURL(p: ImportFromURLParams): Promise<ImportLISHResponse> {
		assert(p, ['url', 'downloadPath']);
		const content = await Utils.fetchURL(p.url);
		const lishs = parseLISHFromJSON(content);
		let lastResponse!: ImportLISHResponse;
		for (const lish of lishs) lastResponse = await importCommon(lish, p.downloadPath, p.overwrite ?? false);
		return lastResponse;
	}

	async function parseFromFile(p: { filePath: string }): Promise<ILISH[]> {
		assert(p, ['filePath']);
		return importLISHFromFile(Utils.expandHome(p.filePath));
	}

	function parseFromJSON(p: { json: string }): ILISH[] {
		assert(p, ['json']);
		return parseLISHFromJSON(p.json);
	}

	async function parseFromURL(p: { url: string }): Promise<ILISH[]> {
		assert(p, ['url']);
		const content = await Utils.fetchURL(p.url);
		return parseLISHFromJSON(content);
	}

	const activeVerifications = new Map<string, AbortController>();

	function startVerification(lishID: string): void {
		const prev = activeVerifications.get(lishID);
		if (prev) prev.abort();
		const ac = new AbortController();
		activeVerifications.set(lishID, ac);
		runVerification(dataServer, lishID, progress => broadcast('lishs:verify', progress), ac.signal).finally(() => {
			if (activeVerifications.get(lishID) === ac) activeVerifications.delete(lishID);
		});
	}

	async function verify(p: { lishID: string }): Promise<SuccessResponse> {
		assert(p, ['lishID']);
		// Cancel any running verification for this LISH
		const prev = activeVerifications.get(p.lishID);
		if (prev) prev.abort();
		const ac = new AbortController();
		activeVerifications.set(p.lishID, ac);
		resetVerification(dataServer, p.lishID);
		// Notify all clients to reset their UI state
		broadcast('lishs:verify', { lishID: p.lishID, filePath: '', verifiedChunks: 0, reset: true });
		// Run verification in background — response is sent immediately after DB reset
		runVerification(dataServer, p.lishID, progress => broadcast('lishs:verify', progress), ac.signal).finally(() => {
			if (activeVerifications.get(p.lishID) === ac) activeVerifications.delete(p.lishID);
		});
		return { success: true };
	}

	return { list, get, exportToFile, exportAllToFile, backup, create, delete: del, importFromFile, importFromJSON, importFromURL, parseFromFile, parseFromJSON, parseFromURL, verify };
}
