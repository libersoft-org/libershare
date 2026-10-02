import { type IStoredLISH } from '@shared';
import { trace } from '../logger.ts';
import { openDataset, datasetPath, validateDatasetNamespace, type DatasetRoot, type SafeDataset } from '../lish/safe-dataset-files.ts';
import { checkDatasetSpace } from '../lish/dataset-space.ts';
import { datasetCopyBytes } from '../lish/dataset-transfer.ts';
import type { DatasetLinkBinding } from '../db/lishs-link-bindings.ts';

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

/** Counts of newly created vs. already-present (skipped) files from an allocation pass. */
export interface IAllocationResult {
	created: number;
	skipped: number;
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
 * Filesystem operations are relative to held directory handles. The complete
 * manifest is checked before any allocation, including recovery of one file.
 *
 * Cancellation: on aborted signal, operations return/resolve silently (no
 * exception) — matches the Downloader's prior "silent early return on destroy"
 * behavior. Callers MUST re-check `signal.aborted` after awaiting.
 */
export class FileAllocator {
	private readonly downloadDir: string;
	private readonly root: DatasetRoot | string;
	private readonly linkBindings: () => readonly DatasetLinkBinding[];

	constructor(root: DatasetRoot | string, linkBindings: () => readonly DatasetLinkBinding[] = () => []) {
		this.root = root;
		this.downloadDir = datasetPath(root);
		this.linkBindings = linkBindings;
	}

	/**
	 * Return indexes of files that are missing on disk or have the wrong size.
	 * Pure read-only — modifies nothing. Empty array means all files are OK.
	 */
	async findMissingFiles(lish: IStoredLISH): Promise<number[]> {
		if (!lish.files || lish.files.length === 0) return [];
		validateDatasetNamespace(lish);
		let dataset: SafeDataset;
		try {
			dataset = await openDataset(this.root);
		} catch (error: any) {
			if (error?.code === 'ENOENT') return lish.files.map((_, index) => index);
			throw error;
		}
		try {
			await dataset.prepare(lish);
			await this.ensureSpaceFor(dataset, lish, []);
			const missing: number[] = [];
			for (let i = 0; i < lish.files.length; i++) {
				const file = lish.files[i]!;
				const info = await dataset.statFile(file.path);
				if (!info || info.size !== file.size) {
					trace(`[FA] missing: ${file.path} exists=${info !== null} size=${info?.size} expected=${file.size}`);
					missing.push(i);
				}
			}
			return missing;
		} finally {
			await dataset.close();
		}
	}

	/**
	 * Initial allocation: create all `lish.directories` entries, then zero-fill
	 * every file in `lish.files` that is missing or has a wrong size.
	 *
	 * Files that already exist with correct size are skipped (counted).
	 *
	 * @returns counts of newly created and skipped files
	 */
	async allocateStructure(lish: IStoredLISH, onProgress?: (p: AllocationProgress) => void, signal?: AbortSignal): Promise<IAllocationResult> {
		const startTime = Date.now();

		const allIndexes: number[] = [];
		for (let i = 0; i < (lish.files?.length ?? 0); i++) allIndexes.push(i);
		const result = await this.allocateFilesInternal(lish, allIndexes, onProgress, signal);
		console.log(`[FA] Allocated structure: ${lish.files?.length ?? 0} files in ${this.downloadDir} (created=${result.created}, skipped=${result.skipped}, ${Date.now() - startTime}ms)`);
		return result;
	}

	/**
	 * Allocate a specific subset of files (mid-download recovery when some files
	 * are detected missing). Validate and reserve the complete manifest first,
	 * so aliases outside this subset cannot redirect an allocation.
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
		const result = await this.allocateFilesInternal(lish, [fileIndex], undefined, signal);
		if (result.created > 0) console.log(`[FA] Re-allocated file: ${file.path} (${file.size} bytes)`);
	}

	// ======== internals ========

	/**
	 * Refuse with DISK_FULL before writing anything when the declared sizes of the files still to
	 * allocate do not fit in the space free under the download directory — zero-filling first
	 * would run the disk full and leave a half-allocated dataset. A replaced file counts in full:
	 * its logical size does not tell us how many blocks a sparse file occupies. Completion must also fit.
	 */
	private async ensureSpaceFor(dataset: SafeDataset, lish: IStoredLISH, fileIndexes: readonly number[]): Promise<void> {
		let needed = 0n;
		for (const fi of fileIndexes) {
			const file = lish.files?.[fi];
			if (!file) continue;
			const existing = await dataset.statFile(file.path);
			const current = existing?.size ?? 0;
			if (current !== file.size) needed += BigInt(file.size);
		}
		const root: DatasetRoot = typeof this.root === 'string' ? { kind: 'explicit', path: this.downloadDir } : this.root;
		const bindings = lish.finalDirectory ? this.linkBindings() : [];
		const completion = lish.finalDirectory ? { path: lish.finalDirectory, bytes: datasetCopyBytes(lish, root, bindings), ...(process.platform !== 'win32' ? { sameFilesystemBytes: datasetCopyBytes(lish, root, bindings, true) } : {}) } : undefined;
		await checkDatasetSpace(this.downloadDir, needed, completion);
	}

	private async allocateFilesInternal(lish: IStoredLISH, fileIndexes: readonly number[], onProgress: ((p: AllocationProgress) => void) | undefined, signal: AbortSignal | undefined): Promise<IAllocationResult> {
		let created = 0;
		let skipped = 0;
		if (signal?.aborted) return { created, skipped };
		validateDatasetNamespace(lish);
		const dataset = await openDataset(this.root, true);
		try {
			await dataset.prepare(lish, signal ? { signal } : {});
			// Aggregate totals across the requested subset — allows per-batch progress
			// percentage irrespective of how many files the caller picked.
			let totalBytes = 0;
			for (const fi of fileIndexes) totalBytes += lish.files?.[fi]?.size ?? 0;
			await this.ensureSpaceFor(dataset, lish, fileIndexes);
			const present = new Set<string>();
			for (const fi of fileIndexes) {
				const file = lish.files?.[fi];
				if (file && (await dataset.statFile(file.path))) present.add(file.path);
			}
			await dataset.prepare(lish, signal ? { reserve: true, signal } : { reserve: true });
			let totalBytesWritten = 0;
			let nextProgressAt = PROGRESS_EMIT_INTERVAL;
			for (const fi of fileIndexes) {
				if (signal?.aborted) return { created, skipped };
				const file = lish.files?.[fi];
				if (!file) continue;
				const fd = await dataset.openFile(file.path, 'write');
				try {
					if (signal?.aborted) return { created, skipped };
					if (present.has(file.path) && (await fd.stat()).size === file.size) {
						totalBytesWritten += file.size;
						skipped++;
						continue;
					}
					if (signal?.aborted) return { created, skipped };
					await fd.truncate(0);
					let remaining = file.size;
					let fileBytesWritten = 0;
					while (remaining > 0) {
						if (signal?.aborted) return { created, skipped };
						const writeSize = Math.min(remaining, ZERO_BUFFER.length);
						const bytesWritten = await fd.write(ZERO_BUFFER.subarray(0, writeSize), fileBytesWritten);
						if (bytesWritten <= 0) throw Object.assign(new Error('File allocation made no progress'), { code: 'EIO' });
						remaining -= bytesWritten;
						fileBytesWritten += bytesWritten;
						totalBytesWritten += bytesWritten;
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
		} catch (error) {
			if (signal?.aborted) return { created, skipped };
			throw error;
		} finally {
			await dataset.close();
		}
	}
}
