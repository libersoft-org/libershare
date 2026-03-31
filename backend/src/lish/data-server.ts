import { open } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { type Database } from 'bun:sqlite';
import { type ILISH, type IStoredLISH, type ILISHSummary, type ILISHDetail, type LISHid, type ChunkID, type LISHSortField, type SortOrder, CodedError, ErrorCodes } from '@shared';
import { type MissingChunk, type VerificationProgress, type FileVerificationProgress, getLISH, getLISHMeta, addLISH, deleteLISH as dbDeleteLISH, updateLISHDirectory as dbUpdateLISHDirectory, listLISHSummaries, getLISHDetail, listAllStoredLISHs, getDatasets as dbGetDatasets, isChunkDownloaded as dbIsChunkDownloaded, markChunkDownloaded as dbMarkChunkDownloaded, isComplete as dbIsComplete, getHaveChunks as dbGetHaveChunks, getMissingChunks as dbGetMissingChunks, findChunkLocation, getVerificationProgress as dbGetVerificationProgress, getFileVerificationProgress as dbGetFileVerificationProgress, markChunkVerified as dbMarkChunkVerified, markChunkFailed as dbMarkChunkFailed, resetVerification as dbResetVerification, isVerified as dbIsVerified, getFilesForVerification as dbGetFilesForVerification, incrementUploadedBytes as dbIncrementUploadedBytes, incrementDownloadedBytes as dbIncrementDownloadedBytes } from '../db/lishs.ts';

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

	updateDirectory(lishID: LISHid, directory: string): boolean {
		return dbUpdateLISHDirectory(this.db, lishID, directory);
	}

	// Chunk state operations

	isChunkDownloaded(lishID: LISHid, chunkID: ChunkID): boolean {
		return dbIsChunkDownloaded(this.db, lishID, chunkID);
	}

	markChunkDownloaded(lishID: LISHid, chunkID: ChunkID): void {
		dbMarkChunkDownloaded(this.db, lishID, chunkID);
	}

	incrementUploadedBytes(lishID: LISHid, bytes: number): void {
		dbIncrementUploadedBytes(this.db, lishID, bytes);
	}

	incrementDownloadedBytes(lishID: LISHid, bytes: number): void {
		dbIncrementDownloadedBytes(this.db, lishID, bytes);
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

	getAllChunkCount(lishID: LISHid): number {
		const row = this.db.query<{ c: number }, [number]>('SELECT COUNT(*) as c FROM lishs_chunks WHERE id_lishs_files IN (SELECT id FROM lishs_files WHERE id_lishs = (SELECT id FROM lishs WHERE lish_id = ?))').get(lishID as any);
		return row?.c ?? 0;
	}

	// Verification operations

	getVerificationProgress(lishID: LISHid): VerificationProgress {
		return dbGetVerificationProgress(this.db, lishID);
	}

	getFileVerificationProgress(lishID: LISHid): FileVerificationProgress[] {
		return dbGetFileVerificationProgress(this.db, lishID);
	}

	markChunkVerified(lishID: LISHid, fileInternalID: number, chunkIndex: number): void {
		dbMarkChunkVerified(this.db, lishID, fileInternalID, chunkIndex);
	}

	markChunkFailed(lishID: LISHid, fileInternalID: number, chunkIndex: number): void {
		dbMarkChunkFailed(this.db, lishID, fileInternalID, chunkIndex);
	}

	resetVerification(lishID: LISHid): void {
		dbResetVerification(this.db, lishID);
	}

	isVerified(lishID: LISHid): boolean {
		return dbIsVerified(this.db, lishID);
	}

	getFilesForVerification(lishID: LISHid): Array<{ fileInternalID: number; path: string; checksums: string[] }> | null {
		return dbGetFilesForVerification(this.db, lishID);
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
		if (!lish.files || fileIndex >= lish.files.length) throw new CodedError(ErrorCodes.INVALID_FILE_INDEX, String(fileIndex));
		const file = lish.files[fileIndex]!;
		const filePath = resolve(downloadDir, file.path);
		if (!filePath.startsWith(resolve(downloadDir) + sep)) throw new CodedError(ErrorCodes.INVALID_FILE_INDEX, `Path traversal: ${file.path}`);
		const offset = chunkIndex * lish.chunkSize;
		const fd = await open(filePath, 'r+');
		try {
			await fd.write(data, 0, data.length, offset);
		} finally {
			await fd.close();
		}
	}
}
