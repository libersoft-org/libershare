import { readdir, stat, access, unlink, rmdir, mkdir, rename } from 'fs/promises';
import { join, sep, dirname } from 'path';
import { homedir, platform } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
export interface FsEntry {
	name: string;
	path: string;
	type: 'file' | 'directory' | 'drive';
	size?: number;
	modified?: string;
	hidden?: boolean;
}
export interface FsInfo {
	platform: 'windows' | 'linux' | 'darwin';
	separator: string;
	home: string;
	roots: string[];
}
export interface FsListResult {
	path: string;
	entries: FsEntry[];
}
const isWindows = platform() === 'win32';

async function getWindowsDrives(): Promise<FsEntry[]> {
	const drives: FsEntry[] = [];
	const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	for (const letter of letters) {
		const drivePath = `${letter}:\\`;
		try {
			await access(drivePath);
			drives.push({
				name: `${letter}:`,
				path: drivePath,
				type: 'drive',
			});
		} catch {
			// Drive doesn't exist or isn't accessible
		}
	}
	return drives;
}

export async function fsInfo(): Promise<FsInfo> {
	const plat = platform();
	const roots = isWindows ? (await getWindowsDrives()).map(d => d.path) : ['/'];
	return {
		platform: plat === 'win32' ? 'windows' : plat === 'darwin' ? 'darwin' : 'linux',
		separator: sep,
		home: homedir(),
		roots,
	};
}

export async function fsList(path?: string): Promise<FsListResult> {
	// Handle root/empty path
	if (!path || path === '') {
		if (isWindows) {
			return {
				path: '',
				entries: await getWindowsDrives(),
			};
		} else path = '/';
	}
	const entries: FsEntry[] = [];
	const dirents = await readdir(path, { withFileTypes: true });
	for (const dirent of dirents) {
		const entryPath = join(path, dirent.name);
		const entry: FsEntry = {
			name: dirent.name,
			path: entryPath,
			type: dirent.isDirectory() ? 'directory' : 'file',
			hidden: dirent.name.startsWith('.'),
		};
		try {
			const stats = await stat(entryPath);
			entry.size = stats.size;
			entry.modified = stats.mtime.toISOString();
		} catch {
			// Can't stat, skip metadata
		}
		entries.push(entry);
	}
	// Sort: directories first, then alphabetically
	entries.sort((a, b) => {
		if (a.type === 'directory' && b.type !== 'directory') return -1;
		if (a.type !== 'directory' && b.type === 'directory') return 1;
		return a.name.localeCompare(b.name);
	});
	return { path, entries };
}

const execAsync = promisify(exec);
export async function fsDelete(path: string): Promise<void> {
	const stats = await stat(path);
	if (stats.isDirectory()) await rmdir(path, { recursive: true });
	else await unlink(path);
}

export async function fsMkdir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

export async function fsOpen(path: string): Promise<void> {
	if (isWindows) await execAsync(`start "" "${path}"`);
	else if (platform() === 'darwin') await execAsync(`open "${path}"`);
	else await execAsync(`xdg-open "${path}"`);
}

export async function fsRename(oldPath: string, newName: string): Promise<void> {
	const dir = dirname(oldPath);
	const newPath = join(dir, newName);
	await rename(oldPath, newPath);
}

export async function fsExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function fsWriteText(path: string, content: string): Promise<void> {
	await Bun.write(path, content);
}

export async function fsReadText(path: string): Promise<string> {
	const file = Bun.file(path);
	return await file.text();
}
