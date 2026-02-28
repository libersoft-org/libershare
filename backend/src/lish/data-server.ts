import { open } from 'fs/promises';
import { join } from 'path';
import { type ILISH, type IStoredLISH, type LISHid, type ChunkID } from '@shared';
import { ArrayStorage } from '../storage.ts';

export interface MissingChunk {
	fileIndex: number;
	chunkIndex: number;
	chunkID: ChunkID;
}

export class DataServer {
	private storage!: ArrayStorage<IStoredLISH>;

	private constructor() {}

	static async create(dataDir: string): Promise<DataServer> {
		const server = new DataServer();
		server.storage = await ArrayStorage.create<IStoredLISH>(dataDir, 'lishs.json', 'id');
		return server;
	}

	get(lishID: LISHid): IStoredLISH | null {
		return this.storage.get(lishID) || null;
	}

	list(): IStoredLISH[] {
		return this.storage.list();
	}

	/**
	 * Get all lishs that have a directory (i.e. are actual datasets, not just metadata).
	 */
	getDatasets(): IStoredLISH[] {
		return this.storage.list().filter(l => l.directory);
	}

	async add(lish: IStoredLISH): Promise<void> {
		await this.storage.upsert(lish);
	}

	async delete(lishID: LISHid): Promise<boolean> {
		return this.storage.delete(lishID);
	}

	// Chunk state operations (stored in lish.chunks[])

	isChunkDownloaded(lishID: LISHid, chunkID: ChunkID): boolean {
		const lish = this.get(lishID);
		return lish?.chunks?.includes(chunkID) ?? false;
	}

	async markChunkDownloaded(lishID: LISHid, chunkID: ChunkID): Promise<void> {
		const lish = this.get(lishID);
		if (!lish) return;
		if (!lish.chunks) lish.chunks = [];
		if (!lish.chunks.includes(chunkID)) {
			lish.chunks.push(chunkID);
			await this.storage.update(lish);
		}
	}

	isComplete(lish: IStoredLISH): boolean {
		if (!lish.files || !lish.chunks) return false;
		const chunkSet = new Set(lish.chunks);
		return lish.files.every(f => f.checksums.every(c => chunkSet.has(c)));
	}

	getHaveChunks(lish: IStoredLISH): Set<ChunkID> | 'all' {
		if (!lish.files) return new Set();
		const chunkSet = new Set(lish.chunks || []);
		const allChunks = lish.files.flatMap(f => f.checksums as ChunkID[]);
		const haveChunks = new Set<ChunkID>();
		let haveAll = true;
		for (const chunkID of allChunks) {
			if (chunkSet.has(chunkID)) haveChunks.add(chunkID);
			else haveAll = false;
		}
		return haveAll ? 'all' : haveChunks;
	}

	getMissingChunks(lish: IStoredLISH): Array<MissingChunk> {
		if (!lish.files) return [];
		const chunkSet = new Set(lish.chunks || []);
		const missing: Array<MissingChunk> = [];
		for (let fileIndex = 0; fileIndex < lish.files.length; fileIndex++) {
			const file = lish.files[fileIndex];
			for (let chunkIndex = 0; chunkIndex < file.checksums.length; chunkIndex++) {
				const chunkID = file.checksums[chunkIndex] as ChunkID;
				if (!chunkSet.has(chunkID)) missing.push({ fileIndex, chunkIndex, chunkID });
			}
		}
		return missing;
	}

	// Chunk I/O

	public async getChunk(lishID: LISHid, chunkID: ChunkID): Promise<Uint8Array | null> {
		const lish = this.get(lishID);
		if (!lish) {
			console.log(`LISH not found: ${lishID}`);
			return null;
		}
		if (!lish.files || lish.files.length === 0) {
			console.log(`No files in LISH: ${lishID}`);
			return null;
		}
		if (!lish.directory) {
			console.log(`No directory set for LISH: ${lishID}`);
			return null;
		}
		return this.readChunk(lish.directory, lish, chunkID);
	}

	private async readChunk(directory: string, lish: ILISH, chunkID: ChunkID): Promise<Uint8Array | null> {
		for (const file of lish.files!) {
			const chunkIndex = file.checksums.findIndex(c => c === chunkID);
			if (chunkIndex !== -1) {
				const dataFilePath = join(directory, file.path);
				try {
					const offset = chunkIndex * lish.chunkSize;
					const fileHandle = Bun.file(dataFilePath);
					const slice = fileHandle.slice(offset, offset + lish.chunkSize);
					const arrayBuffer = await slice.arrayBuffer();
					console.log(`read chunk ${chunkID.slice(0, 8)}... from ${file.path} (index ${chunkIndex})`);
					return new Uint8Array(arrayBuffer);
				} catch (error) {
					console.log(`Error reading chunk from ${dataFilePath}:`, error);
					return null;
				}
			}
		}
		console.warn(`Chunk not found in any file: ${chunkID.slice(0, 8)}...`);
		return null;
	}

	public async writeChunk(downloadDir: string, lish: ILISH, fileIndex: number, chunkIndex: number, data: Uint8Array): Promise<void> {
		if (!lish.files || fileIndex >= lish.files.length) throw new Error(`Invalid file index: ${fileIndex}`);
		const file = lish.files[fileIndex];
		const filePath = join(downloadDir, file.path);
		const offset = chunkIndex * lish.chunkSize;
		const fd = await open(filePath, 'r+');
		await fd.write(data, 0, data.length, offset);
		await fd.close();
	}
}
