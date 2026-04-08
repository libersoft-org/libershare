import { access, mkdir, open, constants } from 'fs/promises';
import { dirname, resolve, sep } from 'path';
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
import { registerDownloadPeer, unregisterDownloadPeer, recordDownloadBytes, unregisterAllPeersForLISH } from './peer-tracker.ts';

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
	private peers: Map<NodeID, LISHClient> = new Map();
	private lastServingPeerCount = 0;
	private failedPeers = new Set<NodeID>(); // peers that failed — don't re-probe until next cycle
	private static readonly MAX_CORRUPT_CHUNKS = 3; // max corrupted chunks before banning peer
	private callForPeersInterval: ReturnType<typeof setInterval> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private needsManifest = false;
	private disabled = false;
	private destroyed = false;
	private lastExhaustedTime = 0;
	private downloadActive = false; // true while downloadChunks is running inside workMutex
	private enableResolvers: (() => void)[] = [];
	private downloadResolve: (() => void) | undefined;
	private downloadReject: ((err: Error) => void) | undefined;
	private pubsubHandlers: { topic: string; handler: (data: Record<string, any>) => void }[] = [];
	private onProgress?: (info: { downloadedChunks: number; totalChunks: number; peers: number; bytesPerSecond: number; filePath?: string; fileDownloadedChunks?: number; allocatingFile?: string; allocatingFileProgress?: number }) => void;
	private onManifestImported?: (lishID: string) => void;
	private speedSamples: { time: number; bytes: number }[] = [];
	private notAvailableLoggedPeers = new Set<string>(); // debug: track first not_available per peer
	private errorCode?: string;
	private errorDetail?: string;
	private onRetry?: (info: { errorCode: string; errorDetail?: string; retryCount: number; maxRetries: number; resolved?: boolean }) => void;
	private fileReallocAttempts = new Map<number, number>();
	private static readonly MAX_FILE_REALLOC = 3;
	private fileReallocInProgress = new Set<number>();
	private writePaused = false;
	private writePauseResolvers: Array<() => void> = [];
	private writeRetryCount = 0;
	private static readonly MAX_WRITE_RETRIES = 5;
	private static readonly WRITE_RETRY_DELAY = 60_000;

	getLISHID(): string { return this.lishID; }
	getError(): { code: string; detail?: string } | null {
		if (this.state !== 'error') return null;
		return { code: this.errorCode!, detail: this.errorDetail };
	}
	getPeerCount(): number { return this.lastServingPeerCount; }

	setProgressCallback(cb: (info: { downloadedChunks: number; totalChunks: number; peers: number; bytesPerSecond: number; filePath?: string; fileDownloadedChunks?: number; allocatingFile?: string; allocatingFileProgress?: number }) => void): void {
		this.onProgress = cb;
	}

	setManifestImportedCallback(cb: (lishID: string) => void): void {
		this.onManifestImported = cb;
	}

	setRetryCallback(cb: (info: { errorCode: string; errorDetail?: string; retryCount: number; maxRetries: number; resolved?: boolean }) => void): void {
		this.onRetry = cb;
	}

	private async waitIfWritePaused(): Promise<void> {
		if (!this.writePaused) return;
		await new Promise<void>(resolve => { this.writePauseResolvers.push(resolve); });
	}

	private resumeWriters(): void {
		this.writePaused = false;
		for (const resolve of this.writePauseResolvers) resolve();
		this.writePauseResolvers = [];
	}

	private setError(code: string, detail?: string): void {
		this.state = 'error';
		this.disabled = true;
		this.errorCode = code;
		this.errorDetail = detail;
		this.clearRetryTimer();
		if (this.callForPeersInterval) { clearInterval(this.callForPeersInterval); this.callForPeersInterval = undefined; }
		for (const { topic, handler } of this.pubsubHandlers) this.network.unsubscribeHandler(topic, handler);
		this.pubsubHandlers = [];
		for (const [, client] of this.peers) client.close().catch(() => {});
		this.peers.clear();
		unregisterAllPeersForLISH(this.lishID);
		this.lastServingPeerCount = 0;
		const total = this.dataServer.getAllChunkCount(this.lishID) || 0;
		const missing = this.dataServer.getMissingChunks(this.lishID).length;
		this.onProgress?.({ downloadedChunks: total - missing, totalChunks: total, peers: 0, bytesPerSecond: 0 });
		this.downloadReject?.(new CodedError(code as any, detail));
		this.downloadResolve = undefined;
		this.downloadReject = undefined;
		for (const resolve of this.enableResolvers) resolve();
		this.enableResolvers = [];
		console.error(`[DL] Error ${this.lishID.slice(0, 8)}: ${code}${detail ? ` — ${detail}` : ''}`);
	}

	private scheduleRetry(): void {
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			if (this.state === 'downloading' && !this.disabled)
				this.doWork().catch(e => { if (!(e instanceof CodedError && e.code === ErrorCodes.DOWNLOAD_CANCELLED)) console.error('[DL] doWork error:', e); });
		}, 10000);
	}

	private clearRetryTimer(): void {
		if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
	}

	disable(): void {
		this.disabled = true;
		this.clearRetryTimer();
		if (this.callForPeersInterval) { clearInterval(this.callForPeersInterval); this.callForPeersInterval = undefined; }
		for (const [, client] of this.peers) client.close().catch(() => {});
		this.peers.clear();
		unregisterAllPeersForLISH(this.lishID);
		this.lastServingPeerCount = 0;
		for (const resolve of this.enableResolvers) resolve();
		this.enableResolvers = [];
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
		if (this.state === 'error') this.state = this.missingChunks.length > 0 ? 'downloading' : 'preparing';
		this.errorCode = undefined;
		this.errorDetail = undefined;
		this.lastExhaustedTime = 0;
		this.fileReallocAttempts.clear();
		this.writeRetryCount = 0;
		console.log(`[DL] Enabled ${this.lishID.slice(0, 8)}`);
		for (const resolve of this.enableResolvers) resolve();
		this.enableResolvers = [];
		this.setupCallForPeersInterval();
		if (this.state === 'downloading' || this.state === 'awaiting-manifest' || this.state === 'preparing') {
			this.callForPeers().catch(() => {});
			this.doWork().catch(e => { if (!(e instanceof CodedError && e.code === ErrorCodes.DOWNLOAD_CANCELLED)) console.error('[DL] doWork error:', e); });
		}
	}

	isDisabled(): boolean { return this.disabled; }

	async destroy(): Promise<void> {
		console.debug(`[DL] destroy ${this.lishID.slice(0, 8)}, state=${this.state}, peers=${this.peers.size}`);
		this.disabled = true;
		this.destroyed = true;
		this.clearRetryTimer();
		if (this.callForPeersInterval) { clearInterval(this.callForPeersInterval); this.callForPeersInterval = undefined; }
		for (const { topic, handler } of this.pubsubHandlers) this.network.unsubscribeHandler(topic, handler);
		this.pubsubHandlers = [];
		for (const [, client] of this.peers) await client.close().catch(() => {});
		this.peers.clear();
		unregisterAllPeersForLISH(this.lishID);
		// Notify frontend to reset peers/speed immediately
		const total = this.dataServer.getAllChunkCount(this.lishID) || 0;
		this.onProgress?.({ downloadedChunks: 0, totalChunks: total, peers: 0, bytesPerSecond: 0 });
		this.downloadReject?.(new CodedError(ErrorCodes.DOWNLOAD_CANCELLED));
		this.downloadResolve = undefined;
		this.downloadReject = undefined;
		for (const resolve of this.enableResolvers) resolve();
		this.enableResolvers = [];
		delete this.onProgress;
		delete this.onManifestImported;
		console.log(`[DL] Destroyed ${this.lishID.slice(0, 8)}`);
	}

	private async waitIfDisabled(): Promise<void> {
		if (!this.disabled) return;
		if (this.destroyed) throw new CodedError(ErrorCodes.DOWNLOAD_CANCELLED);
		await new Promise<void>(resolve => { this.enableResolvers.push(resolve); });
		if (this.destroyed) throw new CodedError(ErrorCodes.DOWNLOAD_CANCELLED);
	}

	private subscribePubsub(): void {
		for (const nid of this.networkIDs) {
			const topic = lishTopic(nid);
			const handler = async (data: Record<string, any>) => { await this.handlePubsubMessage(topic, data); };
			this.pubsubHandlers.push({ topic, handler });
			this.network.subscribe(topic, handler);
		}
	}

	constructor(downloadDir: string, network: Network, dataServer: DataServer, networkIDs: string | string[]) {
		this.downloadDir = downloadDir;
		this.network = network;
		this.dataServer = dataServer;
		this.networkIDs = Array.isArray(networkIDs) ? networkIDs : [networkIDs];
	}

	async init(lishPath: string): Promise<void> {
		this.state = 'initializing';
		// Read and parse LISH
		const content = await Bun.file(lishPath).text();
		this.lish = Utils.safeJSONParse(content, `LISH file: ${lishPath}`);
		this.lishID = this.lish.id as LISHid;
		console.log(`[DL] Loading LISH: ${this.lish.name} (${this.lishID.slice(0, 8)}), ${this.dataServer.getMissingChunks(this.lishID).length} chunks to download`);
		this.missingChunks = this.dataServer.getMissingChunks(this.lishID);
		this.subscribePubsub();
		this.state = 'initialized';
	}

	async initFromManifest(lish: IStoredLISH): Promise<void> {
		this.state = 'initializing';
		this.lish = lish;
		this.lishID = this.lish.id as LISHid;
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
		this.state = 'initialized';
	}

	// Main download loop — returns only when fully downloaded (or throws on error)
	async download(): Promise<void> {
		trace(`[DL] download() state=${this.state}, destroyed=${this.destroyed}, disabled=${this.disabled}`);
		if (this.state !== 'initialized') throw new CodedError(ErrorCodes.DOWNLOADER_NOT_INITIALIZED);
		if (this.needsManifest) {
			this.state = 'awaiting-manifest';
			await this.callForPeers();
		} else {
			this.state = 'preparing';
			trace(`[DL] calling doWork, state=${this.state}`);
			await this.doWork();
			trace(`[DL] doWork returned, state=${this.state}, peers=${this.peers.size}`);
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
				if (this.peers.size === 0) return;
				for (const [, client] of this.peers) {
					const manifest = await client.requestManifest(this.lishID);
					if (manifest && manifest.files && manifest.files.length > 0) {
						this.lish = { ...manifest, directory: this.downloadDir };
						this.dataServer.add(this.lish);
						this.onManifestImported?.(this.lishID);
						this.missingChunks = this.dataServer.getMissingChunks(this.lishID);
						this.needsManifest = false;
						console.log(`[DL] Got manifest: ${manifest.files.length} files, ${this.missingChunks.length} chunks`);
						this.state = 'preparing';
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
				const needsAllocation = await this.needsFileAllocation();
				if (needsAllocation) {
					console.debug(`[DL] allocating files for ${this.lishID.slice(0, 8)}`);
					this.onProgress?.({ downloadedChunks: 0, totalChunks: totalChunksForProgress, peers: 0, bytesPerSecond: 0, filePath: '__allocating__' });
					await this.createDirectoryStructure(totalChunksForProgress);
					if (this.destroyed) return;
				} else {
					trace(`[DL] skipping allocation for ${this.lishID.slice(0, 8)} (files exist)`);
				}
				trace(`[DL] phase 2 done: ${this.lishID.slice(0, 8)}`);
				this.onProgress?.({ downloadedChunks: downloadedForProgress, totalChunks: totalChunksForProgress, peers: 0, bytesPerSecond: 0 });
				this.state = 'downloading';
			}
			// Phase 3: download chunks
			if (this.state === 'downloading') {
				if (this.missingChunks.length === 0) {
					console.log(`[DL] Complete: ${this.lishID.slice(0, 8)}`);
					this.state = 'downloaded';
					this.downloadResolve?.();
					return;
				}
				if (this.peers.size === 0) {
					console.debug(`[DL] no peers, calling for peers (failed: ${this.failedPeers.size})`);
					this.failedPeers.clear();
					await this.callForPeers();
					// Wait briefly for have responses via GossipSub before giving up
					if (this.peers.size === 0) await new Promise(r => setTimeout(r, 2000));
					if (this.peers.size === 0) {
						console.debug(`[DL] no peers found, retry in 10s`);
						this.lastExhaustedTime = Date.now();
						this.scheduleRetry();
						return;
					}
				}
				if (this.peers.size !== 0) {
					this.downloadActive = true;
					try { await this.downloadChunks(); } finally { this.downloadActive = false; }
					const remaining = this.dataServer.getMissingChunks(this.lishID);
					if (remaining.length === 0) {
						console.log(`[DL] Complete: ${this.lishID.slice(0, 8)}`);
						this.state = 'downloaded';
						this.downloadResolve?.();
						return;
					}
					console.log(`[DL] ${remaining.length} chunks missing, retrying in 10s`);
					this.peers.clear();
					unregisterAllPeersForLISH(this.lishID);
					this.failedPeers.clear();
					this.lastExhaustedTime = Date.now();
					this.scheduleRetry();
					return;
				}
			}
		});
	}

	static setMaxDownloadSpeed(kbPerSec: number): void { downloadLimiter.setLimit(kbPerSec); }

	private async downloadChunks(): Promise<void> {
		const missingChunks = this.dataServer.getMissingChunks(this.lishID);
		const allChunks = this.dataServer.getAllChunkCount(this.lishID);
		const totalChunks = allChunks > 0 ? allChunks : missingChunks.length;
		let downloadedCount = totalChunks - missingChunks.length;
		console.log(`[DL] downloadChunks: ${missingChunks.length} missing, ${totalChunks} total, ${this.peers.size} peers`);
		this.notAvailableLoggedPeers.clear();

		if (this.peers.size === 0) return;

		// Shared queue — peers pull chunks concurrently
		const queue = [...missingChunks];
		let queueIdx = 0;
		const lock = new Mutex();
		const activePeerLoops = new Set<string>();
		// Track all peerLoop promises so we can await dynamically spawned ones
		const peerLoopPromises = new Map<string, Promise<void>>();

		const servingPeers = new Set<string>(); // peers that actually served at least 1 chunk
		const corruptCount = new Map<string, number>(); // per-peer corruption counter
		let globalNotAvailable = 0; // consecutive not_available across all peers — reset on any success
		// Pre-populate per-file downloaded chunk counts from DB
		const fileDownloadedChunks = new Map<number, number>();
		const fileVP = this.dataServer.getFileVerificationProgress(this.lishID);
		if (this.lish.files) {
			for (let i = 0; i < this.lish.files.length; i++) {
				const vp = fileVP.find(f => f.filePath === this.lish.files![i]!.path);
				if (vp) fileDownloadedChunks.set(i, vp.verifiedChunks);
			}
		}

		const spawnNewPeerLoops = (): void => {
			for (const [pid, cli] of this.peers) {
				if (!activePeerLoops.has(pid)) {
					console.log(`[DL] Peer ${pid.slice(0, 12)} joined (total: ${this.peers.size})`);
					const p = peerLoop(pid, cli).catch(err => { console.error(`[DL] Peer loop ${pid.slice(0, 12)} error:`, err); });
					peerLoopPromises.set(pid, p);
				}
			}
		};

		const peerLoop = async (peerID: string, client: LISHClient): Promise<void> => {
			activePeerLoops.add(peerID);
			let skippedChunks = 0;
			while (true) {
				if (this.destroyed || this.disabled) break;
				await this.waitIfDisabled();
				await this.waitIfWritePaused();
				let chunk: MissingChunk | undefined;
				await lock.runExclusive(() => {
					if (queueIdx < queue.length) chunk = queue[queueIdx++];
				});
				if (!chunk) break;

				const result = await this.downloadChunk(client, chunk.chunkID, peerID);
				if (result === 'error') {
					console.log(`[DL] Peer ${peerID.slice(0, 12)} disconnected`);
					this.peers.delete(peerID);
					this.failedPeers.add(peerID);
					servingPeers.delete(peerID);
					unregisterDownloadPeer(this.lishID, peerID);
					await client.close().catch(() => {});
					await lock.runExclusive(() => { queue.push(chunk!); });
					// Spawn loops for any newly discovered peers before exiting
					spawnNewPeerLoops();
					break;
				}
				if (result === 'not_available') {
					skippedChunks++;
					globalNotAvailable++;
					if (skippedChunks % 500 === 0) trace(`[DL] Peer ${peerID.slice(0, 12)} skipped ${skippedChunks} chunks (not_available, global: ${globalNotAvailable}/${queue.length})`);
					await lock.runExclusive(() => { queue.push(chunk!); });
					if (this.disabled || this.destroyed) break;
					if (globalNotAvailable > queue.length) {
						console.debug(`[DL] Peer ${peerID.slice(0, 12)} exhausted (${globalNotAvailable} not_available)`);
						servingPeers.delete(peerID);
						break;
					}
					spawnNewPeerLoops();
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
					await lock.runExclusive(() => { queue.push(chunk!); });
					if (count >= Downloader.MAX_CORRUPT_CHUNKS) {
						console.log(`[DL] Peer ${peerID.slice(0, 12)} banned: ${count} corrupt chunks`);
						this.peers.delete(peerID);
						this.failedPeers.add(peerID);
						servingPeers.delete(peerID);
						unregisterDownloadPeer(this.lishID, peerID);
						await client.close().catch(() => {});
						spawnNewPeerLoops();
						break;
					}
					continue;
				}
				// Integrity OK — write chunk
				skippedChunks = 0;
				globalNotAvailable = 0;
				servingPeers.add(peerID);
				try {
					await this.dataServer.writeChunk(this.downloadDir, this.lish, chunk.fileIndex, chunk.chunkIndex, data);
				} catch (err: any) {
					if (err.code === 'ENOENT') {
						// File deleted — inline recovery: re-allocate + reset chunks
						const affectedFile = this.lish.files?.[chunk.fileIndex];
						if (!affectedFile) { this.setError(ErrorCodes.IO_NOT_FOUND, this.downloadDir); break; }
						const attempts = (this.fileReallocAttempts.get(chunk.fileIndex) ?? 0) + 1;
						this.fileReallocAttempts.set(chunk.fileIndex, attempts);
						if (attempts > Downloader.MAX_FILE_REALLOC) {
							console.error(`[DL] File ${affectedFile.path} re-allocation limit (${Downloader.MAX_FILE_REALLOC}) exceeded`);
							this.setError(ErrorCodes.IO_NOT_FOUND, this.downloadDir);
							break;
						}
						if (!this.fileReallocInProgress.has(chunk.fileIndex)) {
							this.fileReallocInProgress.add(chunk.fileIndex);
							console.warn(`[DL] File deleted: ${affectedFile.path}, re-allocating (attempt ${attempts}/${Downloader.MAX_FILE_REALLOC})`);
							this.onRetry?.({ errorCode: ErrorCodes.IO_NOT_FOUND, errorDetail: affectedFile.path, retryCount: attempts, maxRetries: Downloader.MAX_FILE_REALLOC });
							try {
								await this.allocateSingleFile(chunk.fileIndex);
								const resetCount = this.dataServer.resetFileChunks(this.lishID, chunk.fileIndex);
								console.log(`[DL] Re-allocated ${affectedFile.path}, reset ${resetCount} chunks`);
								const fileChunks = this.dataServer.getMissingChunks(this.lishID).filter(c => c.fileIndex === chunk.fileIndex);
								await lock.runExclusive(() => { for (const fc of fileChunks) queue.push(fc); });
								downloadedCount = Math.max(0, downloadedCount - resetCount);
							} catch (allocErr: any) {
								console.error(`[DL] Re-allocation failed for ${affectedFile.path}: ${allocErr.message}`);
								this.setError(ErrorCodes.IO_NOT_FOUND, this.downloadDir);
								break;
							} finally {
								this.fileReallocInProgress.delete(chunk.fileIndex);
							}
							this.onRetry?.({ errorCode: ErrorCodes.IO_NOT_FOUND, errorDetail: affectedFile.path, retryCount: attempts, maxRetries: Downloader.MAX_FILE_REALLOC, resolved: true });
							continue; // chunk already in fileChunks, don't push again
						} else {
							// Another peer is re-allocating — re-queue and wait
							await lock.runExclusive(() => { queue.push(chunk!); });
							continue;
						}
					} else if (err.code === 'ENOSPC' || err.code === 'EACCES' || err.code === 'EPERM') {
						// Disk full or permission denied — inline retry with pause
						const code = err.code === 'ENOSPC' ? ErrorCodes.DISK_FULL : ErrorCodes.DIRECTORY_ACCESS_DENIED;
						if (this.writePaused) {
							// Another peer already handling the write error — just wait and re-queue
							await this.waitIfWritePaused();
							await lock.runExclusive(() => { queue.push(chunk!); });
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
						this.writePaused = true;
						await new Promise<void>(resolve => {
							const timer = setTimeout(resolve, Downloader.WRITE_RETRY_DELAY);
							const check = setInterval(() => { if (this.destroyed || this.disabled) { clearTimeout(timer); clearInterval(check); resolve(); } }, 1000);
							setTimeout(() => clearInterval(check), Downloader.WRITE_RETRY_DELAY + 100);
						});
						if (this.destroyed || this.disabled) break;
						try {
							await this.dataServer.writeChunk(this.downloadDir, this.lish, chunk.fileIndex, chunk.chunkIndex, data);
							console.log(`[DL] Write retry succeeded for ${this.lishID.slice(0, 8)}`);
							this.writeRetryCount = 0;
							this.resumeWriters();
							this.onRetry?.({ errorCode: code, errorDetail: this.downloadDir, retryCount: 0, maxRetries: Downloader.MAX_WRITE_RETRIES, resolved: true });
						} catch (retryErr: any) {
							console.warn(`[DL] ${this.lishID.slice(0, 8)}: write retry still failed (attempt ${this.writeRetryCount}/${Downloader.MAX_WRITE_RETRIES}): ${retryErr.code ?? retryErr.message}`);
							this.resumeWriters();
							await lock.runExclusive(() => { queue.push(chunk!); });
							continue;
						}
					} else {
						this.setError(ErrorCodes.DOWNLOAD_ERROR, err.message);
						break;
					}
				}
				this.dataServer.markChunkDownloaded(this.lishID, chunk.chunkID);
				this.dataServer.incrementDownloadedBytes(this.lishID, data.length);
				recordDownloadBytes(this.lishID, peerID, data.length, this.lish.files?.[chunk.fileIndex]?.path);
				downloadedCount++;
				if (this.writeRetryCount > 0) this.writeRetryCount = 0;
				// Rolling speed average (~10 second window)
				const now = Date.now();
				this.speedSamples.push({ time: now, bytes: data.length });
				this.speedSamples = this.speedSamples.filter(s => s.time > now - 10000);
				const windowBytes = this.speedSamples.reduce((sum, s) => sum + s.bytes, 0);
				const windowSec = this.speedSamples.length > 1
					? (now - this.speedSamples[0]!.time) / 1000
					: 1;
				const bytesPerSecond = windowSec > 0.1 ? Math.round(windowBytes / windowSec) : 0;
				this.lastServingPeerCount = servingPeers.size;
				if (downloadedCount % 50 === 0 || downloadedCount === totalChunks) {
					console.log(`[DL] ${downloadedCount}/${totalChunks} verified, ${servingPeers.size} peers, ${Math.round(bytesPerSecond / 1024)}KB/s`);
				}
				const fIdx = chunk.fileIndex;
				fileDownloadedChunks.set(fIdx, (fileDownloadedChunks.get(fIdx) ?? 0) + 1);
				const filePath = this.lish.files?.[fIdx]?.path;
				const fileChunks = fileDownloadedChunks.get(fIdx);
				this.onProgress?.({ downloadedChunks: downloadedCount, totalChunks, peers: servingPeers.size, bytesPerSecond, ...(filePath != null ? { filePath } : {}), ...(fileChunks != null ? { fileDownloadedChunks: fileChunks } : {}) });
				await downloadLimiter.throttle(data.length);
				// Check for newly discovered peers and spawn loops for them
				spawnNewPeerLoops();
			}
			activePeerLoops.delete(peerID);
		};

		try {
			const initialPeers = [...this.peers.entries()];
			console.log(`[DL] Starting: ${totalChunks} chunks from ${initialPeers.length} peer(s)`);
			// Start initial peer loops
			for (const [peerID, client] of initialPeers) {
				const p = peerLoop(peerID, client).catch(() => {});
				peerLoopPromises.set(peerID, p);
			}
			// Wait until all peer loops (including dynamically spawned ones) settle
			while (peerLoopPromises.size > 0) {
				const current = [...peerLoopPromises.entries()];
				await Promise.all(current.map(([, p]) => p));
				// Remove settled ones
				for (const [id] of current) peerLoopPromises.delete(id);
				// Loop back to check if new loops were spawned while we waited
			}
			console.debug(`[DL] downloadChunks done: ${downloadedCount}/${totalChunks}`);
			if (downloadedCount < totalChunks) {
				console.log(`[DL] Peers exhausted at ${downloadedCount}/${totalChunks}, will retry`);
			}
		} finally {
			for (const [, client] of this.peers) await client.close().catch(() => {});
			this.peers.clear();
			unregisterAllPeersForLISH(this.lishID);
			this.lastServingPeerCount = 0;
			// Reset frontend peers/speed immediately when all peer loops finish
			this.onProgress?.({ downloadedChunks: downloadedCount, totalChunks, peers: 0, bytesPerSecond: 0 });
		}
	}

	private async callForPeers() {
		console.debug(`[DL] callForPeers: ${this.lishID.slice(0, 8)} on ${this.networkIDs.length} networks, peers: ${this.peers.size}`);
		// GossipSub broadcast — peers respond with have+multiaddrs via handlePubsubMessage → connectToPeer
		const msg: PubsubMessage = { type: 'want', lishID: this.lishID };
		for (const nid of this.networkIDs) {
			await this.network.broadcast(lishTopic(nid), msg).catch(() => {});
		}
		// probeTopicPeers runs only via 15s interval (setupCallForPeersInterval), not here — avoids stale stream issues
		trace(`[DL] callForPeers done: ${this.peers.size} peers`);
		this.setupCallForPeersInterval();
	}

	private async probeTopicPeers(): Promise<void> {
		if (this.destroyed) return;
		const topicPeers = new Set<string>();
		for (const nid of this.networkIDs) {
			for (const p of this.network.getTopicPeers(nid)) topicPeers.add(p);
		}
		console.debug(`[DL] probeTopicPeers: ${topicPeers.size} topic, ${this.peers.size} connected, ${this.failedPeers.size} failed`);
		let foundNew = false;
		for (const peerID of topicPeers) {
			if (this.destroyed) return;
			if (this.peers.has(peerID)) { trace(`[DL] probe skip ${peerID.slice(0, 12)}: connected`); continue; }
			if (this.failedPeers.has(peerID)) { trace(`[DL] probe skip ${peerID.slice(0, 12)}: failed`); continue; }
			try {
				trace(`[DL] probing ${peerID.slice(0, 12)}`);
				const { stream: probeStream } = await this.network.dialProtocolByPeerId(peerID, LISH_PROTOCOL);
				if (this.destroyed) { probeStream.abort(new Error('downloader destroyed')); return; }
				const probeClient = new LISHClient(probeStream);
				const manifest = await probeClient.requestManifest(this.lishID);
				await probeClient.close();
				if (this.destroyed) return;

				if (!manifest) { console.debug(`[DL] probe ${peerID.slice(0, 12)}: null manifest`); continue; }

				if (this.needsManifest && manifest.files && manifest.files.length > 0) {
					this.lish = { ...manifest, directory: this.downloadDir };
					this.dataServer.add(this.lish);
					this.onManifestImported?.(this.lishID);
					this.missingChunks = this.dataServer.getMissingChunks(this.lishID);
					this.needsManifest = false;
					this.state = 'preparing';
					console.log(`[DL] Got manifest from ${peerID.slice(0, 12)}: ${manifest.files.length} files, ${this.missingChunks.length} chunks`);
				}

				const { stream: dlStream, connectionType } = await this.network.dialProtocolByPeerId(peerID, LISH_PROTOCOL);
				if (this.destroyed) { dlStream.abort(new Error('downloader destroyed')); return; }
				this.peers.set(peerID, new LISHClient(dlStream));
				registerDownloadPeer(this.lishID, peerID, connectionType);
				this.lastExhaustedTime = 0;
				foundNew = true;
				console.debug(`[DL] probe: ${peerID.slice(0, 12)} connected [${connectionType}] (total: ${this.peers.size})`);
			} catch (err: any) {
				console.debug(`[DL] probe ${peerID.slice(0, 12)} unreachable: ${err.message?.slice(0, 80)}`);
			}
		}
		if (foundNew && !this.downloadActive && !this.destroyed) {
			this.doWork().catch(e => { if (!(e instanceof CodedError && e.code === ErrorCodes.DOWNLOAD_CANCELLED)) console.error('[DL] doWork error:', e); });
		}
	}

	private setupCallForPeersInterval() {
		if (this.callForPeersInterval) return;
		this.callForPeersInterval = setInterval(async () => {
			if (this.destroyed) { clearInterval(this.callForPeersInterval); this.callForPeersInterval = undefined; return; }
			if (this.state === 'downloaded') {
				clearInterval(this.callForPeersInterval);
				this.callForPeersInterval = undefined;
				return;
			}
			if (this.state !== 'downloading' && this.state !== 'awaiting-manifest') return;
			const before = this.peers.size;
			this.failedPeers.clear();
			this.lastExhaustedTime = 0;
			await this.probeTopicPeers();
			if (!this.downloadActive && !this.destroyed && this.peers.size > before) this.doWork().catch(e => { if (!(e instanceof CodedError && e.code === ErrorCodes.DOWNLOAD_CANCELLED)) console.error('[DL] doWork error:', e); });
		}, 15000);
	}

	private async handlePubsubMessage(topic: string, data: Record<string, any>): Promise<void> {
		if (this.destroyed) return;
		if (this.disabled) return;
		if (!this.networkIDs.some(nid => topic === lishTopic(nid))) return;
		if (data['type'] === 'have' && data['lishID'] === this.lishID && data['chunks']) {
			const chunks = data['chunks'] === 'all' ? 'ALL' : `${(data['chunks'] as any[])?.length ?? 0}`;
			const addrs = (data['multiaddrs'] as any[])?.map(a => a?.toString?.() ?? String(a)) ?? [];
			const addrTypes = addrs.map(a => a.includes('/p2p-circuit') ? 'RELAY' : 'DIRECT');
			console.debug(`[DL] HAVE from ${(data['peerID'] as string)?.slice(0, 12)}: ${chunks} chunks [${addrTypes.join(',')}], active=${this.downloadActive}`);
			if (this.peers.has(data['peerID'])) return;
			try {
				await this.connectToPeer(data as HaveMessage);
			} catch (err: any) {
				console.debug(`[DL] connectToPeer failed: ${(data['peerID'] as string)?.slice(0, 12)}: ${err.message?.slice(0, 80)}`);
				return;
			}
			this.lastExhaustedTime = 0;
			if (!this.downloadActive && !this.destroyed) this.doWork().catch(e => { if (!(e instanceof CodedError && e.code === ErrorCodes.DOWNLOAD_CANCELLED)) console.error('[DL] doWork error:', e); });
		}
	}

	private async connectToPeer(data: HaveMessage): Promise<void> {
		const peerID: NodeID = data.peerID;
		const multiaddrs: Multiaddr[] = data.multiaddrs.map(ma => multiaddr(ma.toString()));
		trace(`[DL] dialing ${peerID.slice(0, 12)} via ${multiaddrs.length} addrs`);
		const { stream, connectionType } = await this.network.dialProtocol(multiaddrs, LISH_PROTOCOL);
		if (this.destroyed) { stream.abort(new Error('downloader destroyed')); return; }
		if (this.peers.has(data.peerID)) throw new Error(`Already connected to peer: ${peerID}`);
		this.peers.set(peerID, new LISHClient(stream));
		registerDownloadPeer(this.lishID, peerID, connectionType);
		console.debug(`[DL] peer ${peerID.slice(0, 12)} connected [${connectionType}] (total: ${this.peers.size})`);
	}

	private safePath(relativePath: string): string {
		const resolved = resolve(this.downloadDir, relativePath);
		if (!resolved.startsWith(resolve(this.downloadDir) + sep)) throw new Error(`Path traversal blocked: ${relativePath}`);
		return resolved;
	}

	private async needsFileAllocation(): Promise<boolean> {
		if (!this.lish.files) return false;
		for (const file of this.lish.files) {
			const filePath = this.safePath(file.path);
			const f = Bun.file(filePath);
			if (!(await f.exists()) || f.size !== file.size) return true;
		}
		return false;
	}

	private async createDirectoryStructure(totalChunksForProgress: number): Promise<void> {
		const startTime = Date.now();
		if (this.lish.directories) {
			for (const dir of this.lish.directories) {
				await mkdir(this.safePath(dir.path), { recursive: true });
			}
		}
		let createdFiles = 0;
		let skippedFiles = 0;
		if (this.lish.files) {
			const totalBytes = this.lish.files.reduce((sum, f) => sum + f.size, 0);
			let totalWritten = 0;
			let nextProgressAt = 100 * 1024 * 1024; // emit every ~100MB
			const emitAllocProgress = (currentFile: string, fileWritten: number, fileSize: number) => {
				const pct = totalBytes > 0 ? Math.round((totalWritten / totalBytes) * 100) : 0;
				const filePct = fileSize > 0 ? Math.round((fileWritten / fileSize) * 100) : 100;
				this.onProgress?.({ downloadedChunks: 0, totalChunks: totalChunksForProgress, peers: 0, bytesPerSecond: 0, filePath: '__allocating__', fileDownloadedChunks: pct, allocatingFile: currentFile, allocatingFileProgress: filePct });
			};
			for (const file of this.lish.files) {
				if (this.destroyed) return;
				const filePath = this.safePath(file.path);
				await mkdir(dirname(filePath), { recursive: true });
				if (!(await Bun.file(filePath).exists())) {
					const fd = await open(filePath, 'w');
					try {
						const zeroChunk = new Uint8Array(1024 * 1024);
						let remaining = file.size;
						let fileWritten = 0;
						while (remaining > 0) {
							if (this.destroyed) return;
							const writeSize = Math.min(remaining, zeroChunk.length);
							await fd.write(zeroChunk.subarray(0, writeSize));
							remaining -= writeSize;
							totalWritten += writeSize;
							fileWritten += writeSize;
							if (totalWritten >= nextProgressAt || remaining === 0) {
								nextProgressAt = totalWritten + 100 * 1024 * 1024;
								emitAllocProgress(file.path, fileWritten, file.size);
								await new Promise(r => setTimeout(r, 0));
							}
						}
					} finally {
						await fd.close();
					}
					createdFiles++;
					trace(`[DL] created file: ${file.path} (${file.size}B)`);
				} else {
					totalWritten += file.size;
					skippedFiles++;
				}
			}
		}
		console.log(`[DL] Directory structure created: ${this.lish.files?.length ?? 0} files in ${this.downloadDir} (created=${createdFiles}, skipped=${skippedFiles}, ${Date.now() - startTime}ms)`);
	}

	/** Re-allocate a single file (create dirs + zero-fill). Used when a file is deleted mid-download. */
	private async allocateSingleFile(fileIndex: number): Promise<void> {
		const file = this.lish.files?.[fileIndex];
		if (!file) return;
		const filePath = this.safePath(file.path);
		await mkdir(dirname(filePath), { recursive: true });
		const f = Bun.file(filePath);
		if (!(await f.exists()) || f.size !== file.size) {
			const fd = await open(filePath, 'w');
			try {
				const zeroChunk = new Uint8Array(Math.min(1024 * 1024, file.size));
				let remaining = file.size;
				while (remaining > 0) {
					const writeSize = Math.min(remaining, zeroChunk.length);
					await fd.write(zeroChunk.subarray(0, writeSize));
					remaining -= writeSize;
				}
			} finally {
				await fd.close();
			}
			console.log(`[DL] Re-allocated file: ${file.path} (${file.size} bytes)`);
		}
	}

	// Download a single chunk from a peer using an existing client
	private async downloadChunk(client: LISHClient, chunkID: ChunkID, peerID?: string): Promise<{ data: Uint8Array } | 'not_available' | 'error'> {
		if (this.disabled || this.destroyed) return 'error';
		try {
			const data = await client.requestChunk(this.lishID, chunkID);
			if (!data) {
				if (peerID && !this.notAvailableLoggedPeers.has(peerID)) {
					this.notAvailableLoggedPeers.add(peerID);
					console.debug(`[DL] first not_available from ${peerID.slice(0, 12)}`);
				}
			}
			return data ? { data } : 'not_available';
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.debug(`[DL] chunk error: peer=${peerID?.slice(0, 12)}, err=${msg.slice(0, 80)}`);
			return 'error';
		}
	}
}
