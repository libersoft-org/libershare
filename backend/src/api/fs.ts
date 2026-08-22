import { readdir, stat, access, unlink, mkdir as fsMkdirNode, rename as fsRenameNode } from 'fs/promises';
import { join, sep, dirname, resolve } from 'path';
import { homedir, platform } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Utils } from '../utils.ts';
import { CodedError, ErrorCodes, detectCompression, type ErrorCode, type FsInfo, type FsEntry, type FsListResult, type IPathExistsResult, type SuccessResponse, type CompressionAlgorithm } from '@shared';
import { isContainer } from '../container.ts';
const assert = Utils.assertParams;
const isWindows = platform() === 'win32';
const execFileAsync = promisify(execFile);

// Map Node.js errno codes → CodedError codes for the frontend.
const ERRNO_MAP: Record<string, ErrorCode> = {
	ENOENT: ErrorCodes.FS_NOT_FOUND,
	EACCES: ErrorCodes.FS_ACCESS_DENIED,
	EPERM: ErrorCodes.FS_NOT_PERMITTED,
	EEXIST: ErrorCodes.FS_ALREADY_EXISTS,
	ENOTEMPTY: ErrorCodes.FS_NOT_EMPTY,
	EISDIR: ErrorCodes.FS_IS_DIRECTORY,
	ENOTDIR: ErrorCodes.FS_NOT_DIRECTORY,
	EBUSY: ErrorCodes.FS_BUSY,
	ENOSPC: ErrorCodes.FS_NO_SPACE,
	EROFS: ErrorCodes.FS_READ_ONLY,
	ENAMETOOLONG: ErrorCodes.FS_NAME_TOO_LONG,
	EMFILE: ErrorCodes.FS_TOO_MANY_OPEN,
	ENFILE: ErrorCodes.FS_TOO_MANY_OPEN,
	EINVAL: ErrorCodes.FS_INVALID,
	EXDEV: ErrorCodes.FS_CROSS_DEVICE,
	ENOTSUP: ErrorCodes.FS_NOT_SUPPORTED,
	EOPNOTSUPP: ErrorCodes.FS_NOT_SUPPORTED,
	EIO: ErrorCodes.FS_IO,
	ELOOP: ErrorCodes.FS_TOO_MANY_LINKS,
	EFBIG: ErrorCodes.FS_FILE_TOO_LARGE,
	ETIMEDOUT: ErrorCodes.FS_TIMEOUT,
};

function wrapFsError(err: any, path?: string): CodedError {
	if (err instanceof CodedError) return err;
	const errno: string | undefined = err?.code;
	const code: ErrorCode = (errno && ERRNO_MAP[errno]) || ErrorCodes.FS_ERROR;
	const detail = path ? `${errno ?? 'error'}: ${path}` : (err?.message ?? String(err));
	return new CodedError(code, detail);
}

/** Re-indent a JSON document with tabs; non-JSON content is returned untouched. */
function prettyPrintJSON(content: string): string {
	try {
		return JSON.stringify(JSON.parse(content), null, '\t');
	} catch {
		return content;
	}
}

async function fsCall<T>(path: string | undefined, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err: any) {
		throw wrapFsError(err, path);
	}
}

async function getWindowsDrives(): Promise<FsEntry[]> {
	const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	const results = await Promise.allSettled([...letters].map(letter => access(`${letter}:\\`).then(() => letter)));
	return results.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled').map(r => ({ name: `${r.value}:`, path: `${r.value}:\\`, type: 'drive' as const }));
}

interface FsHandlers {
	info: (p: any, client?: any) => Promise<FsInfo>;
	list: (p: { path?: string }) => Promise<FsListResult>;
	readText: (p: { path: string }) => Promise<{ content: string }>;
	readCompressed: (p: { path: string; algorithm?: CompressionAlgorithm; prettyJSON?: boolean }) => Promise<{ content: string }>;
	decompressText: (p: { data: string; fileName?: string; algorithm?: CompressionAlgorithm; prettyJSON?: boolean }) => Promise<{ content: string }>;
	delete: (p: { path: string }) => Promise<void>;
	mkdir: (p: { path: string }) => Promise<void>;
	open: (p: { path: string }) => Promise<void>;
	rename: (p: { path: string; newName: string }) => Promise<void>;
	exists: (p: { path: string }) => Promise<IPathExistsResult>;
	writeText: (p: { path: string; content: string }) => Promise<SuccessResponse>;
	writeCompressed: (p: { path: string; content: string; algorithm?: CompressionAlgorithm }) => Promise<SuccessResponse>;
}

