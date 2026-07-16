import { Mutex } from 'async-mutex';
import { type ChunkID, type IStoredLISH, type LISHid, ErrorCodes } from '@shared';
import { DataServer, type MissingChunk } from '../lish/data-server.ts';
import { LISHClient, type HaveChunks } from './lish-protocol.ts';
import { downloadLimiter } from './speed-limiter.ts';
import { recordDownloadBytes, touchPeer } from './peer-tracker.ts';
import { trace } from '../logger.ts';
import { PeerManager } from './peer-manager.ts';
import { PauseController } from './pause-controller.ts';
import { ProgressReporter, type FileProgressEntry } from './progress-reporter.ts';
import { FileAllocator, type AllocationProgress } from './file-allocator.ts';
export interface RetryInfo {
	errorCode: string;
	errorDetail?: string;
	retryCount: number;
	maxRetries: number;
	resolved?: boolean;
}
/**
 * All external dependencies the ChunkDownloader needs. The Downloader
 * (orchestrator) is the sole construction site and keeps itself as the single
 * source of truth for `disabled`/`destroyed`/`lish`/etc. \u2014 we read them via
 * callbacks so refactoring these two files doesn't split the truth.
 */
export interface ChunkDownloaderDeps {
	readonly lishID: LISHid;
	readonly downloadDir: string;
	/** Aborted on Downloader.destroy() — forwarded to long-running FileAllocator ops. */
	readonly abortSignal: AbortSignal;
	readonly dataServer: DataServer;
	readonly peerManager: PeerManager;
	readonly pauseController: PauseController;
	readonly progressReporter: ProgressReporter;
	readonly fileAllocator: FileAllocator;
	/** Lazy accessor: the Downloader may replace `this.lish` when a manifest arrives mid-flight. */
	getLish(): IStoredLISH;
	isDestroyed(): boolean;
	isDisabled(): boolean;
	/** Transition Downloader to error state (fatal: corrupt limit, reloc limit, write retry limit, unknown write error). */
	onSetError(code: string, detail?: string): void;
	/** FE retry/resolved notification (ENOENT recovery, disk-full, write-retry). */
	onRetry?: (info: RetryInfo) => void;
	/** Shared with doWork Phase 2: wraps FileAllocator progress into onProgress shape. */
	emitAllocProgress(p: AllocationProgress, totalChunks: number): void;
}

/**
 * Core chunk-transfer engine. Owns the per-lish retry state (file re-alloc
 * attempts, write retry count, debug not-available set), the in-flight
 * peer-loop orchestration, and the two recovery paths (ENOENT / disk-full).
 *
 * Lifetime = one ChunkDownloader per Downloader (per LISH). `run()` may be
 * called multiple times by doWork; retry counters persist so the limits
 * (MAX_FILE_REALLOC=3, MAX_WRITE_RETRIES=5) span a whole user session, not
 * just one peerLoop batch. `resetRetryState()` is called from Downloader.enable()
 * when the user consciously resumes a failed download.
 */
export class ChunkDownloader {
	private readonly deps: ChunkDownloaderDeps;
	private fileReallocAttempts = new Map<number, number>();
	private fileReallocInProgress = new Set<number>();
	private writeRetryCount = 0;
	private notAvailableLoggedPeers = new Set<string>(); // debug: track first not_available per peer
	private peerHaveUpdates = new Map<string, { version: number; chunks: HaveChunks }>();

	private static readonly MAX_CORRUPT_CHUNKS = 3; // max corrupted chunks before banning peer
	private static readonly MAX_FILE_REALLOC = 3;
	private static readonly MAX_WRITE_RETRIES = 5;
	private static readonly WRITE_RETRY_DELAY = 60_000;

	constructor(deps: ChunkDownloaderDeps) {
		this.deps = deps;
	}

	/** Clear retry counters. Called from Downloader.enable() on user resume. */
	resetRetryState(): void {
		this.fileReallocAttempts.clear();
		this.writeRetryCount = 0;
	}

