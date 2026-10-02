import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CodedError, ErrorCodes } from '@shared';
import type { DatasetDirectoryHandle, DatasetEntryInfo, DatasetFileHandle } from './safe-dataset-types.ts';

export type DatasetRoot = { kind: 'explicit'; path: string } | { kind: 'derived'; base: string; component: string };
export interface DatasetNamespace {
	files?: readonly { path: string }[];
	directories?: readonly { path: string }[];
}
export interface DatasetPreparation {
	writable?: boolean;
	reserve?: boolean;
	signal?: AbortSignal;
}

function unsafe(detail: string): never {
	throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, detail);
}
function normalized(error: unknown): unknown {
	if (code(error) !== ErrorCodes.LISH_UNSAFE_PATH || error instanceof CodedError) return error;
	const retained = (error as { retainedDirectory?: unknown }).retainedDirectory;
	const detail = typeof retained === 'string' && /^\.lish-remove-[a-f0-9-]{36}$/u.test(retained) ? `Removal stopped; data preserved in ${retained}/entry` : 'Unsafe dataset filesystem object';
	return new CodedError(ErrorCodes.LISH_UNSAFE_PATH, detail);
}
function code(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}
function components(path: string): string[] {
	if (/^[a-z]:/iu.test(path)) unsafe('Unsafe dataset-relative path');
	const parts = path.split('/');
	if (parts.some(part => !part || part === '.' || part === '..' || /[\\\0]/u.test(part))) unsafe('Unsafe dataset-relative path');
	return parts;
}
function abort(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}
function writable(info: DatasetEntryInfo): void {
	if (info.kind !== 'file' || info.links !== 1) unsafe('The target must be a regular file with one link');
}

function namespace(manifest: DatasetNamespace): { files: Set<string>; sortedDirs: string[] } {
	const files = new Set<string>();
	const dirs = new Set<string>();
	const explicitDirs = new Set<string>();
	const addParents = (path: string): void => {
		const parts = components(path);
		for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
	};
	for (const entry of manifest.files ?? []) {
		addParents(entry.path);
		if (files.has(entry.path)) unsafe('Duplicate dataset file path');
		files.add(entry.path);
	}
	for (const entry of manifest.directories ?? []) {
		addParents(entry.path);
		if (explicitDirs.has(entry.path)) unsafe('Duplicate dataset directory path');
		explicitDirs.add(entry.path);
		dirs.add(entry.path);
	}
	for (const path of dirs) if (files.has(path)) unsafe('A dataset path is both a file and directory');
	const sortedDirs = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length);
	return { files, sortedDirs };
}

export function validateDatasetNamespace(manifest: DatasetNamespace): void {
	namespace(manifest);
}

export function datasetPath(root: DatasetRoot | string): string {
	if (typeof root === 'string') return root;
	return root.kind === 'explicit' ? root.path : join(root.base, root.component);
}

async function nativeRoot(path: string): Promise<DatasetDirectoryHandle> {
	return process.platform === 'win32' ? (await import('./safe-dataset-files-windows.ts')).openWindowsDatasetDirectory(path) : (await import('./safe-dataset-files-posix.ts')).openPosixDatasetDirectory(path);
}

/** Each traversal is relative to held handles; recorded identities must still match on reopening. */
export class SafeDataset {
	private readonly root: DatasetDirectoryHandle;
	private readonly owner: { handle: DatasetDirectoryHandle; name: string } | undefined;
	private readonly selection: DatasetRoot | undefined;
	private readonly entries = new Map<string, DatasetEntryInfo>();
	private readonly identities = new Map<string, string>();
	private preparedFiles: Set<string> | undefined;
	private writePrepared = false;
	private reserving = false;
	private closed = false;
	private readonly created: { path: string; info: DatasetEntryInfo }[] = [];

	constructor(root: DatasetDirectoryHandle, owner?: { handle: DatasetDirectoryHandle; name: string }, selection?: DatasetRoot) {
		this.root = root;
		this.owner = owner;
		this.selection = selection ? { ...selection } : undefined;
	}

	/** Check the original complete choice again; an open parent alone cannot detect a renamed ancestor. */
	async assertPathBinding(): Promise<void> {
		this.active();
		if (!this.selection) unsafe('The dataset has no recorded root choice');
		let reopened: SafeDataset;
		try {
			reopened = await openDataset(this.selection);
		} catch (error) {
			if (code(error) === 'ENOENT') unsafe('Dataset root no longer exists at the chosen path');
			throw normalized(error);
		}
		try {
			if ((await this.root.stat()).identity !== (await reopened.root.stat()).identity) unsafe('Dataset root was replaced at the chosen path');
		} finally {
			await reopened.close();
		}
	}

