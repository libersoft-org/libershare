import { type Database } from 'bun:sqlite';
import { openDataset, type DatasetRoot, type SafeDataset } from './safe-dataset-files.ts';
import { conservativeDatasetRoot } from './dataset-root.ts';
import { DatasetWriteScope } from './dataset-write-scope.ts';
import { readDatasetRange } from './dataset-chunk-io.ts';
import type { DatasetFileHandle } from './safe-dataset-types.ts';
import { getDatasetRoot as dbGetDatasetRoot, setDatasetRoot as dbSetDatasetRoot, addDataset as dbAddDataset, relocateDataset as dbRelocateDataset } from '../db/lishs-roots.ts';
import { getDatasetLinkBindings as dbGetDatasetLinkBindings, type DatasetLinkBinding } from '../db/lishs-link-bindings.ts';
import { clearLishData, clearLishnetData } from '../db/database.ts';
import { getDownloadEnabledLishs as dbGetDownloadEnabledLishs, getUploadEnabledLishs as dbGetUploadEnabledLishs, setDownloadEnabled as dbSetDownloadEnabled, setUploadEnabled as dbSetUploadEnabled } from '../db/lishs.ts';
import { type ILISH, type IStoredLISH, type ILISHSummary, type ILISHDetail, type LISHid, type ChunkID, type LISHSortField, type SortOrder, CodedError, ErrorCodes } from '@shared';
import { type MissingChunk, type VerificationProgress, type FileVerificationProgress, type ChunkSlot, type FileForVerification, type TransferStats, getLISH, getLISHMeta, addLISH, deleteLISH as dbDeleteLISH, updateLISHDirectory as dbUpdateLISHDirectory, updateLISHFinalDirectory as dbUpdateLISHFinalDirectory, listLISHSummaries, getLISHDetail, listAllStoredLISHs, getDatasets as dbGetDatasets, isChunkDownloaded as dbIsChunkDownloaded, markChunkDownloaded as dbMarkChunkDownloaded, isComplete as dbIsComplete, getHaveChunks as dbGetHaveChunks, getMissingChunks as dbGetMissingChunks, getAllChunkSlots as dbGetAllChunkSlots, findChunkLocation, getVerificationProgress as dbGetVerificationProgress, getFileVerificationProgress as dbGetFileVerificationProgress, markChunkVerified as dbMarkChunkVerified, markChunkFailed as dbMarkChunkFailed, markAllFileChunksFailed as dbMarkAllFileChunksFailed, resetVerification as dbResetVerification, isVerified as dbIsVerified, getFilesForVerification as dbGetFilesForVerification, incrementUploadedBytes as dbIncrementUploadedBytes, incrementDownloadedBytes as dbIncrementDownloadedBytes, getTransferStats as dbGetTransferStats, setLISHError as dbSetLISHError, clearLISHError as dbClearLISHError, resetFileChunks as dbResetFileChunks, getFileInternalID as dbGetFileInternalID } from '../db/lishs.ts';

export type { MissingChunk };

/** What reading one chunk can come back with. */
export type ChunkReadResult = Uint8Array | 'lish_not_found' | 'chunk_not_found' | 'file_missing' | 'io_error';

/** Reads chunks for one stream, keeping their files open between reads; see DataServer.createChunkReader. */
export interface ChunkReader {
	getChunk(lishID: LISHid, chunkID: ChunkID): Promise<ChunkReadResult>;
	/** Close every file the reader still keeps open. */
	close(): Promise<void>;
}