	/**
	 * Record a fresh HAVE snapshot for an already-connected peer. Active peer
	 * loops use it to invalidate definitive misses for chunks the peer now
	 * advertises, without forgetting misses for chunks still absent.
	 */
	notifyPeerHave(peerID: string, chunks: HaveChunks): void {
		const version = (this.peerHaveUpdates.get(peerID)?.version ?? 0) + 1;
		this.peerHaveUpdates.set(peerID, { version, chunks: chunks === 'all' ? 'all' : [...chunks] });
	}

	/**
	 * Drain the missing-chunks queue from the currently connected peers. Returns
	 * when either all chunks are downloaded, all peers are exhausted/removed,
	 * or Downloader is disabled/destroyed. Does NOT schedule retry \u2014 the
	 * orchestrator (doWork) decides what to do on partial completion.
	 */
	async run(): Promise<void> {
		const { lishID, downloadDir, dataServer, peerManager, pauseController, progressReporter, fileAllocator } = this.deps;
		// Snapshot lish once per run — manifest is only mutated by the orchestrator in doWork Phase 1 BEFORE run() is called.
		const lish = this.deps.getLish();
		const missingChunks = dataServer.getMissingChunks(lishID);
		const allChunks = dataServer.getAllChunkCount(lishID);
		const totalChunks = allChunks > 0 ? allChunks : missingChunks.length;
		let downloadedCount = totalChunks - missingChunks.length;
		console.log(`[DL] downloadChunks: ${missingChunks.length} missing, ${totalChunks} total, ${peerManager.size()} peers`);
		this.notAvailableLoggedPeers.clear();

		if (peerManager.size() === 0) return;

		// Shared queue \u2014 peers pull chunks concurrently
		const queue = [...missingChunks];
		let queueIdx = 0;
		// Chunks checked out by a peer loop (pulled, not yet resolved or requeued).
		// A peer that finds nothing servable must NOT exit or drop while this is
		// non-zero \u2014 an in-flight failure requeues the chunk, possibly one that
		// only the scanning peer can serve.
		let inFlight = 0;
		// Changes only when an in-flight request puts potentially useful work back
		// into the queue. Idle peers watch this instead of repeatedly rotating the
		// same per-peer notFound entries while nothing has settled.
		let requeueVersion = 0;
		const lock = new Mutex();
		const requeueChunk = async (chunk: MissingChunk): Promise<void> => {
			await lock.runExclusive(() => {
				queue.push(chunk);
				requeueVersion++;
			});
		};
		// Track all peerLoop promises so we can await dynamically spawned ones
		const peerLoopPromises = new Map<string, Promise<void>>();

		const corruptCount = new Map<string, number>(); // per-peer corruption counter
		// Diagnostic only (skip trace log). The former `globalNotAvailable > queue.length`
		// exhaustion guard was unreachable: every failure that increments the counter also
		// requeues the chunk, so queue.length always grows in lockstep or faster.
		let globalNotAvailable = 0; // consecutive not_available across all peers \u2014 reset on any success
		// Seed per-file counters from DB verification state. Reporter owns the fileDownloadedChunks map,
		// lastFilePath/lastFileChunks pointers, sliding speed window and the 1s ticker.
		progressReporter.resetSession();
		progressReporter.loadFileProgress(this.buildFileProgressEntries());

		// Duplicate-checksum slot map. A chunk's content can legitimately appear at multiple
		// (fileIndex, chunkIndex) offsets (shared content across files, or repeated blocks within one).
		// markChunkDownloaded flips `have` for ALL slots sharing a checksum, but writeChunk writes only
		// the requested offset — so a downloaded chunk MUST be written to every shared offset, otherwise
		// the others stay zero-filled from allocation while reported complete (silent corruption).
		// Build checksum → all-slots once; keep only checksums that occur in more than one slot.
		const dupTargets = new Map<string, Array<{ fileIndex: number; chunkIndex: number }>>();
		for (const slot of dataServer.getAllChunkSlots(lishID)) {
			const arr = dupTargets.get(slot.checksum);
			if (arr) arr.push({ fileIndex: slot.fileIndex, chunkIndex: slot.chunkIndex });
			else dupTargets.set(slot.checksum, [{ fileIndex: slot.fileIndex, chunkIndex: slot.chunkIndex }]);
		}
		for (const [cs, arr] of dupTargets) if (arr.length < 2) dupTargets.delete(cs);
		if (dupTargets.size > 0) console.log(`[DL] ${lishID.slice(0, 8)}: ${dupTargets.size} duplicate-checksum group(s); chunks written to all shared offsets`);

		// Write a verified chunk to its own offset, plus every other offset sharing its checksum.
		const writeChunkToAllSlots = async (c: MissingChunk, payload: Uint8Array): Promise<void> => {
			const targets = dupTargets.get(c.chunkID);
			if (!targets) {
				await dataServer.writeChunk(downloadDir, lish, c.fileIndex, c.chunkIndex, payload);
				return;
			}
			for (const t of targets) await dataServer.writeChunk(downloadDir, lish, t.fileIndex, t.chunkIndex, payload);
		};

		const spawnPeerLoop = (peerID: string, client: LISHClient): void => {
			// Safety dedup: onPeerAdded callback fires once per tryAdd, but protects against
			// double-spawn if a peer somehow re-adds while its previous loop is still teardown-ing.
			if (peerManager.isActive(peerID)) return;
			console.log(`[DL] Peer ${peerID.slice(0, 12)} joined (total: ${peerManager.size()})`);
			// peerLoop should not throw \u2014 catch is a safety net for unexpected bugs (state race, type errors, etc.).
			// A silently crashed peer loop would leave the peer in peerManager but not actually downloading,
			// causing the download to stall. So log loudly AND remove the peer.
			const p = peerLoop(peerID, client).catch((err: any) => {
				console.error(`[DL] peerLoop CRASHED for ${peerID.slice(0, 12)}:`, err);
				peerManager.remove(peerID, 'disconnect');
			});
			peerLoopPromises.set(peerID, p);
		};

		const peerLoop = async (peerID: string, client: LISHClient): Promise<void> => {
			peerManager.markActive(peerID);
			let skippedChunks = 0;
			let consecutiveNotAvailable = 0;
			// Chunks this peer answered PEER_CHUNK_NOT_FOUND for — never re-request them from
			// the same peer within this session (they stay in the shared queue for other peers).
			// Without this, a partial seeder missing ≥10 consecutive chunks ahead of one it HAS
			// gets dropped before the queue cursor ever reaches the servable chunk (starvation).
			const notFound = new Set<string>();
			let observedHaveVersion = this.peerHaveUpdates.get(peerID)?.version ?? 0;
			const applyHaveUpdate = (): void => {
				const update = this.peerHaveUpdates.get(peerID);
				if (!update || update.version === observedHaveVersion) return;
				if (update.chunks === 'all') notFound.clear();
				else for (const chunkID of update.chunks) notFound.delete(chunkID);
				observedHaveVersion = update.version;
			};
			while (true) {
				if (this.deps.isDestroyed() || this.deps.isDisabled()) break;
				await pauseController.waitIfDisabled();
				await pauseController.waitIfWritePaused();
				let chunk: MissingChunk | undefined;
				let onlyNotFoundLeft = false;
				let observedRequeueVersion = 0;
				await lock.runExclusive(() => {
					applyHaveUpdate();
					// Compact the consumed prefix — every requeue/rotation appends, so without
					// this the array grows by O(requeues) and the dead slots are never reclaimed.
					if (queueIdx > 1024) {
						queue.splice(0, queueIdx);
						queueIdx = 0;
					}
					const unservable: MissingChunk[] = [];
					while (queueIdx < queue.length) {
						const candidate = queue[queueIdx++]!;
						// Skip chunks already downloaded (dedup re-queued entries)
						if (dataServer.isChunkDownloaded(lishID, candidate.chunkID)) continue;
						if (notFound.has(candidate.chunkID)) {
							unservable.push(candidate);
							continue;
						}
						chunk = candidate;
						break;
					}
					// Chunks this peer can't serve go back to the queue for other peers.
					// Loop push — a spread would blow the argument limit on huge manifests.
					for (const u of unservable) queue.push(u);
					if (!chunk && unservable.length > 0) onlyNotFoundLeft = true;
					if (chunk) inFlight++;
					observedRequeueVersion = requeueVersion;
				});
				if (!chunk) {
					if (inFlight > 0) {
						// Chunks are checked out by other peer loops. Poll only the cheap
						// counters until one is requeued or all in-flight work settles; do not
						// re-scan and rotate an unchanged large queue every 150ms.
						while (inFlight > 0 && requeueVersion === observedRequeueVersion && (this.peerHaveUpdates.get(peerID)?.version ?? 0) === observedHaveVersion && !this.deps.isDisabled() && !this.deps.isDestroyed()) {
							await new Promise(r => setTimeout(r, 150));
						}
						continue;
					}
					// A HAVE may have arrived after the queue scan but before this decision.
					// Re-scan once so newly advertised chunks are not hidden by stale misses.
					if ((this.peerHaveUpdates.get(peerID)?.version ?? 0) !== observedHaveVersion) continue;
					if (onlyNotFoundLeft) {
						// Every remaining chunk is one this peer doesn't have — nothing useful.
						// Same soft drop as before; peer can come back via HAVE broadcast or retry session.
						console.log(`[DL] Peer ${peerID.slice(0, 12)} dropped: has none of the remaining chunks (${notFound.size} not-found)`);
						await peerManager.removeAwait(peerID, 'drop');
					}
					break;
				}

				try {
					// Throttle BEFORE downloading \u2014 ensures bandwidth is reserved before network transfer
					touchPeer(lishID, peerID, 'download');
					const limiterReservation = await downloadLimiter.throttle(lish.chunkSize);
					const result = await this.downloadChunk(client, chunk.chunkID, peerID);
					// Non-data results transferred no payload \u2014 return the reservation so failed
					// probes (an unbounded number for a partial seeder) don't accumulate phantom
					// debt on the shared limiter and starve real transfers.
					if (typeof result === 'string') downloadLimiter.refund(limiterReservation);
					if (result === 'drop-peer') {
						// Peer unusable for this session (no LISH / unreachable / invalid / unknown error).
						// Soft quarantine in droppedPeers \u2014 peer can come back via pubsub 'have' or ~5min cyclic reset.
						console.log(`[DL] Peer ${peerID.slice(0, 12)} dropped to droppedPeers`);
						await peerManager.removeAwait(peerID, 'drop');
						await requeueChunk(chunk);
						break;
					}
					if (result === 'chunk-not-found') {
						// Definitive per-chunk answer — remember it and never re-ask this peer.
						// Does NOT count toward the consecutive-skip drop: a partial seeder is
						// still useful for the chunks it does have (pull skips not-found ones).
						// It also BREAKS the transient streak — the peer just proved it's alive
						// and answering, so interleaved busy/not-found must not add up to a
						// spurious "10 consecutive" drop.
						notFound.add(chunk.chunkID);
						skippedChunks++;
						globalNotAvailable++;
						consecutiveNotAvailable = 0;
						await requeueChunk(chunk);
						if (this.deps.isDisabled() || this.deps.isDestroyed()) break;
						continue;
					}
					if (result === 'skip-chunk') {
						skippedChunks++;
						globalNotAvailable++;
						consecutiveNotAvailable++;
						if (skippedChunks % 500 === 0) trace(`[DL] Peer ${peerID.slice(0, 12)} skipped ${skippedChunks} chunks (skip-chunk, consecutive: ${consecutiveNotAvailable}, global: ${globalNotAvailable}/${queue.length})`);
						await requeueChunk(chunk);
						if (this.deps.isDisabled() || this.deps.isDestroyed()) break;
						// Per-peer: disconnect if peer keeps failing transiently (10 consecutive busy/IO skips)
						if (consecutiveNotAvailable >= 10) {
							console.log(`[DL] Peer ${peerID.slice(0, 12)} dropped: ${consecutiveNotAvailable} consecutive skip-chunk`);
							await peerManager.removeAwait(peerID, 'drop');
							break;
						}
						continue;
					}
					// Verify chunk integrity before writing
					const data = result.data;
					const hasher = new Bun.CryptoHasher(lish.checksumAlgo as any);
					hasher.update(data);
					const actualHash = hasher.digest('hex');
					if (actualHash !== chunk.chunkID) {
						const count = (corruptCount.get(peerID) ?? 0) + 1;
						corruptCount.set(peerID, count);
						console.log(`[DL] Corrupt chunk from ${peerID.slice(0, 12)}: expected ${chunk.chunkID.slice(0, 12)}, got ${actualHash.slice(0, 12)} (${count}/${ChunkDownloader.MAX_CORRUPT_CHUNKS})`);
						await requeueChunk(chunk);
						if (count >= ChunkDownloader.MAX_CORRUPT_CHUNKS) {
							console.log(`[DL] Peer ${peerID.slice(0, 12)} banned: ${count} corrupt chunks`);
							await peerManager.removeAwait(peerID, 'ban');
							break;
						}
						continue;
					}
					// Integrity OK \u2014 write chunk
					skippedChunks = 0;
					consecutiveNotAvailable = 0;
					globalNotAvailable = 0;

					try {
						await writeChunkToAllSlots(chunk, data);
					} catch (err: any) {
						if (err.code === 'ENOENT') {
							// File deleted \u2014 pause ALL peers, verify ALL files, re-allocate missing, reset chunks, resume
							if (this.fileReallocInProgress.size > 0) {
								// Another peer is already handling recovery \u2014 wait and re-queue
								await pauseController.waitIfWritePaused();
								await requeueChunk(chunk);
								continue;
							}
							const globalAttempts = (this.fileReallocAttempts.get(-1) ?? 0) + 1;
							this.fileReallocAttempts.set(-1, globalAttempts);
							if (globalAttempts > ChunkDownloader.MAX_FILE_REALLOC) {
								console.error(`[DL] Global file recovery limit (${ChunkDownloader.MAX_FILE_REALLOC}) exceeded`);
								this.deps.onSetError(ErrorCodes.IO_NOT_FOUND, downloadDir);
								break;
							}
							// Mark recovery in progress, pause all peer writes AND progress emissions.
							// Everything below this line MUST run inside try/finally so destroy/disable
							// during the 10s sleep can't leak pause state or the fileReallocInProgress flag.
							this.fileReallocInProgress.add(-1);
							pauseController.pauseWrites();
							pauseController.pauseProgress();
							progressReporter.resetLastFile();
							console.warn(`[DL] File deleted detected, pausing all transfers for 10s before recovery (attempt ${globalAttempts}/${ChunkDownloader.MAX_FILE_REALLOC})`);
							this.deps.onRetry?.({ errorCode: ErrorCodes.IO_NOT_FOUND, errorDetail: downloadDir, retryCount: globalAttempts, maxRetries: ChunkDownloader.MAX_FILE_REALLOC });
							let aborted = false;
							try {
								// FE shows retrying badge during the 10s pause — no progress override
								// 10s delay — let the user finish deleting files before we scan
								await new Promise<void>(resolve => {
									const timer = setTimeout(resolve, 10_000);
									const check = setInterval(() => {
										if (this.deps.isDestroyed() || this.deps.isDisabled()) {
											clearTimeout(timer);
											clearInterval(check);
											resolve();
										}
									}, 1000);
									setTimeout(() => clearInterval(check), 10_100);
								});
								if (this.deps.isDestroyed() || this.deps.isDisabled()) {
									aborted = true;
									break;
								}
								console.log(`[DL] Recovery: verifying all files`);

								// Step 2: Find and re-allocate missing files with progress
								const missingFiles = await fileAllocator.findMissingFiles(lish);
								if (missingFiles.length > 0) {
									const totalMissingBytes = missingFiles.reduce((sum, fi) => sum + (lish.files?.[fi]?.size ?? 0), 0);
									console.log(`[DL] ${missingFiles.length} files missing (${Math.round(totalMissingBytes / 1024 / 1024)}MB), allocating`);
									progressReporter.emit({ downloadedChunks: 0, totalChunks, peers: 0, bytesPerSecond: 0, filePath: '__allocating__', fileDownloadedChunks: 0 });
									await fileAllocator.allocateFiles(lish, missingFiles, (p: AllocationProgress) => this.deps.emitAllocProgress(p, totalChunks), this.deps.abortSignal);
								}

								// Step 3: Full verification of ALL files \u2014 checksum every chunk
								if (lish.files && !this.deps.isDestroyed()) {
									console.log(`[DL] Verifying ALL file checksums...`);
									progressReporter.emit({ downloadedChunks: 0, totalChunks, peers: 0, bytesPerSecond: 0, filePath: '__verifying__' });
									const { runVerification } = await import('../lish/lish.ts');
									const ac = new AbortController();
									let lastVerified = 0;
									let lastVerifyEmit = 0;
									await runVerification(
										dataServer,
										lishID,
										progress => {
											lastVerified = progress.verifiedChunks ?? 0;
											const now = Date.now();
											if (now - lastVerifyEmit >= 1000) {
												lastVerifyEmit = now;
												progressReporter.emit({ downloadedChunks: lastVerified, totalChunks, peers: 0, bytesPerSecond: 0, filePath: '__verifying__' });
											}
										},
										ac.signal
									);
									progressReporter.emit({ downloadedChunks: lastVerified, totalChunks, peers: 0, bytesPerSecond: 0, filePath: '__verifying__' });
									console.log(`[DL] Verification done: ${lastVerified}/${totalChunks} chunks valid`);
								}

								// Step 4: Rebuild queue from verified state
								const allMissing = dataServer.getMissingChunks(lishID);
								const allTotal = dataServer.getAllChunkCount(lishID) || totalChunks;
								downloadedCount = allTotal - allMissing.length;
								// Re-initialize per-file counters from verified DB state
								progressReporter.loadFileProgress(this.buildFileProgressEntries());
								await lock.runExclusive(() => {
									queue.length = queueIdx;
									for (const mc of allMissing) queue.push(mc);
									requeueVersion++;
								});
								progressReporter.emit({ downloadedChunks: downloadedCount, totalChunks: allTotal, peers: peerManager.size(), bytesPerSecond: 0 });
								console.log(`[DL] Recovery complete: ${downloadedCount}/${allTotal} verified, ${allMissing.length} to download`);
							} catch (allocErr: any) {
								console.error(`[DL] File recovery failed: ${allocErr.message}`);
								this.deps.onSetError(ErrorCodes.IO_NOT_FOUND, downloadDir);
								aborted = true;
								break;
							} finally {
								this.fileReallocInProgress.delete(-1);
								pauseController.resumeProgress();
								pauseController.resumeWrites();
							}
							if (aborted) break;
							this.deps.onRetry?.({ errorCode: ErrorCodes.IO_NOT_FOUND, errorDetail: downloadDir, retryCount: globalAttempts, maxRetries: ChunkDownloader.MAX_FILE_REALLOC, resolved: true });
							continue;
						} else if (err.code === 'ENOSPC' || err.code === 'EACCES' || err.code === 'EPERM') {
							// Disk full or permission denied \u2014 inline retry with pause
							const code = err.code === 'ENOSPC' ? ErrorCodes.DISK_FULL : ErrorCodes.DIRECTORY_ACCESS_DENIED;
							if (pauseController.writePaused) {
								// Another peer already handling the write error \u2014 just wait and re-queue
								await pauseController.waitIfWritePaused();
								await requeueChunk(chunk);
								continue;
							}
							this.writeRetryCount++;
							if (this.writeRetryCount > ChunkDownloader.MAX_WRITE_RETRIES) {
								console.error(`[DL] Write retry limit (${ChunkDownloader.MAX_WRITE_RETRIES}) exceeded for ${lishID.slice(0, 8)}`);
								this.deps.onSetError(code, downloadDir);
								break;
							}
							console.warn(`[DL] ${lishID.slice(0, 8)}: write failed (${err.code}), pausing ${ChunkDownloader.WRITE_RETRY_DELAY / 1000}s (attempt ${this.writeRetryCount}/${ChunkDownloader.MAX_WRITE_RETRIES})`);
							this.deps.onRetry?.({ errorCode: code, errorDetail: downloadDir, retryCount: this.writeRetryCount, maxRetries: ChunkDownloader.MAX_WRITE_RETRIES });
							// Everything below MUST run inside try/finally so destroy/disable during the 60s
							// sleep can't leak _writePaused=true, which would hang all peer loops on the next enable().
							pauseController.pauseWrites();
							let writeAborted = false;
							let writeRequeue = false;
							try {
								await new Promise<void>(resolve => {
									const timer = setTimeout(resolve, ChunkDownloader.WRITE_RETRY_DELAY);
									const check = setInterval(() => {
										if (this.deps.isDestroyed() || this.deps.isDisabled()) {
											clearTimeout(timer);
											clearInterval(check);
											resolve();
										}
									}, 1000);
									setTimeout(() => clearInterval(check), ChunkDownloader.WRITE_RETRY_DELAY + 100);
								});
								if (this.deps.isDestroyed() || this.deps.isDisabled()) {
									writeAborted = true;
									break;
								}
								try {
									await writeChunkToAllSlots(chunk, data);
									console.log(`[DL] Write retry succeeded for ${lishID.slice(0, 8)}`);
									this.writeRetryCount = 0;
									this.deps.onRetry?.({ errorCode: code, errorDetail: downloadDir, retryCount: 0, maxRetries: ChunkDownloader.MAX_WRITE_RETRIES, resolved: true });
								} catch (retryErr: any) {
									console.warn(`[DL] ${lishID.slice(0, 8)}: write retry still failed (attempt ${this.writeRetryCount}/${ChunkDownloader.MAX_WRITE_RETRIES}): ${retryErr.code ?? retryErr.message}`);
									writeRequeue = true;
								}
							} finally {
								pauseController.resumeWrites();
							}
							if (writeAborted) break;
							if (writeRequeue) {
								await requeueChunk(chunk);
								continue;
							}
						} else {
							this.deps.onSetError(ErrorCodes.DOWNLOAD_ERROR, err.message);
							break;
						}
					}
					dataServer.markChunkDownloaded(lishID, chunk.chunkID);
					dataServer.incrementDownloadedBytes(lishID, data.length);
					recordDownloadBytes(lishID, peerID, data.length, lish.files?.[chunk.fileIndex]?.path);
					downloadedCount++;
					if (this.writeRetryCount > 0) this.writeRetryCount = 0;
					const fIdx = chunk.fileIndex;
					progressReporter.recordChunk(data.length, fIdx, lish.files?.[fIdx]?.path);
					if (downloadedCount % 50 === 0 || downloadedCount === totalChunks) {
						const bytesPerSecond = progressReporter.bytesPerSecond();
						console.log(`[DL] ${downloadedCount}/${totalChunks} verified, ${peerManager.size()} peers, ${Math.round(bytesPerSecond / 1024)}KB/s`);
					}
				} finally {
					// The chunk's fate is settled (downloaded, requeued, or fatal) — release
					// the in-flight claim so idle peers can make their exit/drop decision.
					inFlight--;
				}
			}
			peerManager.markInactive(peerID);
		};

		// 1s periodic progress emitter \u2014 reporter owns the sliding window + emit; getSnapshot supplies
		// the values that live on the Downloader local scope (downloadedCount, totalChunks, peer count).
		progressReporter.startTicker(() => ({
			downloadedChunks: downloadedCount,
			totalChunks,
			peers: peerManager.size(),
			paused: pauseController.progressPaused,
		}));

		try {
			// Wire dynamic spawn: any peer added to peerManager (via tryAdd from pubsub / probe)
			// fires this callback and gets its own peerLoop. Replaces the old poll-based spawnNewPeerLoops.
			peerManager.setCallbacks({ onPeerAdded: spawnPeerLoop });

			const initialPeers = peerManager.snapshot();
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
			progressReporter.stopTicker();
			// Unwire spawn BEFORE closing \u2014 avoids spawning a loop for a peer we're about to tear down.
			peerManager.clearCallbacks();
			await peerManager.closeAllAwait('downloadChunks finally');
			// Reset frontend peers/speed immediately when all peer loops finish
			progressReporter.emit({ downloadedChunks: downloadedCount, totalChunks, peers: 0, bytesPerSecond: 0 });
		}
	}

