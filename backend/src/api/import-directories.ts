import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CodedError, ErrorCodes } from '@shared';

/** A directory an import made: its path and the identity it had right after `mkdir`. */
export interface CreatedDirectory {
	readonly path: string;
	readonly dev: bigint;
	readonly ino: bigint;
}

/**
 * Create `dir` and its missing parents one level at a time, without `recursive`, recording in
 * `created` each level this call made. A level that exists already (`EEXIST`) is not ours.
 */
export async function makeOwnDirectories(dir: string, created: CreatedDirectory[]): Promise<void> {
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
		} catch (error: any) {
			if (error?.code !== 'EEXIST') throw error;
			if (!(await stat(level)).isDirectory()) throw new CodedError(ErrorCodes.FS_NOT_DIRECTORY, level);
			continue;
		}
		const { dev, ino } = await lstat(level, { bigint: true });
		created.push({ path: level, dev, ino });
	}
}

/**
 * Remove the directories an import created, deepest first, each only while empty and only while
 * the path still leads to the very directory that was made. The path alone proves nothing: the
 * directory, or one of its parents, can be renamed or swapped for a link in the meantime.
 */
export async function removeOwnEmptyDirectories(created: readonly CreatedDirectory[]): Promise<void> {
	for (const dir of [...created].reverse()) {
		try {
			await removeIfStillOwn(dir);
		} catch (error: any) {
			console.warn(`[Import] Kept ${dir.path} after a failed import: ${error?.code ?? error?.message ?? error}`);
			return;
		}
	}
}

async function removeIfStillOwn(dir: CreatedDirectory): Promise<void> {
	if (!(await isSame(dir.path, dir))) throw new Error('replaced since it was created');
	// Checking the path and then removing it would leave a gap in which it can be swapped.
	// Rename first: the rename is atomic, so whatever now sits under the random name is what the
	// check below sees, and a parent swapped afterwards resolves to a tree without that name.
	const parked = join(dirname(dir.path), `.${basename(dir.path)}.${randomUUID()}.removing`);
	await rename(dir.path, parked);
	try {
		if (!(await isSame(parked, dir))) throw new Error('replaced while being removed');
		await rmdir(parked);
	} catch (error) {
		// Not ours after all, or no longer empty: put it back where it was.
		await rename(parked, dir.path).catch((restoreError: any) => {
			console.warn(`[Import] Could not move ${parked} back to ${dir.path}: ${restoreError?.code ?? restoreError?.message ?? restoreError}`);
		});
		throw error;
	}
}

async function isSame(path: string, dir: CreatedDirectory): Promise<boolean> {
	const now = await lstat(path, { bigint: true });
	return now.isDirectory() && now.dev === dir.dev && now.ino === dir.ino;
}
