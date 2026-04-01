import * as fsPromises from 'node:fs/promises';
import { type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { type HashAlgorithm, type ILISH, type IStoredLISH, type IDirectoryEntry, type IFileEntry, type ILinkEntry, SUPPORTED_ALGOS, CodedError, ErrorCodes } from '@shared';
import { type CompressionAlgorithm } from '@shared';
import { calculateChecksum } from './checksum.ts';
import { Utils } from '../utils.ts';
import { type DataServer } from './data-server.ts';

// Worker URL for checksum-worker. Default works in dev mode (import.meta.url is the actual file URL).
// In compiled binaries, import.meta.url is always the binary path, so app.ts must call setWorkerUrl()
// with new URL('./lish/checksum-worker.js', import.meta.url).href before any LISH creation.
let _workerUrl: string = new URL('./checksum-worker.ts', import.meta.url).href;

/** Override the checksum worker URL. Must be called from the main entrypoint (app.ts) in compiled mode. */
export function setWorkerUrl(url: string): void {
	_workerUrl = url;
}

// Helper to normalize paths to forward slashes
function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

// Helper to get relative path from base
function getRelativePath(fullPath: string, basePath: string): string {
	const normalized = normalizePath(fullPath);
	const base = normalizePath(basePath);
	if (normalized.startsWith(base)) {
		const relative = normalized.slice(base.length);
		return relative.startsWith('/') ? relative.slice(1) : relative;
	}
	return normalized;
}

// Helper to format timestamp to ISO 8601 UTC
function formatTimestamp(date: Date): string {
	return date.toISOString();
}

// Helper to extract permission bits from mode and format as octal string (remove file type bits)
function getPermissions(mode: number): string {
	const perms = mode & 0o777; // Keep only the last 9 bits (rwxrwxrwx)
	return perms.toString(8); // Convert to octal string
}

// Helper to get file/directory stats
async function getStats(fullPath: string): Promise<Stats> {
	try {
		const stat = await Bun.file(fullPath).stat();
		return stat;
	} catch (e) {
		throw new CodedError(ErrorCodes.PATH_ACCESS_DENIED, fullPath);
	}
}

// Calculate checksums sequentially (single-threaded, no worker overhead)
async function calculateChecksumsSequential(filePath: string, fileSize: number, chunkSize: number, algo: HashAlgorithm, _maxWorkers: number, onProgress?: (completed: number, total: number) => void, signal?: AbortSignal): Promise<string[]> {
	const totalChunks = Math.ceil(fileSize / chunkSize);
	const file = Bun.file(filePath);
	const results: string[] = [];
	for (let i = 0; i < totalChunks; i++) {
		if (signal?.aborted) throw new CodedError(ErrorCodes.LISH_CREATE_CANCELLED);
		const checksum = await calculateChecksum(file, i * chunkSize, chunkSize, algo);
		results.push(checksum);
		if (onProgress) onProgress(i + 1, totalChunks);
	}
	return results;
}

// Calculate checksums in parallel using workers
async function calculateChecksumsParallel(filePath: string, fileSize: number, chunkSize: number, algo: HashAlgorithm, maxWorkers: number, onProgress?: (completed: number, total: number) => void, signal?: AbortSignal): Promise<string[]> {
	if (signal?.aborted) throw new CodedError(ErrorCodes.LISH_CREATE_CANCELLED);
	const totalChunks = Math.ceil(fileSize / chunkSize);
	const cpuCount = maxWorkers > 0 ? maxWorkers : navigator.hardwareConcurrency || 1;
	const workerCount = Math.min(cpuCount, totalChunks);
	// Create workers
	const workers: Worker[] = [];
	for (let i = 0; i < workerCount; i++) workers.push(new Worker(_workerUrl));
	let completedChunks = 0;
	const results: string[] = new Array(totalChunks);
	let nextChunk = 0;

	// Process chunks by feeding workers one at a time
	await new Promise<void>((resolveAll, rejectAll) => {
		let finished = false;
		function abortHandler(): void {
			if (finished) return;
			finished = true;
			workers.forEach(w => w.terminate());
			rejectAll(new CodedError(ErrorCodes.LISH_CREATE_CANCELLED));
		}
		if (signal?.aborted) {
			abortHandler();
			return;
		}
		signal?.addEventListener('abort', abortHandler, { once: true });
		function feedWorker(workerIndex: number): void {
			if (finished) return;
			if (nextChunk >= totalChunks) return;
			const chunkIndex = nextChunk++;
			const offset = chunkIndex * chunkSize;
			const worker = workers[workerIndex]!;
			function handler(event: MessageEvent): void {
				if (event.data.index === chunkIndex) {
					worker.removeEventListener('message', handler);
					if (finished) return;
					if (event.data.error) {
						finished = true;
						rejectAll(new Error(event.data.error));
						return;
					}
					results[chunkIndex] = event.data.checksum;
					completedChunks++;
					if (onProgress) onProgress(completedChunks, totalChunks);
					if (completedChunks === totalChunks) {
						signal?.removeEventListener('abort', abortHandler);
						resolveAll();
					} else feedWorker(workerIndex);
				}
			}
			worker.addEventListener('message', handler);
			worker.postMessage({ filePath, offset, chunkSize, algo, index: chunkIndex });
		}
		// Start one chunk per worker
		for (let i = 0; i < workerCount; i++) feedWorker(i);
	});
	// Terminate workers
	workers.forEach(w => w.terminate());
	return results;
}

// Track inodes to detect hard links
interface InodeMap {
	[inode: string]: string; // inode -> first file path encountered
}

// Scan directory recursively to collect all regular files (without computing checksums)
// Used to send the complete file list to the frontend before starting checksum computation
async function scanFiles(dirPath: string, basePath: string, chunkSize: number, inodeMap: { [key: string]: boolean } = {}): Promise<{ path: string; size: number; chunks: number }[]> {
	const result: { path: string; size: number; chunks: number }[] = [];
	const glob = new Bun.Glob('*');
	const scannedPaths: string[] = [];
	for await (const entry of glob.scan({ cwd: dirPath, dot: true, onlyFiles: false })) scannedPaths.push(entry);
	scannedPaths.sort();
	for (const entry of scannedPaths) {
		const fullPath = `${dirPath}/${entry}`;
		let stat: Stats;
		try {
			stat = await getStats(fullPath);
		} catch {
			continue;
		}
		// Check symlink
		let isSymlink = false;
		try {
			const lstat = await fsPromises.lstat(fullPath);
			isSymlink = lstat.isSymbolicLink();
		} catch {}
		if (isSymlink) continue;
		else if (stat.isDirectory()) {
			const subFiles = await scanFiles(fullPath, basePath, chunkSize, inodeMap);
			result.push(...subFiles);
		} else if (stat.isFile()) {
			const inodeKey = `${stat.dev}:${stat.ino}`;
			// Skip hard links (already seen inode)
			if (stat.ino > 0 && inodeMap[inodeKey]) continue;
			if (stat.ino > 0) inodeMap[inodeKey] = true;
			const relativePath = getRelativePath(fullPath, basePath);
			const totalChunks = Math.ceil(stat.size / chunkSize);
			result.push({ path: relativePath, size: stat.size, chunks: totalChunks });
		}
	}
	return result;
}

type ProgressInfo = { type: 'file-list'; files: { path: string; size: number; chunks: number }[] } | { type: 'file-start'; path: string; size: number; chunks: number } | { type: 'chunk'; path: string; current: number; total: number } | { type: 'file'; path: string };

async function processDirectory(dirPath: string, basePath: string, chunkSize: number, algo: HashAlgorithm, maxWorkers: number, directories: IDirectoryEntry[], files: IFileEntry[], links: ILinkEntry[], inodeMap: InodeMap, onProgress?: (info: ProgressInfo) => void, signal?: AbortSignal): Promise<void> {
	const stat = await getStats(dirPath);
	// Add directory entry
	const relativePath = getRelativePath(dirPath, basePath);
	if (relativePath) {
		// Don't add root directory itself
		directories.push({
			path: relativePath,
			permissions: getPermissions(stat.mode),
			modified: formatTimestamp(new Date(stat.mtime)),
			created: formatTimestamp(new Date(stat.birthtime || stat.mtime)),
		});
	}
	// Read directory contents
	const glob = new Bun.Glob('*');
	const scannedPaths: string[] = [];
	for await (const entry of glob.scan({ cwd: dirPath, dot: true, onlyFiles: false })) scannedPaths.push(entry);
	// Sort paths alphabetically
	scannedPaths.sort();
	for (const entry of scannedPaths) {
		if (signal?.aborted) throw new CodedError(ErrorCodes.LISH_CREATE_CANCELLED);
		const fullPath = `${dirPath}/${entry}`;
		const stat = await getStats(fullPath);
		// Check if it's a symlink using lstat (lstat does NOT follow symlinks, stat does)
		let isSymlink = false;
		try {
			const lstat = await fsPromises.lstat(fullPath);
			isSymlink = lstat.isSymbolicLink();
		} catch (e) {
			// Can't determine, treat as not a symlink
		}
		if (isSymlink) {
			// Handle symbolic link - read the link target
			try {
				// Unfortunately Bun doesn't expose readlink directly, so we use realpath
				const target = await fsPromises.realpath(fullPath);
				links.push({
					path: getRelativePath(fullPath, basePath),
					target: normalizePath(target),
					modified: formatTimestamp(new Date(stat.mtime)),
					created: formatTimestamp(new Date(stat.birthtime || stat.mtime)),
				});
			} catch (e) {
				console.warn(`Warning: Could not read symlink ${fullPath}`);
			}
		} else if (stat.isDirectory()) {
			// Recursively process subdirectory
			await processDirectory(fullPath, basePath, chunkSize, algo, maxWorkers, directories, files, links, inodeMap, onProgress, signal);
		} else if (stat.isFile()) {
			const inodeKey = `${stat.dev}:${stat.ino}`;
			const relativePath = getRelativePath(fullPath, basePath);
			// Check if this is a hard link to an already processed file
			// Only consider it a hard link if inode is valid (non-zero) and already seen
			if (stat.ino > 0 && inodeMap[inodeKey]) {
				// This is a hard link
				links.push({
					path: relativePath,
					target: inodeMap[inodeKey],
					hardlink: true,
					modified: formatTimestamp(new Date(stat.mtime)),
					created: formatTimestamp(new Date(stat.birthtime || stat.mtime)),
				});
			} else {
				// First occurrence of this inode - process as regular file
				if (stat.ino > 0) inodeMap[inodeKey] = relativePath;
				// Calculate checksums in parallel with progress tracking
				const totalChunks = Math.ceil(stat.size / chunkSize);
				// Progress feedback - file start
				if (onProgress) onProgress({ type: 'file-start', path: relativePath, size: stat.size, chunks: totalChunks });
				// Calculate checksums (skip for empty files)
				let checksums: string[];
				if (stat.size === 0) checksums = [];
				else {
					const calcFn = maxWorkers === 1 ? calculateChecksumsSequential : calculateChecksumsParallel;
					checksums = await calcFn(
						fullPath,
						stat.size,
						chunkSize,
						algo,
						maxWorkers,
						(completed, total) => {
							if (onProgress) onProgress({ type: 'chunk', path: relativePath, current: completed, total });
						},
						signal
					);
				}
				files.push({
					path: relativePath,
					size: stat.size,
					permissions: getPermissions(stat.mode),
					modified: formatTimestamp(new Date(stat.mtime)),
					created: formatTimestamp(new Date(stat.birthtime || stat.mtime)),
					checksums,
				});
				// Progress feedback - file complete
				if (onProgress) onProgress({ type: 'file', path: relativePath });
			}
		}
	}
}

export async function createLISH(inputPath: string, name: string | undefined, chunkSize: number, algo: HashAlgorithm, maxWorkers: number = 0, description?: string, onProgress?: (info: ProgressInfo) => void, id?: string, signal?: AbortSignal): Promise<ILISH> {
	const created = new Date().toISOString();
	const lishID = id || globalThis.crypto.randomUUID();
	const lish: ILISH = {
		id: lishID,
		name,
		description,
		created,
		chunkSize,
		checksumAlgo: algo,
	};
	// Remove optional fields if undefined
	if (!name) delete lish.name;
	if (!description) delete lish.description;
	const stat = await getStats(inputPath);
	if (stat.isFile()) {
		// Single file processing
		const totalChunks = Math.ceil(stat.size / chunkSize);
		// Get filename from path
		const filename = inputPath.split(/[\\/]/).pop() || inputPath;
		// Emit file list before starting checksums
		if (onProgress) onProgress({ type: 'file-list', files: [{ path: filename, size: stat.size, chunks: totalChunks }] });
		// Progress feedback - file start
		if (onProgress) onProgress({ type: 'file-start', path: filename, size: stat.size, chunks: totalChunks });
		// Calculate checksums (skip for empty files)
		let checksums: string[];
		if (stat.size === 0) checksums = [];
		else {
			if (signal?.aborted) throw new CodedError(ErrorCodes.LISH_CREATE_CANCELLED);
			const calcFn = maxWorkers === 1 ? calculateChecksumsSequential : calculateChecksumsParallel;
			checksums = await calcFn(
				inputPath,
				stat.size,
				chunkSize,
				algo,
				maxWorkers,
				(completed, total) => {
					if (onProgress) onProgress({ type: 'chunk', path: filename, current: completed, total });
				},
				signal
			);
		}
		lish.files = [
			{
				path: filename,
				size: stat.size,
				permissions: getPermissions(stat.mode),
				modified: formatTimestamp(new Date(stat.mtime)),
				created: formatTimestamp(new Date(stat.birthtime || stat.mtime)),
				checksums,
			},
		];
		// Progress feedback - file complete
		if (onProgress) onProgress({ type: 'file', path: filename });
	} else if (stat.isDirectory()) {
		// Directory processing
		const directories: IDirectoryEntry[] = [];
		const files: IFileEntry[] = [];
		const links: ILinkEntry[] = [];
		const inodeMap: InodeMap = {};
		// Scan all files first and emit the complete file list
		const scannedFiles = await scanFiles(inputPath, inputPath, chunkSize);
		if (onProgress) onProgress({ type: 'file-list', files: scannedFiles });
		// Now process directory (computes checksums with per-file progress)
		await processDirectory(inputPath, inputPath, chunkSize, algo, maxWorkers, directories, files, links, inodeMap, onProgress, signal);
		// Sort all arrays alphabetically by path
		directories.sort((a, b) => a.path.localeCompare(b.path));
		files.sort((a, b) => a.path.localeCompare(b.path));
		links.sort((a, b) => a.path.localeCompare(b.path));
		// Only add arrays if they have content
		if (directories.length > 0) lish.directories = directories;
		if (files.length > 0) lish.files = files;
		if (links.length > 0) lish.links = links;
	} else throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE);
	return lish;
}
// ============================================================================
// LISH Export / Import / Validation
// ============================================================================

