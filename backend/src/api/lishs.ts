import { type DataServer } from '../lish/data-server.ts';
import { type IStoredLISH, type CreateLISHResponse, DEFAULT_ALGO } from '@shared';
import { createLISH, DEFAULT_CHUNK_SIZE } from '../lish/lish.ts';
import { exportLISHToFile } from '../lish/lish-export.ts';
import { Utils } from '../utils.ts';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
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

interface LISHsHandlers {
	list: () => IStoredLISH[];
	get: (p: { lishID: string }) => IStoredLISH | null;
	create: (p: CreateLISHParams, client: any) => Promise<CreateLISHResponse>;
}

export function initLISHsHandlers(dataServer: DataServer, emit: EmitFn): LISHsHandlers {
	function list(): IStoredLISH[] {
		return dataServer.list();
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
		const dataPath = Utils.expandHome(p.dataPath);
		// Check that the path exists and is not an empty directory
		const dataPathStat = await stat(dataPath);
		if (dataPathStat.isDirectory()) {
			const entries = await readdir(dataPath);
			if (entries.length === 0) throw new Error('Directory is empty - nothing to create LISH from');
		}
		console.log(`Creating LISH from: ${dataPath}, lishFile=${p.lishFile}, addToSharing=${addToSharing}, name=${p.name}, description=${p.description}`);
		// 1. Create the LISH structure
		const lish: IStoredLISH = await createLISH(dataPath, p.name, chunkSize, algorithm as any, threads, p.description, info => {
			emit(client, 'lishs.create:progress', info);
		});
		// 2. Export to .lish(.gz) file if requested
		let resultLISHFile: string | undefined;
		if (p.lishFile) {
			let lishFilePath = Utils.expandHome(p.lishFile);
			// If the path is a directory, use [lish-id].lish(.gz) as filename
			try {
				const fileStat = await stat(lishFilePath);
				if (fileStat.isDirectory()) {
					const fileName = lish.id + (compressGzip ? '.lish.gz' : '.lish');
					lishFilePath = join(lishFilePath, fileName);
				}
			} catch {
				// Path doesn't exist yet — treat as a file path
			}
			await exportLISHToFile(lish, lishFilePath, minifyJson, compressGzip);
			resultLISHFile = lishFilePath;
		}
		// 3. Save to data-server if requested
		if (addToSharing) {
			lish.directory = dataPath;
			if (lish.files) lish.chunks = lish.files.flatMap(f => f.checksums);
			await dataServer.add(lish);
			console.log(`✓ Dataset imported: ${lish.id}`);
		}
		return { lishID: lish.id, lishFile: resultLISHFile };
	}
	return { list, get, create };
}
