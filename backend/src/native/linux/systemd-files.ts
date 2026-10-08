import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { posix } from 'node:path';

const ROOTS = ['/etc', '/run', '/usr/local/lib', '/usr/lib'];
const CONFIG = 'systemd/timesyncd.conf';

export interface SystemdConfigFilesystem {
	readonly list: (path: string) => Promise<string[]>;
	readonly read: (path: string) => Promise<string>;
	readonly resolve: (path: string) => Promise<string>;
	readonly inspect: (path: string) => Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
}

const filesystem: SystemdConfigFilesystem = { list: readdir, read: path => readFile(path, 'utf8'), resolve: realpath, inspect: lstat };

/** Preserves file boundaries and physical lines for parseTimesyncConfig. */
export async function readTimesyncdConfiguration(roots: readonly string[] = ROOTS, fs: SystemdConfigFilesystem = filesystem): Promise<string> {
	let main: string | undefined;
	for (const root of roots) {
		const path = posix.join(root, CONFIG);
		try {
			await fs.inspect(path);
			main = path;
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
	const dropIns = new Map<string, string>();
	for (const root of roots) {
		const directory = posix.join(root, `${CONFIG}.d`);
		let names: string[];
		try {
			names = await fs.list(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw error;
		}
		for (const name of names) if (name.endsWith('.conf') && !dropIns.has(name)) dropIns.set(name, posix.join(directory, name));
	}
	const paths = [...(main ? [main] : []), ...[...dropIns.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(name => dropIns.get(name)!)];
	const output: string[] = [];
	for (const path of paths) {
		const resolved = await fs.resolve(path);
		if (resolved === '/dev/null') {
			output.push(`# ${path}\n`);
			continue;
		}
		if (!(await fs.inspect(resolved)).isFile()) throw new Error('The effective timesyncd configuration is not a regular file');
		output.push(`# ${path}\n${await fs.read(resolved)}\n`);
	}
	return output.join('\n');
}