	private active(): void {
		if (this.closed) throw Object.assign(new Error('Dataset is closed'), { code: 'EBADF' });
	}

	private remember(path: string, info: DatasetEntryInfo, allowFileAliases = false): void {
		const prior = this.entries.get(path);
		if (prior && prior.identity !== info.identity) unsafe('Dataset entry was replaced');
		const alias = this.identities.get(info.identity);
		if (alias !== undefined && alias !== path && !(allowFileAliases && info.kind === 'file')) unsafe('Dataset paths refer to the same filesystem object');
		this.entries.set(path, info);
		this.identities.set(info.identity, path);
	}

	private async directory(parts: readonly string[], create: boolean): Promise<{ handle: DatasetDirectoryHandle; owned: boolean }> {
		this.active();
		let current = this.root;
		let owned = false;
		let path = '';
		try {
			this.remember('', await this.root.stat());
			for (const part of parts) {
				path = path ? `${path}/${part}` : part;
				let child: DatasetDirectoryHandle;
				let made = false;
				try {
					child = await current.openDirectory(part);
				} catch (error) {
					if (!create || code(error) !== 'ENOENT') throw error;
					try {
						child = await current.createDirectory(part);
						made = true;
					} catch (creation) {
						if (code(creation) !== 'EEXIST') throw creation;
						child = await current.openDirectory(part);
					}
				}
				try {
					const info = await child.stat();
					this.remember(path, info);
					if (made && this.reserving) this.created.push({ path, info });
				} catch (error) {
					await child.close();
					throw error;
				}
				if (owned) await current.close();
				current = child;
				owned = true;
			}
			return { handle: current, owned };
		} catch (error) {
			if (owned) await current.close();
			throw normalized(error);
		}
	}

	async ensureDirectory(path: string): Promise<void> {
		const directory = await this.directory(components(path), true);
		if (directory.owned) await directory.handle.close();
	}

	async statDirectory(path = ''): Promise<DatasetEntryInfo | null> {
		let directory;
		try {
			directory = await this.directory(path ? components(path) : [], false);
		} catch (error) {
			if (code(error) === 'ENOENT') return null;
			throw error;
		}
		try {
			return await directory.handle.stat();
		} finally {
			if (directory.owned) await directory.handle.close();
		}
	}

	private async file(path: string, mode: 'read' | 'write' | 'create', allowAliases: boolean): Promise<DatasetFileHandle> {
		const parts = components(path);
		const name = parts.pop()!;
		const parent = await this.directory(parts, false);
		try {
			const file = await parent.handle.openFile(name, mode);
			try {
				const info = await file.stat();
				if (mode !== 'read') writable(info);
				this.remember(path, info, allowAliases);
				if (mode === 'create' && this.reserving) this.created.push({ path, info });
				return file;
			} catch (error) {
				await file.close();
				throw normalized(error);
			}
		} catch (error) {
			throw normalized(error);
		} finally {
			if (parent.owned) await parent.handle.close();
		}
	}

	async openFile(path: string, mode: 'read' | 'write' | 'create'): Promise<DatasetFileHandle> {
		if (mode !== 'read' && (!this.writePrepared || !this.preparedFiles?.has(path))) unsafe('Prepare the complete dataset before writing');
		return this.file(path, mode, mode === 'read' && !this.writePrepared);
	}

	async statFile(path: string): Promise<DatasetEntryInfo | null> {
		let file: DatasetFileHandle;
		try {
			file = await this.file(path, 'read', !this.writePrepared);
		} catch (error) {
			if (code(error) === 'ENOENT') return null;
			throw error;
		}
		try {
			const info = await file.stat();
			if (this.writePrepared) writable(info);
			return info;
		} finally {
			await file.close();
		}
	}

	/** Validate every path and existing object before reserving any missing targets. No contents are changed. */
	async prepare(manifest: DatasetNamespace, options: DatasetPreparation = {}): Promise<void> {
		this.active();
		this.writePrepared = false;
		const forWrite = options.writable ?? true;
		if (options.reserve && !forWrite) unsafe('Read-only preparation cannot reserve files');
		const { files, sortedDirs } = namespace(manifest);
		try {
			for (const path of sortedDirs) {
				abort(options.signal);
				await this.statDirectory(path);
			}
			for (const path of files) {
				abort(options.signal);
				let file: DatasetFileHandle;
				try {
					file = await this.file(path, 'read', !forWrite);
				} catch (error) {
					if (code(error) === 'ENOENT') continue;
					throw error;
				}
				try {
					if (forWrite) writable(await file.stat());
				} finally {
					await file.close();
				}
			}
			if (options.reserve) {
				this.reserving = true;
				for (const path of sortedDirs) {
					abort(options.signal);
					await this.ensureDirectory(path);
				}
				for (const path of files) {
					abort(options.signal);
					let file: DatasetFileHandle;
					try {
						file = await this.file(path, 'write', false);
					} catch (error) {
						if (code(error) !== 'ENOENT') throw error;
						try {
							file = await this.file(path, 'create', false);
						} catch (creation) {
							if (code(creation) !== 'EEXIST') throw creation;
							file = await this.file(path, 'write', false);
						}
					}
					await file.close();
				}
			}
			abort(options.signal);
			this.preparedFiles = files;
			this.writePrepared = forWrite;
			this.created.length = 0;
		} catch (error) {
			await this.rollbackReservations();
			throw normalized(error);
		} finally {
			this.reserving = false;
		}
	}

