import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { syncDirectory } from './file-durability.ts';
import { CodedError, ErrorCodes } from '@shared';

/**
 * Filesystem error codes that signal the data directory cannot be written —
 * persisting state would silently disappear, so the caller fails fast instead
 * of limping along with non-persistent in-memory state. Exported so unit tests
 * can drive the same set the production code uses.
 */
export const FATAL_STORAGE_CODES = ['EACCES', 'EROFS', 'EPERM', 'ENOSPC', 'EISDIR'] as const;
export type FatalStorageCode = (typeof FATAL_STORAGE_CODES)[number];

export function isFatalStorageError(error: unknown): error is NodeJS.ErrnoException & { code: FatalStorageCode } {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' && (FATAL_STORAGE_CODES as readonly string[]).includes(code);
}

/**
 * Build the operator-facing message for a fatal storage error. Pure function
 * so unit tests can assert the exact wording without spawning a real process.
 */
export function fatalStorageMessage(filePath: string, code: FatalStorageCode): string[] {
	const lines = [`[Storage] FATAL: cannot persist ${filePath} (${code}).`];
	if (code === 'ENOSPC') {
		lines.push(`[Storage] The filesystem hosting the data directory is full.`);
	} else if (code === 'EISDIR') {
		lines.push(`[Storage] A directory exists where a file is expected — remove it before restart.`);
	} else {
		lines.push(`[Storage] If running in Docker with cap_drop:ALL, the container loses CAP_DAC_OVERRIDE and`);
		lines.push(`[Storage] cannot write to a host bind-mount unless its owner matches the container UID.`);
		lines.push(`[Storage] Fix on the host: chown 0:0 <mounted-dir> && chmod 0700 <mounted-dir>, then restart.`);
	}
	return lines;
}

/**
 * A settings write that did not complete. `published` says whether the new file had already
 * been renamed into place: before it the old file is intact, after it the new content is on
 * disk but its durability was not confirmed. The message is the public contract — it reaches
 * API clients verbatim — so it names the outcome and never carries setting values.
 */
export class StorageWriteError extends Error {
	readonly code: string | undefined;
	readonly published: boolean;

	constructor(cause: unknown, published: boolean) {
		const code = (cause as NodeJS.ErrnoException | null)?.code;
		const suffix = code ? ` (${code})` : '';
		super(published ? `Settings file now contains the new settings, but durability could not be confirmed${suffix}.` : `Settings file was not replaced; in-memory settings may differ from disk${suffix}.`, { cause });
		this.name = 'StorageWriteError';
		this.code = code;
		this.published = published;
	}
}

/**
 * A settings file that exists but cannot be used. Carries the I/O code when there is one and
 * an operator-facing recovery hint; never the file content.
 */
export class StorageLoadError extends Error {
	readonly code: string | undefined;

	constructor(filePath: string, cause: unknown) {
		const code = (cause as NodeJS.ErrnoException | null)?.code;
		const kind = code ?? (cause instanceof SyntaxError ? 'invalid JSON' : 'invalid document');
		super(`Cannot load ${filePath} (${kind}). The file was left untouched: stop the node, restore a verified settings export to this path or fix the file, then start again.`, { cause });
		this.name = 'StorageLoadError';
		this.code = code;
	}
}

/**
 * Create `dir` (private mode) and flush the parent of every level that did not exist, so the
 * new entries survive a power loss together with the file written into them.
 */
async function ensureDirectory(dir: string): Promise<void> {
	const created = await mkdir(dir, { recursive: true, mode: 0o700 });
	if (created === undefined) return;
	for (let level = dir; ; level = dirname(level)) {
		await syncDirectory(dirname(level));
		if (level === created || dirname(level) === level) break;
	}
}

