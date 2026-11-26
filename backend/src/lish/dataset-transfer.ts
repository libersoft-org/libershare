import { readdir } from 'node:fs/promises';
import { CodedError, ErrorCodes, validateLISHStructure, type ILISH } from '@shared';
import { createDataset, openDataset, type DatasetRoot, type SafeDataset } from './safe-dataset-files.ts';
import { datasetRootPath, conservativeDatasetRoot } from './dataset-root.ts';
import type { DatasetFileHandle, DatasetContentGuard, DatasetEntryInfo } from './safe-dataset-types.ts';
import { checkDatasetCopySpace } from './dataset-space.ts';

export interface DatasetMoveResult {
	cleanupWarnings: { stage: 'source-cleanup' | 'target-close' | 'source-close'; code: string; retainedDirectory?: string; retainedPath?: string }[];
}

function cleanupCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'IO_ERROR';
}

function cleanupWarning(stage: DatasetMoveResult['cleanupWarnings'][number]['stage'], error: unknown): DatasetMoveResult['cleanupWarnings'][number] {
	const detail = error instanceof CodedError ? error.detail : undefined;
	const retainedDirectory = detail?.match(/^Removal stopped; data preserved in (\.lish-remove-[a-f0-9-]{36})\/entry$/u)?.[1];
	const retainedPath = (error as { retainedPath?: unknown } | null)?.retainedPath;
	return { stage, code: cleanupCode(error), ...(retainedDirectory ? { retainedDirectory, ...(typeof retainedPath === 'string' ? { retainedPath } : {}) } : {}) };
}

export interface DatasetMoveProgress {
	type: 'file-list' | 'chunk' | 'file';
	totalFiles: number;
	completedFiles: number;
	totalBytes: number;
	completedBytes: number;
	path?: string;
	fileBytes?: number;
	fileSize?: number;
	files?: { path: string; size: number }[];
}

function directoriesOf(manifest: ILISH): string[] {
	const paths = new Set<string>((manifest.directories ?? []).map(entry => entry.path));
	for (const entry of [...(manifest.files ?? []), ...(manifest.directories ?? [])]) {
		const parts = entry.path.split('/');
		for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join('/'));
	}
	return [...paths].sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a));
}

/** Bytes a copy of the dataset to another filesystem writes: the declared sizes of all its files. */
export function datasetCopyBytes(manifest: ILISH): bigint {
	return (manifest.files ?? []).reduce((bytes, file) => bytes + BigInt(file.size), 0n);
}

async function snapshot(dataset: SafeDataset, manifest: ILISH): Promise<Map<string, string>> {
	const identities = new Map<string, string>();
	for (const file of manifest.files ?? []) {
		const info = await dataset.statFile(file.path);
		if (info) identities.set(file.path, info.identity);
	}
	for (const path of [...directoriesOf(manifest), '']) {
		const info = await dataset.statDirectory(path);
		if (info) identities.set(path, info.identity);
	}
	return identities;
}

async function removeContents(dataset: SafeDataset, manifest: ILISH, identities: Map<string, string>, removeRoot: boolean, guards?: ReadonlyMap<string, DatasetContentGuard>): Promise<boolean> {
	let retained = false;
	for (const file of manifest.files ?? []) {
		const identity = identities.get(file.path);
		if (identity) await dataset.removeFile(file.path, identity, guards?.get(file.path));
	}
	for (const path of [...directoriesOf(manifest), ...(removeRoot ? [''] : [])]) {
		const identity = identities.get(path);
		if (!identity) continue;
		try {
			await dataset.removeDirectory(path, identity);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
			retained = true;
		}
	}
	return retained;
}

