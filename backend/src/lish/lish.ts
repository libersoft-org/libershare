import * as fsPromises from 'node:fs/promises';
import { type Stats } from 'node:fs';
import { type HashAlgorithm, type ILISH, type IDirectoryEntry, type IFileEntry, type ILinkEntry } from '@shared';
import { calculateChecksum } from './checksum.ts';
export const LISH_VERSION = 1;

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
		throw new Error(`Cannot access path: ${fullPath}`);
	}
}

// Calculate checksums sequentially (single-threaded, no worker overhead)
async function calculateChecksumsSequential(filePath: string, fileSize: number, chunkSize: number, algo: HashAlgorithm, _maxWorkers: number, onProgress?: (completed: number, total: number) => void): Promise<string[]> {
	const totalChunks = Math.ceil(fileSize / chunkSize);
	const file = Bun.file(filePath);
	const results: string[] = [];
	for (let i = 0; i < totalChunks; i++) {
		const checksum = await calculateChecksum(file, i * chunkSize, chunkSize, algo);
		results.push(checksum);
		if (onProgress) onProgress(i + 1, totalChunks);
	}
	return results;
}

// Calculate checksums in parallel using workers
async function calculateChecksumsParallel(filePath: string, fileSize: number, chunkSize: number, algo: HashAlgorithm, maxWorkers: number, onProgress?: (completed: number, total: number) => void): Promise<string[]> {
	const totalChunks = Math.ceil(fileSize / chunkSize);
	const cpuCount = maxWorkers > 0 ? maxWorkers : navigator.hardwareConcurrency || 1;
	const workerCount = Math.min(cpuCount, totalChunks);
	// Create workers
	const workers: Worker[] = [];
	for (let i = 0; i < workerCount; i++) {
		workers.push(new Worker(new URL('./checksum-worker.ts', import.meta.url).href));
	}
	let completedChunks = 0;
	const results: string[] = new Array(totalChunks);
	let nextChunk = 0;

	// Process chunks by feeding workers one at a time
	await new Promise<void>((resolveAll, rejectAll) => {
		let finished = false;
		function feedWorker(workerIndex: number): void {
			if (finished) return;
			if (nextChunk >= totalChunks) return;
			const chunkIndex = nextChunk++;
			const offset = chunkIndex * chunkSize;
			const worker = workers[workerIndex]!;
			function handler(event: MessageEvent): void {
				if (event.data.index === chunkIndex) {
					worker.removeEventListener('message', handler);
					if (event.data.error) {
						finished = true;
						rejectAll(new Error(event.data.error));
						return;
					}
					results[chunkIndex] = event.data.checksum;
					completedChunks++;
					if (onProgress) onProgress(completedChunks, totalChunks);
					if (completedChunks === totalChunks) {
						resolveAll();
					} else {
						feedWorker(workerIndex);
					}
				}
			}
			worker.addEventListener('message', handler);
			worker.postMessage({ filePath, offset, chunkSize, algo, index: chunkIndex });
		}
		// Start one chunk per worker
		for (let i = 0; i < workerCount; i++) {
			feedWorker(i);
		}
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
	for await (const entry of glob.scan({ cwd: dirPath, dot: true, onlyFiles: false })) {
		scannedPaths.push(entry);
	}
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
		if (isSymlink) {
			continue;
		} else if (stat.isDirectory()) {
			const subFiles = await scanFiles(fullPath, basePath, chunkSize, inodeMap);
			result.push(...subFiles);
		} else if (stat.isFile()) {
			const inodeKey = `${stat.dev}:${stat.ino}`;
			// Skip hard links (already seen inode)
			if (stat.ino > 0 && inodeMap[inodeKey]) {
				continue;
			}
			if (stat.ino > 0) inodeMap[inodeKey] = true;
			const relativePath = getRelativePath(fullPath, basePath);
			const totalChunks = Math.ceil(stat.size / chunkSize);
			result.push({ path: relativePath, size: stat.size, chunks: totalChunks });
		}
	}
	return result;
}

type ProgressInfo = { type: 'file-list'; files: { path: string; size: number; chunks: number }[] } | { type: 'file-start'; path: string; size: number; chunks: number } | { type: 'chunk'; path: string; current: number; total: number } | { type: 'file'; path: string };

async function processDirectory(dirPath: string, basePath: string, chunkSize: number, algo: HashAlgorithm, maxWorkers: number, directories: IDirectoryEntry[], files: IFileEntry[], links: ILinkEntry[], inodeMap: InodeMap, onProgress?: (info: ProgressInfo) => void): Promise<void> {
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
	for await (const entry of glob.scan({ cwd: dirPath, dot: true, onlyFiles: false })) {
		scannedPaths.push(entry);
	}
	// Sort paths alphabetically
	scannedPaths.sort();
	for (const entry of scannedPaths) {
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
			await processDirectory(fullPath, basePath, chunkSize, algo, maxWorkers, directories, files, links, inodeMap, onProgress);
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
				// Calculate checksums (sequential for 1 thread, parallel for multiple)
				const calcFn = maxWorkers === 1 ? calculateChecksumsSequential : calculateChecksumsParallel;
				const checksums = await calcFn(fullPath, stat.size, chunkSize, algo, maxWorkers, (completed, total) => {
					if (onProgress) onProgress({ type: 'chunk', path: relativePath, current: completed, total });
				});
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

export async function createLISH(inputPath: string, name: string | undefined, chunkSize: number, algo: HashAlgorithm, maxWorkers: number = 0, description?: string, onProgress?: (info: ProgressInfo) => void, id?: string): Promise<ILISH> {
	const created = new Date().toISOString();
	const lishId = id || globalThis.crypto.randomUUID();
	const lish: ILISH = {
		version: LISH_VERSION,
		id: lishId,
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
		// Calculate checksums (sequential for 1 thread, parallel for multiple)
		const calcFn = maxWorkers === 1 ? calculateChecksumsSequential : calculateChecksumsParallel;
		const checksums = await calcFn(inputPath, stat.size, chunkSize, algo, maxWorkers, (completed, total) => {
			if (onProgress) onProgress({ type: 'chunk', path: filename, current: completed, total });
		});
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
		await processDirectory(inputPath, inputPath, chunkSize, algo, maxWorkers, directories, files, links, inodeMap, onProgress);
		// Sort all arrays alphabetically by path
		directories.sort((a, b) => a.path.localeCompare(b.path));
		files.sort((a, b) => a.path.localeCompare(b.path));
		links.sort((a, b) => a.path.localeCompare(b.path));
		// Only add arrays if they have content
		if (directories.length > 0) lish.directories = directories;
		if (files.length > 0) lish.files = files;
		if (links.length > 0) lish.links = links;
	} else throw new Error('Input must be a file or directory');
	return lish;
}
