import { mkdir, open } from 'fs/promises';
import { dirname, resolve, sep } from 'path';
import type { IStoredLISH } from '@shared';
import { trace } from '../logger.ts';

/**
 * Progress event emitted while zero-filling files.
 *
 * The caller is responsible for mapping this into their own progress shape
 * (e.g. the Downloader wraps it into onProgress with 'filePath: "__allocating__"').
 */
export interface AllocationProgress {
	/** Currently allocating file (relative path from the manifest). */
	filePath: string;
	/** Bytes written to this file so far. */
	fileBytesWritten: number;
	/** Total size of this file. */
	fileSize: number;
	/** Bytes written across all files in this allocation batch. */
	totalBytesWritten: number;
	/** Sum of file sizes for all files being allocated in this batch. */
	totalBytes: number;
}

const ZERO_BUFFER = new Uint8Array(1024 * 1024); // 1MB reusable zero-fill buffer
const PROGRESS_EMIT_INTERVAL = 50 * 1024 * 1024; // emit progress every 50MB

/**
 * Stateless file allocator for LISH downloads.
 *
 * "Stateless" here means the allocator owns only an immutable `downloadDir` —
 * there is no per-download mutable state. Every operation takes the manifest
 * as an argument and is independently cancellable via AbortSignal.
 *
 * Path-traversal protection: every path is resolved relative to downloadDir
 * and rejected if it escapes (see safePath()).
 *
 * Cancellation: on aborted signal, operations return/resolve silently (no
 * exception) — matches the Downloader's prior "silent early return on destroy"
 * behavior. Callers MUST re-check `signal.aborted` after awaiting.
 */
export class FileAllocator {
	private readonly downloadDir: string;

	constructor(downloadDir: string) {
		this.downloadDir = downloadDir;
	}

	/**
	 * Resolve a manifest-relative path to an absolute path inside downloadDir.
	 * Throws if the resolved path escapes downloadDir (path-traversal attempt).
	 */
	private safePath(relativePath: string): string {
		const resolved = resolve(this.downloadDir, relativePath);
		if (!resolved.startsWith(resolve(this.downloadDir) + sep)) throw new Error(`Path traversal blocked: ${relativePath}`);
		return resolved;
	}

	/**
	 * Return indexes of files that are missing on disk or have the wrong size.
	 * Pure read-only — modifies nothing. Empty array means all files are OK.
	 */
	async findMissingFiles(lish: IStoredLISH): Promise<number[]> {
		if (!lish.files || lish.files.length === 0) return [];
		const missing: number[] = [];
		for (let i = 0; i < lish.files.length; i++) {
			const file = lish.files[i]!;
			const filePath = this.safePath(file.path);
			const f = Bun.file(filePath);
			const exists = await f.exists();
			if (!exists || f.size !== file.size) {
				trace(`[FA] missing: ${file.path} exists=${exists} size=${f.size} expected=${file.size}`);
				missing.push(i);
			}
		}
		return missing;
	}

	/**
	 * Initial allocation: create all `lish.directories` entries, then zero-fill
	 * every file in `lish.files` that is missing or has a wrong size.
	 *
	 * Files that already exist with correct size are skipped (counted).
	 *
	 * @returns counts of newly created and skipped files
	 */
	async allocateStructure(lish: IStoredLISH, onProgress?: (p: AllocationProgress) => void, signal?: AbortSignal): Promise<{ created: number; skipped: number }> {
		const startTime = Date.now();
		if (lish.directories) {
			for (const dir of lish.directories) {
				if (signal?.aborted) return { created: 0, skipped: 0 };
				await mkdir(this.safePath(dir.path), { recursive: true });
			}
		}
		if (!lish.files || lish.files.length === 0) {
			console.log(`[FA] Allocated structure: 0 files in ${this.downloadDir} (${Date.now() - startTime}ms)`);
			return { created: 0, skipped: 0 };
		}
		const allIndexes: number[] = [];
		for (let i = 0; i < lish.files.length; i++) allIndexes.push(i);
		const result = await this.allocateFilesInternal(lish, allIndexes, onProgress, signal);
		console.log(`[FA] Allocated structure: ${lish.files.length} files in ${this.downloadDir} (created=${result.created}, skipped=${result.skipped}, ${Date.now() - startTime}ms)`);
		return result;
	}

