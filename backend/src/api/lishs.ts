import { type DataServer } from '../lish/data-server.ts';
import { type ILISH, type IStoredLISH, type ILISHSummary, type ILISHDetail, type SuccessResponse, type CreateLISHResponse, type ImportLISHResponse, type LISHSortField, type SortOrder, type CompressionAlgorithm, DEFAULT_ALGO, sanitizeFilename, CodedError, ErrorCodes } from '@shared';
import { createLISH, exportLISHToFile, importLISHFromFile, parseLISHFromJSON, resetVerification, runVerification } from '../lish/lish.ts';
import { DEFAULT_CHUNK_SIZE } from '@shared';
import { Utils } from '../utils.ts';
import { setBusy, clearBusy } from './busy.ts';
import { getEnabledUploads, removeUploadState, enableUpload } from '../protocol/lish-protocol.ts';
import { getDownloadEnabledLishs, destroyActiveDownloader, removeDownloadState, restartDownloadIfEnabled, triggerEnableDownload, markDownloadEnabled, stopRecoveryForLISH } from './transfer.ts';
import { mkdir, readdir, stat, access, unlink, rmdir } from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { join, dirname } from 'path';
const assert = Utils.assertParams;
type EmitFn = (client: any, event: string, data: any) => void;
type BroadcastFn = (event: string, data: any) => void;
interface CreateLISHParams {
	name?: string;
	description?: string;
	dataPath: string;
	lishFile?: string;
	addToSharing?: boolean;
	addToDownloading?: boolean;
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
	enableSharing?: boolean;
	enableDownloading?: boolean;
}
interface ImportFromJSONParams {
	json: string;
	downloadPath: string;
	overwrite?: boolean;
	enableSharing?: boolean;
	enableDownloading?: boolean;
}
interface ImportFromURLParams {
	url: string;
	downloadPath: string;
	overwrite?: boolean;
	enableSharing?: boolean;
	enableDownloading?: boolean;
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
interface MoveParams {
	lishID: string;
	newDirectory: string;
	moveData: boolean;
	createSubdirectory?: boolean;
}
interface LISHsHandlers {
	list: (p?: { sortBy?: LISHSortField; sortOrder?: SortOrder }) => { items: ILISHSummary[]; verifying: string | null; pendingVerification: string[] };
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
	verifyAll: () => Promise<SuccessResponse>;
	stopVerify: (p: { lishID: string }) => Promise<SuccessResponse>;
	stopVerifyAll: () => Promise<SuccessResponse>;
	stopCreate: () => Promise<SuccessResponse>;
	move: (p: MoveParams) => Promise<SuccessResponse>;
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
	// Track current creation so it can be aborted
	let currentCreation: AbortController | null = null;

	function list(p?: { sortBy?: LISHSortField; sortOrder?: SortOrder }): { items: ILISHSummary[]; verifying: string | null; pendingVerification: string[]; moving: string[]; uploadEnabled: string[]; downloadEnabled: string[] } {
		return {
			items: dataServer.listSummaries(p?.sortBy, p?.sortOrder),
			verifying: currentVerification?.lishID ?? null,
			pendingVerification: [...verificationQueue],
			moving: [...movingLISHs],
			uploadEnabled: [...getEnabledUploads()],
			downloadEnabled: [...getDownloadEnabledLishs()],
		};
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
		const addToDownloading = p.addToDownloading ?? false;
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
		const ac = new AbortController();
		currentCreation = ac;
		let lish: IStoredLISH;
		try {
			lish = await createLISH(dataPath, p.name, chunkSize, algorithm as any, threads, p.description, info => emit(client, 'lishs.create:progress', info), undefined, ac.signal);
		} finally {
			if (currentCreation === ac) currentCreation = null;
		}
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
			lish.directory = dataPathStat.isFile() ? dirname(dataPath) : dataPath;
			dataServer.add(lish);
			console.log(`✓ Dataset imported: ${lish.id}`);
			broadcast('lishs:add', dataServer.getDetail(lish.id));
			startVerification(lish.id);
			if (addToDownloading) triggerEnableDownload(lish.id);
		}
		return { lishID: lish.id, lishFile: resultLISHFile };
	}

