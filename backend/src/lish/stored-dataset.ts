import type { IStoredLISH } from '@shared';
import type { DataServer } from './data-server.ts';
import { openDataset } from './safe-dataset-files.ts';
import { conservativeDatasetRoot } from './dataset-root.ts';

/** Completion in the DB does not authorize following links on disk. */
export async function storedDatasetFilesPresent(dataServer: DataServer, lish: IStoredLISH): Promise<boolean> {
	if (!lish.directory) return false;
	let dataset;
	try {
		dataset = await openDataset(dataServer.getDatasetRoot(lish.id) ?? conservativeDatasetRoot(lish.directory));
		await dataset.prepare(lish, { reserve: false, writable: true });
		for (const file of lish.files ?? []) {
			const info = await dataset.statFile(file.path);
			if (!info || info.size !== file.size) return false;
		}
		return true;
	} catch (error: any) {
		if (error.code === 'ENOENT') return false;
		throw error;
	} finally {
		await dataset?.close();
	}
}
