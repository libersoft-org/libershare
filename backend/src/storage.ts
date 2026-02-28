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

	private constructor(
		dataDir: string,
		fileName: string,
		private readonly defaults: T
	) {
		super(dataDir, fileName);
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
			const key = keys[i];
			if (obj[key] === undefined) obj[key] = {};
			obj = obj[key];
		}
		obj[keys[keys.length - 1]] = value;
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

/**
 * Array storage with key-based CRUD operations.
 */
export class ArrayStorage<T extends Record<string, any>> extends BaseStorage<T[]> {
	private items!: T[];

	private constructor(
		dataDir: string,
		fileName: string,
		private readonly keyField: keyof T
	) {
		super(dataDir, fileName);
	}

	static async create<T extends Record<string, any>>(dataDir: string, fileName: string, keyField: keyof T): Promise<ArrayStorage<T>> {
		const storage = new ArrayStorage<T>(dataDir, fileName, keyField);
		const loaded = await storage.loadFile([]);
		storage.items = Array.isArray(loaded) ? loaded : [];
		return storage;
	}

	list(): T[] {
		return this.items;
	}

	get(key: string): T | undefined {
		return this.items.find(item => item[this.keyField] === key);
	}

	exists(key: string): boolean {
		return this.items.some(item => item[this.keyField] === key);
	}

	async add(item: T): Promise<boolean> {
		if (this.exists(item[this.keyField] as string)) return false;
		this.items.push(item);
		await this.saveFile(this.items);
		return true;
	}

	async update(item: T): Promise<boolean> {
		const index = this.items.findIndex(i => i[this.keyField] === item[this.keyField]);
		if (index === -1) return false;
		this.items[index] = item;
		await this.saveFile(this.items);
		return true;
	}

	async upsert(item: T): Promise<void> {
		const index = this.items.findIndex(i => i[this.keyField] === item[this.keyField]);
		if (index === -1) this.items.push(item);
		else this.items[index] = item;
		await this.saveFile(this.items);
	}

	async delete(key: string): Promise<boolean> {
		const len = this.items.length;
		this.items = this.items.filter(item => item[this.keyField] !== key);
		if (this.items.length !== len) {
			await this.saveFile(this.items);
			return true;
		}
		return false;
	}

	async replace(items: T[]): Promise<void> {
		this.items = items;
		await this.saveFile(this.items);
	}

	async clear(): Promise<void> {
		this.items = [];
		await this.saveFile(this.items);
	}
}