	async function del(p: { lishID: string; deleteLISH: boolean; deleteData: boolean }): Promise<boolean> {
		assert(p, ['lishID']);
		const lish = dataServer.get(p.lishID);
		if (!lish) return false;
		if (p.deleteLISH) {
			// Full deletion — stop transfers, stop verification, stop recovery, clean up, delete DB row
			stopRecoveryForLISH(p.lishID);
			removeUploadState(p.lishID);
			await removeDownloadState(p.lishID);
			// Stop any running/queued verification for this LISH
			if (currentVerification?.lishID === p.lishID) currentVerification.ac.abort();
			const qIdx = verificationQueue.indexOf(p.lishID);
			if (qIdx >= 0) verificationQueue.splice(qIdx, 1);
			clearBusy(p.lishID);
			if (p.deleteData && lish.directory) {
				await deleteLISHData(lish);
			}
			const deleted = dataServer.delete(p.lishID);
			if (deleted) {
				console.log(`✓ LISH deleted: ${p.lishID}`);
				broadcast('lishs:remove', { lishID: p.lishID });
			}
			return deleted;
		}
		// Delete only data — use busy to temporarily block, verify, then restore original state
		if (p.deleteData && lish.directory) {
			setBusy(p.lishID, 'deleting');
			await destroyActiveDownloader(p.lishID);
			await deleteLISHData(lish);
			dataServer.resetVerification(p.lishID);
			// Transition directly from 'deleting' to 'verifying' — no busy gap
			setBusy(p.lishID, 'verifying');
			startVerification(p.lishID);
		}
		return true;
	}

	async function importCommon(lish: ILISH, downloadPath: string, overwrite: boolean, enableSharing?: boolean, enableDownloading?: boolean): Promise<ImportLISHResponse> {
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
		// Set enabled flags BEFORE verification — verify sets busy which blocks triggerEnableDownload.
		// After verify completes, restartDownloadIfEnabled picks up the enabled flag automatically.
		if (enableSharing) enableUpload(lish.id);
		if (enableDownloading) markDownloadEnabled(lish.id);
		startVerification(lish.id);
		return { lishID: lish.id, directory };
	}

	async function importFromFile(p: ImportFromFileParams): Promise<ImportLISHResponse> {
		assert(p, ['filePath', 'downloadPath']);
		const lishs = await importLISHFromFile(Utils.expandHome(p.filePath));
		let lastResponse!: ImportLISHResponse;
		for (const lish of lishs) {
			lastResponse = await importCommon(lish, p.downloadPath, p.overwrite ?? false, p.enableSharing, p.enableDownloading);
		}
		return lastResponse;
	}

	async function importFromJSON(p: ImportFromJSONParams): Promise<ImportLISHResponse> {
		assert(p, ['json', 'downloadPath']);
		const lishs = parseLISHFromJSON(p.json);
		let lastResponse!: ImportLISHResponse;
		for (const lish of lishs) lastResponse = await importCommon(lish, p.downloadPath, p.overwrite ?? false, p.enableSharing, p.enableDownloading);
		return lastResponse;
	}

