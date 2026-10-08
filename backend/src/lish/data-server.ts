import { type Database } from 'bun:sqlite';
import { openDataset, type DatasetRoot, type SafeDataset } from './safe-dataset-files.ts';
import { conservativeDatasetRoot } from './dataset-root.ts';
import { DatasetWriteScope } from './dataset-write-scope.ts';
import { readDatasetRange } from './dataset-chunk-io.ts';
import type { DatasetEntryInfo, DatasetFileHandle } from './safe-dataset-types.ts';
import { getDatasetRoot as dbGetDatasetRoot, setDatasetRoot as dbSetDatasetRoot, addDataset as dbAddDataset, relocateDataset as dbRelocateDataset } from '../db/lishs-roots.ts';
import { getDatasetLinkBindings as dbGetDatasetLinkBindings, type DatasetLinkBinding } from '../db/lishs-link-bindings.ts';
import { clearLishData, clearLishnetData } from '../db/database.ts';
import { getDownloadEnabledLishs as dbGetDownloadEnabledLishs, getUploadEnabledLishs as dbGetUploadEnabledLishs, setDownloadEnabled as dbSetDownloadEnabled, setUploadEnabled as dbSetUploadEnabled } from '../db/lishs.ts';
import { type ILISH, type IStoredLISH, type ILISHSummary, type ILISHDetail, type LISHid, type ChunkID, type LISHSortField, type SortOrder, CodedError, ErrorCodes } from '@shared';
import { type AddLISHOptions, type MissingChunk, type VerificationProgress, type FileVerificationProgress, type ChunkSlot, type FileForVerification, type TransferStats, getLISH, getLISHMeta, addLISH, deleteLISH as dbDeleteLISH, updateLISHDirectory as dbUpdateLISHDirectory, updateLISHFinalDirectory as dbUpdateLISHFinalDirectory, listLISHSummaries, getLISHDetail, listAllStoredLISHs, getDatasets as dbGetDatasets, isChunkDownloaded as dbIsChunkDownloaded, markChunkDownloaded as dbMarkChunkDownloaded, isComplete as dbIsComplete, getHaveChunks as dbGetHaveChunks, getMissingChunks as dbGetMissingChunks, getAllChunkSlots as dbGetAllChunkSlots, findChunkLocation, getVerificationProgress as dbGetVerificationProgress, getFileVerificationProgress as dbGetFileVerificationProgress, markChunkVerified as dbMarkChunkVerified, markChunkFailed as dbMarkChunkFailed, markAllFileChunksFailed as dbMarkAllFileChunksFailed, resetVerification as dbResetVerification, isVerified as dbIsVerified, getFilesForVerification as dbGetFilesForVerification, incrementUploadedBytes as dbIncrementUploadedBytes, incrementDownloadedBytes as dbIncrementDownloadedBytes, getTransferStats as dbGetTransferStats, setLISHError as dbSetLISHError, clearLISHError as dbClearLISHError, resetFileChunks as dbResetFileChunks, getFileInternalID as dbGetFileInternalID } from '../db/lishs.ts';

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
	/** What the file's chosen path names now, resolved from the dataset root again; null when nothing is there. */
	statPath(): Promise<DatasetEntryInfo | null>;
	close(): Promise<void>;
}

/** Whether a file can be deleted or renamed while it is open; see DataServer.createChunkReader. */
const PATH_CAN_CHANGE_WHILE_OPEN = process.platform !== 'win32';

export class DataServer {
	private db: Database;
	private openRoot: typeof openDataset;
	private readonly chunkReaders = new Set<{ release(lishID: LISHid): Promise<void> }>();
	/** LISHs whose kept chunk files must stay closed, with how many holders want that. */
	private readonly chunkFileHolds = new Map<LISHid, number>();

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