export function initFsHandlers(): FsHandlers {
	async function info(_p: any, client?: any): Promise<FsInfo> {
		const plat = platform();
		const roots = isWindows ? (await getWindowsDrives()).map(d => d.path) : ['/'];
		const isLocal = client?.data?.isLocalClient ?? false;
		const inContainer = await isContainer();
		return {
			platform: plat === 'win32' ? 'windows' : plat === 'darwin' ? 'darwin' : 'linux',
			separator: sep,
			home: homedir(),
			roots,
			localFilesystem: isLocal && !inContainer,
		};
	}

	async function list(p: { path?: string }): Promise<FsListResult> {
		let path = p.path;
		if (!path || path === '') {
			if (isWindows) return { path: '', entries: await getWindowsDrives() };
			else path = '/';
		}
		// Windows: bare drive letter (e.g. "C:") needs trailing backslash for readdir
		if (isWindows && /^[A-Z]:$/i.test(path)) path += '\\';
		const entries: any[] = [];
		let dirents;
		try {
			dirents = await readdir(path, { withFileTypes: true });
		} catch (err: any) {
			// Permission errors on listing are returned as a soft error in the result so the UI can show an inline notice.
			if (err?.code === 'EPERM' || err?.code === 'EACCES') return { path, entries: [], error: `Permission denied: ${path}` };
			throw wrapFsError(err, path);
		}
		for (const dirent of dirents) {
			const entryPath = join(path, dirent.name);
			const entry: any = {
				name: dirent.name,
				path: entryPath,
				type: dirent.isDirectory() ? 'directory' : 'file',
				hidden: dirent.name.startsWith('.'),
			};
			try {
				const stats = await stat(entryPath);
				entry.size = stats.size;
				entry.modified = stats.mtime.toISOString();
			} catch {}
			entries.push(entry);
		}
		entries.sort((a: any, b: any) => {
			if (a.type === 'directory' && b.type !== 'directory') return -1;
			if (a.type !== 'directory' && b.type === 'directory') return 1;
			return a.name.localeCompare(b.name);
		});
		return { path, entries };
	}

	async function readText(p: { path: string }): Promise<{ content: string }> {
		assert(p, ['path']);
		return fsCall(p.path, async () => {
			const file = Bun.file(p.path);
			return { content: await file.text() };
		});
	}

	/**
	 * Read a file, decompressing it when the path (or the explicit `algorithm`)
	 * says it is compressed. With `prettyJSON` the JSON body is re-indented,
	 * so the frontend never has to parse or re-serialise it for display.
	 */
	async function readCompressed(p: { path: string; algorithm?: CompressionAlgorithm; prettyJSON?: boolean }): Promise<{ content: string }> {
		assert(p, ['path']);
		return fsCall(p.path, async () => {
			const content = await Utils.readFileCompressed(p.path, p.algorithm);
			return { content: p.prettyJSON ? prettyPrintJSON(content) : content };
		});
	}

	/**
	 * Decompress a base64-encoded file uploaded from the client's own machine.
	 * The algorithm is taken from `algorithm`, else detected from `fileName`;
	 * an uncompressed upload is returned as-is.
	 */
	async function decompressText(p: { data: string; fileName?: string; algorithm?: CompressionAlgorithm; prettyJSON?: boolean }): Promise<{ content: string }> {
		assert(p, ['data']);
		const bytes = Buffer.from(p.data, 'base64');
		const algorithm = p.algorithm ?? detectCompression(p.fileName ?? '');
		const decoded = algorithm ? Utils.decompress(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), algorithm) : bytes;
		const content = new TextDecoder().decode(decoded);
		return { content: p.prettyJSON ? prettyPrintJSON(content) : content };
	}

	async function del(p: { path: string }): Promise<void> {
		assert(p, ['path']);
		return fsCall(p.path, async () => {
			const stats = await stat(p.path);
			if (stats.isDirectory()) {
				const { rm } = await import('fs/promises');
				await rm(p.path, { recursive: true });
			} else await unlink(p.path);
		});
	}

	async function mkdirFn(p: { path: string }): Promise<void> {
		assert(p, ['path']);
		return fsCall(p.path, () => fsMkdirNode(p.path, { recursive: true }).then(() => undefined));
	}

	async function open(p: { path: string }): Promise<void> {
		assert(p, ['path']);
		return fsCall(p.path, async () => {
			// execFile (no shell) — the path is passed as an argument, never parsed by a shell.
			// resolve() also neutralizes a leading "-" being read as an option by open/xdg-open.
			const target = resolve(p.path);
			if (isWindows) {
				// cmd's `start` parses metacharacters (&, ^) even via execFile, so use PowerShell.
				// Single-quoted PS strings have no escapes except '' — and " is illegal in Windows paths.
				const psPath = target.replace(/'/g, "''");
				await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `Invoke-Item -LiteralPath '${psPath}'`]);
			} else if (platform() === 'darwin') await execFileAsync('open', [target]);
			else await execFileAsync('xdg-open', [target]);
		});
	}

	async function renameFn(p: { path: string; newName: string }): Promise<void> {
		assert(p, ['path', 'newName']);
		const dir = dirname(p.path);
		const newPath = join(dir, p.newName);
		return fsCall(p.path, () => fsRenameNode(p.path, newPath));
	}

	async function exists(p: { path: string }): Promise<IPathExistsResult> {
		assert(p, ['path']);
		try {
			const s = await stat(p.path);
			return { exists: true, type: s.isDirectory() ? 'directory' : 'file' };
		} catch {
			return { exists: false };
		}
	}

	async function writeText(p: { path: string; content: string }): Promise<SuccessResponse> {
		assert(p, ['path', 'content']);
		return fsCall(p.path, async () => {
			await Bun.write(p.path, p.content);
			return { success: true };
		});
	}

	async function writeCompressed(p: { path: string; content: string; algorithm?: CompressionAlgorithm }): Promise<SuccessResponse> {
		assert(p, ['path', 'content']);
		return fsCall(p.path, async () => {
			const compressed = Utils.compress(Buffer.from(p.content, 'utf-8'), p.algorithm);
			await Bun.write(p.path, compressed);
			return { success: true };
		});
	}

	return { info, list, readText, readCompressed, decompressText, delete: del, mkdir: mkdirFn, open, rename: renameFn, exists, writeText, writeCompressed };
}