	async function importFromURL(p: ImportFromURLParams): Promise<ImportLISHResponse> {
		assert(p, ['url', 'downloadPath']);
		const content = await Utils.fetchURL(p.url);
		const lishs = parseLISHFromJSON(content);
		let lastResponse!: ImportLISHResponse;
		for (const lish of lishs) lastResponse = await importCommon(lish, p.downloadPath, p.overwrite ?? false, p.enableSharing, p.enableDownloading);
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

	// Verification queue — only one verification runs at a time
	let currentVerification: { lishID: string; ac: AbortController } | null = null;
	const verificationQueue: string[] = [];

	// Track LISHs currently being moved
	const movingLISHs = new Set<string>();

	function enqueueVerification(lishID: string): void {
		if (currentVerification?.lishID === lishID) return;
		if (verificationQueue.includes(lishID)) return;
		verificationQueue.push(lishID);
		broadcast('lishs:verify', { lishID, filePath: '', verifiedChunks: 0, queued: true });
		processVerificationQueue();
	}

	function processVerificationQueue(): void {
		if (currentVerification || verificationQueue.length === 0) return;
		const lishID = verificationQueue.shift()!;
		const ac = new AbortController();
		currentVerification = { lishID, ac };
		setBusy(lishID, 'verifying');
		broadcast('lishs:verify', { lishID, filePath: '', verifiedChunks: 0, started: true });
		runVerification(dataServer, lishID, progress => broadcast('lishs:verify', progress), ac.signal).finally(() => {
			const isOwner = currentVerification?.ac === ac;
			if (isOwner) {
				clearBusy(lishID);
				if (ac.signal.aborted) broadcast('lishs:verify', { lishID, filePath: '', verifiedChunks: 0, done: true });
				currentVerification = null;
			}
			// Resume download if enabled — no-op if download not enabled or LISH deleted
			if (isOwner && !ac.signal.aborted) restartDownloadIfEnabled(lishID);
			processVerificationQueue();
		});
	}

	function startVerification(lishID: string): void {
		enqueueVerification(lishID);
	}

	async function verify(p: { lishID: string }): Promise<SuccessResponse> {
		assert(p, ['lishID']);
		// Cancel if currently running for this LISH
		if (currentVerification?.lishID === p.lishID) {
			currentVerification.ac.abort();
			currentVerification = null;
		}
		// Remove from queue if pending
		const qIDx = verificationQueue.indexOf(p.lishID);
		if (qIDx >= 0) verificationQueue.splice(qIDx, 1);
		broadcast('lishs:verify', { lishID: p.lishID, filePath: '', verifiedChunks: 0, started: true });
		enqueueVerification(p.lishID);
		return { success: true };
	}

	async function verifyAll(): Promise<SuccessResponse> {
		const allLISHs = dataServer.listSummaries(undefined, 'desc');
		for (const lish of allLISHs) {
			// Skip if already verifying or already in queue
			if (currentVerification?.lishID === lish.id) continue;
			if (verificationQueue.includes(lish.id)) continue;
			broadcast('lishs:verify', { lishID: lish.id, filePath: '', verifiedChunks: 0, started: true });
			enqueueVerification(lish.id);
		}
		return { success: true };
	}

	async function stopVerify(p: { lishID: string }): Promise<SuccessResponse> {
		assert(p, ['lishID']);
		clearBusy(p.lishID);
		// Stop if currently running
		if (currentVerification?.lishID === p.lishID) currentVerification.ac.abort();
		// Remove from queue if pending
		const qIDx = verificationQueue.indexOf(p.lishID);
		if (qIDx >= 0) {
			verificationQueue.splice(qIDx, 1);
			broadcast('lishs:verify', { lishID: p.lishID, filePath: '', verifiedChunks: 0, done: true });
		}
		return { success: true };
	}

	async function stopVerifyAll(): Promise<SuccessResponse> {
		if (currentVerification) {
			clearBusy(currentVerification.lishID);
			currentVerification.ac.abort();
		}
		while (verificationQueue.length > 0) {
			const lishID = verificationQueue.shift()!;
			clearBusy(lishID);
			broadcast('lishs:verify', { lishID, filePath: '', verifiedChunks: 0, done: true });
		}
		return { success: true };
	}

	async function stopCreate(): Promise<SuccessResponse> {
		if (currentCreation) {
			currentCreation.abort();
			currentCreation = null;
		}
		return { success: true };
	}

	async function move(p: MoveParams): Promise<SuccessResponse> {
		assert(p, ['lishID', 'newDirectory']);
		const lish = dataServer.get(p.lishID);
		if (!lish) throw new CodedError(ErrorCodes.LISH_NOT_FOUND, p.lishID);
		let newDir = Utils.expandHome(p.newDirectory);
		if (p.createSubdirectory !== false) {
			const subDirName = sanitizeFilename(lish.name || lish.id) || lish.id;
			newDir = join(newDir, subDirName);
		}
		// Stop verification if running for this LISH
		if (currentVerification?.lishID === p.lishID) {
			currentVerification.ac.abort();
			currentVerification = null;
		}
		const qIdx = verificationQueue.indexOf(p.lishID);
		if (qIdx >= 0) {
			verificationQueue.splice(qIdx, 1);
			broadcast('lishs:verify', { lishID: p.lishID, filePath: '', verifiedChunks: 0, done: true });
		}
		movingLISHs.add(p.lishID);
		setBusy(p.lishID, 'moving');
		broadcast('lishs:move:status', { lishID: p.lishID, moving: true });
		try {
			if (p.moveData && lish.directory) {
				const oldDir = lish.directory;
				const allFiles = lish.files ?? [];
				const allLinks = lish.links ?? [];
				const totalFiles = allFiles.length + allLinks.length;
				const totalBytes = allFiles.reduce((s, f) => s + (f.size ?? 0), 0);
				let completedFiles = 0;
				let completedBytes = 0;
				// Broadcast file list to all clients
				broadcast('lishs:move:progress', {
					lishID: p.lishID,
					type: 'file-list',
					totalFiles,
					completedFiles: 0,
					totalBytes,
					completedBytes: 0,
					files: allFiles.map(f => ({ path: f.path, size: f.size ?? 0 })),
				});
				// Create target directory
				await mkdir(newDir, { recursive: true });
				// Copy files with streaming progress
				const PROGRESS_INTERVAL = 512 * 1024; // Report every 512KB
				for (const file of allFiles) {
					const srcPath = join(oldDir, file.path);
					const dstPath = join(newDir, file.path);
					await mkdir(dirname(dstPath), { recursive: true });
					const fileSize = file.size ?? 0;
					let fileBytes = 0;
					let lastReported = 0;
					await new Promise<void>((resolve, reject) => {
						const rs = createReadStream(srcPath);
						const ws = createWriteStream(dstPath);
						rs.on('data', (chunk: string | Buffer) => {
							fileBytes += chunk.length;
							if (fileBytes - lastReported >= PROGRESS_INTERVAL) {
								lastReported = fileBytes;
								broadcast('lishs:move:progress', {
									lishID: p.lishID,
									type: 'chunk',
									path: file.path,
									totalFiles,
									completedFiles,
									totalBytes,
									completedBytes: completedBytes + fileBytes,
									fileBytes,
									fileSize,
								});
							}
						});
						rs.on('error', reject);
						ws.on('error', reject);
						ws.on('finish', resolve);
						rs.pipe(ws);
					});
					completedFiles++;
					completedBytes += fileSize;
					broadcast('lishs:move:progress', { lishID: p.lishID, type: 'file', path: file.path, totalFiles, completedFiles, totalBytes, completedBytes });
				}
				// Create directories listed in the LISH
				for (const dir of lish.directories ?? []) {
					await mkdir(join(newDir, dir.path), { recursive: true });
				}
				// Copy symlinks (small, no streaming needed)
				for (const link of allLinks) {
					const srcPath = join(oldDir, link.path);
					const dstPath = join(newDir, link.path);
					await mkdir(dirname(dstPath), { recursive: true });
					await new Promise<void>((resolve, reject) => {
						const rs = createReadStream(srcPath);
						const ws = createWriteStream(dstPath);
						rs.on('error', reject);
						ws.on('error', reject);
						ws.on('finish', resolve);
						rs.pipe(ws);
					});
					completedFiles++;
					broadcast('lishs:move:progress', { lishID: p.lishID, type: 'file', path: link.path, totalFiles, completedFiles, totalBytes, completedBytes });
				}
				// Delete old data
				await deleteLISHData(lish);
			}
			// Update directory in DB
			dataServer.updateDirectory(p.lishID, newDir);
			console.log(`✓ LISH moved: ${p.lishID} → ${newDir}`);
			broadcast('lishs:move', { lishID: p.lishID, directory: newDir });
			return { success: true };
		} finally {
			movingLISHs.delete(p.lishID);
			clearBusy(p.lishID);
			broadcast('lishs:move:status', { lishID: p.lishID, moving: false });
		}
	}

	return { list, get, exportToFile, exportAllToFile, backup, create, delete: del, importFromFile, importFromJSON, importFromURL, parseFromFile, parseFromJSON, parseFromURL, verify, verifyAll, stopVerify, stopVerifyAll, stopCreate, move, startVerification };
}