interface OpenChunkFile {
	readonly file: DatasetFileHandle;
	readonly size: number;
	close(): Promise<void>;
}

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

	public getChunk(lishID: LISHid, chunkID: ChunkID): Promise<ChunkReadResult> {
		return this.readChunk(lishID, chunkID, async (id, filePath) => {
			const opened = await this.openChunkFile(id, filePath);
			return { ...opened, done: () => opened.close() };
		});
	}

	/**
	 * A chunk reader for one stream of requests: it keeps the files it read open for the next
	 * chunk, instead of opening the dataset and the file, reading their size and closing both for
	 * every chunk (on Windows that is several round trips to the I/O worker). It keeps at most
	 * `maxFiles` of them, closing the least recently used one first, so a stream walking through
	 * many files cannot run the process out of file handles. Files that no read is using close
	 * `idleMs` after the last read finished — so an idle stream does not keep them locked — and on
	 * `close()`; a file is never closed under a read that is still opening or reading it.
	 * The chunk's location is still looked up for every read, so a deleted LISH or reset chunk is
	 * never served from a kept file; a moved dataset gets a new key and is opened afresh.
	 */
	createChunkReader(idleMs = 2000, maxFiles = 4): ChunkReader {
		interface KeptFile {
			readonly opened: Promise<OpenChunkFile>;
			users: number;
			dropped: boolean;
		}
		// Insertion order is use order: a used entry is moved to the end.
		const files = new Map<string, KeptFile>();
		let timer: ReturnType<typeof setTimeout> | undefined;
		// Forget the entry; its file closes once the last read using it is done.
		const drop = async (key: string, entry: KeptFile): Promise<void> => {
			if (files.get(key) === entry) files.delete(key);
			entry.dropped = true;
			if (entry.users === 0)
				await entry.opened.then(
					opened => opened.close(),
					() => {}
				);
		};
		const dropUnused = (): Promise<void[]> => Promise.all([...files.entries()].filter(([, entry]) => entry.users === 0).map(([key, entry]) => drop(key, entry)));
		return {
			getChunk: (lishID, chunkID) =>
				this.readChunk(lishID, chunkID, async (id, filePath) => {
					const key = JSON.stringify([id, this.getDatasetRoot(id) ?? getLISHMeta(this.db, id)?.directory ?? null, filePath]);
					let entry = files.get(key);
					files.delete(key);
					entry ??= { opened: this.openChunkFile(id, filePath), users: 0, dropped: false };
					files.set(key, entry);
					entry.users++;
					for (const [oldKey, oldEntry] of files) {
						if (files.size <= maxFiles) break;
						if (oldEntry.users === 0) void drop(oldKey, oldEntry);
					}
					const kept = entry;
					let opened: OpenChunkFile;
					try {
						opened = await kept.opened;
					} catch (error) {
						kept.users--;
						void drop(key, kept);
						throw error;
					}
					return {
						file: opened.file,
						size: opened.size,
						done: async failed => {
							kept.users--;
							clearTimeout(timer);
							timer = setTimeout(() => void dropUnused(), idleMs);
							timer.unref?.();
							// A failed read may mean the kept file went bad: drop it so the next read reopens it.
							if (failed || kept.dropped) await drop(key, kept);
						},
					};
				}),
			close: async () => {
				clearTimeout(timer);
				await Promise.all([...files.entries()].map(([key, entry]) => drop(key, entry)));
			},
		};
	}

	/** Open a chunk's file for reading, together with its dataset, and read the file's size. */
	private async openChunkFile(lishID: LISHid, filePath: string): Promise<OpenChunkFile> {
		const dataset = await this.openDataset(lishID);
		try {
			const file = await dataset.openFile(filePath, 'read');
			try {
				const info = await file.stat();
				return {
					file,
					size: info.size,
					close: async () => {
						try {
							await file.close();
						} finally {
							await dataset.close();
						}
					},
				};
			} catch (error) {
				await file.close();
				throw error;
			}
		} catch (error) {
			await dataset.close();
			throw error;
		}
	}

	private async readChunk(lishID: LISHid, chunkID: ChunkID, open: (lishID: LISHid, filePath: string) => Promise<{ file: DatasetFileHandle; size: number; done(failed: boolean): Promise<void> }>): Promise<ChunkReadResult> {
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
			const opened = await open(lishID, location.filePath);
			let failed = true;
			try {
				const data = await readDatasetRange(opened.file, offset, Math.max(0, Math.min(meta.chunkSize, opened.size - offset)));
				failed = false;
				return data;
			} finally {
				await opened.done(failed);
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

	public async writeChunk(downloadDir: string | DatasetRoot, lish: ILISH, fileIndex: number, chunkIndex: number, data: Uint8Array, scope?: DatasetWriteScope): Promise<void> {
		if (!Number.isSafeInteger(fileIndex) || fileIndex < 0 || !lish.files || fileIndex >= lish.files.length) throw new CodedError(ErrorCodes.INVALID_FILE_INDEX, String(fileIndex));
		const file = lish.files[fileIndex]!;
		const offset = chunkIndex * lish.chunkSize;
		const length = Math.min(lish.chunkSize, file.size - offset);
		if (!Number.isSafeInteger(lish.chunkSize) || lish.chunkSize <= 0 || !Number.isSafeInteger(file.size) || file.size < 0 || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= file.checksums.length || !Number.isSafeInteger(offset) || length <= 0 || data.length !== length) throw new CodedError(ErrorCodes.UPLOAD_INVALID_CHUNK);
		const writes = scope ?? new DatasetWriteScope();
		try {
			await writes.write(typeof downloadDir === 'string' ? conservativeDatasetRoot(downloadDir) : downloadDir, lish, this.openRoot, async dataset => {
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
			});
		} finally {
			if (!scope) await writes.close();
		}
	}
}
