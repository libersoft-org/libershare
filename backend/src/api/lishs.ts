import { type DataServer } from '../lish/data-server.ts';
import { type IStoredLISH, type CreateLISHResponse, DEFAULT_ALGO } from '@shared';
import { createLISH, DEFAULT_CHUNK_SIZE } from '../lish/lish.ts';
import { exportLISHToFile } from '../lish/lish-export.ts';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;
type EmitFn = (client: any, event: string, data: any) => void;
interface CreateLISHParams {
	name?: string;
	description?: string;
	dataPath: string;
	lishFile?: string;
	addToSharing?: boolean;
	chunkSize?: number;
	algorithm?: string;
	threads?: number;
	minifyJson?: boolean;
	compressGzip?: boolean;
}

export function initLISHsHandlers(dataServer: DataServer, emit: EmitFn) {
	function list(): IStoredLISH[] {
		return dataServer.getAll();
	}
	function get(p: { lishID: string }): IStoredLISH | null {
		assert(p, ['lishID']);
		return dataServer.get(p.lishID) ?? null;
	}

	async function create(p: CreateLISHParams, client: any): Promise<CreateLISHResponse> {
		assert(p, ['dataPath']);
		const addToSharing = p.addToSharing ?? false;
		const algorithm = p.algorithm ?? DEFAULT_ALGO;
		const chunkSize = p.chunkSize ?? DEFAULT_CHUNK_SIZE;
		const threads = p.threads ?? 0; // 0 = all CPU threads
		const minifyJson = p.minifyJson ?? false;
		const compressGzip = p.compressGzip ?? false;

		// TODO: check that dataPath is not already in datasets.
		// TODO: check that dataPath exists
		const dataPath = Utils.expandHome(p.dataPath);
		console.log(`Creating LISH from: ${dataPath}, lishFile=${p.lishFile}, addToSharing=${addToSharing}, name=${p.name}, description=${p.description}`);

		// 1. Create the LISH structure
		const lish: IStoredLISH = await createLISH(dataPath, p.name, chunkSize, algorithm as any, threads, p.description, info => {
			emit(client, 'lishs.create:progress', info);
		});

		// 2. Export to .lish(.gz) file if requested
		if (p.lishFile) {
			const lishFilePath = Utils.expandHome(p.lishFile);
			await exportLISHToFile(lish, lishFilePath, minifyJson, compressGzip);
		}

		// 3. Save to data-server if requested
		if (addToSharing) {
			lish.directory = dataPath;
			if (lish.files) {
				lish.chunks = lish.files.flatMap(f => f.checksums);
			}
			await dataServer.add(lish);
			console.log(`✓ Dataset imported: ${lish.id}`);
		}

		return { lishID: lish.id };
	}

	return { list, get, create };
}
