import { type Database } from 'bun:sqlite';
import { openDataset, type DatasetRoot, type SafeDataset } from './safe-dataset-files.ts';
import { conservativeDatasetRoot } from './dataset-root.ts';
import { readDatasetRange } from './dataset-chunk-io.ts';
import { getDatasetRoot as dbGetDatasetRoot, setDatasetRoot as dbSetDatasetRoot, addDataset as dbAddDataset, relocateDataset as dbRelocateDataset } from '../db/lishs-roots.ts';
import { getDatasetLinkBindings as dbGetDatasetLinkBindings, type DatasetLinkBinding } from '../db/lishs-link-bindings.ts';
import { clearLishData, clearLishnetData } from '../db/database.ts';
import { getDownloadEnabledLishs as dbGetDownloadEnabledLishs, getUploadEnabledLishs as dbGetUploadEnabledLishs, setDownloadEnabled as dbSetDownloadEnabled, setUploadEnabled as dbSetUploadEnabled } from '../db/lishs.ts';
import { type ILISH, type IStoredLISH, type ILISHSummary, type ILISHDetail, type LISHid, type ChunkID, type LISHSortField, type SortOrder, CodedError, ErrorCodes } from '@shared';
import { type MissingChunk, type VerificationProgress, type FileVerificationProgress, type ChunkSlot, type FileForVerification, type TransferStats, getLISH, getLISHMeta, addLISH, deleteLISH as dbDeleteLISH, updateLISHDirectory as dbUpdateLISHDirectory, updateLISHFinalDirectory as dbUpdateLISHFinalDirectory, listLISHSummaries, getLISHDetail, listAllStoredLISHs, getDatasets as dbGetDatasets, isChunkDownloaded as dbIsChunkDownloaded, markChunkDownloaded as dbMarkChunkDownloaded, isComplete as dbIsComplete, getHaveChunks as dbGetHaveChunks, getMissingChunks as dbGetMissingChunks, getAllChunkSlots as dbGetAllChunkSlots, findChunkLocation, getVerificationProgress as dbGetVerificationProgress, getFileVerificationProgress as dbGetFileVerificationProgress, markChunkVerified as dbMarkChunkVerified, markChunkFailed as dbMarkChunkFailed, markAllFileChunksFailed as dbMarkAllFileChunksFailed, resetVerification as dbResetVerification, isVerified as dbIsVerified, getFilesForVerification as dbGetFilesForVerification, incrementUploadedBytes as dbIncrementUploadedBytes, incrementDownloadedBytes as dbIncrementDownloadedBytes, getTransferStats as dbGetTransferStats, setLISHError as dbSetLISHError, clearLISHError as dbClearLISHError, resetFileChunks as dbResetFileChunks, getFileInternalID as dbGetFileInternalID } from '../db/lishs.ts';

export type { MissingChunk };

export class DataServer {
	private db: Database;
	private openRoot: typeof openDataset;

	constructor(db: Database, openRoot: typeof openDataset = openDataset) {
		this.db = db;
		this.openRoot = openRoot;
	}

	getDatasetRoot(lishID: LISHid, final = false): DatasetRoot | null {
		return dbGetDatasetRoot(this.db, lishID, final);
	}

	setDatasetRoot(lishID: LISHid, root: DatasetRoot | null, final = false): void {
		dbSetDatasetRoot(this.db, lishID, root, final);
	}

	addDataset(lish: IStoredLISH, root: DatasetRoot, finalRoot?: DatasetRoot): void {
		dbAddDataset(this.db, lish, root, finalRoot);
	}

	getDatasetLinkBindings(lishID: LISHid): DatasetLinkBinding[] {
		return dbGetDatasetLinkBindings(this.db, lishID);
	}

	relocateDataset(lishID: LISHid, root: DatasetRoot, clearFinal = false, bindings?: readonly DatasetLinkBinding[]): void {
		dbRelocateDataset(this.db, lishID, root, clearFinal, bindings);
	}

