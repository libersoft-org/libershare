import { type DataServer } from '../lish/data-server.ts';

type EmitFn = (client: any, event: string, data: any) => void;
interface CreateLishParams {
	inputPath: string;
	saveToFile: boolean;
	addToSharing: boolean;
	name: string;
	description: string;
	outputFilePath?: string;
	algorithm: string;
	chunkSize: number;
	threads: number;
	path?: string;
}

export function initLishsHandlers(dataServer: DataServer, emit: EmitFn) {
	const getAll = () => dataServer.getAllLishs();
	const get = (p: { lishID: string }) => dataServer.getLish(p.lishID);

	const create = async (p: CreateLishParams, client: any) => {
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
				emit(client, 'lishs.create:progress', { path: p.path, ...info });
			}
		);
		return { lishID: lish.id };
	};

	return { getAll, get, create };
}