	/**
	 * Request a single chunk from a peer over an existing client.
	 * Result semantics:
	 *   - { data }           \u2192 success, chunk received
	 *   - 'chunk-not-found'  \u2192 peer has the LISH but not THIS chunk (partial seeder).
	 *                          Caller requeues for other peers and stops asking this
	 *                          peer for the chunk within the session.
	 *   - 'skip-chunk'       \u2192 transient failure for THIS chunk (busy / IO). Caller
	 *                          requeues and counts consecutive skips (10\u00d7 \u2192 droppedPeers).
	 *   - 'drop-peer'        \u2192 peer not useful now (no LISH, unreachable, invalid, unknown).
	 *                          Caller requeues the chunk, moves peer to droppedPeers (soft
	 *                          quarantine with auto-recovery via pubsub 'have' or the
	 *                          ~5min cyclic reset). Never bans the peer permanently.
	 * Permanent bans (bannedPeers) are reserved for actively malicious behavior
	 * (corrupt chunks) and are handled by the caller above.
	 */
	private async downloadChunk(client: LISHClient, chunkID: ChunkID, peerID?: string): Promise<{ data: Uint8Array } | 'skip-chunk' | 'chunk-not-found' | 'drop-peer'> {
		if (this.deps.isDisabled() || this.deps.isDestroyed()) return 'drop-peer';
		try {
			const data = await client.requestChunk(this.deps.lishID, chunkID);
			return { data };
		} catch (err) {
			const code = (err as { code?: string }).code;
			// Definitive per-chunk answer \u2014 the peer is an honest partial seeder.
			if (code === ErrorCodes.PEER_CHUNK_NOT_FOUND) {
				if (peerID && !this.notAvailableLoggedPeers.has(peerID)) {
					this.notAvailableLoggedPeers.add(peerID);
					console.debug(`[DL] first chunk-not-found from ${peerID.slice(0, 12)}`);
				}
				return 'chunk-not-found';
			}
			// Chunk-specific transient \u2014 peer has the LISH, but this particular chunk isn't servable right now.
			if (code === ErrorCodes.PEER_BUSY || code === ErrorCodes.PEER_IO_ERROR) {
				if (peerID && !this.notAvailableLoggedPeers.has(peerID)) {
					this.notAvailableLoggedPeers.add(peerID);
					console.debug(`[DL] first skip-chunk from ${peerID.slice(0, 12)}: ${code}`);
				}
				return 'skip-chunk';
			}
			// Peer-level \u2014 LISH not shared, stream dead/timeout, malformed response, or unknown error.
			// Drop into droppedPeers (soft quarantine; peer can come back via 'have' broadcast or 5min reset).
			const msg = err instanceof Error ? err.message : String(err);
			console.debug(`[DL] drop peer ${peerID?.slice(0, 12)}: ${code ?? msg.slice(0, 80)}`);
			return 'drop-peer';
		}
	}

	/**
	 * Map DB file verification progress onto fileIndex-keyed entries for the
	 * ProgressReporter. Called at run start and again after surgical ENOENT
	 * recovery to re-seed the per-file counters from verified state.
	 */
	private buildFileProgressEntries(): FileProgressEntry[] {
		const { lishID, dataServer } = this.deps;
		const lish = this.deps.getLish();
		if (!lish.files) return [];
		const vp = dataServer.getFileVerificationProgress(lishID);
		const entries: FileProgressEntry[] = [];
		for (let i = 0; i < lish.files.length; i++) {
			const match = vp.find(f => f.filePath === lish.files![i]!.path);
			if (match) entries.push({ fileIndex: i, verifiedChunks: match.verifiedChunks });
		}
		return entries;
	}
}