	private async rollbackReservations(): Promise<void> {
		for (const entry of this.created.splice(0).reverse()) {
			try {
				if (entry.info.kind === 'directory') await this.removeDirectory(entry.path, entry.info.identity);
				else await this.removeFile(entry.path, entry.info.identity);
			} catch {
				/* A replaced or no longer empty object is not ours to remove. */
			}
		}
	}

	async removeFile(path: string, expectedIdentity: string): Promise<void> {
		const info = await this.statFile(path);
		if (!info) return;
		if (info.identity !== expectedIdentity) unsafe('Dataset file was replaced before removal');
		const parts = components(path);
		const name = parts.pop()!;
		const parent = await this.directory(parts, false);
		try {
			await parent.handle.removeFile(name, expectedIdentity);
			this.entries.delete(path);
			this.identities.delete(info.identity);
		} catch (error) {
			throw normalized(error);
		} finally {
			if (parent.owned) await parent.handle.close();
		}
	}

	async removeDirectory(path: string, expectedIdentity: string): Promise<void> {
		const info = await this.statDirectory(path);
		if (!info) return;
		if (info.identity !== expectedIdentity) unsafe('Dataset directory was replaced before removal');
		if (!path) {
			if (!this.owner) unsafe('An explicit dataset root cannot be removed');
			await this.root.close();
			this.closed = true;
			try {
				await this.owner.handle.removeDirectory(this.owner.name, expectedIdentity);
			} catch (error) {
				throw normalized(error);
			}
			return;
		}
		const parts = components(path);
		const name = parts.pop()!;
		const parent = await this.directory(parts, false);
		try {
			await parent.handle.removeDirectory(name, expectedIdentity);
			this.entries.delete(path);
			this.identities.delete(info.identity);
		} catch (error) {
			throw normalized(error);
		} finally {
			if (parent.owned) await parent.handle.close();
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		try {
			await this.root.close();
		} finally {
			await this.owner?.handle.close();
		}
	}
}

async function open(root: DatasetRoot | string, create: boolean, exclusive: boolean): Promise<SafeDataset> {
	const chosen: DatasetRoot = typeof root === 'string' ? { kind: 'explicit', path: resolve(root) } : root.kind === 'explicit' ? { kind: 'explicit', path: resolve(root.path) } : { kind: 'derived', base: resolve(root.base), component: root.component };
	if (chosen.kind === 'explicit') {
		if (exclusive) {
			await mkdir(dirname(chosen.path), { recursive: true });
			await mkdir(chosen.path);
		} else if (create) await mkdir(chosen.path, { recursive: true });
		return new SafeDataset(await nativeRoot(chosen.path), undefined, chosen);
	}
	const parts = components(chosen.component);
	if (parts.length !== 1) unsafe('Derived dataset root must be one path component');
	const base = await nativeRoot(chosen.base);
	try {
		let child: DatasetDirectoryHandle;
		if (exclusive) child = await base.createDirectory(chosen.component);
		else {
			try {
				child = await base.openDirectory(chosen.component);
			} catch (error) {
				if (!create || code(error) !== 'ENOENT') throw error;
				try {
					child = await base.createDirectory(chosen.component);
				} catch (creation) {
					if (code(creation) !== 'EEXIST') throw creation;
					child = await base.openDirectory(chosen.component);
				}
			}
		}
		return new SafeDataset(child, { handle: base, name: chosen.component }, chosen);
	} catch (error) {
		await base.close();
		throw error;
	}
}

export async function openDataset(root: DatasetRoot | string, create = false): Promise<SafeDataset> {
	try {
		return await open(root, create, false);
	} catch (error) {
		throw normalized(error);
	}
}
export async function createDataset(root: DatasetRoot | string): Promise<SafeDataset> {
	try {
		return await open(root, true, true);
	} catch (error) {
		throw normalized(error);
	}
}