export async function exportLISHToFile(lish: IStoredLISH, outputFilePath: string, minifyJSON: boolean = false, compress: boolean = false, compressionAlgorithm: CompressionAlgorithm = 'gzip'): Promise<void> {
	await fsPromises.mkdir(dirname(outputFilePath), { recursive: true });
	const { directory, chunks, ...exportData } = lish;
	await Utils.writeJSONToFile(exportData, outputFilePath, minifyJSON, compress, compressionAlgorithm);
	console.log(`✓ LISH exported to: ${outputFilePath}`);
}

/**
 * Validate that the given data is a valid ILISH object.
 * Throws a descriptive error if any required field is missing or invalid.
 */
export function validateImportedLISH(data: unknown): ILISH {
	if (!data || typeof data !== 'object') throw new CodedError(ErrorCodes.LISH_INVALID_FORMAT);
	const obj = data as Record<string, unknown>;
	if (typeof obj['id'] !== 'string' || !obj['id']) throw new CodedError(ErrorCodes.LISH_MISSING_ID);
	if (typeof obj['created'] !== 'string' || !obj['created']) throw new CodedError(ErrorCodes.LISH_MISSING_CREATED);
	if (typeof obj['chunkSize'] !== 'number' || obj['chunkSize'] <= 0) throw new CodedError(ErrorCodes.LISH_INVALID_CHUNK_SIZE);
	if (typeof obj['checksumAlgo'] !== 'string' || !(SUPPORTED_ALGOS as readonly string[]).includes(obj['checksumAlgo'])) throw new CodedError(ErrorCodes.LISH_UNSUPPORTED_CHECKSUM, String(obj['checksumAlgo']));
	return data as ILISH;
}

