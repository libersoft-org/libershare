import { join } from 'path';
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
 * Base class for JSON file storage.
 */
abstract class BaseStorage<T> {
	protected readonly filePath: string;

	constructor(dataDir: string, fileName: string) {
		this.filePath = join(dataDir, fileName);
		console.log(`[Storage] ${this.filePath}`);
	}

	protected async loadFile(defaultValue: T): Promise<T> {
		const file = Bun.file(this.filePath);
		if (!(await file.exists())) {
			// Write default to disk
			await this.saveFile(defaultValue);
			return defaultValue;
		}
		try {
			return JSON.parse(await file.text());
		} catch (error) {
			console.error(`[Storage] Error loading ${this.filePath}:`, error);
			return defaultValue;
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

	private async writeFile(data: T): Promise<void> {
		try {
			await Bun.write(this.filePath, JSON.stringify(data, null, '\t'));
		} catch (error) {
			// Permission / read-only filesystem errors at this layer mean every
			// subsequent write to settings.json (peer identity, joined networks,
			// user preferences) would silently disappear and the next restart
			// would regenerate state from defaults. That is much worse than
			// crashing — fail fast with an operator-actionable hint instead of
			// limping along. The most common trigger in container deployments is
			// `cap_drop: ALL` stripping CAP_DAC_OVERRIDE while the bind-mount on
			// the host is owned by a non-root user.
			if (isFatalStorageError(error)) {
				for (const line of fatalStorageMessage(this.filePath, error.code!)) console.error(line);
				process.exit(74); // sysexits.h EX_IOERR
			}
			console.error(`[Storage] Error saving ${this.filePath}:`, error);
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
	 * and the rest of the batch still lands. `finalize` runs on the draft, so a correction
	 * derived from the batch is published together with it.
	 */
	async setMany(entries: ReadonlyArray<{ path: string; value: any }>, finalize?: (draft: T) => void): Promise<{ applied: number; skipped: string[] }> {
		const draft = structuredClone(this.data);
		const skipped: string[] = [];
		let applied = 0;
		for (const entry of entries) {
			try {
				JSONStorage.assign(draft, entry.path, entry.value);
				applied++;
			} catch (err) {
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
