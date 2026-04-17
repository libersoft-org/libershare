/**
 * Per-download progress accounting and emission.
 *
 * Owns everything about "how fast are we downloading" and "which file is currently
 * being served to the FE":
 *
 *   - Sliding 10s speed window (bytes/sec)
 *   - Per-file chunk counters (for the file-panel progress bar)
 *   - Last-served file pointer (filePath + count shown in the periodic tick)
 *   - 1s periodic ticker that emits ProgressInfo to the downstream callback
 *   - Pass-through emit() for lifecycle events (error, allocation, verification)
 *
 * Design: the reporter does NOT own `downloadedCount` / `totalChunks` / peer count
 * \u2014 those live on the Downloader and are read via a getSnapshot() callback passed
 * to startTicker(). This keeps a single source of truth in the caller and makes
 * the reporter trivially testable (no mocks beyond a snapshot function).
 */

export interface ProgressInfo {
	downloadedChunks: number;
	totalChunks: number;
	peers: number;
	bytesPerSecond: number;
	filePath?: string;
	fileDownloadedChunks?: number;
	allocatingFile?: string;
	allocatingFileProgress?: number;
}

export type ProgressCallback = (info: ProgressInfo) => void;

export interface TickerSnapshot {
	downloadedChunks: number;
	totalChunks: number;
	peers: number;
	/** If true, the tick is skipped (no emit). Used during ENOENT / write recovery. */
	paused: boolean;
}

/** Entries fed to loadFileProgress() \u2014 one per file in the manifest that has existing verified chunks. */
export interface FileProgressEntry {
	fileIndex: number;
	verifiedChunks: number;
}

const SPEED_WINDOW_MS = 10_000;
const TICK_INTERVAL_MS = 1000;

export class ProgressReporter {
	private cb: ProgressCallback | undefined;
	private speedSamples: { time: number; bytes: number }[] = [];
	private fileChunks = new Map<number, number>();
	private lastFilePath: string | undefined;
	private lastFileChunks: number | undefined;
	private tickerHandle: ReturnType<typeof setInterval> | undefined;

	setCallback(cb: ProgressCallback | undefined): void {
		this.cb = cb;
	}

	clearCallback(): void {
		this.cb = undefined;
	}

	hasCallback(): boolean {
		return this.cb != null;
	}

	/** Pass-through emit for lifecycle events (error, allocation, verification, destroy). */
	emit(info: ProgressInfo): void {
		this.cb?.(info);
	}

	/**
	 * Seed per-file counters from DB verification state. Called at downloadChunks
	 * start and after surgical ENOENT recovery. Entries with verifiedChunks === 0
	 * are skipped (they would be a no-op in the periodic emit anyway).
	 */
	loadFileProgress(entries: ReadonlyArray<FileProgressEntry>): void {
		this.fileChunks.clear();
		for (const e of entries) {
			if (e.verifiedChunks > 0) this.fileChunks.set(e.fileIndex, e.verifiedChunks);
		}
	}

	/**
	 * Record a successfully downloaded+written chunk: push a speed sample, bump
	 * the per-file counter, and update the last-served pointer. The next ticker
	 * emission will reflect all three.
	 */
	recordChunk(byteLen: number, fileIndex: number, filePath: string | undefined): void {
		const now = Date.now();
		this.speedSamples.push({ time: now, bytes: byteLen });
		this.trimSamples(now);
		const count = (this.fileChunks.get(fileIndex) ?? 0) + 1;
		this.fileChunks.set(fileIndex, count);
		this.lastFilePath = filePath;
		this.lastFileChunks = count;
	}

	/**
	 * Clear the last-served file pointer. Called before recovery so the retrying
	 * UI state doesn't show a stale file path while we're re-verifying.
	 */
	resetLastFile(): void {
		this.lastFilePath = undefined;
		this.lastFileChunks = undefined;
	}

	/** Current sliding-window speed in bytes/sec. Returns 0 while the window is too short. */
	bytesPerSecond(): number {
		const now = Date.now();
		this.trimSamples(now);
		if (this.speedSamples.length < 2) return 0;
		const windowBytes = this.speedSamples.reduce((sum, s) => sum + s.bytes, 0);
		const oldestTime = this.speedSamples[0]!.time;
		const elapsed = (now - oldestTime) / 1000;
		return elapsed >= 0.5 ? Math.round(windowBytes / elapsed) : 0;
	}

	/**
	 * Start the 1s periodic tick. `getSnapshot` is called synchronously every
	 * tick to fetch the current count/total/peers/paused. Safe to call again \u2014
	 * any existing ticker is stopped first.
	 */
	startTicker(getSnapshot: () => TickerSnapshot): void {
		this.stopTicker();
		this.tickerHandle = setInterval(() => {
			const snap = getSnapshot();
			if (snap.paused) return;
			const info: ProgressInfo = {
				downloadedChunks: snap.downloadedChunks,
				totalChunks: snap.totalChunks,
				peers: snap.peers,
				bytesPerSecond: this.bytesPerSecond(),
			};
			if (this.lastFilePath != null) info.filePath = this.lastFilePath;
			if (this.lastFileChunks != null) info.fileDownloadedChunks = this.lastFileChunks;
			this.cb?.(info);
		}, TICK_INTERVAL_MS);
	}

	stopTicker(): void {
		if (this.tickerHandle) {
			clearInterval(this.tickerHandle);
			this.tickerHandle = undefined;
		}
	}

	/** Clear all session state (speed window, per-file counters, last-served pointer). */
	resetSession(): void {
		this.speedSamples = [];
		this.fileChunks.clear();
		this.lastFilePath = undefined;
		this.lastFileChunks = undefined;
	}

	private trimSamples(now: number): void {
		const cutoff = now - SPEED_WINDOW_MS;
		this.speedSamples = this.speedSamples.filter(s => s.time > cutoff);
	}
}
