import { readFileSync, writeFileSync, existsSync } from 'fs';
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

	protected loadFile<U>(defaultValue: U): U {
		if (!existsSync(this.filePath)) {
			this.saveFile(defaultValue);
			return defaultValue;
		}
		try {
			return JSON.parse(readFileSync(this.filePath, 'utf-8'));
		} catch (error) {
			console.error(`[Storage] Error loading ${this.filePath}:`, error);
			return defaultValue;
		}
	}

	protected saveFile(data: T): void {
		try {
			writeFileSync(this.filePath, JSON.stringify(data, null, '\t'));
		} catch (error) {
			console.error(`[Storage] Error saving ${this.filePath}:`, error);
		}
	}
}

/**
 * JSON storage with path-based access (e.g., "ui.theme").
 */
export class JsonStorage<T extends Record<string, any>> extends BaseStorage<T> {
	private data: T;

	constructor(
		dataDir: string,
		fileName: string,
		private readonly defaults: T
	) {
		super(dataDir, fileName);
		const loaded = this.loadFile(structuredClone(defaults));
		this.data = this.deepMerge(defaults, loaded);
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

	set(path: string, value: any): void {
		const keys = path.split('.');
		let obj: any = this.data;
		for (let i = 0; i < keys.length - 1; i++) {
			const key = keys[i];
			if (obj[key] === undefined) obj[key] = {};
			obj = obj[key];
		}
		obj[keys[keys.length - 1]] = value;
		this.saveFile(this.data);
	}

	getAll(): T {
		return this.data;
	}

	reset(): T {
		this.data = structuredClone(this.defaults);
		this.saveFile(this.data);
		return this.data;
	}
}

/**
 * Array storage with key-based CRUD operations.
 */
export class ArrayStorage<T extends Record<string, any>> extends BaseStorage<T[]> {
	private items: T[];

	constructor(
		dataDir: string,
		fileName: string,
		private readonly keyField: keyof T
	) {
		super(dataDir, fileName);
		const loaded = this.loadFile<T[]>([]);
		this.items = Array.isArray(loaded) ? loaded : [];
	}

	getAll(): T[] {
		return this.items;
	}

	get(key: string): T | undefined {
		return this.items.find(item => item[this.keyField] === key);
	}

	exists(key: string): boolean {
		return this.items.some(item => item[this.keyField] === key);
	}

	add(item: T): boolean {
		if (this.exists(item[this.keyField] as string)) return false;
		this.items.push(item);
		this.saveFile(this.items);
		return true;
	}

	update(item: T): boolean {
		const index = this.items.findIndex(i => i[this.keyField] === item[this.keyField]);
		if (index === -1) return false;
		this.items[index] = item;
		this.saveFile(this.items);
		return true;
	}

	upsert(item: T): void {
		const index = this.items.findIndex(i => i[this.keyField] === item[this.keyField]);
		if (index === -1) this.items.push(item);
		else this.items[index] = item;
		this.saveFile(this.items);
	}

	delete(key: string): boolean {
		const len = this.items.length;
		this.items = this.items.filter(item => item[this.keyField] !== key);
		if (this.items.length !== len) {
			this.saveFile(this.items);
			return true;
		}
		return false;
	}

	setAll(items: T[]): void {
		this.items = items;
		this.saveFile(this.items);
	}

	clear(): void {
		this.items = [];
		this.saveFile(this.items);
	}
}
