import { type DataServer } from '../lish/data-server.ts';

type P = Record<string, any>;

export function initDatasetsHandlers(dataServer: DataServer) {
	const getDatasets = () => {
		return dataServer.getDatasets().map(l => ({
			id: l.id,
			lishID: l.id,
			directory: l.directory!,
			complete: dataServer.isComplete(l),
		}));
	};

	const getDataset = (p: P) => {
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
