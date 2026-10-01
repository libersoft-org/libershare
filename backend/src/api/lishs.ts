import { type DataServer } from '../lish/data-server.ts';
import { type ILISH, type IStoredLISH, type ILISHDetail, type ILISHListResult, type SuccessResponse, type CreateLISHResponse, type ImportLISHResponse, type LISHSortField, type SortOrder, type CompressionAlgorithm, DEFAULT_ALGO, compressionExtension, validateLISHStructure, formatSizeOverLimit, CodedError, ErrorCodes, productName } from '@shared';
import { datasetRootName, datasetRootPath, conservativeDatasetRoot } from '../lish/dataset-root.ts';
import { createLISH, exportLISHToFile, importLISHFromFile, parseLISHFromJSON, runVerification } from '../lish/lish.ts';
import { DEFAULT_CHUNK_SIZE } from '@shared';
import { Utils } from '../utils.ts';
import { type Settings, DEFAULT_MAX_CHUNK_SIZE } from '../settings.ts';
import { setBusy, clearBusy } from './busy.ts';
import { getEnabledUploads, removeUploadState, enableUpload, disableUpload } from '../protocol/lish-protocol.ts';
import { getDownloadEnabledLishs, destroyActiveDownloader, removeDownloadState, restartDownloadIfEnabled, markDownloadEnabled, stopRecoveryForLISH, forceDisableDownload } from './transfer.ts';
import { readdir, stat, access } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { openDataset, createDataset, type DatasetRoot } from '../lish/safe-dataset-files.ts';
import { deleteDatasetData, moveDatasetData } from '../lish/dataset-transfer.ts';
const assert = Utils.assertParams;
type EmitFn = (client: any, event: string, data: any) => void;
type BroadcastFn = (event: string, data: any) => void;
interface CreateLISHParams {
	name?: string;
	description?: string;
	dataPath: string;
	lishFile?: string;
	addToSharing?: boolean;
	addToDownloading?: boolean;
	chunkSize?: number;
	algorithm?: string;
	threads?: number;
	minifyJSON?: boolean;
	compress?: boolean;
	compressionAlgorithm?: CompressionAlgorithm;
}
interface ImportFromFileParams {
	filePath: string;
	downloadPath: string;
	overwrite?: boolean;
	enableSharing?: boolean;
	enableDownloading?: boolean;
}
interface ImportFromJSONParams {
	json: string;
	downloadPath: string;
	overwrite?: boolean;
	enableSharing?: boolean;
	enableDownloading?: boolean;
}
interface ImportFromURLParams {
	url: string;
	downloadPath: string;
	overwrite?: boolean;
	enableSharing?: boolean;
	enableDownloading?: boolean;
}
interface ExportToFileParams {
	lishID: string;
	filePath: string;
	minifyJSON?: boolean;
	compress?: boolean;
	compressionAlgorithm?: CompressionAlgorithm;
}
interface ExportAllToFileParams {
	filePath: string;
	minifyJSON?: boolean;
	compress?: boolean;
	compressionAlgorithm?: CompressionAlgorithm;
}
interface MoveParams {
	lishID: string;
	newDirectory: string;
	moveData: boolean;
	createSubdirectory?: boolean;
}
interface LISHsHandlers {
	list: (p?: { sortBy?: LISHSortField; sortOrder?: SortOrder }) => ILISHListResult;
	get: (p: { lishID: string }) => ILISHDetail | null;
	exportToFile: (p: ExportToFileParams) => Promise<SuccessResponse>;
	exportAllToFile: (p: ExportAllToFileParams) => Promise<SuccessResponse>;
	backup: () => IStoredLISH[];
	create: (p: CreateLISHParams, client: any) => Promise<CreateLISHResponse>;
	delete: (p: { lishID: string; deleteLISH: boolean; deleteData: boolean }) => Promise<boolean>;
	importFromFile: (p: ImportFromFileParams) => Promise<ImportLISHResponse>;
	importFromJSON: (p: ImportFromJSONParams) => Promise<ImportLISHResponse>;
	importFromURL: (p: ImportFromURLParams) => Promise<ImportLISHResponse>;
	parseFromFile: (p: { filePath: string }) => Promise<ILISH[]>;
	parseFromJSON: (p: { json: string }) => ILISH[];
	parseFromURL: (p: { url: string }) => Promise<ILISH[]>;
	verify: (p: { lishID: string }) => Promise<SuccessResponse>;
	verifyAll: () => Promise<SuccessResponse>;
	stopVerify: (p: { lishID: string }) => Promise<SuccessResponse>;
	stopVerifyAll: () => Promise<SuccessResponse>;
	stopCreate: (p?: unknown, client?: unknown) => Promise<SuccessResponse>;
	/** As {@link LISHsHandlers.stopCreate}, but for every creation at once — maintenance only. */
	stopAllCreates: () => Promise<SuccessResponse>;
	move: (p: MoveParams) => Promise<SuccessResponse>;
	startVerification: (lishID: string) => void;
	finalizeDownload: (lishID: string) => Promise<SuccessResponse>; // Move from temp to final directory after download completes
	/** Continue finalization for a transfer lifecycle admitted before mutation shutdown. */
	finalizeDownloadAdmitted: (lishID: string) => Promise<SuccessResponse>;
	importManifest: (lish: ILISH, downloadPath: string, opts?: { overwrite?: boolean; enableSharing?: boolean; enableDownloading?: boolean }) => Promise<ImportLISHResponse>; // Shared import entrypoint
	/** As {@link LISHsHandlers.importManifest}, for a caller that already holds mutation admission. */
	importManifestAdmitted: (lish: ILISH, downloadPath: string, opts?: { overwrite?: boolean; enableSharing?: boolean; enableDownloading?: boolean }) => Promise<ImportLISHResponse>;
	pauseMutations: () => Promise<void>;
	resumeMutations: () => void;
	runMutation: <T>(operation: () => Promise<T>) => Promise<T>;
}

