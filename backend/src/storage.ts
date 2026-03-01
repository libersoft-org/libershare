import { join } from 'path';

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

	protected async saveFile(data: T): Promise<void> {
		try {
			await Bun.write(this.filePath, JSON.stringify(data, null, '\t'));
		} catch (error) {
			console.error(`[Storage] Error saving ${this.filePath}:`, error);
		}
	}
}

/**
 * JSON storage with path-based access (e.g., "ui.theme").
 */
export class JsonStorage<T extends Record<string, any>> extends BaseStorage<T> {
	private data!: T;
	private readonly defaults: T;

	private constructor(dataDir: string, fileName: string, defaults: T) {
		super(dataDir, fileName);
		this.defaults = defaults;
	}

	static async create<T extends Record<string, any>>(dataDir: string, fileName: string, defaults: T): Promise<JsonStorage<T>> {
		const storage = new JsonStorage(dataDir, fileName, defaults);
		const loaded = await storage.loadFile(structuredClone(defaults));
		storage.data = storage.deepMerge(defaults, loaded);
		return storage;
	}

	private deepMerge<U extends Record<string, any>>(defaults: U, override: Partial<U>): U {
		const result = { ...defaults };
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

	async set(path: string, value: any): Promise<void> {
		const keys = path.split('.');
		let obj: any = this.data;
		for (let i = 0; i < keys.length - 1; i++) {
			const key = keys[i]!;
			if (obj[key] === undefined) obj[key] = {};
			obj = obj[key];
		}
		obj[keys[keys.length - 1]!] = value;
		await this.saveFile(this.data);
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
