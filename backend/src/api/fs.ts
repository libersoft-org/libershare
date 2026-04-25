import { readdir, stat, access, unlink, mkdir as fsMkdirNode, rename as fsRenameNode } from 'fs/promises';
import { join, sep, dirname } from 'path';
import { homedir, platform } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Utils } from '../utils.ts';
import { CodedError, ErrorCodes, type ErrorCode, type FsInfo, type FsEntry, type FsListResult, type SuccessResponse, type CompressionAlgorithm } from '@shared';
import { isContainer } from '../container.ts';
const assert = Utils.assertParams;
const isWindows = platform() === 'win32';
const execAsync = promisify(exec);

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
	readCompressed: (p: { path: string; algorithm?: CompressionAlgorithm }) => Promise<{ content: string }>;
	delete: (p: { path: string }) => Promise<void>;
	mkdir: (p: { path: string }) => Promise<void>;
	open: (p: { path: string }) => Promise<void>;
	rename: (p: { path: string; newName: string }) => Promise<void>;
	exists: (p: { path: string }) => Promise<{ exists: boolean; type?: 'file' | 'directory' }>;
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

	async function readCompressed(p: { path: string; algorithm?: CompressionAlgorithm }): Promise<{ content: string }> {
		assert(p, ['path']);
		return fsCall(p.path, async () => {
			const compressed = await Bun.file(p.path).arrayBuffer();
			const decompressed = Utils.decompress(new Uint8Array(compressed), p.algorithm);
			return { content: new TextDecoder().decode(decompressed) };
		});
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
			if (isWindows) await execAsync(`start "" "${p.path}"`);
			else if (platform() === 'darwin') await execAsync(`open "${p.path}"`);
			else await execAsync(`xdg-open "${p.path}"`);
		});
	}

	async function renameFn(p: { path: string; newName: string }): Promise<void> {
		assert(p, ['path', 'newName']);
		const dir = dirname(p.path);
		const newPath = join(dir, p.newName);
		return fsCall(p.path, () => fsRenameNode(p.path, newPath));
	}

	async function exists(p: { path: string }): Promise<{ exists: boolean; type?: 'file' | 'directory' }> {
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

	return { info, list, readText, readCompressed, delete: del, mkdir: mkdirFn, open, rename: renameFn, exists, writeText, writeCompressed };
}