/** Synchronous admission gate plus drain barrier for LISH state mutations. */
export class LISHMutationGate {
	private closed = false;
	private active = 0;
	private readonly drainWaiters = new Set<() => void>();

	tryEnter(): (() => void) | null {
		if (this.closed) return null;
		this.active++;
		let left = false;
		return () => {
			if (left) return;
			left = true;
			this.active--;
			if (this.active !== 0) return;
			for (const resolve of this.drainWaiters) resolve();
			this.drainWaiters.clear();
		};
	}

	async closeAndDrain(): Promise<void> {
		this.closed = true;
		if (this.active === 0) return;
		await new Promise<void>(resolve => this.drainWaiters.add(resolve));
	}

	open(): void {
		if (this.active !== 0) throw new Error('Cannot open LISH mutation admission before active operations drain');
		this.closed = false;
	}

	get isClosed(): boolean {
		return this.closed;
	}
}

export function initLISHsHandlers(dataServer: DataServer, emit: EmitFn, broadcast: BroadcastFn, settings: Settings): LISHsHandlers {
	/**
	 * Every creation admitted and not yet finished.
	 *
	 * A single slot held the last one only: two creations admitted together left the earlier
	 * one running after a stop, and whoever was waiting for the mutation gate to drain — a
	 * factory reset — waited for its whole hashing pass. This set is what maintenance stops.
	 */
	const activeCreations = new Set<AbortController>();

	/**
	 * The one creation each client's cancel button refers to — its newest.
	 *
	 * The client is part of the bookkeeping because the cancel button belongs to the screen
	 * that pressed it: picking "the newest creation" across the whole set cancelled whatever
	 * another window had started last. Searching this client's remaining creations is no good
	 * either — the progress view sends a cancel on the button and another when it unmounts, so
	 * once the cancelled one is gone the second call would land on an older creation of the
	 * same client that nobody asked to stop. An entry is therefore dropped when its creation
	 * ends, and never replaced by an older one.
	 */
	const currentCreation = new Map<unknown, AbortController>();
	const mutationAdmission = new LISHMutationGate();

	async function runMutation<T>(operation: () => Promise<T>): Promise<T> {
		const leave = mutationAdmission.tryEnter();
		if (!leave) throw new CodedError(ErrorCodes.INTERNAL_ERROR, 'LISH changes are paused during factory reset');
		try {
			return await operation();
		} finally {
			leave();
		}
	}

	function list(p?: { sortBy?: LISHSortField; sortOrder?: SortOrder }): ILISHListResult {
		return {
			items: dataServer.listSummaries(p?.sortBy, p?.sortOrder),
			verifying: currentVerification?.lishID ?? null,
			pendingVerification: [...verificationQueue],
			moving: [...movingLISHs],
			uploadEnabled: [...getEnabledUploads()],
			downloadEnabled: [...getDownloadEnabledLishs()],
		};
	}

	function get(p: { lishID: string }): ILISHDetail | null {
		assert(p, ['lishID']);
		return dataServer.getDetail(p.lishID);
	}

	async function exportToFile(p: ExportToFileParams): Promise<SuccessResponse> {
		assert(p, ['lishID', 'filePath']);
		const lish = dataServer.get(p.lishID);
		if (!lish) throw new CodedError(ErrorCodes.LISH_NOT_FOUND, p.lishID);
		// `finalDirectory` goes out with the other node-local state: it is an absolute
		// path on this machine (it carries the OS user name) and means nothing anywhere else.
		const { directory, finalDirectory, chunks, ...exportData } = lish;
		await Utils.writeJSONToFile(exportData, p.filePath, p.minifyJSON, p.compress, p.compressionAlgorithm);
		console.log(`✓ LISH exported to: ${p.filePath}`);
		return { success: true };
	}

	async function exportAllToFile(p: ExportAllToFileParams): Promise<SuccessResponse> {
		assert(p, ['filePath']);
		const lishs = dataServer.list();
		if (lishs.length === 0) throw new CodedError(ErrorCodes.NO_LISHS);
		const exportData: ILISH[] = lishs.map(lish => {
			const { directory, finalDirectory, chunks, ...data } = lish;
			return data;
		});
		await Utils.writeJSONToFile(exportData, p.filePath, p.minifyJSON, p.compress, p.compressionAlgorithm);
		console.log(`✓ All LISHs exported to: ${p.filePath}`);
		return { success: true };
	}

	function backup(): IStoredLISH[] {
		return dataServer.list();
	}

	async function create(p: CreateLISHParams, client: any): Promise<CreateLISHResponse> {
		return runMutation(() => createAdmitted(p, client));
	}

	async function createAdmitted(p: CreateLISHParams, client: any): Promise<CreateLISHResponse> {
		// Registered before the first await, not next to the hashing call that consumes it.
		// The path checks below await, and a stop arriving in that window found nothing to
		// cancel — so the operation kept its mutation permit and whoever was waiting for the
		// gate to drain (a factory reset) waited for the whole pass anyway.
		const ac = new AbortController();
		const owner = client ?? null;
		activeCreations.add(ac);
		currentCreation.set(owner, ac);
		try {
			return await createWithController(p, client, ac);
		} finally {
			activeCreations.delete(ac);
			if (currentCreation.get(owner) === ac) currentCreation.delete(owner);
		}
	}

	async function createWithController(p: CreateLISHParams, client: any, ac: AbortController): Promise<CreateLISHResponse> {
		assert(p, ['dataPath']);
		const addToSharing = p.addToSharing ?? false;
		const addToDownloading = p.addToDownloading ?? false;
		const algorithm = p.algorithm ?? DEFAULT_ALGO;
		const chunkSize = p.chunkSize ?? DEFAULT_CHUNK_SIZE;
		// Reject overly large chunkSize before the (potentially long) hashing pass.
		const maxChunkSize: number = settings.get('network.maxChunkSize') ?? DEFAULT_MAX_CHUNK_SIZE;
		// Match validateLISHStructure's contract (integer chunkSize) so a LISH this
		// version creates is always one it can also import — a fractional size would
		// pass creation/export but be rejected on import.
		if (typeof chunkSize !== 'number' || !Number.isInteger(chunkSize) || chunkSize <= 0) throw new CodedError(ErrorCodes.LISH_INVALID_CHUNK_SIZE, String(chunkSize));
		if (chunkSize > maxChunkSize) throw new CodedError(ErrorCodes.LISH_CHUNK_SIZE_TOO_LARGE, formatSizeOverLimit(chunkSize, maxChunkSize));
		const threads = p.threads ?? 0; // 0 = all CPU threads
		const minifyJSON = p.minifyJSON ?? false;
		const compress = p.compress ?? false;
		const compressionAlgorithm = p.compressionAlgorithm ?? 'gzip';
		// TODO: check that dataPath is not already in datasets.
		const dataPath = Utils.expandHome(p.dataPath);
		// Check that the path exists and is not an empty directory
		const dataPathStat = await stat(dataPath);
		// A stop arriving during that stat used to be noticed only further down, after this
		// function had read the directory anyway — a pointless pass over a large or slow one
		// that the factory reset, waiting for the mutation gate to drain, waited for.
		if (ac.signal.aborted) throw new CodedError(ErrorCodes.LISH_CREATE_CANCELLED);
		if (dataPathStat.isDirectory()) {
			const entries = await readdir(dataPath);
			if (entries.length === 0) throw new CodedError(ErrorCodes.DIRECTORY_EMPTY);
		}
		console.log(`Creating LISH from: ${dataPath}, lishFile=${p.lishFile}, addToSharing=${addToSharing}, name=${p.name}, description=${p.description}`);
		// 1. Create the LISH structure
		const lish: IStoredLISH = await createLISH(dataPath, p.name, chunkSize, algorithm as any, threads, p.description, info => emit(client, 'lishs.create:progress', info), undefined, ac.signal);
		// 2. Export to .lish(.gz) file if requested
		let resultLISHFile: string | undefined;
		if (p.lishFile) {
			let lishFilePath = Utils.expandHome(p.lishFile);
			// If the path is a directory, use [lish-id].lish(.gz) as filename
			try {
				const fileStat = await stat(lishFilePath);
				if (fileStat.isDirectory()) {
					const ext = compress ? '.lish' + compressionExtension(compressionAlgorithm) : '.lish';
					let candidate = join(lishFilePath, lish.id + ext);
					// Handle unlikely collision: append numeric suffix
					let suffix = 1;
					while (true) {
						try {
							await access(candidate);
							candidate = join(lishFilePath, lish.id + '-' + suffix + ext);
							suffix++;
						} catch {
							break; // Path doesn't exist — use it
						}
					}
					lishFilePath = candidate;
				}
			} catch {
				// Path doesn't exist yet — treat as a file path
			}
			await exportLISHToFile(lish, lishFilePath, minifyJSON, compress, compressionAlgorithm);
			resultLISHFile = lishFilePath;
		}
		// 3. Save to data-server if requested (required for both sharing and downloading)
		if (addToSharing || addToDownloading) {
			lish.directory = dataPathStat.isFile() ? dirname(dataPath) : dataPath;
			await addLISH(lish, { root: { kind: 'explicit', path: resolve(lish.directory) }, enableSharing: addToSharing, enableDownloading: addToDownloading });
		}
		return { lishID: lish.id, lishFile: resultLISHFile };
	}

	async function del(p: { lishID: string; deleteLISH: boolean; deleteData: boolean }): Promise<boolean> {
		return runMutation(() => deleteAdmitted(p));
	}

	async function deleteAdmitted(p: { lishID: string; deleteLISH: boolean; deleteData: boolean }): Promise<boolean> {
		assert(p, ['lishID']);
		const lish = dataServer.get(p.lishID);
		if (!lish) return false;
		if (p.deleteLISH) {
			// Full deletion — stop transfers, stop verification, stop recovery, clean up, delete DB row
			stopRecoveryForLISH(p.lishID);
			removeUploadState(p.lishID);
			await removeDownloadState(p.lishID);
			await stopDatasetWork(p.lishID);
			clearBusy(p.lishID);
			if (p.deleteData && lish.directory) await deleteDatasetData(lish, storedRoot(lish));
			const deleted = dataServer.delete(p.lishID);
			if (deleted) {
				console.log(`✓ LISH deleted: ${p.lishID}`);
				broadcast('lishs:remove', { lishID: p.lishID });
			}
			return deleted;
		}
		// Delete only data — use busy to temporarily block, verify, then restore original state
		if (p.deleteData && lish.directory) {
			await stopDatasetWork(p.lishID);
			setBusy(p.lishID, 'deleting');
			try { await deleteDatasetData(lish, storedRoot(lish)); } catch (error) { clearBusy(p.lishID); throw error; }
			dataServer.resetVerification(p.lishID);
			// Transition directly from 'deleting' to 'verifying' — no busy gap
			setBusy(p.lishID, 'verifying');
			enqueueVerification(p.lishID);
		}
		return true;
	}

	/**
	 * Single entry point for adding any LISH (locally created, imported from .lish/JSON/URL,
	 * or received as a manifest from a peer) into the data-server. Validates structure, persists,
	 * broadcasts, applies sharing/downloading flags, and starts verification.
	 * Caller must have already resolved `lish.directory` (and optionally `lish.finalDirectory`).
	 */
	async function addLISH(lish: IStoredLISH, opts: { root: DatasetRoot; finalRoot?: DatasetRoot; enableSharing?: boolean | undefined; enableDownloading?: boolean | undefined }): Promise<void> {
		const maxChunkSize: number = settings.get('network.maxChunkSize') ?? DEFAULT_MAX_CHUNK_SIZE;
		validateLISHStructure(lish, maxChunkSize);
		const dataset = await openDataset(opts.root);
		try { await dataset.prepare(lish, { reserve: false, writable: !!opts.enableDownloading }); } finally { await dataset.close(); }
		dataServer.addDataset(lish, opts.root, opts.finalRoot);
		console.log(`✓ LISH added: ${lish.id}${lish.finalDirectory ? ` (temp: ${lish.directory} → final: ${lish.finalDirectory})` : ''}`);
		broadcast('lishs:add', dataServer.getDetail(lish.id));
		// Set enabled flags BEFORE verification — verify sets busy which blocks triggerEnableDownload.
		// After verify completes, restartDownloadIfEnabled picks up the enabled flag automatically.
		if (opts.enableSharing) enableUpload(lish.id);
		if (opts.enableDownloading) markDownloadEnabled(lish.id);
		enqueueVerification(lish.id);
	}

	async function importCommon(lish: ILISH, downloadPath: string, overwrite: boolean, enableSharing?: boolean, enableDownloading?: boolean): Promise<ImportLISHResponse> {
		// Validate structure early to fail fast before any disk operations.
		const maxChunkSize: number = settings.get('network.maxChunkSize') ?? DEFAULT_MAX_CHUNK_SIZE;
		validateLISHStructure(lish, maxChunkSize);
		const existing = dataServer.get(lish.id);
		if (existing && !overwrite) throw new CodedError(ErrorCodes.LISH_ALREADY_EXISTS, lish.id);
		const dirName = datasetRootName(lish);
		const finalRoot: DatasetRoot = { kind: 'derived', base: resolve(Utils.expandHome(downloadPath)), component: dirName };
		const destinationBase = await openDataset({ kind: 'explicit', path: finalRoot.base }, true);
		await destinationBase.close();
		let root = finalRoot;
		if (enableDownloading) {
			const base = resolve(Utils.expandHome(settings.get('storage.tempPath') ?? `~/${productName}/temp/`));
			const tempBase = await openDataset({ kind: 'explicit', path: base }, true);
			await tempBase.close();
			for (let suffix = 0; ; suffix++) {
				root = { kind: 'derived', base, component: suffix ? `${dirName} (${suffix})` : dirName };
				try { const created = await createDataset(root); await created.close(); break; }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
			}
		} else {
			const created = await openDataset(root, true);
			await created.close();
		}
		const directory = datasetRootPath(root);
		// Construct local state explicitly; imported root choices never grant authority.
		const storedLISH: IStoredLISH = {
			id: lish.id, name: lish.name, description: lish.description, created: lish.created,
			chunkSize: lish.chunkSize, checksumAlgo: lish.checksumAlgo,
			files: lish.files ?? [], directories: lish.directories ?? [], links: lish.links ?? [],
			directory,
			...(enableDownloading ? { finalDirectory: datasetRootPath(finalRoot) } : {}),
		};
		if (existing) {
			await stopDatasetWork(lish.id);
		}
		await addLISH(storedLISH, { root, ...(enableDownloading ? { finalRoot } : {}), enableSharing, enableDownloading });
		return { lishID: lish.id, directory };
	}

	async function importFromFile(p: ImportFromFileParams): Promise<ImportLISHResponse> {
		return runMutation(() => importFromFileAdmitted(p));
	}

	async function importFromFileAdmitted(p: ImportFromFileParams): Promise<ImportLISHResponse> {
		assert(p, ['filePath', 'downloadPath']);
		const lishs = await importLISHFromFile(Utils.expandHome(p.filePath));
		let lastResponse!: ImportLISHResponse;
		for (const lish of lishs) lastResponse = await importCommon(lish, p.downloadPath, p.overwrite ?? false, p.enableSharing, p.enableDownloading);
		return lastResponse;
	}

	async function importFromJSON(p: ImportFromJSONParams): Promise<ImportLISHResponse> {
		return runMutation(() => importFromJSONAdmitted(p));
	}

	async function importFromJSONAdmitted(p: ImportFromJSONParams): Promise<ImportLISHResponse> {
		assert(p, ['json', 'downloadPath']);
		const lishs = parseLISHFromJSON(p.json);
		let lastResponse!: ImportLISHResponse;
		for (const lish of lishs) lastResponse = await importCommon(lish, p.downloadPath, p.overwrite ?? false, p.enableSharing, p.enableDownloading);
		return lastResponse;
	}

	async function importFromURL(p: ImportFromURLParams): Promise<ImportLISHResponse> {
		return runMutation(() => importFromURLAdmitted(p));
	}

	async function importFromURLAdmitted(p: ImportFromURLParams): Promise<ImportLISHResponse> {
		assert(p, ['url', 'downloadPath']);
		const content = await Utils.fetchURL(p.url);
		const lishs = parseLISHFromJSON(content);
		let lastResponse!: ImportLISHResponse;
		for (const lish of lishs) lastResponse = await importCommon(lish, p.downloadPath, p.overwrite ?? false, p.enableSharing, p.enableDownloading);
		return lastResponse;
	}

	async function parseFromFile(p: { filePath: string }): Promise<ILISH[]> {
		assert(p, ['filePath']);
		return importLISHFromFile(Utils.expandHome(p.filePath));
	}

	function parseFromJSON(p: { json: string }): ILISH[] {
		assert(p, ['json']);
		return parseLISHFromJSON(p.json);
	}

	async function parseFromURL(p: { url: string }): Promise<ILISH[]> {
		assert(p, ['url']);
		const content = await Utils.fetchURL(p.url);
		return parseLISHFromJSON(content);
	}

	// Verification queue — only one verification runs at a time during normal use.
	// Superseded runs remain tracked until their Promise settles so reset can drain them.
	interface VerificationRun {
		lishID: string;
		ac: AbortController;
		promise: Promise<void>;
	}
	let currentVerification: VerificationRun | null = null;
	const activeVerificationRuns = new Set<VerificationRun>();
	const verificationQueue: string[] = [];
	let stoppingAllVerifications = false;

	// Track LISHs currently being moved
	const movingLISHs = new Set<string>();

	function enqueueVerification(lishID: string): void {
		if (currentVerification?.lishID === lishID) return;
		if (verificationQueue.includes(lishID)) return;
		setBusy(lishID, 'verifying');
		verificationQueue.push(lishID);
		broadcast('lishs:verify', { lishID, filePath: '', verifiedChunks: 0, queued: true });
		processVerificationQueue();
	}

	function processVerificationQueue(): void {
		if (stoppingAllVerifications || currentVerification || verificationQueue.length === 0) return;
		const lishID = verificationQueue.shift()!;
		const ac = new AbortController();
		const run: VerificationRun = { lishID, ac, promise: Promise.resolve() };
		currentVerification = run;
		setBusy(lishID, 'verifying');
		broadcast('lishs:verify', { lishID, filePath: '', verifiedChunks: 0, started: true });
		let unsafe = false;
		run.promise = runVerification(dataServer, lishID, progress => broadcast('lishs:verify', progress), ac.signal)
			.catch(async error => {
				if (currentVerification !== run || ac.signal.aborted) return;
				console.error(`[Verify] ${lishID.slice(0, 8)} failed:`, error);
				if (error instanceof CodedError && error.code === ErrorCodes.LISH_UNSAFE_PATH) {
					unsafe = true;
					dataServer.setError(lishID, error.code, error.detail);
					stopRecoveryForLISH(lishID);
					disableUpload(lishID);
					dataServer.setUploadEnabled(lishID, false);
					dataServer.setDownloadEnabled(lishID, false);
					broadcast('transfer.download:error', { lishID, error: error.code, errorDetail: error.detail });
					await forceDisableDownload(lishID);
				}
			})
			.finally(() => {
				activeVerificationRuns.delete(run);
				const isOwner = currentVerification === run;
				if (isOwner) {
					clearBusy(lishID);
					if (ac.signal.aborted) broadcast('lishs:verify', { lishID, filePath: '', verifiedChunks: 0, done: true });
					currentVerification = null;
				}
				// Resume download if enabled — no-op if download not enabled or LISH deleted.
				if (isOwner && !unsafe && !ac.signal.aborted && !mutationAdmission.isClosed) restartDownloadIfEnabled(lishID);
				if (!mutationAdmission.isClosed) processVerificationQueue();
			});
		activeVerificationRuns.add(run);
	}

	function startVerification(lishID: string): void {
		const leave = mutationAdmission.tryEnter();
		if (!leave) return;
		try {
			enqueueVerification(lishID);
		} finally {
			leave();
		}
	}

	async function verify(p: { lishID: string }): Promise<SuccessResponse> {
		return runMutation(() => verifyAdmitted(p));
	}

	async function verifyAdmitted(p: { lishID: string }): Promise<SuccessResponse> {
		assert(p, ['lishID']);
		// Cancel if currently running for this LISH
		if (currentVerification?.lishID === p.lishID) {
			currentVerification.ac.abort();
			currentVerification = null;
		}
		// Remove from queue if pending
		const qIDx = verificationQueue.indexOf(p.lishID);
		if (qIDx >= 0) verificationQueue.splice(qIDx, 1);
		broadcast('lishs:verify', { lishID: p.lishID, filePath: '', verifiedChunks: 0, started: true });
		enqueueVerification(p.lishID);
		return { success: true };
	}

	async function verifyAll(): Promise<SuccessResponse> {
		return runMutation(verifyAllAdmitted);
	}

	async function verifyAllAdmitted(): Promise<SuccessResponse> {
		const allLISHs = dataServer.listSummaries(undefined, 'desc');
		for (const lish of allLISHs) {
			// Skip if already verifying or already in queue
			if (currentVerification?.lishID === lish.id) continue;
			if (verificationQueue.includes(lish.id)) continue;
			broadcast('lishs:verify', { lishID: lish.id, filePath: '', verifiedChunks: 0, started: true });
			enqueueVerification(lish.id);
		}
		return { success: true };
	}

	async function stopVerify(p: { lishID: string }): Promise<SuccessResponse> {
		return runMutation(() => stopVerifyAdmitted(p));
	}

	async function stopVerifyAdmitted(p: { lishID: string }): Promise<SuccessResponse> {
		assert(p, ['lishID']);
		clearBusy(p.lishID);
		// Stop if currently running
		if (currentVerification?.lishID === p.lishID) currentVerification.ac.abort();
		// Remove from queue if pending
		const qIDx = verificationQueue.indexOf(p.lishID);
		if (qIDx >= 0) {
			verificationQueue.splice(qIDx, 1);
			broadcast('lishs:verify', { lishID: p.lishID, filePath: '', verifiedChunks: 0, done: true });
		}
		return { success: true };
	}

	async function stopVerifyAll(): Promise<SuccessResponse> {
		stoppingAllVerifications = true;
		while (verificationQueue.length > 0) {
			const lishID = verificationQueue.shift()!;
			clearBusy(lishID);
			broadcast('lishs:verify', { lishID, filePath: '', verifiedChunks: 0, done: true });
		}
		for (const run of activeVerificationRuns) {
			clearBusy(run.lishID);
			run.ac.abort();
		}
		while (activeVerificationRuns.size > 0) await Promise.allSettled([...activeVerificationRuns].map(run => run.promise));
		currentVerification = null;
		stoppingAllVerifications = false;
		if (!mutationAdmission.isClosed) processVerificationQueue();
		return { success: true };
	}

	async function stopCreate(_p?: unknown, client?: unknown): Promise<SuccessResponse> {
		// The public cancel button: the creation this client is on, and nothing else. Another
		// window's work is not this button's to stop, and a repeated cancel — the progress view
		// sends one on the button and another when it unmounts — finds the entry already gone
		// rather than falling back to an older creation of the same client. `null` and
		// `undefined` are the same "no client": a call without one — the CLI, a local caller —
		// matches the creations started the same way.
		currentCreation.get(client ?? null)?.abort();
		return { success: true };
	}

	async function stopAllCreates(): Promise<SuccessResponse> {
		// The maintenance hook: a factory reset is about to wipe or restart everything, so it
		// cancels every creation rather than waiting out their hashing passes.
		for (const creation of activeCreations) creation.abort();
		return { success: true };
	}

	async function move(p: MoveParams): Promise<SuccessResponse> {
		return runMutation(() => moveAdmitted(p));
	}

	function storedRoot(lish: IStoredLISH, final = false): DatasetRoot {
		const directory = final ? lish.finalDirectory : lish.directory;
		if (!directory) throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'The dataset has no local directory');
		return dataServer.getDatasetRoot(lish.id, final) ?? conservativeDatasetRoot(directory);
	}

	async function stopDatasetWork(lishID: string): Promise<void> {
		const runs = [...activeVerificationRuns].filter(run => run.lishID === lishID);
		for (const run of runs) run.ac.abort();
		const index = verificationQueue.indexOf(lishID);
		if (index >= 0) verificationQueue.splice(index, 1);
		await Promise.all(runs.map(run => run.promise));
		await destroyActiveDownloader(lishID);
	}

	async function moveAdmitted(p: MoveParams): Promise<SuccessResponse> {
		assert(p, ['lishID', 'newDirectory']);
		const lish = dataServer.get(p.lishID);
		if (!lish) throw new CodedError(ErrorCodes.LISH_NOT_FOUND, p.lishID);
		if (movingLISHs.has(p.lishID)) throw new CodedError(ErrorCodes.LISH_ALREADY_EXISTS, 'A dataset move is already running');
		const base = resolve(Utils.expandHome(p.newDirectory));
		const root: DatasetRoot = p.createSubdirectory === false ? { kind: 'explicit', path: base } : { kind: 'derived', base, component: datasetRootName(lish) };
		const newDir = datasetRootPath(root);
		movingLISHs.add(p.lishID);
		try {
			await stopDatasetWork(p.lishID);
			setBusy(p.lishID, 'moving');
			broadcast('lishs:move:status', { lishID: p.lishID, moving: true });
			const commit = (): void => {
				dataServer.relocateDataset(p.lishID, root);
			};
			if (p.moveData && lish.directory) {
				await moveDatasetData(lish, storedRoot(lish), root, commit, progress => broadcast('lishs:move:progress', { lishID: p.lishID, ...progress }));
			} else {
				const target = await openDataset(root, true);
				try { await target.prepare(lish, { reserve: false, writable: true }); } finally { await target.close(); }
				commit();
			}
			broadcast('lishs:move', { lishID: p.lishID, directory: newDir });
			return { success: true };
		} finally {
			movingLISHs.delete(p.lishID);
			clearBusy(p.lishID);
			broadcast('lishs:move:status', { lishID: p.lishID, moving: false });
		}
	}

	async function finalizeDownload(lishID: string): Promise<SuccessResponse> {
		return runMutation(() => finalizeDownloadAdmitted(lishID));
	}

	async function finalizeDownloadAdmitted(lishID: string): Promise<SuccessResponse> {
		const lish = dataServer.get(lishID);
		if (!lish) throw new CodedError(ErrorCodes.LISH_NOT_FOUND, lishID);
		if (!lish.finalDirectory || !lish.directory) return { success: true };
		if (movingLISHs.has(lishID)) return { success: false };
		const targetRoot = storedRoot(lish, true);
		const finalDir = datasetRootPath(targetRoot);
		movingLISHs.add(lishID);
		setBusy(lishID, 'moving');
		broadcast('lishs:move:status', { lishID, moving: true });
		try {
			await moveDatasetData(lish, storedRoot(lish), targetRoot, () => {
				dataServer.relocateDataset(lishID, targetRoot, true);
			}, progress => broadcast('lishs:move:progress', { lishID, ...progress }));
			broadcast('lishs:move', { lishID, directory: finalDir });
			broadcast('lishs:finalize', { lishID, directory: finalDir });
			return { success: true };
		} catch (error) {
			const code = error instanceof CodedError ? error.code : (error as NodeJS.ErrnoException).code === 'EEXIST' ? ErrorCodes.LISH_ALREADY_EXISTS : ErrorCodes.IO_NOT_FOUND;
			const detail = error instanceof CodedError ? error.detail : (error as Error).message;
			dataServer.setError(lishID, code, detail);
			broadcast('lishs:finalize:error', { lishID, error: code, errorDetail: detail });
			return { success: false };
		} finally {
			movingLISHs.delete(lishID);
			clearBusy(lishID);
			broadcast('lishs:move:status', { lishID, moving: false });
		}
	}

	async function importManifest(lish: ILISH, downloadPath: string, opts?: { overwrite?: boolean; enableSharing?: boolean; enableDownloading?: boolean }): Promise<ImportLISHResponse> {
		return runMutation(() => importManifestAdmitted(lish, downloadPath, opts));
	}

	async function importManifestAdmitted(lish: ILISH, downloadPath: string, opts?: { overwrite?: boolean; enableSharing?: boolean; enableDownloading?: boolean }): Promise<ImportLISHResponse> {
		return importCommon(lish, downloadPath, opts?.overwrite ?? false, opts?.enableSharing, opts?.enableDownloading);
	}

	async function pauseMutations(): Promise<void> {
		await mutationAdmission.closeAndDrain();
	}

	function resumeMutations(): void {
		mutationAdmission.open();
	}

	return { list, get, exportToFile, exportAllToFile, backup, create, delete: del, importFromFile, importFromJSON, importFromURL, parseFromFile, parseFromJSON, parseFromURL, verify, verifyAll, stopVerify, stopVerifyAll, stopCreate, stopAllCreates, move, startVerification, finalizeDownload, finalizeDownloadAdmitted, importManifest, importManifestAdmitted, pauseMutations, resumeMutations, runMutation };
}
