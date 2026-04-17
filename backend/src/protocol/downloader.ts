import { access, constants } from 'fs/promises';
import { dirname } from 'path';
import { type IStoredLISH, type LISHid, type ChunkID, CodedError, ErrorCodes } from '@shared';
import { type Network } from './network.ts';
import { downloadLimiter } from './speed-limiter.ts';
import { lishTopic } from './constants.ts';
import { Utils } from '../utils.ts';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { type HaveChunks, LISH_PROTOCOL, LISHClient } from './lish-protocol.ts';
import { Mutex } from 'async-mutex';
import { DataServer, type MissingChunk } from '../lish/data-server.ts';
import { trace } from '../logger.ts';
import { recordDownloadBytes, touchPeer } from './peer-tracker.ts';
import { PeerManager } from './peer-manager.ts';
import { FileAllocator, type AllocationProgress } from './file-allocator.ts';
import { PauseController } from './pause-controller.ts';
import { ProgressReporter, type ProgressCallback, type FileProgressEntry } from './progress-reporter.ts';

type NodeID = string;
interface PubsubMessage {
	type: 'want' | 'have';
	lishID: LISHid;
}
export interface WantMessage extends PubsubMessage {
	type: 'want';
}
export interface HaveMessage extends PubsubMessage {
	type: 'have';
	lishID: LISHid;
	peerID: NodeID;
	multiaddrs: Multiaddr[];
	chunks: HaveChunks;
}
type State = 'added' | 'initializing' | 'initialized' | 'preparing' | 'awaiting-manifest' | 'downloading' | 'downloaded' | 'error';

/**
 * Allowed state transitions for the Downloader state machine.
 *
 * Rules:
 *  - Every state can transition to 'error' at any time (via setError) — this is handled by `force: true`
 *    in transitionTo(), not by listing 'error' in every row.
 *  - Retry from 'error' can shortcut back into 'downloading' directly (files/dir already allocated).
 *  - 'preparing' appears as a target from 'downloading' for mid-download file reallocation recovery.
 *  - Attempting an invalid transition logs a warning and is a no-op (safe degradation).
 */
const ALLOWED_TRANSITIONS: Record<State, readonly State[]> = {
	'added':             ['initializing'],
	'initializing':      ['initialized'],
	'initialized':       ['awaiting-manifest', 'preparing'],
	'awaiting-manifest': ['preparing'],
	'preparing':         ['downloading', 'downloaded', 'awaiting-manifest'],
	'downloading':       ['downloaded', 'preparing'],
	'downloaded':        ['preparing'],
	'error':             ['downloading', 'preparing', 'awaiting-manifest', 'initialized'],
};

export class Downloader {
	private lish!: IStoredLISH;
	private readonly dataServer: DataServer;
	private network: Network;
	private readonly downloadDir: string;
	private readonly networkIDs: string[];
	private lishID!: LISHid;
	private state: State = 'added';
	private workMutex = new Mutex();
	private missingChunks: MissingChunk[] = [];
	private readonly peerManager = new PeerManager();
	// File allocation (zero-fill + directory layout). Stateless — only config is downloadDir;
	// it's assigned in the constructor once downloadDir is known.
	private readonly fileAllocator: FileAllocator;
	// Aborted in destroy(); passed to fileAllocator to stop in-progress zero-filling.
	private readonly abortController = new AbortController();
	private lastServingPeerCount = 0;
	private static readonly MAX_CORRUPT_CHUNKS = 3; // max corrupted chunks before banning peer
	private callForPeersInterval: ReturnType<typeof setInterval> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private needsManifest = false;
	private disabled = false;
	private destroyed = false;
	private lastExhaustedTime = 0;
	private downloadActive = false; // true while downloadChunks is running inside workMutex
	// Pause/resume coordination — owns enableResolvers, writePauseResolvers, writePaused, progressPaused.
	// Reads `disabled`/`destroyed` via callbacks so those flags remain single-source on this class.
	private readonly pauseController = new PauseController(
		() => this.disabled,
		() => this.destroyed,
	);
	private downloadResolve: (() => void) | undefined;
	private downloadReject: ((err: Error) => void) | undefined;
	private pubsubHandlers: { topic: string; handler: (data: Record<string, any>) => void }[] = [];
	// All progress accounting (speed window, per-file counters, 1s ticker, pass-through emit).
	private readonly progressReporter = new ProgressReporter();
	private onManifestImported?: (lishID: string) => void;
	private notAvailableLoggedPeers = new Set<string>(); // debug: track first not_available per peer
	private errorCode: string | undefined;
	private errorDetail: string | undefined;
	private onRetry?: (info: { errorCode: string; errorDetail?: string; retryCount: number; maxRetries: number; resolved?: boolean }) => void;
	private fileReallocAttempts = new Map<number, number>();
	private static readonly MAX_FILE_REALLOC = 3;
	private fileReallocInProgress = new Set<number>();
	private writeRetryCount = 0;
	private static readonly MAX_WRITE_RETRIES = 5;
	private static readonly WRITE_RETRY_DELAY = 60_000;

	getLISHID(): string {
		return this.lishID;
	}

	/**
	 * Central state mutation. Validates the requested transition against ALLOWED_TRANSITIONS
	 * and logs a warning (and bails) if the transition is not allowed.
	 *
	 * Pass `force: true` for emergency transitions to 'error' (setError) — these are permitted
	 * from any state and cannot fail.
	 *
	 * Returns true if the state was changed, false otherwise. Callers that rely on the old state
	 * (e.g. retry logic) MUST check the return value.
	 */
	private transitionTo(newState: State, reason: string, force: boolean = false): boolean {
		const from = this.state;
		if (from === newState) {
			// Idempotent self-transition — no-op, no log.
			return true;
		}
		if (!force) {
			const allowed = ALLOWED_TRANSITIONS[from];
			if (!allowed.includes(newState)) {
				console.warn(`[DL] ${this.lishID?.slice(0, 8) ?? '?'} invalid transition ${from} → ${newState} (${reason}), ignored`);
				return false;
			}
		}
		trace(`[DL] ${this.lishID?.slice(0, 8) ?? '?'} ${from} → ${newState} (${reason})`);
		this.state = newState;
		return true;
	}
	getError(): { code: string; detail?: string } | null {
		if (this.state !== 'error') return null;
		const err: { code: string; detail?: string } = { code: this.errorCode! };
		if (this.errorDetail !== undefined) err.detail = this.errorDetail;
		return err;
	}
	getPeerCount(): number {
		return this.lastServingPeerCount;
	}

	setProgressCallback(cb: ProgressCallback): void {
		this.progressReporter.setCallback(cb);
	}

	setManifestImportedCallback(cb: (lishID: string) => void): void {
		this.onManifestImported = cb;
	}

