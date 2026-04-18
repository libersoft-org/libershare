import { access, constants } from 'fs/promises';
import { dirname } from 'path';
import { type IStoredLISH, type LISHid, CodedError, ErrorCodes } from '@shared';
import { type Network } from './network.ts';
import { downloadLimiter } from './speed-limiter.ts';
import { lishTopic } from './constants.ts';
import { Utils } from '../utils.ts';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { type HaveChunks, LISH_PROTOCOL, LISHClient } from './lish-protocol.ts';
import { Mutex } from 'async-mutex';
import { DataServer, type MissingChunk } from '../lish/data-server.ts';
import { trace } from '../logger.ts';
import { PeerManager } from './peer-manager.ts';
import { FileAllocator, type AllocationProgress } from './file-allocator.ts';
import { PauseController } from './pause-controller.ts';
import { ProgressReporter, type ProgressCallback } from './progress-reporter.ts';
import { ChunkDownloader, type RetryInfo } from './chunk-downloader.ts';
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
	added: ['initializing'],
	initializing: ['initialized'],
	initialized: ['awaiting-manifest', 'preparing'],
	'awaiting-manifest': ['preparing'],
	preparing: ['downloading', 'downloaded', 'awaiting-manifest'],
	downloading: ['downloaded', 'preparing'],
	downloaded: ['preparing'],
	error: ['downloading', 'preparing', 'awaiting-manifest', 'initialized'],
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
	/**
	 * Self-rescheduling timer for periodic peer discovery (callForPeers + probeTopicPeers).
	 * Delay is adaptive based on current peer count — see getPeerDiscoveryDelay().
	 * Replaces the old fixed 15s setInterval with a setTimeout chain so each cycle
	 * can recompute the delay based on the current state.
	 */
	private peerDiscoveryTimer: ReturnType<typeof setTimeout> | undefined;
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
		() => this.destroyed
	);
	private downloadResolve: (() => void) | undefined;
	private downloadReject: ((err: Error) => void) | undefined;
	private pubsubHandlers: { topic: string; handler: (data: Record<string, any>) => void }[] = [];
	// All progress accounting (speed window, per-file counters, 1s ticker, pass-through emit).
	private readonly progressReporter = new ProgressReporter();
	private onManifestImported?: (lishID: string) => void;
	private errorCode: string | undefined;
	private errorDetail: string | undefined;
	private onRetry?: (info: RetryInfo) => void;
	// Core chunk-transfer engine. Constructed lazily in init()/initFromManifest() once `lishID` is known.
	// Owns fileReallocAttempts/writeRetryCount/notAvailableLoggedPeers and the peerLoop orchestration.
	private chunkDownloader: ChunkDownloader | undefined;

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
		this.clearPeerDiscoveryTimer();
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
		this.clearPeerDiscoveryTimer();
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
		this.chunkDownloader?.resetRetryState();
		this.peerManager.clearAllDropped();
		console.log(`[DL] Enabled ${this.lishID.slice(0, 8)}`);
		this.pauseController.notifyStateChange();
		this.scheduleNextPeerDiscovery();
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
		this.clearPeerDiscoveryTimer();
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
		this.chunkDownloader = this.createChunkDownloader();
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
		this.chunkDownloader = this.createChunkDownloader();
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

	/** Build ChunkDownloader deps. Called once lishID is set (in init/initFromManifest). */
	private createChunkDownloader(): ChunkDownloader {
		return new ChunkDownloader({
			lishID: this.lishID,
			downloadDir: this.downloadDir,
			abortSignal: this.abortController.signal,
			dataServer: this.dataServer,
			peerManager: this.peerManager,
			pauseController: this.pauseController,
			progressReporter: this.progressReporter,
			fileAllocator: this.fileAllocator,
			// lish is lazy — doWork Phase 1 may replace this.lish after manifest fetch.
			getLish: () => this.lish,
			isDestroyed: () => this.destroyed,
			isDisabled: () => this.disabled,
			onSetError: (code, detail) => this.setError(code, detail),
			onRetry: info => this.onRetry?.(info),
			emitAllocProgress: (p, total) => this.emitAllocProgress(p, total),
		});
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
			// Re-check after acquiring the mutex — destroy() may have fired while we were queued.
			if (this.destroyed) return;
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
						await this.chunkDownloader!.run();
					} finally {
						this.downloadActive = false;
						// Reset for next doWork iteration. Dead-code `lastServingPeerCount` never goes non-zero
						// but stays reset here to preserve the original semantics (separate audit item).
						this.lastServingPeerCount = 0;
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

	private async callForPeers() {
		console.debug(`[DL] callForPeers: ${this.lishID.slice(0, 8)} on ${this.networkIDs.length} networks, peers: ${this.peerManager.size()}`);
		// GossipSub broadcast — peers respond with have+multiaddrs via handlePubsubMessage → connectToPeer
		const msg: PubsubMessage = { type: 'want', lishID: this.lishID };
		for (const nid of this.networkIDs) {
			await this.network.broadcast(lishTopic(nid), msg).catch((err: any) => trace(`[DL] broadcast WANT on ${nid}: ${err?.message ?? err}`));
		}
		// probeTopicPeers runs only via the adaptive peer-discovery timer (scheduleNextPeerDiscovery), not here
		// — avoids stale stream issues.
		trace(`[DL] callForPeers done: ${this.peerManager.size()} peers`);
		this.scheduleNextPeerDiscovery();
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

	/**
	 * Adaptive delay for the next peer-discovery cycle, chosen by current peer count.
	 * Fewer peers → more aggressive discovery; once we have plenty, back off significantly.
	 * Replaces the old fixed 15s cadence which was extremely noisy on busy networks.
	 */
	private getPeerDiscoveryDelay(): number {
		const count = this.peerManager.size();
		if (count === 0) return 120_000; // 2min — ramp-up / no peers found yet
		if (count < 6) return 300_000; // 5min — 1–5 peers, still hungry
		if (count < 20) return 600_000; // 10min — 6–19 peers, comfortable
		return 1_800_000; // 30min — 20+ peers, plenty
	}

	private clearPeerDiscoveryTimer(): void {
		if (this.peerDiscoveryTimer) {
			clearTimeout(this.peerDiscoveryTimer);
			this.peerDiscoveryTimer = undefined;
		}
	}

	/**
	 * Schedule the next peer-discovery cycle (callForPeers + probeTopicPeers).
	 * Self-rescheduling: each fired callback re-schedules itself with a freshly computed delay.
	 * Idempotent — if a timer is already pending it stays.
	 */
	private scheduleNextPeerDiscovery(): void {
		if (this.peerDiscoveryTimer) return;
		if (this.destroyed) return;
		if (this.disabled) return;
		if (this.state === 'downloaded' || this.state === 'error') return;
		const delay = this.getPeerDiscoveryDelay();
		trace(`[DL] next peer discovery in ${Math.round(delay / 1000)}s (peers=${this.peerManager.size()})`);
		this.peerDiscoveryTimer = setTimeout(() => {
			this.peerDiscoveryTimer = undefined;
			this.runPeerDiscoveryCycle().catch(e => trace(`[DL] discovery cycle error: ${e?.message ?? e}`));
		}, delay);
	}

	/**
	 * Manually trigger an immediate peer-discovery cycle (e.g. user clicked "Find peers" in UI).
	 * Cancels any pending scheduled cycle, runs immediately, then re-schedules normally.
	 * Cheap by design — if the user clicks repeatedly, each click sends another `want` broadcast;
	 * remote peers rate-limit their `have` responses so the spam is harmless.
	 */
	triggerPeerDiscovery(): void {
		if (this.destroyed) return;
		if (this.disabled) return;
		if (this.state === 'downloaded' || this.state === 'error') return;
		this.clearPeerDiscoveryTimer();
		console.debug(`[DL] manual peer discovery trigger for ${this.lishID.slice(0, 8)}`);
		this.runPeerDiscoveryCycle().catch(e => trace(`[DL] manual discovery cycle error: ${e?.message ?? e}`));
	}

	private async runPeerDiscoveryCycle(): Promise<void> {
		if (this.destroyed) return;
		if (this.state === 'downloaded') return;
		if (this.state !== 'downloading' && this.state !== 'awaiting-manifest') {
			// State not eligible right now — just re-schedule, will check again next time.
			this.scheduleNextPeerDiscovery();
			return;
		}
		const before = this.peerManager.size();
		// NOTE: bannedPeers is NEVER cleared here — bans are persistent for the app session.
		this.peerManager.maybeResetDroppedAfter5Min();
		this.lastExhaustedTime = 0;
		// Broadcast want so all peers (including probe-only) respond with have + chunk availability.
		await this.callForPeers().catch((err: any) => trace(`[DL] cycle callForPeers failed (will retry): ${err?.message ?? err}`));
		await this.probeTopicPeers();
		if (!this.downloadActive && !this.destroyed && this.peerManager.size() > before)
			this.doWork().catch(e => {
				if (!(e instanceof CodedError && e.code === ErrorCodes.DOWNLOAD_CANCELLED)) console.error('[DL] doWork error:', e);
			});
		this.scheduleNextPeerDiscovery();
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
}