/** Refuse to replace anything but a regular file; a missing target is a first write. */
async function assertReplaceableTarget(path: string): Promise<void> {
	try {
		const info = await lstat(path);
		if (!info.isFile()) throw Object.assign(new Error(`${path} is not a regular file`), { code: info.isDirectory() ? 'EISDIR' : 'EINVAL' });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
}

/**
 * Base class for JSON file storage.
 */
abstract class BaseStorage<T> {
	protected readonly filePath: string;

	constructor(dataDir: string, fileName: string) {
		this.filePath = join(dataDir, fileName);
		console.log(`[Storage] ${this.filePath}`);
	}

	/**
	 * Read the stored document. Only a file that does not exist starts from the defaults;
	 * anything else — unreadable, a directory, truncated or invalid JSON — is thrown, because
	 * treating it as "no settings" would overwrite the user's file with defaults on the next
	 * save. The broken file is left in place for the operator to restore.
	 */
	protected async loadFile(defaultValue: T): Promise<T> {
		let text: string;
		try {
			text = await readFile(this.filePath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new StorageLoadError(this.filePath, error);
			await this.saveFile(defaultValue);
			return defaultValue;
		}
		try {
			return JSON.parse(text);
		} catch (error) {
			throw new StorageLoadError(this.filePath, error);
		}
	}

	private saveChain: Promise<void> = Promise.resolve();

	/**
	 * Persist `data` as the whole JSON file. Writes are chained per instance so
	 * concurrent `set()` calls can never interleave truncate+write on the same
	 * file or finish out of order (an older write landing last would leave stale
	 * values on disk). The snapshot is taken when the queued write runs, so
	 * bursts collapse to the latest in-memory state.
	 */
	protected saveFile(data: T): Promise<void> {
		const queued = this.saveChain.then(() => this.writeFile(data));
		this.saveChain = queued.catch(() => {});
		return queued;
	}

	/**
	 * Replace the file atomically: write a unique sibling, flush it, rename it over the target
	 * and flush the directory. A crash or a full disk mid-write therefore leaves either the old
	 * or the new document, never a truncated one that the next start would read as a fresh
	 * install. Never deletes the target first and never falls back to writing it in place.
	 */
	private async writeFile(data: T): Promise<void> {
		const text = JSON.stringify(data, null, '	');
		const dir = dirname(this.filePath);
		const staging = `${this.filePath}.${randomUUID()}.tmp`;
		let published = false;
		try {
			await ensureDirectory(dir);
			await assertReplaceableTarget(this.filePath);
			const handle = await open(staging, 'wx', 0o600);
			try {
				await handle.writeFile(text);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await assertReplaceableTarget(this.filePath);
			await rename(staging, this.filePath);
			published = true;
			await syncDirectory(dir);
		} catch (error) {
			if (!published) await unlink(staging).catch(() => {});
			const failure = new StorageWriteError(error, published);
			console.error(`[Storage] Error saving ${this.filePath}: ${failure.message}`);
			// Permission / read-only / full-disk errors mean every later write would disappear as
			// well, and the next restart would come back to stale state. That is worse than
			// crashing: fail fast with an operator-actionable hint. The most common trigger in
			// container deployments is `cap_drop: ALL` stripping CAP_DAC_OVERRIDE while the
			// bind-mount on the host is owned by a non-root user.
			if (isFatalStorageError(error)) {
				for (const line of fatalStorageMessage(this.filePath, error.code!)) console.error(line);
				process.exit(74); // sysexits.h EX_IOERR
			}
			throw failure;
		}
	}
}

/**
 * JSON storage with path-based access (e.g., "ui.theme").
 */
export class JSONStorage<T extends Record<string, any>> extends BaseStorage<T> {
	private data!: T;
	private readonly defaults: T;

	private constructor(dataDir: string, fileName: string, defaults: T) {
		super(dataDir, fileName);
		this.defaults = defaults;
	}

	static async create<T extends Record<string, any>>(dataDir: string, fileName: string, defaults: T): Promise<JSONStorage<T>> {
		const storage = new JSONStorage(dataDir, fileName, defaults);
		const loaded = await storage.loadFile(structuredClone(defaults));
		// A partial object from an older version is fine — the defaults fill it in. A root that
		// is not an object at all is not a settings document.
		if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) throw new StorageLoadError(storage.filePath, new Error('root is not an object'));
		storage.data = storage.deepMerge(defaults, loaded);
		return storage;
	}

	private deepMerge<U extends Record<string, any>>(defaults: U, override: Partial<U>): U {
		// Deep copy, not a spread: a group missing from the file would otherwise be the defaults'
		// own object, and the first set() into it would rewrite the value reset() restores.
		const result = structuredClone(defaults);
		for (const key in override) {
			if (override[key] !== undefined) {
				if (typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key])) result[key] = this.deepMerge(defaults[key], override[key] as any);
				else result[key] = override[key] as any;
			}
		}
		return result;
	}

	get(path?: string): any {
		if (!path) return this.data;
		const keys = path.split('.');
		let value: any = this.data;
		for (const key of keys) {
			if (value === undefined || value === null) return undefined;
			value = value[key];
		}
		return value;
	}

	/**
	 * Write one value into `target` at a dotted path.
	 *
	 * Rejects prototype-polluting keys at every depth. Without that, a path like
	 * "__proto__.polluted" or "constructor.prototype.polluted" would walk into
	 * Object.prototype and assign to it, affecting every object in the process.
	 */
	private static assign(target: Record<string, any>, path: string, value: any): void {
		const keys = path.split('.');
		for (const key of keys) {
			if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, `Illegal settings key: ${key}`);
		}
		let obj: any = target;
		for (let i = 0; i < keys.length - 1; i++) {
			const key = keys[i]!;
			if (obj[key] === undefined) obj[key] = {};
			obj = obj[key];
		}
		obj[keys[keys.length - 1]!] = value;
	}

	async set(path: string, value: any): Promise<void> {
		JSONStorage.assign(this.data, path, value);
		await this.saveFile(this.data);
	}

	/**
	 * Apply many writes to a COPY and publish it in one assignment.
	 *
	 * Readers do not take the caller's write lock — `Network.startLocked()` builds the node
	 * straight off {@link list} — so applying an import key by key to the live document let a
	 * restart read a half-applied one: the new port with the old discovery flag, a pair no
	 * import ever asked for. Staging the whole batch means a reader sees either the document
	 * as it was or the finished import, never a mixture.
	 *
	 * Not all-or-nothing about validity: a key the storage rejects is reported in `skipped`
	 * and the rest of the batch still lands — unless `onInvalid` is `'throw'`, which rejects
	 * the whole call before anything is published. `finalize` runs on the draft, so a
	 * correction derived from the batch is published together with it.
	 */
	async setMany(entries: ReadonlyArray<{ path: string; value: any }>, finalize?: (draft: T) => void, onInvalid: 'skip' | 'throw' = 'skip'): Promise<{ applied: number; skipped: string[] }> {
		const draft = structuredClone(this.data);
		const skipped: string[] = [];
		let applied = 0;
		for (const entry of entries) {
			try {
				JSONStorage.assign(draft, entry.path, entry.value);
				applied++;
			} catch (err) {
				if (onInvalid === 'throw') throw err;
				console.warn(`Skipped settings key '${entry.path}':`, (err as Error).message);
				skipped.push(entry.path);
			}
		}
		finalize?.(draft);
		this.data = draft;
		await this.saveFile(this.data);
		return { applied, skipped };
	}

	list(): T {
		return this.data;
	}

	async reset(): Promise<T> {
		this.data = structuredClone(this.defaults);
		await this.saveFile(this.data);
		return this.data;
	}
}
