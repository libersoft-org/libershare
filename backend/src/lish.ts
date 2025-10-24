export interface IManifest {
	version: number;
	id: string;
	created: string;
	chunkSize: number;
	checksumAlgo: HashAlgorithm;
	description?: string;
	directories?: IDirectoryEntry[];
	files?: IFileEntry[];
	links?: ILinkEntry[];
}
export interface IDirectoryEntry {
	path: string;
	mode: number;
	modified?: string;
	created?: string;
}
export interface IFileEntry {
	path: string;
	size: number;
	mode: number;
	modified?: string;
	created?: string;
	checksums: string[];
}
export interface ILinkEntry {
	path: string;
	target: string;
	hardlink?: boolean;
	modified?: string;
	created?: string;
}
export const SUPPORTED_ALGOS = ['sha256', 'sha512', 'blake2b256', 'blake2b512', 'blake2s256', 'shake128', 'shake256'] as const;
export type HashAlgorithm = (typeof SUPPORTED_ALGOS)[number];
export const MANIFEST_VERSION = 1;
export const DEFAULT_CHUNK_SIZE = 5242880; // 5 MB
export const DEFAULT_ALGO: HashAlgorithm = 'sha256';

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

// Helper to get file/directory stats
async function getStats(fullPath: string) {
	try {
		const stat = await Bun.file(fullPath).stat();
		return stat;
	} catch (e) {
		throw new Error(`Cannot access path: ${fullPath}`);
	}
}

async function calculateChecksum(file: ReturnType<typeof Bun.file>, offset: number, chunkSize: number, algo: HashAlgorithm): Promise<string> {
	const end = Math.min(offset + chunkSize, file.size);
	const chunk = file.slice(offset, end);
	const buffer = await chunk.arrayBuffer();
	const hasher = new Bun.CryptoHasher(algo as any);
	hasher.update(buffer);
	return hasher.digest('hex');
}

// Track inodes to detect hard links
interface InodeMap {
	[inode: string]: string; // inode -> first file path encountered
}

async function processDirectory(dirPath: string, basePath: string, chunkSize: number, algo: HashAlgorithm, directories: IDirectoryEntry[], files: IFileEntry[], links: ILinkEntry[], inodeMap: InodeMap, onProgress?: (info: { type: 'file' | 'chunk' | 'file-start'; path?: string; current?: number; total?: number; size?: number; chunks?: number }) => void): Promise<void> {
	const stat = await getStats(dirPath);
	// Add directory entry
	const relativePath = getRelativePath(dirPath, basePath);
	if (relativePath) {
		// Don't add root directory itself
		directories.push({
			path: relativePath,
			mode: stat.mode,
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
		// Check if it's a symlink by comparing realpath
		let isSymlink = false;
		try {
			const realPath = await Bun.file(fullPath).realpath();
			isSymlink = normalizePath(realPath) !== normalizePath(fullPath);
		} catch (e) {
			// Not a symlink or can't determine
		}
		if (isSymlink) {
			// Handle symbolic link - read the link target
			try {
				// Unfortunately Bun doesn't expose readlink directly, so we use realpath
				const target = await Bun.file(fullPath).realpath();
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
			await processDirectory(fullPath, basePath, chunkSize, algo, directories, files, links, inodeMap, onProgress);
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
				if (stat.ino > 0) {
					inodeMap[inodeKey] = relativePath;
				}
				// Calculate checksums
				const file = Bun.file(fullPath);
				const totalChunks = Math.ceil(stat.size / chunkSize);
				const checksums: string[] = [];
				// Progress feedback - file start
				if (onProgress) onProgress({ type: 'file-start', path: relativePath, size: stat.size, chunks: totalChunks });
				for (let offset = 0; offset < stat.size; offset += chunkSize) {
					const chunkIndex = Math.floor(offset / chunkSize) + 1;
					const checksum = await calculateChecksum(file, offset, chunkSize, algo);
					checksums.push(checksum);
					// Progress feedback - chunk processed
					if (onProgress) onProgress({ type: 'chunk', path: relativePath, current: chunkIndex, total: totalChunks });
				}
				files.push({
					path: relativePath,
					size: stat.size,
					mode: stat.mode,
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

export async function createManifest(inputPath: string, chunkSize: number, algo: HashAlgorithm, description?: string, onProgress?: (info: { type: 'file' | 'chunk' | 'file-start'; path?: string; current?: number; total?: number; size?: number; chunks?: number }) => void): Promise<IManifest> {
	const created = new Date().toISOString();
	const id = globalThis.crypto.randomUUID();
	const manifest: IManifest = {
		version: MANIFEST_VERSION,
		id,
		created,
		chunkSize,
		checksumAlgo: algo,
	};
	if (description) manifest.description = description;
	const stat = await getStats(inputPath);
	if (stat.isFile()) {
		// Single file processing
		const file = Bun.file(inputPath);
		const totalChunks = Math.ceil(stat.size / chunkSize);
		const checksums: string[] = [];
		for (let offset = 0; offset < stat.size; offset += chunkSize) {
			const chunkIndex = Math.floor(offset / chunkSize) + 1;
			const checksum = await calculateChecksum(file, offset, chunkSize, algo);
			checksums.push(checksum);
			if (onProgress) onProgress({ type: 'chunk', current: chunkIndex, total: totalChunks });
		}
		// Get filename from path
		const filename = inputPath.split(/[\\/]/).pop() || inputPath;
		manifest.files = [
			{
				path: filename,
				size: stat.size,
				mode: stat.mode,
				modified: formatTimestamp(new Date(stat.mtime)),
				created: formatTimestamp(new Date(stat.birthtime || stat.mtime)),
				checksums,
			},
		];
	} else if (stat.isDirectory()) {
		// Directory processing
		const directories: IDirectoryEntry[] = [];
		const files: IFileEntry[] = [];
		const links: ILinkEntry[] = [];
		const inodeMap: InodeMap = {};
		await processDirectory(inputPath, inputPath, chunkSize, algo, directories, files, links, inodeMap, onProgress);
		// Sort all arrays alphabetically by path
		directories.sort((a, b) => a.path.localeCompare(b.path));
		files.sort((a, b) => a.path.localeCompare(b.path));
		links.sort((a, b) => a.path.localeCompare(b.path));
		// Only add arrays if they have content
		if (directories.length > 0) manifest.directories = directories;
		if (files.length > 0) manifest.files = files;
		if (links.length > 0) manifest.links = links;
	} else throw new Error('Input must be a file or directory');
	return manifest;
}
