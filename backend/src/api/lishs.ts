import { type DataServer } from '../lish/data-server.ts';

type P = Record<string, any>;
type EmitFn = (event: string, data: any) => void;

export function initLishsHandlers(dataServer: DataServer, emit: EmitFn) {
	const getAll = () => dataServer.getAllLishs();
	const get = (p: P) => dataServer.getLish(p.lishID);

	const create = async (p: P) => {
		const lish = await dataServer.createLISH(
			p.inputPath,
			p.saveToFile,
			p.addToSharing,
			p.name,
			p.description,
			p.outputFilePath,
			p.algorithm,
			p.chunkSize,
			p.threads,
			// todo: check that path is not already in datasets.
			// todo: check that path exists
			info => {
				emit('lishs.create:progress', { path: p.path, ...info });
			}
		);
		return { lishID: lish.id };
	};

	return { getAll, get, create };
}
