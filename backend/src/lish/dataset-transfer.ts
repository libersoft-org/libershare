import { CodedError, ErrorCodes, validateLISHStructure, type ILISH } from '@shared';
import { createDataset, openDataset, type DatasetRoot, type SafeDataset } from './safe-dataset-files.ts';
import { resolve, relative, isAbsolute } from 'node:path';
import { datasetRootPath, conservativeDatasetRoot } from './dataset-root.ts';
import type { DatasetFileHandle } from './safe-dataset-types.ts';
import type { DatasetLinkBinding } from '../db/lishs-link-bindings.ts';
import { checkDatasetCopySpace } from './dataset-space.ts';

export interface DatasetMoveResult {
	cleanupWarnings: { stage: 'source-cleanup' | 'target-close' | 'source-close'; code: string; retainedDirectory?: string }[];
}

function cleanupCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'IO_ERROR';
}

function cleanupWarning(stage: DatasetMoveResult['cleanupWarnings'][number]['stage'], error: unknown): DatasetMoveResult['cleanupWarnings'][number] {
	const detail = error instanceof CodedError ? error.detail : undefined;
	const retainedDirectory = detail?.match(/^Removal stopped; data preserved in (\.lish-remove-[a-f0-9-]{36})\/entry$/u)?.[1];
	return { stage, code: cleanupCode(error), ...(retainedDirectory ? { retainedDirectory } : {}) };
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
	for (const entry of [...(manifest.files ?? []), ...(manifest.links ?? []), ...(manifest.directories ?? [])]) {
		const parts = entry.path.split('/');
		for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join('/'));
	}
	return [...paths].sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a));
}

function materializedFiles(manifest: ILISH, root: DatasetRoot, bindings: readonly DatasetLinkBinding[]): { source: string; declaredSource: string; file: NonNullable<ILISH['files']>[number] }[] {
	const files = manifest.files ?? [];
	const filesByPath = new Map(files.map(file => [file.path, file]));
	const bindingsByPath = new Map(bindings.map(binding => [binding.path, binding]));
	const rootPath = datasetRootPath(root);
	const entries = files.map(file => ({ source: file.path, declaredSource: file.path, file }));
	for (const link of manifest.links ?? []) {
		const binding = bindingsByPath.get(link.path);
		if (binding && (binding.target !== link.target || binding.hardlink !== (link.hardlink === true))) throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'The local link association no longer matches the manifest');
		const path =
			binding?.source ??
			relative(rootPath, resolve(rootPath, link.target))
				.split('\\')
				.join('/');
		const target = filesByPath.get(path);
		if (!target || isAbsolute(path) || path.startsWith('../')) throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'The link target is not a declared dataset file');
		// After materialization the local copy can be edited independently of its original target.
		entries.push({ source: binding?.materializedIdentity ? binding.path : target.path, declaredSource: target.path, file: { ...target, path: link.path } });
	}
	return entries;
}

export function datasetCopyBytes(manifest: ILISH, root: DatasetRoot, bindings: readonly DatasetLinkBinding[] = []): bigint {
	return materializedFiles(manifest, root, bindings).reduce((bytes, entry) => bytes + BigInt(entry.file.size), 0n);
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

function cleanupManifest(manifest: ILISH, bindings: readonly DatasetLinkBinding[]): ILISH {
	const files = [...(manifest.files ?? [])];
	const filesByPath = new Map(files.map(file => [file.path, file]));
	const linksByPath = new Map((manifest.links ?? []).map(link => [link.path, link]));
	for (const binding of bindings) {
		const link = linksByPath.get(binding.path);
		const source = filesByPath.get(binding.source);
		if (!link || !source || link.target !== binding.target || (link.hardlink === true) !== binding.hardlink) throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'The materialized file no longer matches the manifest');
		files.push({ ...source, path: binding.path });
	}
	return { ...manifest, files };
}

function checkMaterializedIdentities(identities: ReadonlyMap<string, string>, bindings: readonly DatasetLinkBinding[]): void {
	for (const binding of bindings) {
		const actual = identities.get(binding.path);
		if (actual && actual !== binding.materializedIdentity) throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'The materialized file was replaced or its identity is unknown');
	}
}

