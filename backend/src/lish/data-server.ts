import { open } from 'fs/promises';
import { join } from 'path';
import { type Database } from 'bun:sqlite';
import { type ILISH, type IStoredLISH, type ILISHSummary, type ILISHDetail, type LISHid, type ChunkID, type LISHSortField, type SortOrder } from '@shared';
import { type MissingChunk, getLISH, getLISHMeta, addLISH, deleteLISH as dbDeleteLISH, listLISHSummaries, getLISHDetail, listAllStoredLISHs, getDatasets as dbGetDatasets, isChunkDownloaded as dbIsChunkDownloaded, markChunkDownloaded as dbMarkChunkDownloaded, isComplete as dbIsComplete, getHaveChunks as dbGetHaveChunks, getMissingChunks as dbGetMissingChunks, findChunkLocation } from '../db/lishs.ts';

export type { MissingChunk };

export class DataServer {
	private db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	get(lishID: LISHid): IStoredLISH | null {
		return getLISH(this.db, lishID);
	}

	list(): IStoredLISH[] {
		return listAllStoredLISHs(this.db);
	}

	listSummaries(sortBy?: LISHSortField, sortOrder?: SortOrder): ILISHSummary[] {
		return listLISHSummaries(this.db, sortBy, sortOrder);
	}

	getDetail(lishID: LISHid): ILISHDetail | null {
		return getLISHDetail(this.db, lishID);
	}

	/**
	 * Get all lishs that have a directory (i.e. are actual datasets, not just metadata).
	 */
	getDatasets(): IStoredLISH[] {
		return dbGetDatasets(this.db);
	}

	add(lish: IStoredLISH): void {
		addLISH(this.db, lish);
	}

	delete(lishID: LISHid): boolean {
		return dbDeleteLISH(this.db, lishID);
	}

	// Chunk state operations

	isChunkDownloaded(lishID: LISHid, chunkID: ChunkID): boolean {
		return dbIsChunkDownloaded(this.db, lishID, chunkID);
	}

	markChunkDownloaded(lishID: LISHid, chunkID: ChunkID): void {
		dbMarkChunkDownloaded(this.db, lishID, chunkID);
	}

	isComplete(lishID: LISHid): boolean {
		return dbIsComplete(this.db, lishID);
	}

	isCompleteLISH(lish: IStoredLISH): boolean {
		return dbIsComplete(this.db, lish.id);
	}

	getHaveChunks(lishID: LISHid): Set<ChunkID> | 'all' {
		return dbGetHaveChunks(this.db, lishID);
	}

	getMissingChunks(lishID: LISHid): MissingChunk[] {
		return dbGetMissingChunks(this.db, lishID);
	}

	// Chunk I/O

	public async getChunk(lishID: LISHid, chunkID: ChunkID): Promise<Uint8Array | null> {
		const meta = getLISHMeta(this.db, lishID);
		if (!meta) {
			console.log(`LISH not found: ${lishID}`);
			return null;
		}
		if (!meta.directory) {
			console.log(`No directory set for LISH: ${lishID}`);
			return null;
		}

		const location = findChunkLocation(this.db, lishID, chunkID);
		if (!location) {
			console.warn(`Chunk not found in any file: ${chunkID.slice(0, 8)}...`);
			return null;
		}

		const dataFilePath = join(meta.directory, location.filePath);
		try {
			const offset = location.chunkIndex * meta.chunkSize;
			const fileHandle = Bun.file(dataFilePath);
			const slice = fileHandle.slice(offset, offset + meta.chunkSize);
			const arrayBuffer = await slice.arrayBuffer();
			console.log(`read chunk ${chunkID.slice(0, 8)}... from ${location.filePath} (index ${location.chunkIndex})`);
			return new Uint8Array(arrayBuffer);
		} catch (error) {
			console.log(`Error reading chunk from ${dataFilePath}:`, error);
			return null;
		}
	}

	public async writeChunk(downloadDir: string, lish: ILISH, fileIndex: number, chunkIndex: number, data: Uint8Array): Promise<void> {
		if (!lish.files || fileIndex >= lish.files.length) throw new Error(`Invalid file index: ${fileIndex}`);
		const file = lish.files[fileIndex]!;
		const filePath = join(downloadDir, file.path);
		const offset = chunkIndex * lish.chunkSize;
		const fd = await open(filePath, 'r+');
		await fd.write(data, 0, data.length, offset);
		await fd.close();
	}
}