	/**
	 * Allocate a specific subset of files (mid-download recovery when some files
	 * are detected missing). Creates parent directories as needed; does NOT
	 * recreate `lish.directories` entries (assumed to exist from initial alloc).
	 */
	async allocateFiles(lish: IStoredLISH, fileIndexes: readonly number[], onProgress?: (p: AllocationProgress) => void, signal?: AbortSignal): Promise<void> {
		if (fileIndexes.length === 0) return;
		await this.allocateFilesInternal(lish, fileIndexes, onProgress, signal);
	}

	/**
	 * Re-allocate a single file (after mid-download deletion). Emits no progress
	 * — used for fast sequential re-allocation in doWork Phase 3. Logs one
	 * INFO-level "re-allocated" line on completion.
	 */
	async allocateFile(lish: IStoredLISH, fileIndex: number, signal?: AbortSignal): Promise<void> {
		const file = lish.files?.[fileIndex];
		if (!file) return;
		if (signal?.aborted) return;
		const filePath = this.safePath(file.path);
		await mkdir(dirname(filePath), { recursive: true });
		const existing = Bun.file(filePath);
		if ((await existing.exists()) && existing.size === file.size) return;
		await this.zeroFillFile(filePath, file.size, signal);
		console.log(`[FA] Re-allocated file: ${file.path} (${file.size} bytes)`);
	}

	// ======== internals ========

	private async allocateFilesInternal(
		lish: IStoredLISH,
		fileIndexes: readonly number[],
		onProgress: ((p: AllocationProgress) => void) | undefined,
		signal: AbortSignal | undefined,
	): Promise<{ created: number; skipped: number }> {
		let created = 0;
		let skipped = 0;
		if (!lish.files) return { created, skipped };

		// Aggregate totals across the requested subset — allows per-batch progress
		// percentage irrespective of how many files the caller picked.
		let totalBytes = 0;
		for (const fi of fileIndexes) totalBytes += lish.files[fi]?.size ?? 0;
		let totalBytesWritten = 0;
		let nextProgressAt = PROGRESS_EMIT_INTERVAL;

		for (const fi of fileIndexes) {
			if (signal?.aborted) return { created, skipped };
			const file = lish.files[fi];
			if (!file) continue;
			const filePath = this.safePath(file.path);
			await mkdir(dirname(filePath), { recursive: true });
			const existing = Bun.file(filePath);
			if ((await existing.exists()) && existing.size === file.size) {
				totalBytesWritten += file.size;
				skipped++;
				continue;
			}
			const fd = await open(filePath, 'w');
			try {
				let remaining = file.size;
				let fileBytesWritten = 0;
				while (remaining > 0) {
					if (signal?.aborted) return { created, skipped };
					const writeSize = Math.min(remaining, ZERO_BUFFER.length);
					await fd.write(ZERO_BUFFER.subarray(0, writeSize));
					remaining -= writeSize;
					fileBytesWritten += writeSize;
					totalBytesWritten += writeSize;
					if (totalBytesWritten >= nextProgressAt || remaining === 0) {
						nextProgressAt = totalBytesWritten + PROGRESS_EMIT_INTERVAL;
						if (onProgress) {
							onProgress({
								filePath: file.path,
								fileBytesWritten,
								fileSize: file.size,
								totalBytesWritten,
								totalBytes,
							});
							// Yield to the event loop so concurrent peerLoops (or UI) can run
							await new Promise(r => setTimeout(r, 0));
						}
					}
				}
			} finally {
				await fd.close();
			}
			created++;
			trace(`[FA] created file: ${file.path} (${file.size}B)`);
		}
		return { created, skipped };
	}

	/**
	 * Zero-fill a file of the given size. No progress, no yielding — used by
	 * allocateFile() for the "re-allocate one file" hot path.
	 */
	private async zeroFillFile(filePath: string, size: number, signal: AbortSignal | undefined): Promise<void> {
		const fd = await open(filePath, 'w');
		try {
			let remaining = size;
			while (remaining > 0) {
				if (signal?.aborted) return;
				const writeSize = Math.min(remaining, ZERO_BUFFER.length);
				await fd.write(ZERO_BUFFER.subarray(0, writeSize));
				remaining -= writeSize;
			}
		} finally {
			await fd.close();
		}
	}
}