async function removeContents(dataset: SafeDataset, manifest: ILISH, identities: Map<string, string>, removeRoot: boolean): Promise<boolean> {
	let retained = false;
	for (const file of manifest.files ?? []) {
		const identity = identities.get(file.path);
		if (identity) await dataset.removeFile(file.path, identity);
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

export async function deleteDatasetData(manifest: ILISH, root: DatasetRoot, bindings: readonly DatasetLinkBinding[] = []): Promise<void> {
	const contents = cleanupManifest(manifest, bindings);
	let dataset: SafeDataset;
	try {
		dataset = await openDataset(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw error;
	}
	try {
		await dataset.prepare(contents, { reserve: false, writable: false });
		const identities = await snapshot(dataset, contents);
		checkMaterializedIdentities(identities, bindings);
		await dataset.assertPathBinding();
		await removeContents(dataset, contents, identities, root.kind === 'derived');
	} finally {
		await dataset.close();
	}
}

async function copyFile(source: DatasetFileHandle, target: DatasetFileHandle, file: NonNullable<ILISH['files']>[number], manifest: ILISH, verification: 'manifest' | 'source', progress: (bytes: number) => void): Promise<number> {
	const info = await source.stat();
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
	return info.size;
}

/** The destination is exclusively created; the original survives any failure before commit. */
export async function moveDatasetData(manifest: ILISH, sourceRoot: DatasetRoot, targetRoot: DatasetRoot, commit: (bindings: DatasetLinkBinding[]) => void, progress: (event: DatasetMoveProgress) => void, verification: 'manifest' | 'source' = 'manifest', bindings: readonly DatasetLinkBinding[] = []): Promise<DatasetMoveResult> {
	validateLISHStructure(manifest, Number.MAX_SAFE_INTEGER);
	const copies = materializedFiles(manifest, sourceRoot, bindings);
	const sourceContents = cleanupManifest(manifest, bindings);
	const copiedManifest = { ...manifest, files: copies.map(entry => entry.file), links: [] };
	const source = await openDataset(sourceRoot);
	let target: SafeDataset | undefined;
	let commitStarted = false;
	let committed = false;
	let failure: unknown;
	let failed = false;
	const result: DatasetMoveResult = { cleanupWarnings: [] };
	let targetIdentities = new Map<string, string>();
	try {
		await source.prepare(sourceContents, { reserve: false, writable: false });
		const sourceIdentities = await snapshot(source, sourceContents);
		checkMaterializedIdentities(sourceIdentities, bindings);
		const sizes = new Map<string, number>();
		for (const { file, source: path } of copies) {
			const info = await source.statFile(path);
			if (!info) throw new CodedError(ErrorCodes.IO_NOT_FOUND, 'Source file is missing');
			sizes.set(file.path, info.size);
		}
		const destination = targetRoot.kind === 'derived' ? targetRoot : conservativeDatasetRoot(datasetRootPath(targetRoot));
		await checkDatasetCopySpace(
			datasetRootPath(destination),
			[...sizes.values()].reduce((total, size) => total + BigInt(size), 0n)
		);
		if (destination.kind !== 'derived') throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'Copy destination needs a parent directory');
		const base = await openDataset({ kind: 'explicit', path: destination.base }, true);
		await base.close();
		target = await createDataset(destination);
		const rootInfo = await target.statDirectory();
		if (rootInfo) targetIdentities.set('', rootInfo.identity);
		await target.prepare(copiedManifest, { reserve: true, writable: true });
		targetIdentities = await snapshot(target, copiedManifest);
		const files = copiedManifest.files;
		const totalFiles = files.length;
		const totalBytes = files.reduce((sum, file) => sum + sizes.get(file.path)!, 0);
		let completedFiles = 0;
		let completedBytes = 0;
		progress({ type: 'file-list', totalFiles, completedFiles, totalBytes, completedBytes, files: files.map(({ path }) => ({ path, size: sizes.get(path)! })) });
		for (const { file, source: sourcePath } of copies) {
			const input = await source.openFile(sourcePath, 'read');
			try {
				const output = await target.openFile(file.path, 'write');
				try {
					const copiedBytes = await copyFile(input, output, file, manifest, verification, fileBytes => progress({ type: 'chunk', path: file.path, totalFiles, completedFiles, totalBytes, completedBytes: completedBytes + fileBytes, fileBytes, fileSize: sizes.get(file.path)! }));
					completedBytes += copiedBytes;
				} finally {
					await output.close();
				}
			} finally {
				await input.close();
			}
			completedFiles++;
			progress({ type: 'file', path: file.path, totalFiles, completedFiles, totalBytes, completedBytes });
		}
		await target.prepare(copiedManifest, { reserve: false, writable: true });
		const copiesByPath = new Map(copies.map(copy => [copy.file.path, copy]));
		const nextBindings = (manifest.links ?? []).map(link => {
			const materializedIdentity = targetIdentities.get(link.path);
			if (!materializedIdentity) throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'Missing materialized file identity');
			return { path: link.path, target: link.target, hardlink: link.hardlink === true, source: copiesByPath.get(link.path)!.declaredSource, materializedIdentity };
		});
		await target.assertPathBinding();
		commitStarted = true;
		commit(nextBindings);
		committed = true;
		try {
			await source.assertPathBinding();
			if (await removeContents(source, sourceContents, sourceIdentities, sourceRoot.kind === 'derived')) result.cleanupWarnings.push({ stage: 'source-cleanup', code: 'ENOTEMPTY' });
		} catch (error) {
			result.cleanupWarnings.push(cleanupWarning('source-cleanup', error));
		}
	} catch (error) {
		if (target && !commitStarted) {
			try {
				await removeContents(target, copiedManifest, targetIdentities, true);
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