/**
 * Read a .lish/.lishs (or compressed) file and return the parsed ILISH(s).
 * Handles both single objects and arrays.
 */
export async function importLISHFromFile(filePath: string): Promise<ILISH[]> {
	const content = await Utils.readFileCompressed(filePath);
	const data = Utils.safeJSONParse(content, filePath);
	if (Array.isArray(data)) return data.map(item => validateImportedLISH(item));
	return [validateImportedLISH(data)];
}

/**
 * Parse a JSON string into validated ILISH object(s).
 * Handles both single objects and arrays.
 */
export function parseLISHFromJSON(json: string): ILISH[] {
	const data = Utils.safeJSONParse(json, 'JSON input');
	if (Array.isArray(data)) return data.map(item => validateImportedLISH(item));
	return [validateImportedLISH(data)];
}

export interface VerifyFileProgress {
	lishID: string;
	filePath: string;
	verifiedChunks: number;
	done?: boolean;
	reset?: boolean;
}

/**
 * Verify all chunks of a LISH by comparing stored checksums against actual file data.
 * Emits progress events per chunk via onProgress callback.
 */
/**
 * Reset verification state in DB. Call before starting verification.
 */
export function resetVerification(dataServer: DataServer, lishID: string): void {
	const meta = dataServer.get(lishID);
	if (!meta) throw new CodedError(ErrorCodes.LISH_NOT_FOUND, lishID);
	dataServer.resetVerification(lishID);
}

