import { type DataServer } from '../lish/data-server.ts';
import { type IStoredLish, type CreateLishResponse } from '@shared';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;
type EmitFn = (client: any, event: string, data: any) => void;
interface CreateLishParams {
	name?: string;
	description?: string;
	dataPath: string;
	lishFile?: string;
	addToSharing?: boolean;
	chunkSize?: number;
	algorithm?: string;
	threads?: number;
}

export function initLishsHandlers(dataServer: DataServer, emit: EmitFn) {
	function getAll(): IStoredLish[] {
		return dataServer.getAllLishs();
	}
	function get(p: { lishID: string }): IStoredLish | null {
		assert(p, ['lishID']);
		return dataServer.getLish(p.lishID);
	}

	async function create(p: CreateLishParams, client: any): Promise<CreateLishResponse> {
		assert(p, ['dataPath']);
		const addToSharing = p.addToSharing ?? false;
		const algorithm = p.algorithm ?? 'sha256';
		const chunkSize = p.chunkSize ?? 1024 * 1024; // 1MB
		const threads = p.threads ?? 0; // 0 = all CPU threads
		const lish = await dataServer.createLISH(
			p.dataPath,
			p.lishFile,
			addToSharing,
			p.name,
			p.description,
			algorithm,
			chunkSize,
			threads,
			// TODO: check that dataPath is not already in datasets.
			// TODO: check that dataPath exists
			info => {
				emit(client, 'lishs.create:progress', info);
			}
		);
		return { lishID: lish.id };
	}

	return { getAll, get, create };
}