	setRetryCallback(cb: (info: { errorCode: string; errorDetail?: string; retryCount: number; maxRetries: number; resolved?: boolean }) => void): void {
		this.onRetry = cb;
	}

	private setError(code: string, detail?: string): void {
		this.transitionTo('error', `setError(${code})`, true);
		this.disabled = true;
		this.errorCode = code;
		this.errorDetail = detail;
		this.clearRetryTimer();
		if (this.callForPeersInterval) {
			clearInterval(this.callForPeersInterval);
			this.callForPeersInterval = undefined;
		}
		for (const { topic, handler } of this.pubsubHandlers) this.network.unsubscribeHandler(topic, handler);
		this.pubsubHandlers = [];
		// Fire-and-forget close — stream may already be reset/aborted, which is benign.
		// Log at trace so real bugs (e.g. TypeError) can still be spotted in debug logs.
		this.peerManager.closeAll('setError');
		this.lastServingPeerCount = 0;
		const total = this.dataServer.getAllChunkCount(this.lishID) || 0;
		const missing = this.dataServer.getMissingChunks(this.lishID).length;
		this.progressReporter.emit({ downloadedChunks: total - missing, totalChunks: total, peers: 0, bytesPerSecond: 0 });
		this.downloadReject?.(new CodedError(code as any, detail));
		this.downloadResolve = undefined;
		this.downloadReject = undefined;
		this.pauseController.notifyStateChange();
		console.error(`[DL] Error ${this.lishID.slice(0, 8)}: ${code}${detail ? ` — ${detail}` : ''}`);
	}

