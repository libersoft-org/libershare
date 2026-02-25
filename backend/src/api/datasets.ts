import { type DataServer } from '../lish/data-server.ts';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;

export function initDatasetsHandlers(dataServer: DataServer) {
	const getDatasets = () => {
		return dataServer.getDatasets().map(l => ({
			id: l.id,
			lishID: l.id,
			directory: l.directory!,
			complete: dataServer.isComplete(l),
		}));
	};

	const getDataset = (p: { id: string }) => {
		assert(p, ['id']);
		const lish = dataServer.getLish(p.id);
		if (!lish || !lish.directory) return null;
		return {
			id: lish.id,
			lishID: lish.id,
			directory: lish.directory,
			complete: dataServer.isComplete(lish),
		};
	};

	return { getDatasets, getDataset };
}
