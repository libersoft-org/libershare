import { readdir, stat, access, unlink, rmdir, mkdir as fsMkdirNode, rename as fsRenameNode } from 'fs/promises';
import { join, sep, dirname } from 'path';
import { homedir, platform } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const isWindows = platform() === 'win32';
const execAsync = promisify(exec);

async function getWindowsDrives() {
	const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	const results = await Promise.allSettled(
		[...letters].map(letter => access(`${letter}:\\`).then(() => letter)),
	);
	return results
		.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
		.map(r => ({ name: `${r.value}:`, path: `${r.value}:\\`, type: 'drive' as const }));
}

type P = Record<string, any>;

export function initFsHandlers() {
	const info = async () => {
		const plat = platform();
		const roots = isWindows ? (await getWindowsDrives()).map(d => d.path) : ['/'];
		return {
			platform: plat === 'win32' ? 'windows' : plat === 'darwin' ? 'darwin' : 'linux',
			separator: sep,
			home: homedir(),
			roots,
		};
	};

	const list = async (p: P) => {
		let path = p.path;
		if (!path || path === '') {
			if (isWindows) return { path: '', entries: await getWindowsDrives() };
			else path = '/';
		}
		const entries: any[] = [];
		const dirents = await readdir(path, { withFileTypes: true });
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
	};

	const readText = async (p: P) => {
		const file = Bun.file(p.path);
		return { content: await file.text() };
	};

	const readGzip = async (p: P) => {
		const compressed = await Bun.file(p.path).arrayBuffer();
		const decompressed = Bun.gunzipSync(new Uint8Array(compressed));
		return { content: new TextDecoder().decode(decompressed) };
	};

	const del = async (p: P) => {
		const stats = await stat(p.path);
		if (stats.isDirectory()) {
			const { rm } = await import('fs/promises');
			await rm(p.path, { recursive: true });
		} else await unlink(p.path);
	};

	const mkdirFn = async (p: P) => {
		await fsMkdirNode(p.path, { recursive: true });
	};

	const open = async (p: P) => {
		if (isWindows) await execAsync(`start "" "${p.path}"`);
		else if (platform() === 'darwin') await execAsync(`open "${p.path}"`);
		else await execAsync(`xdg-open "${p.path}"`);
	};

	const renameFn = async (p: P) => {
		const dir = dirname(p.path);
		const newPath = join(dir, p.newName);
		await fsRenameNode(p.path, newPath);
	};

	const exists = async (p: P) => {
		try {
			await access(p.path);
			return { exists: true };
		} catch {
			return { exists: false };
		}
	};

	const writeText = async (p: P) => {
		await Bun.write(p.path, p.content);
		return { success: true };
	};

	const writeGzip = async (p: P) => {
		const compressed = Bun.gzipSync(Buffer.from(p.content, 'utf-8'));
		await Bun.write(p.path, compressed);
		return { success: true };
	};

	return { info, list, readText, readGzip, delete: del, mkdir: mkdirFn, open, rename: renameFn, exists, writeText, writeGzip };
}