export async function deleteDatasetData(manifest: ILISH, root: DatasetRoot): Promise<void> {
	let dataset: SafeDataset;
	try {
		dataset = await openDataset(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw error;
	}
	try {
		await dataset.prepare(manifest, { reserve: false, writable: false });
		const identities = await snapshot(dataset, manifest);
		await dataset.assertPathBinding();
		await removeContents(dataset, manifest, identities, root.kind === 'derived');
	} finally {
		await dataset.close();
	}
}

async function copyFile(source: DatasetFileHandle, target: DatasetFileHandle, file: NonNullable<ILISH['files']>[number], manifest: ILISH, verification: 'manifest' | 'source', progress: (bytes: number) => void): Promise<DatasetContentGuard> {
	const info = await source.stat();
	if (info.modified === undefined || info.changed === undefined) throw new CodedError(ErrorCodes.FS_FILE_CHANGED);
	const contentHash = new Bun.CryptoHasher('sha256');
	if (verification === 'manifest' && info.size !== file.size) throw new CodedError(ErrorCodes.IO_NOT_FOUND, 'Source file size changed');
	const buffer = new Uint8Array(Math.min(256 * 1024, manifest.chunkSize));
	const copiedChecksums: string[] = [];
	let position = 0;
	while (position < info.size) {
		const checksum = file.checksums[copiedChecksums.length];
		const end = Math.min(position + manifest.chunkSize, info.size);
		const hasher = new Bun.CryptoHasher(manifest.checksumAlgo as any);
		while (position < end) {
			const requested = buffer.subarray(0, Math.min(buffer.length, end - position));
			const received = await source.read(requested, position);
			if (received === 0) throw new CodedError(ErrorCodes.IO_NOT_FOUND, 'Source file ended during copy');
			const bytes = requested.subarray(0, received);
			hasher.update(bytes);
			contentHash.update(bytes);
			let written = 0;
			while (written < received) {
				const count = await target.write(bytes.subarray(written), position + written);
				if (count === 0) throw new CodedError(ErrorCodes.DISK_FULL, 'Copy made no write progress');
				written += count;
			}
			position += received;
			progress(position);
		}
		const copiedChecksum = hasher.digest('hex');
		if (verification === 'manifest' && copiedChecksum !== checksum) throw new CodedError(ErrorCodes.LISH_INVALID_MANIFEST, 'Copied file checksum does not match the manifest');
		copiedChecksums.push(copiedChecksum);
	}
	await target.truncate(info.size);
	// Read back the new file before committing its location.
	let offset = 0;
	for (const checksum of copiedChecksums) {
		const end = Math.min(offset + manifest.chunkSize, info.size);
		const hasher = new Bun.CryptoHasher(manifest.checksumAlgo as any);
		while (offset < end) {
			const received = await target.read(buffer.subarray(0, Math.min(buffer.length, end - offset)), offset);
			if (received === 0) throw new CodedError(ErrorCodes.IO_NOT_FOUND, 'Copied file ended during verification');
			hasher.update(buffer.subarray(0, received));
			offset += received;
		}
		if (hasher.digest('hex') !== checksum) throw new CodedError(ErrorCodes.LISH_INVALID_MANIFEST, 'Copied file verification failed');
	}
	const current = await source.stat();
	if (current.size !== info.size || current.modified !== info.modified || current.changed !== info.changed) throw new CodedError(ErrorCodes.FS_FILE_CHANGED);
	return { size: info.size, modified: info.modified, changed: info.changed, checksum: contentHash.digest('hex') };
}

async function verifyLinkedFile(handle: DatasetFileHandle, file: NonNullable<ILISH['files']>[number], manifest: ILISH, progress: (bytes: number) => void): Promise<DatasetEntryInfo> {
	const before = await handle.stat();
	if (before.size !== file.size) throw new CodedError(ErrorCodes.IO_NOT_FOUND, 'Source file size changed');
	const buffer = new Uint8Array(Math.min(256 * 1024, manifest.chunkSize));
	let position = 0;
	for (const checksum of file.checksums) {
		const end = Math.min(position + manifest.chunkSize, file.size);
		const hasher = new Bun.CryptoHasher(manifest.checksumAlgo as any);
		while (position < end) {
			const count = await handle.read(buffer.subarray(0, Math.min(buffer.length, end - position)), position);
			if (!count) throw new CodedError(ErrorCodes.FS_FILE_CHANGED);
			hasher.update(buffer.subarray(0, count));
			position += count;
			progress(position);
		}
		if (hasher.digest('hex') !== checksum) throw new CodedError(ErrorCodes.LISH_INVALID_MANIFEST);
	}
	const after = await handle.stat();
	if (after.size !== before.size || after.modified !== before.modified || after.changed !== before.changed) throw new CodedError(ErrorCodes.FS_FILE_CHANGED);
	return after;
}

async function checkCopySources(source: SafeDataset, contents: ILISH, identities: ReadonlyMap<string, string>): Promise<void> {
	for (const file of contents.files ?? []) {
		const identity = identities.get(file.path);
		if (identity) await source.checkFileForCopyMove(file.path, identity);
	}
}

/** New files are created exclusively, including inside an explicitly selected empty destination. */
export async function moveDatasetData(manifest: ILISH, sourceRoot: DatasetRoot, targetRoot: DatasetRoot, commit: () => void, progress: (event: DatasetMoveProgress) => void, verification: 'manifest' | 'source' = 'manifest'): Promise<DatasetMoveResult> {
	validateLISHStructure(manifest, Number.MAX_SAFE_INTEGER);
	const files = manifest.files ?? [];
	const source = await openDataset(sourceRoot);
	let target: SafeDataset | undefined;
	let targetCreated = false;
	let commitStarted = false;
	let linkedMove = false;
	const linkedPaths = new Set<string>();
	let committed = false;
	let failure: unknown;
	let failed = false;
	const result: DatasetMoveResult = { cleanupWarnings: [] };
	let targetIdentities = new Map<string, string>();
	try {
		await source.prepare(manifest, { reserve: false, writable: false });
		const sourceIdentities = await snapshot(source, manifest);
		const sizes = new Map<string, number>();
		const sourceGuards = new Map<string, DatasetContentGuard>();
		const sourceDevices = new Set<string>();
		let uniqueSources = true;
		const sourceInfos = new Map<string, DatasetEntryInfo>();
		for (const file of files) {
			const info = await source.statFile(file.path);
			if (!info) throw new CodedError(ErrorCodes.IO_NOT_FOUND, 'Source file is missing');
			sizes.set(file.path, info.size);
			if (info.device) sourceDevices.add(info.device);
			else uniqueSources = false;
			sourceInfos.set(file.path, info);
		}
		const ownedCounts = new Map<string, number>();
		for (const file of files) {
			const id = sourceIdentities.get(file.path);
			if (id) ownedCounts.set(id, (ownedCounts.get(id) ?? 0) + 1);
		}
		const directIDs = new Set<string>();
		for (const file of files) {
			const info = sourceInfos.get(file.path)!;
			if (directIDs.has(info.identity) || info.links !== ownedCounts.get(info.identity)) uniqueSources = false;
			directIDs.add(info.identity);
		}
		const destination = targetRoot.kind === 'derived' ? targetRoot : conservativeDatasetRoot(datasetRootPath(targetRoot));
		if (destination.kind !== 'derived') throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'Copy destination needs a parent directory');
		const base = await openDataset({ kind: 'explicit', path: destination.base }, true);
		await base.close();
		if (targetRoot.kind === 'explicit') {
			try {
				target = await openDataset(targetRoot);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
			if (target) {
				if ((await readdir(datasetRootPath(targetRoot))).length) throw Object.assign(new Error('Selected directory is not empty'), { code: 'EEXIST' });
				await target.assertPathBinding();
			}
		}
		if (!target) {
			target = await createDataset(destination);
			targetCreated = true;
		}
		const rootInfo = await target.statDirectory();
		if (rootInfo?.identity === sourceIdentities.get('')) throw Object.assign(new Error('Destination is the source directory'), { code: 'EEXIST' });
		if (rootInfo) targetIdentities.set('', rootInfo.identity);
		linkedMove = process.platform !== 'win32' && uniqueSources && rootInfo?.device !== undefined && sourceDevices.size === 1 && sourceDevices.has(rootInfo.device);
		if (!linkedMove && process.platform !== 'win32') await checkCopySources(source, manifest, sourceIdentities);
		// A move within one filesystem links the files instead of copying them, so it needs no space.
		const copyBytes = (): bigint => files.reduce((bytes, file) => bytes + BigInt(sizes.get(file.path)!), 0n);
		await checkDatasetCopySpace(datasetRootPath(destination), linkedMove ? 0n : copyBytes());
		if (linkedMove && verification === 'manifest') {
			for (const file of files) {
				const handle = await source.openFile(file.path, 'read');
				try {
					await verifyLinkedFile(handle, file, manifest, () => {});
				} finally {
					await handle.close();
				}
			}
		}
		const createTargetsIndividually = linkedMove;
		await target.prepare(manifest, { reserve: linkedMove ? 'directories' : true, writable: true, exclusive: true });
		targetIdentities = await snapshot(target, manifest);
		const totalFiles = files.length;
		const totalBytes = files.reduce((sum, file) => sum + sizes.get(file.path)!, 0);
		let completedFiles = 0;
		let completedBytes = 0;
		progress({ type: 'file-list', totalFiles, completedFiles, totalBytes, completedBytes, files: files.map(({ path }) => ({ path, size: sizes.get(path)! })) });
		let linkPhase = false;
		const linkedVersions = new Map<string, DatasetEntryInfo>();
		for (const file of files) {
			if (linkedMove) {
				if (!linkPhase) {
					await target.prepare(manifest, { reserve: false, writable: false });
					linkPhase = true;
				}
				try {
					await source.linkFileTo(file.path, target, sourceIdentities.get(file.path)!);
				} catch (error) {
					if (!(error instanceof CodedError) || error.code !== ErrorCodes.FS_MOVE_UNSUPPORTED || linkedPaths.size !== 0) throw error;
					await checkCopySources(source, manifest, sourceIdentities);
					await checkDatasetCopySpace(datasetRootPath(destination), copyBytes());
					await target.prepare(manifest, { reserve: false, writable: true });
					linkedMove = false;
				}
				if (linkedMove) {
					linkedPaths.add(file.path);
					targetIdentities.set(file.path, sourceIdentities.get(file.path)!);
					if (verification === 'manifest') {
						const fileHandle = await target.openFile(file.path, 'read');
						try {
							linkedVersions.set(file.path, await verifyLinkedFile(fileHandle, file, manifest, bytes => progress({ type: 'chunk', path: file.path, totalFiles, completedFiles, totalBytes, completedBytes: completedBytes + bytes, fileBytes: bytes, fileSize: sizes.get(file.path)! })));
						} catch (error) {
							if ((await target.statFile(file.path))?.identity !== sourceIdentities.get(file.path)) throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'Linked destination was replaced');
							throw error;
						} finally {
							await fileHandle.close();
						}
					}
					completedBytes += sizes.get(file.path)!;
					completedFiles++;
					progress({ type: 'file', path: file.path, totalFiles, completedFiles, totalBytes, completedBytes });
					continue;
				}
			}
			const input = await source.openFile(file.path, 'read');
			try {
				const output = await target.openFile(file.path, createTargetsIndividually ? 'create' : 'write');
				targetIdentities.set(file.path, (await output.stat()).identity);
				try {
					const guard = await copyFile(input, output, file, manifest, verification, fileBytes => progress({ type: 'chunk', path: file.path, totalFiles, completedFiles, totalBytes, completedBytes: completedBytes + fileBytes, fileBytes, fileSize: sizes.get(file.path)! }));
					sourceGuards.set(file.path, guard);
					completedBytes += guard.size;
				} finally {
					await output.close();
				}
			} finally {
				await input.close();
			}
			completedFiles++;
			progress({ type: 'file', path: file.path, totalFiles, completedFiles, totalBytes, completedBytes });
		}
		await target.prepare(manifest, { reserve: false, writable: !linkedMove });
		if (!linkedMove) {
			const guardsByIdentity = new Map<string, DatasetContentGuard>();
			for (const [path, guard] of sourceGuards) {
				const identity = sourceIdentities.get(path)!;
				const prior = guardsByIdentity.get(identity);
				if (prior && (prior.checksum !== guard.checksum || prior.modified !== guard.modified || prior.changed !== guard.changed)) throw new CodedError(ErrorCodes.FS_FILE_CHANGED);
				guardsByIdentity.set(identity, guard);
			}
			for (const file of files) {
				const identity = sourceIdentities.get(file.path);
				if (!identity) continue;
				const guard = guardsByIdentity.get(identity);
				if (!guard) throw new CodedError(ErrorCodes.FS_FILE_CHANGED);
				sourceGuards.set(file.path, guard);
			}
		}
		for (const [path, guard] of linkedMove ? [] : sourceGuards) {
			const info = await source.statFile(path);
			if (!info || info.size !== guard.size || info.modified !== guard.modified || info.changed !== guard.changed) throw new CodedError(ErrorCodes.FS_FILE_CHANGED);
		}
		for (const [path, version] of linkedVersions) {
			const current = await target.statFile(path);
			if (!current || current.size !== version.size || current.modified !== version.modified || current.changed !== version.changed) throw new CodedError(ErrorCodes.FS_FILE_CHANGED);
		}
		await target.assertPathBinding();
		commitStarted = true;
		commit();
		committed = true;
		try {
			await source.assertPathBinding();
			if (linkedMove) {
				for (const path of linkedPaths) if ((await target.statFile(path))?.identity !== sourceIdentities.get(path)) throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'Linked destination was replaced');
			}
			if (await removeContents(source, manifest, sourceIdentities, sourceRoot.kind === 'derived', linkedMove ? undefined : sourceGuards)) result.cleanupWarnings.push({ stage: 'source-cleanup', code: 'ENOTEMPTY' });
		} catch (error) {
			result.cleanupWarnings.push(cleanupWarning('source-cleanup', error));
		}
	} catch (error) {
		if (target && !commitStarted) {
			try {
				const rollbackIdentities = new Map(targetIdentities);
				// Failed link moves retain both names rather than risk removing the last surviving one.
				for (const path of linkedPaths) rollbackIdentities.delete(path);
				await removeContents(target, manifest, rollbackIdentities, targetCreated);
			} catch (cleanupError) {
				console.warn('The incomplete copy could not be removed safely:', cleanupError);
			}
		}
		failure = error;
		failed = true;
	} finally {
		for (const [dataset, stage] of [
			[target, 'target-close'],
			[source, 'source-close'],
		] as const) {
			if (!dataset) continue;
			try {
				await dataset.close();
			} catch (error) {
				if (committed) result.cleanupWarnings.push(cleanupWarning(stage, error));
				else if (!failed) {
					failure = error;
					failed = true;
				}
			}
		}
	}
	if (failed) throw failure;
	return result;
}