	private scheduleRetry(): void {
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			if (this.state === 'downloading' && !this.disabled)
				this.doWork().catch(e => {
					if (!(e instanceof CodedError && e.code === ErrorCodes.DOWNLOAD_CANCELLED)) console.error('[DL] doWork error:', e);
				});
		}, 10000);
	}

	private clearRetryTimer(): void {
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
	}

	disable(): void {
		this.disabled = true;
		this.clearRetryTimer();
		if (this.callForPeersInterval) {
			clearInterval(this.callForPeersInterval);
			this.callForPeersInterval = undefined;
		}
		this.peerManager.closeAll('disable');
		this.lastServingPeerCount = 0;
		this.pauseController.notifyStateChange();
		console.log(`[DL] Disabled ${this.lishID.slice(0, 8)}`);
	}

	async enable(): Promise<void> {
		// Validate download directory before resuming
		const hasChunks = this.dataServer.getAllChunkCount(this.lishID) > this.dataServer.getMissingChunks(this.lishID).length;
		const checkPath = hasChunks ? this.downloadDir : dirname(this.downloadDir);
		try {
			await access(checkPath, constants.R_OK | constants.W_OK);
		} catch (err: any) {
			const code = err.code === 'EACCES' || err.code === 'EPERM' ? ErrorCodes.DIRECTORY_ACCESS_DENIED : ErrorCodes.IO_NOT_FOUND;
			this.setError(code, this.downloadDir);
			return;
		}
		this.disabled = false;
		if (this.state === 'error') this.transitionTo(this.missingChunks.length > 0 ? 'downloading' : 'preparing', 'enable() retry from error');
		this.errorCode = undefined;
		this.errorDetail = undefined;
		this.lastExhaustedTime = 0;
		this.fileReallocAttempts.clear();
		this.writeRetryCount = 0;
		this.peerManager.clearAllDropped();
		console.log(`[DL] Enabled ${this.lishID.slice(0, 8)}`);
		this.pauseController.notifyStateChange();
		this.setupCallForPeersInterval();
		if (this.state === 'downloading' || this.state === 'awaiting-manifest' || this.state === 'preparing') {
			this.callForPeers().catch((err: any) => trace(`[DL] enable callForPeers failed (will retry): ${err?.message ?? err}`));
			this.doWork().catch(e => {
				if (!(e instanceof CodedError && e.code === ErrorCodes.DOWNLOAD_CANCELLED)) console.error('[DL] doWork error:', e);
			});
		}
	}

	isDisabled(): boolean {
		return this.disabled;
	}

	async destroy(): Promise<void> {
		console.debug(`[DL] destroy ${this.lishID.slice(0, 8)}, state=${this.state}, peers=${this.peerManager.size()}`);
		this.disabled = true;
		this.destroyed = true;
		this.abortController.abort();
		this.clearRetryTimer();
		if (this.callForPeersInterval) {
			clearInterval(this.callForPeersInterval);
			this.callForPeersInterval = undefined;
		}
		for (const { topic, handler } of this.pubsubHandlers) this.network.unsubscribeHandler(topic, handler);
		this.pubsubHandlers = [];
		await this.peerManager.closeAllAwait('destroy');
		// Notify frontend to reset peers/speed immediately
		const total = this.dataServer.getAllChunkCount(this.lishID) || 0;
		this.progressReporter.emit({ downloadedChunks: 0, totalChunks: total, peers: 0, bytesPerSecond: 0 });
		this.downloadReject?.(new CodedError(ErrorCodes.DOWNLOAD_CANCELLED));
		this.downloadResolve = undefined;
		this.downloadReject = undefined;
		this.pauseController.notifyStateChange();
		this.progressReporter.clearCallback();
		delete this.onManifestImported;
		console.log(`[DL] Destroyed ${this.lishID.slice(0, 8)}`);
	}

	private subscribePubsub(): void {
		for (const nid of this.networkIDs) {
			const topic = lishTopic(nid);
			const handler = async (data: Record<string, any>) => {
				await this.handlePubsubMessage(topic, data);
			};
			this.pubsubHandlers.push({ topic, handler });
			this.network.subscribe(topic, handler);
		}
	}

	constructor(downloadDir: string, network: Network, dataServer: DataServer, networkIDs: string | string[]) {
		this.downloadDir = downloadDir;
		this.network = network;
		this.dataServer = dataServer;
		this.networkIDs = Array.isArray(networkIDs) ? networkIDs : [networkIDs];
		this.fileAllocator = new FileAllocator(downloadDir);
	}

	async init(lishPath: string): Promise<void> {
		this.transitionTo('initializing', 'init() start');
		// Read and parse LISH
		const content = await Bun.file(lishPath).text();
		this.lish = Utils.safeJSONParse(content, `LISH file: ${lishPath}`);
		this.lishID = this.lish.id as LISHid;
		this.peerManager.setLishID(this.lishID);
		console.log(`[DL] Loading LISH: ${this.lish.name} (${this.lishID.slice(0, 8)}), ${this.dataServer.getMissingChunks(this.lishID).length} chunks to download`);
		this.missingChunks = this.dataServer.getMissingChunks(this.lishID);
		this.subscribePubsub();
		this.transitionTo('initialized', 'init() done');
	}

	async initFromManifest(lish: IStoredLISH): Promise<void> {
		this.transitionTo('initializing', 'initFromManifest() start');
		this.lish = lish;
		this.lishID = this.lish.id as LISHid;
		this.peerManager.setLishID(this.lishID);
		// Check if we already have the full manifest in DB
		const existingChunks = this.dataServer.getMissingChunks(this.lishID);
		if (existingChunks.length > 0 || this.dataServer.isCompleteLISH(lish)) {
			this.missingChunks = existingChunks;
			console.log(`[DL] Loading LISH: ${this.lish.name} (${this.lishID.slice(0, 8)}), ${this.missingChunks.length} chunks to download`);
		} else {
			this.needsManifest = true;
			console.log(`[DL] Loading LISH: ${this.lish.name} (${this.lishID.slice(0, 8)}), awaiting manifest from peer`);
		}
		this.subscribePubsub();
		this.transitionTo('initialized', 'initFromManifest() done');
	}

	// Main download loop — returns only when fully downloaded (or throws on error)
	async download(): Promise<void> {
		trace(`[DL] download() state=${this.state}, destroyed=${this.destroyed}, disabled=${this.disabled}`);
		if (this.state !== 'initialized') throw new CodedError(ErrorCodes.DOWNLOADER_NOT_INITIALIZED);
		if (this.needsManifest) {
			this.transitionTo('awaiting-manifest', 'download() needs manifest');
			await this.callForPeers();
		} else {
			this.transitionTo('preparing', 'download() has manifest');
			trace(`[DL] calling doWork, state=${this.state}`);
			await this.doWork();
			trace(`[DL] doWork returned, state=${this.state}, peers=${this.peerManager.size()}`);
		}
		// Wait until state reaches 'downloaded' — doWork may change state asynchronously
		if ((this.state as State) !== 'downloaded') {
			await new Promise<void>((resolve, reject) => {
				this.downloadResolve = resolve;
				this.downloadReject = reject;
			});
		}
	}

	async doWork(): Promise<void> {
		if (this.destroyed) return;
		// Throttle: don't re-enter within 10s of last exhausted cycle
		if (this.lastExhaustedTime > 0 && Date.now() - this.lastExhaustedTime < 10000) {
			trace(`[DL] doWork throttled (${Math.round((Date.now() - this.lastExhaustedTime) / 1000)}s since exhaust)`);
			return;
		}
		// Skip if downloadChunks is already running — new peers get picked up dynamically
		if (this.workMutex.isLocked()) {
			trace(`[DL] doWork skipped — workMutex locked`);
			return;
		}
		await this.workMutex.runExclusive(async () => {
			// Phase 1: fetch manifest from a peer if needed
			if (this.state === 'awaiting-manifest') {
				if (this.peerManager.size() === 0) return;
				for (const [, client] of this.peerManager.entries()) {
					let manifest: import('@shared').IStoredLISH | null = null;
					try {
						manifest = await client.requestManifest(this.lishID);
					} catch (error: any) {
						console.warn(`[DL] Manifest request failed: ${error.message?.slice(0, 120) ?? error}`);
					}
					if (manifest && manifest.files && manifest.files.length > 0) {
						this.lish = { ...manifest, directory: this.downloadDir };
						this.dataServer.add(this.lish);
						this.onManifestImported?.(this.lishID);
						this.missingChunks = this.dataServer.getMissingChunks(this.lishID);
						this.needsManifest = false;
						console.log(`[DL] Got manifest: ${manifest.files.length} files, ${this.missingChunks.length} chunks`);
						this.transitionTo('preparing', 'doWork() got manifest');
						break;
					}
				}
				if (this.needsManifest) return;
			}
			// Phase 2: create directory structure (skip if already has downloaded chunks — files already allocated)
			if (this.state === 'preparing') {
				// Validate download directory: if resuming (some chunks exist), check the dir itself;
				// for fresh downloads, check parent (dir will be created by mkdir)
				const hasDownloadedChunks = this.dataServer.getAllChunkCount(this.lishID) > this.dataServer.getMissingChunks(this.lishID).length;
				const checkPath = hasDownloadedChunks ? this.downloadDir : dirname(this.downloadDir);
				try {
					await access(checkPath, constants.R_OK | constants.W_OK);
				} catch (err: any) {
					const code = err.code === 'EACCES' || err.code === 'EPERM' ? ErrorCodes.DIRECTORY_ACCESS_DENIED : ErrorCodes.IO_NOT_FOUND;
					this.setError(code, this.downloadDir);
					return;
				}
				const totalChunksForProgress = this.dataServer.getAllChunkCount(this.lishID) || this.missingChunks.length;
				const downloadedForProgress = totalChunksForProgress - this.missingChunks.length;
				console.debug(`[DL] preparing ${this.lishID.slice(0, 8)}: ${downloadedForProgress}/${totalChunksForProgress}, missing=${this.missingChunks.length}`);
				// Empty-manifest recovery: if the LISH has no file metadata and the DB has no chunks,
				// we need a manifest re-fetch before we can do anything else. (Was the side-effect
				// inside the former needsFileAllocation() — kept here to preserve control flow.)
				if ((!this.lish.files || this.lish.files.length === 0) && this.dataServer.getAllChunkCount(this.lishID) === 0) {
					console.warn(`[DL] ${this.lishID.slice(0, 8)}: no files in manifest or DB, requesting manifest from peers`);
					this.needsManifest = true;
					this.transitionTo('awaiting-manifest', 'doWork phase 2: empty manifest, re-fetch');
				}
				const missingBeforeAlloc = await this.fileAllocator.findMissingFiles(this.lish);
				if (missingBeforeAlloc.length > 0) {
					console.debug(`[DL] allocating files for ${this.lishID.slice(0, 8)}`);
					this.progressReporter.emit({ downloadedChunks: 0, totalChunks: totalChunksForProgress, peers: 0, bytesPerSecond: 0, filePath: '__allocating__' });
					await this.fileAllocator.allocateStructure(this.lish, (p: AllocationProgress) => this.emitAllocProgress(p, totalChunksForProgress), this.abortController.signal);
					if (this.destroyed) return;
				} else {
					trace(`[DL] skipping allocation for ${this.lishID.slice(0, 8)} (files exist)`);
				}
				trace(`[DL] phase 2 done: ${this.lishID.slice(0, 8)}`);
				this.progressReporter.emit({ downloadedChunks: downloadedForProgress, totalChunks: totalChunksForProgress, peers: 0, bytesPerSecond: 0 });
				this.transitionTo('downloading', 'doWork() phase 2 complete');
			}
			// Phase 3: download chunks
			if (this.state === 'downloading') {
				if (this.missingChunks.length === 0) {
					const missingFileIndexes = await this.fileAllocator.findMissingFiles(this.lish);
					if (missingFileIndexes.length === 0) {
						console.log(`[DL] Complete: ${this.lishID.slice(0, 8)}`);
						this.transitionTo('downloaded', 'doWork() all chunks present');
						this.downloadResolve?.();
						return;
					}
					// Reset only the missing files' chunks (surgical, not full manifest re-fetch)
					console.warn(`[DL] ${this.lishID.slice(0, 8)}: ${missingFileIndexes.length} files missing on disk, resetting their chunks`);
					for (const fi of missingFileIndexes) {
						await this.fileAllocator.allocateFile(this.lish, fi, this.abortController.signal);
						this.dataServer.resetFileChunks(this.lishID, fi);
					}
					this.missingChunks = this.dataServer.getMissingChunks(this.lishID);
					// Continue downloading the reset chunks
				}
				if (this.peerManager.size() === 0) {
					console.debug(`[DL] no peers, calling for peers (banned: ${this.peerManager.bannedSize()})`);
					await this.callForPeers();
					// Wait briefly for have responses via GossipSub before giving up
					if (this.peerManager.size() === 0) await new Promise(r => setTimeout(r, 2000));
					if (this.peerManager.size() === 0) {
						console.debug(`[DL] no peers found, retry in 10s`);
						this.lastExhaustedTime = Date.now();
						this.scheduleRetry();
						return;
					}
				}
				if (this.peerManager.size() !== 0) {
					this.downloadActive = true;
					try {
						await this.downloadChunks();
					} finally {
						this.downloadActive = false;
					}
					const remaining = this.dataServer.getMissingChunks(this.lishID);
					if (remaining.length === 0) {
						const missingFiles = await this.fileAllocator.findMissingFiles(this.lish);
						if (missingFiles.length === 0) {
							console.log(`[DL] Complete: ${this.lishID.slice(0, 8)}`);
							this.transitionTo('downloaded', 'doWork() complete after downloadChunks');
							this.downloadResolve?.();
							return;
						}
						console.warn(`[DL] ${this.lishID.slice(0, 8)}: ${missingFiles.length} files missing on disk after downloadChunks, resetting`);
						for (const fi of missingFiles) {
							await this.fileAllocator.allocateFile(this.lish, fi, this.abortController.signal);
							this.dataServer.resetFileChunks(this.lishID, fi);
						}
						// Fall through to retry with reset chunks
					}
					console.log(`[DL] ${remaining.length} chunks missing, retrying in 10s`);
					this.peerManager.closeAll('doWork retry');
					this.lastExhaustedTime = Date.now();
					this.scheduleRetry();
					return;
				}
			}
		});
	}

	static setMaxDownloadSpeed(kbPerSec: number): void {
		downloadLimiter.setLimit(kbPerSec);
	}

	private async downloadChunks(): Promise<void> {
		const missingChunks = this.dataServer.getMissingChunks(this.lishID);
		const allChunks = this.dataServer.getAllChunkCount(this.lishID);
		const totalChunks = allChunks > 0 ? allChunks : missingChunks.length;
		let downloadedCount = totalChunks - missingChunks.length;
		console.log(`[DL] downloadChunks: ${missingChunks.length} missing, ${totalChunks} total, ${this.peerManager.size()} peers`);
		this.notAvailableLoggedPeers.clear();

		if (this.peerManager.size() === 0) return;

		// Shared queue — peers pull chunks concurrently
		const queue = [...missingChunks];
		let queueIdx = 0;
		const lock = new Mutex();
		// Track all peerLoop promises so we can await dynamically spawned ones
		const peerLoopPromises = new Map<string, Promise<void>>();

		const corruptCount = new Map<string, number>(); // per-peer corruption counter
		let globalNotAvailable = 0; // consecutive not_available across all peers — reset on any success
		// Seed per-file counters from DB verification state. Reporter owns the fileDownloadedChunks map,
		// lastFilePath/lastFileChunks pointers, sliding speed window and the 1s ticker.
		this.progressReporter.resetSession();
		this.progressReporter.loadFileProgress(this.buildFileProgressEntries());

		const spawnPeerLoop = (peerID: string, client: LISHClient): void => {
			// Safety dedup: onPeerAdded callback fires once per tryAdd, but protects against
			// double-spawn if a peer somehow re-adds while its previous loop is still teardown-ing.
			if (this.peerManager.isActive(peerID)) return;
			console.log(`[DL] Peer ${peerID.slice(0, 12)} joined (total: ${this.peerManager.size()})`);
			// peerLoop should not throw — catch is a safety net for unexpected bugs (state race, type errors, etc.).
			// A silently crashed peer loop would leave the peer in peerManager but not actually downloading,
			// causing the download to stall. So log loudly AND remove the peer.
			const p = peerLoop(peerID, client).catch((err: any) => {
				console.error(`[DL] peerLoop CRASHED for ${peerID.slice(0, 12)}:`, err);
				this.peerManager.remove(peerID, 'disconnect');
			});
			peerLoopPromises.set(peerID, p);
		};

		const peerLoop = async (peerID: string, client: LISHClient): Promise<void> => {
			this.peerManager.markActive(peerID);
			let skippedChunks = 0;
			let consecutiveNotAvailable = 0;
			while (true) {
				if (this.destroyed || this.disabled) break;
				await this.pauseController.waitIfDisabled();
				await this.pauseController.waitIfWritePaused();
				let chunk: MissingChunk | undefined;
				await lock.runExclusive(() => {
					while (queueIdx < queue.length) {
						const candidate = queue[queueIdx++];
						// Skip chunks already downloaded (dedup re-queued entries)
						if (!this.dataServer.isChunkDownloaded(this.lishID, candidate!.chunkID)) {
							chunk = candidate;
							break;
						}
					}
				});
				if (!chunk) break;

				// Throttle BEFORE downloading — ensures bandwidth is reserved before network transfer
				touchPeer(this.lishID, peerID, 'download');
				// console.debug(`[DL] throttle chunkSize=${this.lish.chunkSize} peer=${peerID.slice(0, 12)}`);
				await downloadLimiter.throttle(this.lish.chunkSize);
				const result = await this.downloadChunk(client, chunk.chunkID, peerID);
				if (result === 'drop-peer') {
					// Peer unusable for this session (no LISH / unreachable / invalid / unknown error).
					// Soft quarantine in droppedPeers — peer can come back via pubsub 'have' or ~5min cyclic reset.
					console.log(`[DL] Peer ${peerID.slice(0, 12)} dropped to droppedPeers`);
					await this.peerManager.removeAwait(peerID, 'drop');
					await lock.runExclusive(() => {
						queue.push(chunk!);
					});
					break;
				}
				if (result === 'skip-chunk') {
					skippedChunks++;
					globalNotAvailable++;
					consecutiveNotAvailable++;
					if (skippedChunks % 500 === 0) trace(`[DL] Peer ${peerID.slice(0, 12)} skipped ${skippedChunks} chunks (skip-chunk, consecutive: ${consecutiveNotAvailable}, global: ${globalNotAvailable}/${queue.length})`);
					await lock.runExclusive(() => {
						queue.push(chunk!);
					});
					if (this.disabled || this.destroyed) break;
					// Per-peer: disconnect if peer has nothing useful (10 consecutive skip-chunk)
					if (consecutiveNotAvailable >= 10) {
						console.log(`[DL] Peer ${peerID.slice(0, 12)} dropped: ${consecutiveNotAvailable} consecutive skip-chunk`);
						await this.peerManager.removeAwait(peerID, 'drop');
						break;
					}
					if (globalNotAvailable > queue.length) {
						console.debug(`[DL] Peer ${peerID.slice(0, 12)} exhausted (${globalNotAvailable} skip-chunk)`);
						break;
					}
					continue;
				}
				// Verify chunk integrity before writing
				const data = result.data;
				const hasher = new Bun.CryptoHasher(this.lish.checksumAlgo as any);
				hasher.update(data);
				const actualHash = hasher.digest('hex');
				if (actualHash !== chunk.chunkID) {
					const count = (corruptCount.get(peerID) ?? 0) + 1;
					corruptCount.set(peerID, count);
					console.log(`[DL] Corrupt chunk from ${peerID.slice(0, 12)}: expected ${chunk.chunkID.slice(0, 12)}, got ${actualHash.slice(0, 12)} (${count}/${Downloader.MAX_CORRUPT_CHUNKS})`);
					await lock.runExclusive(() => {
						queue.push(chunk!);
					});
					if (count >= Downloader.MAX_CORRUPT_CHUNKS) {
						console.log(`[DL] Peer ${peerID.slice(0, 12)} banned: ${count} corrupt chunks`);
						await this.peerManager.removeAwait(peerID, 'ban');
						break;
					}
					continue;
				}
				// Integrity OK — write chunk
				skippedChunks = 0;
				consecutiveNotAvailable = 0;
				globalNotAvailable = 0;

				try {
					await this.dataServer.writeChunk(this.downloadDir, this.lish, chunk.fileIndex, chunk.chunkIndex, data);
				} catch (err: any) {
					if (err.code === 'ENOENT') {
						// File deleted — pause ALL peers, verify ALL files, re-allocate missing, reset chunks, resume
						if (this.fileReallocInProgress.size > 0) {
							// Another peer is already handling recovery — wait and re-queue
							await this.pauseController.waitIfWritePaused();
							await lock.runExclusive(() => {
								queue.push(chunk!);
							});
							continue;
						}
						const globalAttempts = (this.fileReallocAttempts.get(-1) ?? 0) + 1;
						this.fileReallocAttempts.set(-1, globalAttempts);
						if (globalAttempts > Downloader.MAX_FILE_REALLOC) {
							console.error(`[DL] Global file recovery limit (${Downloader.MAX_FILE_REALLOC}) exceeded`);
							this.setError(ErrorCodes.IO_NOT_FOUND, this.downloadDir);
							break;
						}
						// Mark recovery in progress, pause all peer writes AND progress emissions
						this.fileReallocInProgress.add(-1);
						this.pauseController.pauseWrites();
						this.pauseController.pauseProgress();
						this.progressReporter.resetLastFile();
						console.warn(`[DL] File deleted detected, pausing all transfers for 10s before recovery (attempt ${globalAttempts}/${Downloader.MAX_FILE_REALLOC})`);
						this.onRetry?.({ errorCode: ErrorCodes.IO_NOT_FOUND, errorDetail: this.downloadDir, retryCount: globalAttempts, maxRetries: Downloader.MAX_FILE_REALLOC });
						// FE shows "Opakuji" (retrying) badge during the 10s pause — no progress override
						// 10s delay — let the user finish deleting files before we scan
						await new Promise<void>(resolve => {
							const timer = setTimeout(resolve, 10_000);
							const check = setInterval(() => {
								if (this.destroyed || this.disabled) {
									clearTimeout(timer);
									clearInterval(check);
									resolve();
								}
							}, 1000);
							setTimeout(() => clearInterval(check), 10_100);
						});
						if (this.destroyed || this.disabled) break;
						try {
							console.log(`[DL] Recovery: verifying all files`);

							// Step 2: Find and re-allocate missing files with progress
							const missingFiles = await this.fileAllocator.findMissingFiles(this.lish);
							if (missingFiles.length > 0) {
								const totalMissingBytes = missingFiles.reduce((sum, fi) => sum + (this.lish.files?.[fi]?.size ?? 0), 0);
								console.log(`[DL] ${missingFiles.length} files missing (${Math.round(totalMissingBytes / 1024 / 1024)}MB), allocating`);
								this.progressReporter.emit({ downloadedChunks: 0, totalChunks, peers: 0, bytesPerSecond: 0, filePath: '__allocating__', fileDownloadedChunks: 0 });
								await this.fileAllocator.allocateFiles(this.lish, missingFiles, (p: AllocationProgress) => this.emitAllocProgress(p, totalChunks), this.abortController.signal);
							}

							// Step 3: Full verification of ALL files — checksum every chunk
							if (this.lish.files && !this.destroyed) {
								console.log(`[DL] Verifying ALL file checksums...`);
								this.progressReporter.emit({ downloadedChunks: 0, totalChunks, peers: 0, bytesPerSecond: 0, filePath: '__verifying__' });
								const { runVerification } = await import('../lish/lish.ts');
								const ac = new AbortController();
								let lastVerified = 0;
								let lastVerifyEmit = 0;
								await runVerification(
									this.dataServer,
									this.lishID,
									progress => {
										lastVerified = progress.verifiedChunks ?? 0;
										const now = Date.now();
										if (now - lastVerifyEmit >= 1000) {
											lastVerifyEmit = now;
											this.progressReporter.emit({ downloadedChunks: lastVerified, totalChunks, peers: 0, bytesPerSecond: 0, filePath: '__verifying__' });
										}
									},
									ac.signal
								);
								this.progressReporter.emit({ downloadedChunks: lastVerified, totalChunks, peers: 0, bytesPerSecond: 0, filePath: '__verifying__' });
								console.log(`[DL] Verification done: ${lastVerified}/${totalChunks} chunks valid`);
							}

							// Step 4: Rebuild queue from verified state
							const allMissing = this.dataServer.getMissingChunks(this.lishID);
							const allTotal = this.dataServer.getAllChunkCount(this.lishID) || totalChunks;
							downloadedCount = allTotal - allMissing.length;
							// Re-initialize per-file counters from verified DB state
							this.progressReporter.loadFileProgress(this.buildFileProgressEntries());
							await lock.runExclusive(() => {
								queue.length = queueIdx;
								for (const mc of allMissing) queue.push(mc);
							});
							this.progressReporter.emit({ downloadedChunks: downloadedCount, totalChunks: allTotal, peers: this.peerManager.size(), bytesPerSecond: 0 });
							console.log(`[DL] Recovery complete: ${downloadedCount}/${allTotal} verified, ${allMissing.length} to download`);
						} catch (allocErr: any) {
							console.error(`[DL] File recovery failed: ${allocErr.message}`);
							this.setError(ErrorCodes.IO_NOT_FOUND, this.downloadDir);
							break;
						} finally {
							this.fileReallocInProgress.delete(-1);
							this.pauseController.resumeProgress();
							this.pauseController.resumeWrites();
						}
						this.onRetry?.({ errorCode: ErrorCodes.IO_NOT_FOUND, errorDetail: this.downloadDir, retryCount: globalAttempts, maxRetries: Downloader.MAX_FILE_REALLOC, resolved: true });
						continue;
					} else if (err.code === 'ENOSPC' || err.code === 'EACCES' || err.code === 'EPERM') {
						// Disk full or permission denied — inline retry with pause
						const code = err.code === 'ENOSPC' ? ErrorCodes.DISK_FULL : ErrorCodes.DIRECTORY_ACCESS_DENIED;
						if (this.pauseController.writePaused) {
							// Another peer already handling the write error — just wait and re-queue
							await this.pauseController.waitIfWritePaused();
							await lock.runExclusive(() => {
								queue.push(chunk!);
							});
							continue;
						}
						this.writeRetryCount++;
						if (this.writeRetryCount > Downloader.MAX_WRITE_RETRIES) {
							console.error(`[DL] Write retry limit (${Downloader.MAX_WRITE_RETRIES}) exceeded for ${this.lishID.slice(0, 8)}`);
							this.setError(code, this.downloadDir);
							break;
						}
						console.warn(`[DL] ${this.lishID.slice(0, 8)}: write failed (${err.code}), pausing ${Downloader.WRITE_RETRY_DELAY / 1000}s (attempt ${this.writeRetryCount}/${Downloader.MAX_WRITE_RETRIES})`);
						this.onRetry?.({ errorCode: code, errorDetail: this.downloadDir, retryCount: this.writeRetryCount, maxRetries: Downloader.MAX_WRITE_RETRIES });
						this.pauseController.pauseWrites();
						await new Promise<void>(resolve => {
							const timer = setTimeout(resolve, Downloader.WRITE_RETRY_DELAY);
							const check = setInterval(() => {
								if (this.destroyed || this.disabled) {
									clearTimeout(timer);
									clearInterval(check);
									resolve();
								}
							}, 1000);
							setTimeout(() => clearInterval(check), Downloader.WRITE_RETRY_DELAY + 100);
						});
						if (this.destroyed || this.disabled) break;
						try {
							await this.dataServer.writeChunk(this.downloadDir, this.lish, chunk.fileIndex, chunk.chunkIndex, data);
							console.log(`[DL] Write retry succeeded for ${this.lishID.slice(0, 8)}`);
							this.writeRetryCount = 0;
							this.pauseController.resumeWrites();
							this.onRetry?.({ errorCode: code, errorDetail: this.downloadDir, retryCount: 0, maxRetries: Downloader.MAX_WRITE_RETRIES, resolved: true });
						} catch (retryErr: any) {
							console.warn(`[DL] ${this.lishID.slice(0, 8)}: write retry still failed (attempt ${this.writeRetryCount}/${Downloader.MAX_WRITE_RETRIES}): ${retryErr.code ?? retryErr.message}`);
							this.pauseController.resumeWrites();
							await lock.runExclusive(() => {
								queue.push(chunk!);
							});
							continue;
						}
					} else {
						this.setError(ErrorCodes.DOWNLOAD_ERROR, err.message);
						break;
					}
				}
				this.dataServer.markChunkDownloaded(this.lishID, chunk.chunkID);
				this.dataServer.incrementDownloadedBytes(this.lishID, data.length);
				recordDownloadBytes(this.lishID, peerID, data.length, this.lish.files?.[chunk.fileIndex]?.path, chunk.chunkID);
				downloadedCount++;
				if (this.writeRetryCount > 0) this.writeRetryCount = 0;
				const fIdx = chunk.fileIndex;
				this.progressReporter.recordChunk(data.length, fIdx, this.lish.files?.[fIdx]?.path);
				if (downloadedCount % 50 === 0 || downloadedCount === totalChunks) {
					const bytesPerSecond = this.progressReporter.bytesPerSecond();
					console.log(`[DL] ${downloadedCount}/${totalChunks} verified, ${this.peerManager.size()} peers, ${Math.round(bytesPerSecond / 1024)}KB/s`);
				}
			}
			this.peerManager.markInactive(peerID);
		};

		// 1s periodic progress emitter — reporter owns the sliding window + emit; getSnapshot supplies
		// the values that live on the Downloader local scope (downloadedCount, totalChunks, peer count).
		this.progressReporter.startTicker(() => ({
			downloadedChunks: downloadedCount,
			totalChunks,
			peers: this.peerManager.size(),
			paused: this.pauseController.progressPaused,
		}));

		try {
			// Wire dynamic spawn: any peer added to peerManager (via tryAdd from pubsub / probe)
			// fires this callback and gets its own peerLoop. Replaces the old poll-based spawnNewPeerLoops.
			this.peerManager.setCallbacks({ onPeerAdded: spawnPeerLoop });

			const initialPeers = this.peerManager.snapshot();
			console.log(`[DL] Starting: ${totalChunks} chunks from ${initialPeers.length} peer(s)`);
			for (const [peerID, client] of initialPeers) spawnPeerLoop(peerID, client);
			// Wait until all peer loops (including dynamically spawned ones) settle
			while (peerLoopPromises.size > 0) {
				const current = [...peerLoopPromises.entries()];
				await Promise.all(current.map(([, p]) => p));
				for (const [id] of current) peerLoopPromises.delete(id);
			}
			console.debug(`[DL] downloadChunks done: ${downloadedCount}/${totalChunks}`);
			if (downloadedCount < totalChunks) {
				console.log(`[DL] Peers exhausted at ${downloadedCount}/${totalChunks}, will retry`);
			}
		} finally {
			this.progressReporter.stopTicker();
			// Unwire spawn BEFORE closing — avoids spawning a loop for a peer we're about to tear down.
			this.peerManager.clearCallbacks();
			await this.peerManager.closeAllAwait('downloadChunks finally');
			this.lastServingPeerCount = 0;
			// Reset frontend peers/speed immediately when all peer loops finish
			this.progressReporter.emit({ downloadedChunks: downloadedCount, totalChunks, peers: 0, bytesPerSecond: 0 });
		}
	}

	private async callForPeers() {
		console.debug(`[DL] callForPeers: ${this.lishID.slice(0, 8)} on ${this.networkIDs.length} networks, peers: ${this.peerManager.size()}`);
		// GossipSub broadcast — peers respond with have+multiaddrs via handlePubsubMessage → connectToPeer
		const msg: PubsubMessage = { type: 'want', lishID: this.lishID };
		for (const nid of this.networkIDs) {
			await this.network.broadcast(lishTopic(nid), msg).catch((err: any) => trace(`[DL] broadcast WANT on ${nid}: ${err?.message ?? err}`));
		}
		// probeTopicPeers runs only via 15s interval (setupCallForPeersInterval), not here — avoids stale stream issues
		trace(`[DL] callForPeers done: ${this.peerManager.size()} peers`);
		this.setupCallForPeersInterval();
	}

	private async probeTopicPeers(): Promise<void> {
		if (this.destroyed) return;
		const topicPeers = new Set<string>();
		for (const nid of this.networkIDs) {
			for (const p of this.network.getTopicPeers(nid)) topicPeers.add(p);
		}
		console.debug(`[DL] probeTopicPeers: ${topicPeers.size} topic, ${this.peerManager.size()} connected, ${this.peerManager.bannedSize()} banned`);
		let foundNew = false;
		for (const peerID of topicPeers) {
			if (this.destroyed) return;
			if (this.peerManager.has(peerID)) {
				trace(`[DL] probe skip ${peerID.slice(0, 12)}: connected`);
				continue;
			}
			if (this.peerManager.isBanned(peerID)) {
				trace(`[DL] probe skip ${peerID.slice(0, 12)}: banned`);
				continue;
			}
			if (this.peerManager.isDropped(peerID)) {
				trace(`[DL] probe skip ${peerID.slice(0, 12)}: dropped`);
				continue;
			}
			try {
				trace(`[DL] probing ${peerID.slice(0, 12)}`);
				const { stream: probeStream } = await this.network.dialProtocolByPeerId(peerID, LISH_PROTOCOL);
				if (this.destroyed) {
					probeStream.abort(new Error('downloader destroyed'));
					return;
				}
				const probeClient = new LISHClient(probeStream);
				let manifest: import('@shared').IStoredLISH | null = null;
				try {
					manifest = await probeClient.requestManifest(this.lishID);
				} catch (error: any) {
					console.debug(`[DL] probe ${peerID.slice(0, 12)}: manifest error ${error.code ?? error.message?.slice(0, 60) ?? error}`);
					this.peerManager.remove(peerID, 'drop');
				}
				await probeClient.close();
				if (this.destroyed) return;

				if (!manifest) {
					this.peerManager.remove(peerID, 'drop');
					continue;
				}

				if (this.needsManifest && manifest.files && manifest.files.length > 0) {
					// Protect manifest import with workMutex to prevent race with doWork()
					await this.workMutex.runExclusive(async () => {
						if (!this.needsManifest) return; // double-check after acquiring lock
						this.lish = { ...manifest, directory: this.downloadDir };
						this.dataServer.add(this.lish);
						this.onManifestImported?.(this.lishID);
						this.missingChunks = this.dataServer.getMissingChunks(this.lishID);
						this.needsManifest = false;
						this.transitionTo('preparing', 'probeTopicPeers() got manifest');
						console.log(`[DL] Got manifest from ${peerID.slice(0, 12)}: ${manifest.files?.length ?? 0} files, ${this.missingChunks.length} chunks`);
					});
				}

				const { stream: dlStream, connectionType } = await this.network.dialProtocolByPeerId(peerID, LISH_PROTOCOL);
				if (this.destroyed) {
					dlStream.abort(new Error('downloader destroyed'));
					return;
				}
				// Atomic add — if handlePubsubMessage concurrently added this peer during our dial,
				// tryAdd returns false and we close the duplicate stream. No check-then-act race.
				const dlClient = new LISHClient(dlStream);
				if (!this.peerManager.tryAdd(peerID, dlClient, connectionType)) {
					await dlClient.close().catch((err: any) => trace(`[DL] probe duplicate close: ${err?.message ?? err}`));
					trace(`[DL] probe ${peerID.slice(0, 12)}: already connected, closing duplicate`);
					continue;
				}
				this.lastExhaustedTime = 0;
				foundNew = true;
				console.debug(`[DL] probe: ${peerID.slice(0, 12)} connected [${connectionType}] (total: ${this.peerManager.size()})`);
			} catch (err: any) {
				console.debug(`[DL] probe ${peerID.slice(0, 12)} unreachable: ${err.message?.slice(0, 80)}`);
			}
		}
		if (foundNew && !this.downloadActive && !this.destroyed) {
			this.doWork().catch(e => {
				if (!(e instanceof CodedError && e.code === ErrorCodes.DOWNLOAD_CANCELLED)) console.error('[DL] doWork error:', e);
			});
		}
	}

	private setupCallForPeersInterval() {
		if (this.callForPeersInterval) return;
		this.callForPeersInterval = setInterval(async () => {
			if (this.destroyed) {
				clearInterval(this.callForPeersInterval);
				this.callForPeersInterval = undefined;
				return;
			}
			if (this.state === 'downloaded') {
				clearInterval(this.callForPeersInterval);
				this.callForPeersInterval = undefined;
				return;
			}
			if (this.state !== 'downloading' && this.state !== 'awaiting-manifest') return;
			const before = this.peerManager.size();
			// NOTE: bannedPeers is NEVER cleared here — bans are persistent for the app session.
			this.peerManager.tickCycleAndMaybeReset(); // re-check every ~5 min
			this.lastExhaustedTime = 0;
			// Broadcast want so all peers (including probe-only) respond with have + chunk availability
			await this.callForPeers().catch((err: any) => trace(`[DL] interval callForPeers failed (will retry): ${err?.message ?? err}`));
			await this.probeTopicPeers();
			if (!this.downloadActive && !this.destroyed && this.peerManager.size() > before)
				this.doWork().catch(e => {
					if (!(e instanceof CodedError && e.code === ErrorCodes.DOWNLOAD_CANCELLED)) console.error('[DL] doWork error:', e);
				});
		}, 15000);
	}

	private async handlePubsubMessage(topic: string, data: Record<string, any>): Promise<void> {
		if (this.destroyed) return;
		if (this.disabled) return;
		if (!this.networkIDs.some(nid => topic === lishTopic(nid))) return;
		if (data['type'] === 'have' && data['lishID'] === this.lishID && data['chunks']) {
			const chunks = data['chunks'] === 'all' ? 'ALL' : `${(data['chunks'] as any[])?.length ?? 0}`;
			const addrs = (data['multiaddrs'] as any[])?.map(a => a?.toString?.() ?? String(a)) ?? [];
			const addrTypes = addrs.map(a => (a.includes('/p2p-circuit') ? 'RELAY' : 'DIRECT'));
			// Peer sent have → it has data now, remove from dropped (but not if banned — bans are permanent)
			if (this.peerManager.isBanned(data['peerID'])) {
				trace(`[DL] HAVE from ${(data['peerID'] as string)?.slice(0, 12)} ignored: banned`);
			} else if (this.peerManager.clearDropped(data['peerID'])) console.debug(`[DL] ${(data['peerID'] as string)?.slice(0, 12)} removed from droppedPeers (sent have)`);
			console.debug(`[DL] HAVE from ${(data['peerID'] as string)?.slice(0, 12)}: ${chunks} chunks [${addrTypes.join(',')}], active=${this.downloadActive}`);
			if (this.peerManager.has(data['peerID'])) {
				// Update availability for already-connected peer
				const totalChunks = this.dataServer.getAllChunkCount(this.lishID) || 1;
				const hp = data['chunks'] === 'all' ? 100 : Math.round((((data['chunks'] as any[])?.length ?? 0) / totalChunks) * 100);
				this.peerManager.updateHavePercent(data['peerID'], hp);
				return;
			}
			// Don't reconnect banned peers (permanent ban for this app session)
			if (this.peerManager.isBanned(data['peerID'])) {
				trace(`[DL] HAVE from ${(data['peerID'] as string)?.slice(0, 12)} ignored: banned`);
				return;
			}
			try {
				await this.connectToPeer(data as HaveMessage);
			} catch (err: any) {
				console.debug(`[DL] connectToPeer failed: ${(data['peerID'] as string)?.slice(0, 12)}: ${err.message?.slice(0, 80)}`);
				return;
			}
			this.lastExhaustedTime = 0;
			if (!this.downloadActive && !this.destroyed)
				this.doWork().catch(e => {
					if (!(e instanceof CodedError && e.code === ErrorCodes.DOWNLOAD_CANCELLED)) console.error('[DL] doWork error:', e);
				});
		}
	}

	private async connectToPeer(data: HaveMessage): Promise<void> {
		const peerID: NodeID = data.peerID;
		const multiaddrs: Multiaddr[] = data.multiaddrs.map(ma => multiaddr(ma.toString()));
		trace(`[DL] dialing ${peerID.slice(0, 12)} via ${multiaddrs.length} addrs`);
		const { stream, connectionType } = await this.network.dialProtocol(multiaddrs, LISH_PROTOCOL);
		if (this.destroyed) {
			stream.abort(new Error('downloader destroyed'));
			return;
		}
		const totalChunks = this.dataServer.getAllChunkCount(this.lishID) || 1;
		const havePercent = data.chunks === 'all' ? 100 : Math.round((data.chunks.length / totalChunks) * 100);
		// Atomic add — if probeTopicPeers concurrently added the same peer during our dial,
		// tryAdd returns false; close the duplicate stream to avoid a leak.
		const client = new LISHClient(stream);
		if (!this.peerManager.tryAdd(peerID, client, connectionType, havePercent)) {
			await client.close().catch((err: any) => trace(`[DL] connectToPeer duplicate close: ${err?.message ?? err}`));
			trace(`[DL] connectToPeer ${peerID.slice(0, 12)}: already connected, closing duplicate`);
			return;
		}
		console.debug(`[DL] peer ${peerID.slice(0, 12)} connected [${connectionType}] have=${havePercent}% (total: ${this.peerManager.size()})`);
	}

	/**
	 * Bridge from FileAllocator's AllocationProgress events to the Downloader's
	 * onProgress shape (filePath: '__allocating__', fileDownloadedChunks is the
	 * aggregate allocation percentage, allocatingFile / allocatingFileProgress
	 * describe the file currently being zero-filled).
	 */
	private emitAllocProgress(p: AllocationProgress, totalChunks: number): void {
		const pct = p.totalBytes > 0 ? Math.round((p.totalBytesWritten / p.totalBytes) * 100) : 0;
		const filePct = p.fileSize > 0 ? Math.round((p.fileBytesWritten / p.fileSize) * 100) : 100;
		this.progressReporter.emit({
			downloadedChunks: 0,
			totalChunks,
			peers: 0,
			bytesPerSecond: 0,
			filePath: '__allocating__',
			fileDownloadedChunks: pct,
			allocatingFile: p.filePath,
			allocatingFileProgress: filePct,
		});
	}

	/**
	 * Map DB file verification progress onto fileIndex-keyed entries for the
	 * ProgressReporter. Called once at downloadChunks start and again after
	 * surgical ENOENT recovery to re-seed the per-file counters from verified state.
	 */
	private buildFileProgressEntries(): FileProgressEntry[] {
		if (!this.lish.files) return [];
		const vp = this.dataServer.getFileVerificationProgress(this.lishID);
		const entries: FileProgressEntry[] = [];
		for (let i = 0; i < this.lish.files.length; i++) {
			const match = vp.find(f => f.filePath === this.lish.files![i]!.path);
			if (match) entries.push({ fileIndex: i, verifiedChunks: match.verifiedChunks });
		}
		return entries;
	}

	// Download a single chunk from a peer using an existing client.
	// Result semantics:
	//  - { data }       → success, chunk received
	//  - 'skip-chunk'   → peer has the LISH but can't serve THIS chunk right now (busy / missing / transient IO).
	//                     Requeue the chunk, keep the peer, count consecutive skips (10× → droppedPeers).
	//  - 'drop-peer'    → peer is not useful to us right now (no LISH, unreachable, invalid request, unknown error).
	//                     Requeue the chunk, move peer to droppedPeers (soft quarantine with auto-recovery via
	//                     pubsub 'have' broadcasts or the ~5min cyclic reset). Never bans the peer permanently.
	// Permanent bans (bannedPeers) are reserved for actively malicious behavior (corrupt chunks, handled in doWork).
	private async downloadChunk(client: LISHClient, chunkID: ChunkID, peerID?: string): Promise<{ data: Uint8Array } | 'skip-chunk' | 'drop-peer'> {
		if (this.disabled || this.destroyed) return 'drop-peer';
		try {
			const data = await client.requestChunk(this.lishID, chunkID);
			return { data };
		} catch (err) {
			const code = (err as { code?: string }).code;
			// Chunk-specific transient — peer has the LISH, but this particular chunk isn't servable right now.
			if (code === ErrorCodes.PEER_BUSY || code === ErrorCodes.PEER_CHUNK_NOT_FOUND || code === ErrorCodes.PEER_IO_ERROR) {
				if (peerID && !this.notAvailableLoggedPeers.has(peerID)) {
					this.notAvailableLoggedPeers.add(peerID);
					console.debug(`[DL] first skip-chunk from ${peerID.slice(0, 12)}: ${code}`);
				}
				return 'skip-chunk';
			}
			// Peer-level — LISH not shared, stream dead/timeout, malformed response, or unknown error.
			// Drop into droppedPeers (soft quarantine; peer can come back via 'have' broadcast or 5min reset).
			const msg = err instanceof Error ? err.message : String(err);
			console.debug(`[DL] drop peer ${peerID?.slice(0, 12)}: ${code ?? msg.slice(0, 80)}`);
			return 'drop-peer';
		}
	}
}
