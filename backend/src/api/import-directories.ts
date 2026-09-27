import { mkdir, stat, rmdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CodedError, ErrorCodes } from '@shared';

/**
 * Create `dir` and its missing parents one level at a time, without `recursive`, recording in
 * `created` each level this call made. A level that exists already (`EEXIST`) is not ours.
 */
export async function makeOwnDirectories(dir: string, created: string[]): Promise<void> {
	const missing: string[] = [];
	for (let current = resolve(dir); ;) {
		try {
			if (!(await stat(current)).isDirectory()) throw new CodedError(ErrorCodes.FS_NOT_DIRECTORY, current);
			break;
		} catch (error: any) {
			if (error?.code !== 'ENOENT') throw error;
			missing.unshift(current);
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	for (const level of missing) {
		try {
			await mkdir(level);
			created.push(level);
		} catch (error: any) {
			if (error?.code !== 'EEXIST') throw error;
			if (!(await stat(level)).isDirectory()) throw new CodedError(ErrorCodes.FS_NOT_DIRECTORY, level);
		}
	}
}

/**
 * Remove the directories an import created, deepest first, each only while empty.
 * Non-recursive: a directory something else has put content in, or a link, stops the walk.
 */
export async function removeOwnEmptyDirectories(created: readonly string[]): Promise<void> {
	for (const dir of [...created].reverse()) {
		try {
			await rmdir(dir);
		} catch (error: any) {
			console.warn(`[Import] Kept ${dir} after a failed import: ${error?.code ?? error?.message ?? error}`);
			return;
		}
	}
}
