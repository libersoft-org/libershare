import { type DataServer } from '../lish/data-server.ts';
import { type Dataset } from '@shared';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;

interface DatasetsHandlers {
	getDatasets: () => Dataset[];
	getDataset: (p: { id: string }) => Dataset | null;
}

export function initDatasetsHandlers(dataServer: DataServer): DatasetsHandlers {
	function getDatasets(): Dataset[] {
		return dataServer.getDatasets().map(l => ({
			id: l.id,
			lishID: l.id,
			directory: l.directory!,
			complete: dataServer.isComplete(l),
		}));
	}

	function getDataset(p: { id: string }): Dataset | null {
		assert(p, ['id']);
		const lish = dataServer.get(p.id);
		if (!lish || !lish.directory) return null;
		return {
			id: lish.id,
			lishID: lish.id,
			directory: lish.directory,
			complete: dataServer.isComplete(lish),
		};
	}

	return { getDatasets, getDataset };
}
