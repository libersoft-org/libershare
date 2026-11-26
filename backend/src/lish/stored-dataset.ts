import type { IStoredLISH } from '@shared';
import type { DataServer } from './data-server.ts';
import { openDataset, type SafeDataset } from './safe-dataset-files.ts';
import { conservativeDatasetRoot } from './dataset-root.ts';

/** Open the stored dataset and ask `present` about it; a dataset that is not there holds nothing. */
async function checkStoredDataset(dataServer: DataServer, lish: IStoredLISH, present: (dataset: SafeDataset) => Promise<boolean>): Promise<boolean> {
	if (!lish.directory) return false;
	let dataset;
	try {
		dataset = await openDataset(dataServer.getDatasetRoot(lish.id) ?? conservativeDatasetRoot(lish.directory));
		await dataset.prepare(lish, { reserve: false, writable: true });
		return await present(dataset);
	} catch (error: any) {
		if (error.code === 'ENOENT') return false;
		throw error;
	} finally {
		await dataset?.close();
	}
}

/** Completion in the DB does not authorize following links on disk. */
export function storedDatasetFilesPresent(dataServer: DataServer, lish: IStoredLISH): Promise<boolean> {
	return checkStoredDataset(dataServer, lish, async dataset => {
		for (const file of lish.files ?? []) {
			const info = await dataset.statFile(file.path);
			if (!info || info.size !== file.size) return false;
		}
		return true;
	});
}

/**
 * Whether every folder the manifest declares is on disk. Asked apart from the files: a missing
 * folder is simply created again, while a missing file means its content has to be checked anew.
 */
export function storedDatasetFoldersPresent(dataServer: DataServer, lish: IStoredLISH): Promise<boolean> {
	return checkStoredDataset(dataServer, lish, async dataset => {
		for (const directory of lish.directories ?? []) if (!(await dataset.statDirectory(directory.path))) return false;
		return true;
	});
}