	async openDataset(lishID: LISHid): Promise<SafeDataset> {
		const meta = getLISHMeta(this.db, lishID);
		if (!meta?.directory) throw new CodedError(ErrorCodes.LISH_NOT_FOUND, lishID);
		return this.openRoot(this.getDatasetRoot(lishID) ?? conservativeDatasetRoot(meta.directory));
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

	/**
	 * Remove every LISH record from the database (downloads category of the
	 * factory reset). On-disk data files are left untouched.
	 */
	clearLishs(): void {
		clearLishData(this.db);
	}

	/** Remove every lishnet record (networks category of the factory reset). */
	clearLishnets(): void {
		clearLishnetData(this.db);
	}

	/** LISHs with downloading enabled in the DB (used to resume after a reset). */
	getDownloadEnabledLishs(): Set<string> {
		return dbGetDownloadEnabledLishs(this.db);
	}

	/** LISHs with sharing enabled in the DB (used to resume after a reset). */
	getUploadEnabledLishs(): Set<string> {
		return dbGetUploadEnabledLishs(this.db);
	}

	setDownloadEnabled(lishID: LISHid, enabled: boolean): void {
		dbSetDownloadEnabled(this.db, lishID, enabled);
	}

	setUploadEnabled(lishID: LISHid, enabled: boolean): void {
		dbSetUploadEnabled(this.db, lishID, enabled);
	}

	updateDirectory(lishID: LISHid, directory: string): boolean {
		return dbUpdateLISHDirectory(this.db, lishID, directory);
	}

	updateFinalDirectory(lishID: LISHid, finalDirectory: string | null): boolean {
		return dbUpdateLISHFinalDirectory(this.db, lishID, finalDirectory);
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

	getTransferStats(lishID: LISHid): TransferStats {
		return dbGetTransferStats(this.db, lishID);
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

	getAllChunkSlots(lishID: LISHid): ChunkSlot[] {
		return dbGetAllChunkSlots(this.db, lishID);
	}

	getAllChunkCount(lishID: LISHid): number {
		const row = this.db.query<{ c: number }, [number]>('SELECT COUNT(*) as c FROM lishs_chunks WHERE id_lishs_files IN (SELECT id FROM lishs_files WHERE id_lishs = (SELECT id FROM lishs WHERE lish_id = ?))').get(lishID as any);
		return row?.c ?? 0;
	}

	// Verification operations

	getVerificationProgress(lishID: LISHid): VerificationProgress {
		return dbGetVerificationProgress(this.db, lishID);
	}

	findChunkFile(lishID: LISHid, chunkID: import('@shared').ChunkID): string | undefined {
		const loc = findChunkLocation(this.db, lishID, chunkID);
		return loc?.filePath;
	}

	getFileVerificationProgress(lishID: LISHid): FileVerificationProgress[] {
		return dbGetFileVerificationProgress(this.db, lishID);
	}

	markChunkVerified(chunkRowID: number): void {
		dbMarkChunkVerified(this.db, chunkRowID);
	}

	markChunkFailed(chunkRowID: number): void {
		dbMarkChunkFailed(this.db, chunkRowID);
	}

	markAllFileChunksFailed(fileInternalID: number): void {
		dbMarkAllFileChunksFailed(this.db, fileInternalID);
	}

	resetVerification(lishID: LISHid): void {
		dbResetVerification(this.db, lishID);
	}

	isVerified(lishID: LISHid): boolean {
		return dbIsVerified(this.db, lishID);
	}

	getFilesForVerification(lishID: LISHid): FileForVerification[] | null {
		return dbGetFilesForVerification(this.db, lishID);
	}

	// Error state

	setError(lishID: LISHid, errorCode: string, errorDetail?: string): void {
		dbSetLISHError(this.db, lishID, errorCode, errorDetail);
	}

	clearError(lishID: LISHid): void {
		dbClearLISHError(this.db, lishID);
	}

	/** Reset have=FALSE for all chunks of a specific file. Returns count of reset chunks. */
	resetFileChunks(lishID: LISHid, fileIndex: number): number {
		const fileInternalID = dbGetFileInternalID(this.db, lishID, fileIndex);
		if (fileInternalID === null) return 0;
		return dbResetFileChunks(this.db, fileInternalID);
	}

	// Chunk I/O

	public async getChunk(lishID: LISHid, chunkID: ChunkID): Promise<Uint8Array | 'lish_not_found' | 'chunk_not_found' | 'file_missing' | 'io_error'> {
		const meta = getLISHMeta(this.db, lishID);
		if (!meta) {
			console.log(`LISH not found: ${lishID}`);
			return 'lish_not_found';
		}
		if (!meta.directory) {
			console.log(`No directory set for LISH: ${lishID}`);
			return 'lish_not_found';
		}

		const location = findChunkLocation(this.db, lishID, chunkID);
		if (!location) {
			console.debug(`Chunk not found in any file: ${chunkID.slice(0, 8)}...`);
			return 'chunk_not_found';
		}

		try {
			const offset = location.chunkIndex * meta.chunkSize;
			const dataset = await this.openDataset(lishID);
			try {
				const file = await dataset.openFile(location.filePath, 'read');
				try {
					const info = await file.stat();
					return await readDatasetRange(file, offset, Math.max(0, Math.min(meta.chunkSize, info.size - offset)));
				} finally {
					await file.close();
				}
			} finally {
				await dataset.close();
			}
		} catch (error: any) {
			if (error.code === ErrorCodes.LISH_UNSAFE_PATH) throw error;
			if (error.code === 'ENOENT') {
				// The backing file vanished from disk. Stop claiming its chunks: reset them so
				// further requests answer chunk_not_found (honest partial seeder). Report
				// file_missing so the protocol layer can kick verify/recovery right away —
				// the consecutive-io_error threshold would never fire after the reset.
				const reset = dbResetFileChunks(this.db, location.fileInternalID);
				console.warn(`[DataServer] ${location.filePath} missing on disk — reset ${reset} chunks of ${lishID.slice(0, 8)} for re-download`);
				return 'file_missing';
			}
			console.error(`Error reading chunk from ${location.filePath}:`, error.code ?? error.message);
			return 'io_error';
		}
	}

	public async writeChunk(downloadDir: string | DatasetRoot, lish: ILISH, fileIndex: number, chunkIndex: number, data: Uint8Array): Promise<void> {
		if (!Number.isSafeInteger(fileIndex) || fileIndex < 0 || !lish.files || fileIndex >= lish.files.length) throw new CodedError(ErrorCodes.INVALID_FILE_INDEX, String(fileIndex));
		const file = lish.files[fileIndex]!;
		const offset = chunkIndex * lish.chunkSize;
		const length = Math.min(lish.chunkSize, file.size - offset);
		if (!Number.isSafeInteger(lish.chunkSize) || lish.chunkSize <= 0 || !Number.isSafeInteger(file.size) || file.size < 0 || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= file.checksums.length || !Number.isSafeInteger(offset) || length <= 0 || data.length !== length) throw new CodedError(ErrorCodes.UPLOAD_INVALID_CHUNK);
		const dataset = await this.openRoot(typeof downloadDir === 'string' ? conservativeDatasetRoot(downloadDir) : downloadDir);
		try {
			await dataset.prepare(lish);
			const fd = await dataset.openFile(file.path, 'write');
			try {
				let bytesWritten = 0;
				while (bytesWritten < data.length) {
					const count = await fd.write(data.subarray(bytesWritten), offset + bytesWritten);
					if (!Number.isInteger(count) || count <= 0 || count > data.length - bytesWritten) throw Object.assign(new Error('File write made no progress'), { code: 'EIO' });
					bytesWritten += count;
				}
			} finally {
				await fd.close();
			}
		} finally {
			await dataset.close();
		}
	}
}
