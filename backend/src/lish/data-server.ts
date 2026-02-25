import { mkdir, open } from 'fs/promises';
import { join, dirname } from 'path';
import { type ILish, type IStoredLish, type LishID, type ChunkID } from './lish.ts';
import { createLISH, DEFAULT_CHUNK_SIZE, DEFAULT_ALGO } from './lish.ts';
import { ArrayStorage } from '../storage.ts';
import { Utils } from '../utils.ts';

export interface MissingChunk {
	fileIndex: number;
	chunkIndex: number;
	chunkID: ChunkID;
}

export class DataServer {
	private storage: ArrayStorage<IStoredLish>;
	private downloadDir: string;

	constructor(dataDir: string) {
		this.downloadDir = join(dataDir, 'downloads');
		this.storage = new ArrayStorage<IStoredLish>(dataDir, 'lishs.json', 'id');
	}

	getLish(lishID: LishID): IStoredLish | null {
		return this.storage.get(lishID) || null;
	}

	getAllLishs(): IStoredLish[] {
		return this.storage.getAll();
	}

	/**
	 * Get all lishs that have a directory (i.e. are actual datasets, not just metadata).
	 */
	getDatasets(): IStoredLish[] {
		return this.storage.getAll().filter(l => l.directory);
	}

	async addLish(lish: IStoredLish): Promise<void> {
		await this.storage.upsert(lish);
	}

	async deleteLish(lishID: LishID): Promise<boolean> {
		return this.storage.delete(lishID);
	}

	// Chunk state operations (stored in lish.chunks[])

	isChunkDownloaded(lishID: LishID, chunkID: ChunkID): boolean {
		const lish = this.getLish(lishID);
		return lish?.chunks?.includes(chunkID) ?? false;
	}

	async markChunkDownloaded(lishID: LishID, chunkID: ChunkID): Promise<void> {
		const lish = this.getLish(lishID);
		if (!lish) return;
		if (!lish.chunks) lish.chunks = [];
		if (!lish.chunks.includes(chunkID)) {
			lish.chunks.push(chunkID);
			await this.storage.update(lish);
		}
	}

	isComplete(lish: IStoredLish): boolean {
		if (!lish.files || !lish.chunks) return false;
		const allChunks = lish.files.flatMap(f => f.checksums);
		return allChunks.every(c => lish.chunks!.includes(c));
	}

	getHaveChunks(lish: IStoredLish): Set<ChunkID> | 'all' {
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

	getMissingChunks(lish: IStoredLish): Array<MissingChunk> {
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

	public async getChunk(lishID: LishID, chunkID: ChunkID): Promise<Uint8Array | null> {
		const lish = this.getLish(lishID);
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

	private async readChunk(directory: string, lish: ILish, chunkID: ChunkID): Promise<Uint8Array | null> {
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

	public async writeChunk(downloadDir: string, lish: ILish, fileIndex: number, chunkIndex: number, data: Uint8Array): Promise<void> {
		if (!lish.files || fileIndex >= lish.files.length) throw new Error(`Invalid file index: ${fileIndex}`);
		const file = lish.files[fileIndex];
		const filePath = join(downloadDir, file.path);
		const offset = chunkIndex * lish.chunkSize;
		const fd = await open(filePath, 'r+');
		await fd.write(data, 0, data.length, offset);
		await fd.close();
	}

	// Create & export

	public async createLISH(inputPath: string, saveToFile: boolean = false, addToSharing: boolean = true, name: string | undefined, description: string | undefined, outputFilePath: string | undefined, algo: string = DEFAULT_ALGO, chunkSize: number = DEFAULT_CHUNK_SIZE, threads: number = 0, onProgress?: (info: { type: string; path?: string; current?: number; total?: number }) => void): Promise<IStoredLish> {
		console.log(`Importing dataset from: ${inputPath}, saveToFile=${saveToFile}, addToSharing=${addToSharing}, name=${name}, description=${description}, outputFilePath=${outputFilePath}`);
		const absolutePath = Utils.expandHome(inputPath);
		outputFilePath = outputFilePath ? Utils.expandHome(outputFilePath) : undefined;
		const lish: IStoredLish = await createLISH(absolutePath, name, chunkSize, algo as any, threads, description, onProgress);
		if (saveToFile) await this.exportLishToFile(lish, outputFilePath);
		if (addToSharing) {
			// Set directory and mark all chunks as downloaded
			lish.directory = absolutePath;
			if (lish.files) {
				lish.chunks = lish.files.flatMap(f => f.checksums);
			}
			await this.addLish(lish);
			console.log(`✓ Dataset imported: ${lish.id}`);
		}
		return lish;
	}

	public async exportLishToFile(lish: IStoredLish, outputFilePath: string | undefined): Promise<void> {
		if (!outputFilePath) throw new Error('Output file path is required when saveToFile is true');
		const { writeFile } = await import('fs/promises');
		const outputDir = dirname(outputFilePath);
		await mkdir(outputDir, { recursive: true });
		// Export without local-only fields
		const { directory, chunks, ...exportData } = lish;
		await writeFile(outputFilePath, JSON.stringify(exportData, null, 2));
		console.log(`✓ LISH exported to: ${outputFilePath}`);
	}
}
