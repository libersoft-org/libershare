import { type DataServer } from '../lish/data-server.ts';

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
