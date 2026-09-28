import { open, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { CodedError, ErrorCodes } from '@shared';

/** Check the opened object before truncation or writing, not the pathname seen earlier. */
export async function assertDatasetWriteTarget(file: Pick<FileHandle, 'stat'>): Promise<Stats> {
	const info = await file.stat();
	if (!info.isFile() || !Number.isSafeInteger(info.nlink) || info.nlink !== 1) {
		throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'The target must be a regular file with one link');
	}
	return info;
}

/** Inspect an existing allocation target without changing its contents. */
export async function readDatasetWriteTarget(path: string): Promise<Stats | null> {
	let file: FileHandle;
	try {
		file = await open(path, 'r');
	} catch (error: any) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
	try {
		return await assertDatasetWriteTarget(file);
	} finally {
		await file.close();
	}
}

/** Open or reserve a file without truncating an object that has not been checked yet. */
export async function openDatasetAllocationTarget(path: string): Promise<{ file: FileHandle; created: boolean }> {
	let file: FileHandle;
	let created = false;
	try {
		file = await open(path, 'r+');
	} catch (error: any) {
		if (error.code !== 'ENOENT') throw error;
		try {
			file = await open(path, 'wx+');
			created = true;
		} catch (createError: any) {
			if (createError.code !== 'EEXIST') throw createError;
			file = await open(path, 'r+');
		}
	}
	try {
		await assertDatasetWriteTarget(file);
		return { file, created };
	} catch (error) {
		await file.close();
		throw error;
	}
}