/**
 * Run verification of all chunks (call after resetVerification).
 * Fire & forget — errors are logged, not thrown.
 * Pass an AbortSignal to allow cancellation.
 */
export async function runVerification(dataServer: DataServer, lishID: string, onProgress: (progress: VerifyFileProgress) => void, signal?: AbortSignal): Promise<void> {
	const meta = dataServer.get(lishID);
	if (!meta || !meta.directory) { console.debug(`[Verify] SKIP ${lishID.slice(0, 8)}: no meta or directory`); return; }
	const files = dataServer.getFilesForVerification(lishID);
	if (!files) { console.debug(`[Verify] SKIP ${lishID.slice(0, 8)}: getFilesForVerification returned null`); return; }
	const totalChunks = files.reduce((sum, f) => sum + f.checksums.length, 0);
	console.log(`[Verify] START ${lishID.slice(0, 8)}: ${files.length} files, ${totalChunks} chunks, dir=${meta.directory}`);
	const verifyStart = Date.now();
	let totalVerified = 0;
	let totalFailed = 0;
	let totalMissing = 0;
	let totalBytes = 0;
	for (const fileEntry of files) {
		if (signal?.aborted) { console.debug(`[Verify] ABORTED ${lishID.slice(0, 8)} after ${totalVerified + totalFailed}/${totalChunks} chunks`); return; }
		if (!dataServer.get(lishID)) { console.debug(`[Verify] LISH DELETED ${lishID.slice(0, 8)}`); return; }
		const filePath = join(meta.directory, fileEntry.path);
		let fileVerified = 0;
		let fileFailed = 0;
		const fileStart = Date.now();
		const file = Bun.file(filePath);
		const fileExists = await file.exists();
		if (!fileExists) {
			console.log(`[Verify] MISSING ${fileEntry.path} (${fileEntry.checksums.length} chunks) at ${filePath}`);
			for (let i = 0; i < fileEntry.checksums.length; i++) dataServer.markChunkFailed(lishID, fileEntry.fileInternalID, i);
			totalMissing += fileEntry.checksums.length;
			onProgress({ lishID, filePath: fileEntry.path, verifiedChunks: 0 });
			continue;
		}
		let fileShort = 0;
		for (let chunkIndex = 0; chunkIndex < fileEntry.checksums.length; chunkIndex++) {
			if (signal?.aborted) { console.debug(`[Verify] ABORTED ${lishID.slice(0, 8)} after ${totalVerified + totalFailed}/${totalChunks} chunks`); return; }
			const expectedChecksum = fileEntry.checksums[chunkIndex]!;
			const offset = chunkIndex * meta.chunkSize;
			if (offset >= file.size) {
				dataServer.markChunkFailed(lishID, fileEntry.fileInternalID, chunkIndex);
				fileFailed++;
				fileShort++;
				onProgress({ lishID, filePath: fileEntry.path, verifiedChunks: fileVerified });
				continue;
			}
			try {
				const actualChecksum = await calculateChecksum(file, offset, meta.chunkSize, meta.checksumAlgo);
				if (actualChecksum === expectedChecksum) {
					dataServer.markChunkVerified(lishID, fileEntry.fileInternalID, chunkIndex);
					fileVerified++;
					totalBytes += Math.min(meta.chunkSize, file.size - offset);
				} else {
					dataServer.markChunkFailed(lishID, fileEntry.fileInternalID, chunkIndex);
					fileFailed++;
				}
			} catch (err: any) {
				dataServer.markChunkFailed(lishID, fileEntry.fileInternalID, chunkIndex);
				fileFailed++;
			}
			onProgress({ lishID, filePath: fileEntry.path, verifiedChunks: fileVerified });
		}
		if (fileShort > 0) console.debug(`[Verify] SHORT ${fileEntry.path}: ${fileShort} chunks past EOF`);
		totalVerified += fileVerified;
		totalFailed += fileFailed;
		const fileElapsed = Date.now() - fileStart;
		const fileSizeMB = (file.size / 1024 / 1024).toFixed(1);
		const fileMBs = fileElapsed > 0 ? (file.size / 1024 / 1024 / (fileElapsed / 1000)).toFixed(0) : '∞';
		console.log(`[Verify] FILE ${fileEntry.path}: ${fileVerified}/${fileEntry.checksums.length} pass, ${fileFailed} fail (${fileSizeMB}MB in ${fileElapsed}ms, ${fileMBs}MB/s)`);
	}

	const elapsed = Date.now() - verifyStart;
	const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
	const throughput = elapsed > 0 ? (totalBytes / 1024 / 1024 / (elapsed / 1000)).toFixed(0) : '∞';
	console.log(`[Verify] DONE ${lishID.slice(0, 8)}: ${totalVerified} pass, ${totalFailed} fail, ${totalMissing} missing (${totalMB}MB in ${(elapsed / 1000).toFixed(1)}s, ${throughput}MB/s)`);
	onProgress({ lishID, filePath: '', verifiedChunks: 0, done: true });
}