	addDataset(lish: IStoredLISH, root: DatasetRoot, finalRoot?: DatasetRoot, options: AddLISHOptions = {}): void {
		dbAddDataset(this.db, lish, root, finalRoot, options);
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
	 * many files cannot run the process out of file handles. A file that no read is using closes
	 * `idleMs` after its own last read finished — so an idle file does not stay locked while the
	 * stream reads others — on `close()`, and on `holdChunkFiles()` for its LISH; a file is never
	 * closed under a read that is still opening or reading it.
	 * The chunk's location is still looked up for every read, so a deleted LISH or reset chunk is
	 * never served from a kept file; a moved dataset gets a new key and is opened afresh.
	 */
	createChunkReader(idleMs = 2000, maxFiles = 4): ChunkReader {
		interface KeptFile {
			readonly key: string;
			readonly lishID: LISHid;
			readonly opened: Promise<OpenChunkFile>;
			users: number;
			dropped: boolean;
			closing: boolean;
			idle?: ReturnType<typeof setTimeout>;
			/** Settles with the outcome of closing the file. */
			readonly closed: Promise<void>;
			readonly close: () => void;
		}
		// Insertion order is use order: a used entry is moved to the end.
		const files = new Map<string, KeptFile>();
		// Every file not closed yet, including dropped ones still closing: what a hold waits for.
		const unclosed = new Set<KeptFile>();
		const keep = (key: string, lishID: LISHid, opened: Promise<OpenChunkFile>): KeptFile => {
			const { promise: closed, resolve, reject } = Promise.withResolvers<void>();
			const entry: KeptFile = {
				key,
				lishID,
				opened,
				users: 0,
				dropped: false,
				closing: false,
				closed,
				close: () =>
					void opened
						.then(
							file => file.close(),
							() => {}
						)
						.then(resolve, reject),
			};
			unclosed.add(entry);
			// A close started by the idle timer or the file limit has no one awaiting it.
			closed.then(
				() => unclosed.delete(entry),
				error => {
					unclosed.delete(entry);
					console.error(`[Upload] closing a kept chunk file failed: ${error?.message ?? error}`);
				}
			);
			return entry;
		};
		// Forget the entry; its file closes once the last read using it is done.
		const drop = (entry: KeptFile): void => {
			if (files.get(entry.key) === entry) files.delete(entry.key);
			entry.dropped = true;
			clearTimeout(entry.idle);
			if (entry.users === 0 && !entry.closing) {
				entry.closing = true;
				entry.close();
			}
		};
		// Drop the matching files and wait until every one of them, and any already closing, is closed.
		const dropAll = async (match: (entry: KeptFile) => boolean): Promise<void> => {
			const entries = [...unclosed].filter(match);
			for (const entry of entries) drop(entry);
			const failed = (await Promise.allSettled(entries.map(entry => entry.closed))).find(outcome => outcome.status === 'rejected');
			if (failed) throw failed.reason;
		};
		const control = { release: (lishID: LISHid) => dropAll(entry => entry.lishID === lishID) };
		this.chunkReaders.add(control);
		return {
			getChunk: (lishID, chunkID) =>
				this.readChunk(lishID, chunkID, async (id, filePath) => {
					const key = JSON.stringify([id, this.getDatasetRoot(id) ?? getLISHMeta(this.db, id)?.directory ?? null, filePath]);
					for (;;) {
						// The dataset is being deleted or moved: read it as an uncached read would, so no handle outlives the read.
						if (this.chunkFileHolds.has(id)) {
							const opened = await this.openChunkFile(id, filePath);
							return { ...opened, done: () => opened.close() };
						}
						let entry = files.get(key);
						const reused = entry !== undefined;
						files.delete(key);
						entry ??= keep(key, id, this.openChunkFile(id, filePath));
						files.set(key, entry);
						entry.users++;
						clearTimeout(entry.idle);
						for (const oldEntry of files.values()) {
							if (files.size <= maxFiles) break;
							if (oldEntry.users === 0) drop(oldEntry);
						}
						const kept = entry;
						let opened: OpenChunkFile;
						let size: number;
						try {
							opened = await kept.opened;
							size = opened.size;
							// A kept file is the one the path named when it was opened. Check the path still names
							// it, and take its current size: a file deleted, renamed or replaced on disk must not go
							// on being served from the old handle, and one that grew must not be cut at its old size.
							// Windows refuses to delete or rename a file, or a folder above it, while it is open here,
							// so its path cannot change and the costly lookup — several I/O round trips per chunk —
							// is skipped.
							if (reused) {
								// A path that cannot be resolved now counts as changed; the fresh open below then
								// reports whatever is really wrong with it, as an uncached read would.
								const [info, atPath] = await Promise.all([opened.file.stat(), PATH_CAN_CHANGE_WHILE_OPEN ? opened.statPath().catch(() => null) : undefined]);
								if (atPath !== undefined && atPath?.identity !== info.identity) {
									kept.users--;
									drop(kept);
									continue;
								}
								size = info.size;
							}
						} catch (error) {
							kept.users--;
							drop(kept);
							throw error;
						}
						return {
							file: opened.file,
							size,
							done: async failed => {
								kept.users--;
								// A failed read may mean the kept file went bad: drop it so the next read reopens it.
								if (failed || kept.dropped) drop(kept);
								else if (kept.users === 0) {
									// Per file, so reading another file does not keep this one open.
									kept.idle = setTimeout(() => drop(kept), idleMs);
									kept.idle.unref?.();
								}
							},
						};
					}
				}),
			close: async () => {
				// Stays registered until its files are closed, so a hold started meanwhile waits for them.
				try {
					await dropAll(() => true);
				} finally {
					this.chunkReaders.delete(control);
				}
			},
		};
	}

	/**
	 * Close the files every chunk reader keeps open for this LISH, waiting for reads still using
	 * them, and read it uncached until the returned function is called. Windows refuses to delete or
	 * rename a file, or a folder above it, while it is open, so a local delete or move of the
	 * dataset must hold this for as long as it touches the files.
	 */
	async holdChunkFiles(lishID: LISHid): Promise<() => void> {
		this.chunkFileHolds.set(lishID, (this.chunkFileHolds.get(lishID) ?? 0) + 1);
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			const count = (this.chunkFileHolds.get(lishID) ?? 1) - 1;
			if (count > 0) this.chunkFileHolds.set(lishID, count);
			else this.chunkFileHolds.delete(lishID);
		};
		const failed = (await Promise.allSettled([...this.chunkReaders].map(reader => reader.release(lishID)))).find(outcome => outcome.status === 'rejected');
		if (failed) {
			release();
			throw failed.reason;
		}
		return release;
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
					// Through a freshly opened root, not the kept one: a kept root follows its folder when the
					// folder or one of its parents is moved, so it cannot tell that the chosen path changed.
					statPath: async () => {
						const current = await this.openDataset(lishID);
						try {
							return await current.statFile(filePath);
						} finally {
							await current.close();
						}
					},
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
