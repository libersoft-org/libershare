import { FFIType as F, ptr, read, toArrayBuffer, type Pointer, type Library } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';

export const CORE_FOUNDATION = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation';
export type CFRef = bigint;
export type CFValue = null | string | number | bigint | boolean | Buffer | Date | CFValue[] | { [key: string]: CFValue };
const UTF8 = 0x08000100;
const MAX_BYTES = 64 * 1024 * 1024;

const symbols = {
	CFGetTypeID: { args: ['u64'], returns: 'u64' },
	CFRetain: { args: ['u64'], returns: 'u64' }, CFRelease: { args: ['u64'], returns: 'void' },
	CFEqual: { args: ['u64', 'u64'], returns: 'bool' },
	CFStringGetTypeID: { args: [], returns: 'u64' },
	CFStringCreateWithBytes: { args: ['u64', 'ptr', 'i64', 'u32', 'bool'], returns: 'u64' },
	CFStringCreateExternalRepresentation: { args: ['u64', 'u64', 'u32', 'u8'], returns: 'u64' },
	CFArrayGetTypeID: { args: [], returns: 'u64' }, CFArrayGetCount: { args: ['u64'], returns: 'i64' },
	CFArrayGetValueAtIndex: { args: ['u64', 'i64'], returns: 'u64' },
	CFArrayCreateMutable: { args: ['u64', 'i64', 'ptr'], returns: 'u64' },
	CFArrayAppendValue: { args: ['u64', 'u64'], returns: 'void' },
	CFDictionaryGetTypeID: { args: [], returns: 'u64' }, CFDictionaryGetCount: { args: ['u64'], returns: 'i64' },
	CFDictionaryGetKeysAndValues: { args: ['u64', 'ptr', 'ptr'], returns: 'void' },
	CFDictionaryGetValue: { args: ['u64', 'u64'], returns: 'u64' },
	CFDictionaryCreateMutable: { args: ['u64', 'i64', 'ptr', 'ptr'], returns: 'u64' },
	CFDictionarySetValue: { args: ['u64', 'u64', 'u64'], returns: 'void' },
	CFDictionaryRemoveValue: { args: ['u64', 'u64'], returns: 'void' },
	CFNumberGetTypeID: { args: [], returns: 'u64' }, CFNumberIsFloatType: { args: ['u64'], returns: 'bool' },
	CFNumberGetValue: { args: ['u64', 'i64', 'ptr'], returns: 'bool' },
	CFNumberCreate: { args: ['u64', 'i64', 'ptr'], returns: 'u64' },
	CFBooleanGetTypeID: { args: [], returns: 'u64' }, CFBooleanGetValue: { args: ['u64'], returns: 'bool' },
	CFDataGetTypeID: { args: [], returns: 'u64' }, CFDataGetLength: { args: ['u64'], returns: 'i64' },
	CFDataGetBytePtr: { args: ['u64'], returns: 'ptr' }, CFDataCreate: { args: ['u64', 'ptr', 'i64'], returns: 'u64' },
	CFDateGetTypeID: { args: [], returns: 'u64' }, CFDateGetAbsoluteTime: { args: ['u64'], returns: 'f64' }, CFDateCreate: { args: ['u64', 'f64'], returns: 'u64' },
	CFNullGetTypeID: { args: [], returns: 'u64' },
	CFPropertyListCreateDeepCopy: { args: ['u64', 'u64', 'u64'], returns: 'u64' },
	CFPropertyListCreateData: { args: ['u64', 'u64', 'i64', 'u64', 'ptr'], returns: 'u64' },
	CFPropertyListCreateWithData: { args: ['u64', 'u64', 'u64', 'ptr', 'ptr'], returns: 'u64' },
	CFURLCreateFromFileSystemRepresentation: { args: ['u64', 'ptr', 'i64', 'bool'], returns: 'u64' },
} as const;

function bounded(value: number | bigint, max = MAX_BYTES): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 0 || number > max) throw new Error('Invalid CoreFoundation value size');
	return number;
}

/** Create/Copy references belong to this scope; borrowed Get references never do. */
export class CoreFoundation {
	private readonly library = loadSystemLibrary(CORE_FOUNDATION, symbols);
	readonly symbols: Library<typeof symbols>['symbols'] = this.library.symbols;
	private readonly owned: CFRef[] = [];
	private readonly dataSymbols = new Map<string, Pointer>();
	private closed = false;
	private readonly types = {
		string: this.symbols.CFStringGetTypeID(), array: this.symbols.CFArrayGetTypeID(), dictionary: this.symbols.CFDictionaryGetTypeID(),
		number: this.symbols.CFNumberGetTypeID(), boolean: this.symbols.CFBooleanGetTypeID(), data: this.symbols.CFDataGetTypeID(), date: this.symbols.CFDateGetTypeID(), null: this.symbols.CFNullGetTypeID(),
	};

	own(ref: CFRef): CFRef { if (!ref) throw new Error('CoreFoundation returned a null reference'); this.owned.push(ref); return ref; }
	retain(ref: CFRef): CFRef { return this.own(this.symbols.CFRetain(ref)); }
	release(ref: CFRef): void {
		const index = this.owned.lastIndexOf(ref);
		if (index < 0) throw new Error('Cannot release a borrowed CoreFoundation reference');
		this.owned.splice(index, 1); this.symbols.CFRelease(ref);
	}

	/** RTLD_DEFAULT resolves constants from the already loaded, trusted framework. */
	symbolAddress(name: string): Pointer {
		const cached = this.dataSymbols.get(name);
		if (cached) return cached;
		if (!/^kCF[A-Za-z0-9]+$/.test(name)) throw new Error('Invalid CoreFoundation data symbol');
		const system = loadSystemLibrary('/usr/lib/libSystem.B.dylib', { dlsym: { args: [F.u64, F.ptr], returns: F.ptr } });
		try {
			const encoded = Buffer.from(`${name}\0`);
			const address = Number(system.symbols.dlsym(0xfffffffffffffffen, ptr(encoded))) as Pointer;
			if (!address) throw new Error(`CoreFoundation symbol ${name} is unavailable`);
			this.dataSymbols.set(name, address); return address;
		} finally { system.close(); }
	}

	createString(value: string): CFRef {
		const bytes = Buffer.from(value, 'utf8');
		return this.own(this.symbols.CFStringCreateWithBytes(0n, bytes.length ? ptr(bytes) : null, bytes.length, UTF8, false));
	}
	string(ref: CFRef): string {
		if (!ref || this.symbols.CFGetTypeID(ref) !== this.types.string) throw new Error('Expected CFString');
		const data = this.own(this.symbols.CFStringCreateExternalRepresentation(0n, ref, UTF8, 0));
		try { return this.data(data).toString('utf8'); } finally { this.release(data); }
	}
	array(ref: CFRef): CFRef[] {
		if (!ref || this.symbols.CFGetTypeID(ref) !== this.types.array) throw new Error('Expected CFArray');
		const count = bounded(this.symbols.CFArrayGetCount(ref), 1000000);
		return Array.from({ length: count }, (_, index) => this.symbols.CFArrayGetValueAtIndex(ref, index));
	}
	data(ref: CFRef): Buffer {
		if (!ref || this.symbols.CFGetTypeID(ref) !== this.types.data) throw new Error('Expected CFData');
		const length = bounded(this.symbols.CFDataGetLength(ref));
		if (!length) return Buffer.alloc(0);
		const bytes = this.symbols.CFDataGetBytePtr(ref);
		if (!bytes) throw new Error('CFData has no bytes');
		return Buffer.from(new Uint8Array(toArrayBuffer(bytes, 0, length)));
	}

	toJS(ref: CFRef, depth = 0): CFValue {
		if (!ref) return null;
		if (depth > 64) throw new Error('CoreFoundation collection nesting exceeds 64 levels');
		const type = this.symbols.CFGetTypeID(ref);
		if (type === this.types.string) return this.string(ref);
		if (type === this.types.boolean) return this.symbols.CFBooleanGetValue(ref);
		if (type === this.types.null) return null;
		if (type === this.types.data) return this.data(ref);
		if (type === this.types.date) return new Date((this.symbols.CFDateGetAbsoluteTime(ref) + 978307200) * 1000);
		if (type === this.types.number) {
			if (this.symbols.CFNumberIsFloatType(ref)) {
				const out = new Float64Array(1);
				if (!this.symbols.CFNumberGetValue(ref, 13, ptr(out))) throw new Error('CFNumber conversion failed');
				return out[0]!;
			}
			const out = new BigInt64Array(1);
			if (!this.symbols.CFNumberGetValue(ref, 4, ptr(out))) throw new Error('CFNumber integer conversion failed');
			return Number.isSafeInteger(Number(out[0])) ? Number(out[0]) : out[0]!;
		}
		if (type === this.types.array) return this.array(ref).map(item => this.toJS(item, depth + 1));
		if (type === this.types.dictionary) {
			const count = bounded(this.symbols.CFDictionaryGetCount(ref), 1000000);
			const keys = new BigUint64Array(count), values = new BigUint64Array(count);
			if (count) this.symbols.CFDictionaryGetKeysAndValues(ref, ptr(keys), ptr(values));
			return Object.fromEntries([...keys].map((key, index) => [this.string(key), this.toJS(values[index]!, depth + 1)]));
		}
		throw new Error(`Unsupported CoreFoundation type ${type}`);
	}

	fromJS(value: CFValue, depth = 0): CFRef {
		if (depth > 64) throw new Error('CoreFoundation collection nesting exceeds 64 levels');
		if (typeof value === 'string') return this.createString(value);
		if (value === null || typeof value === 'boolean') return this.retain(read.u64(this.symbolAddress(value === null ? 'kCFNull' : value ? 'kCFBooleanTrue' : 'kCFBooleanFalse')));
		if (typeof value === 'number' || typeof value === 'bigint') {
			if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid CFNumber');
			const integer = typeof value === 'bigint' || Number.isSafeInteger(value);
			if (integer && (BigInt(value) < -(1n << 63n) || BigInt(value) >= 1n << 63n)) throw new Error('CFNumber is outside signed 64-bit range');
			const bytes = integer ? new BigInt64Array([BigInt(value)]) : new Float64Array([Number(value)]);
			return this.own(this.symbols.CFNumberCreate(0n, integer ? 4 : 13, ptr(bytes)));
		}
		if (Buffer.isBuffer(value)) return this.own(this.symbols.CFDataCreate(0n, value.length ? ptr(value) : null, value.length));
		if (value instanceof Date) return this.own(this.symbols.CFDateCreate(0n, value.getTime() / 1000 - 978307200));
		if (Array.isArray(value)) {
			const array = this.own(this.symbols.CFArrayCreateMutable(0n, 0, this.symbolAddress('kCFTypeArrayCallBacks')));
			for (const item of value) { const ref = this.fromJS(item, depth + 1); this.symbols.CFArrayAppendValue(array, ref); this.release(ref); }
			return array;
		}
		const dictionary = this.own(this.symbols.CFDictionaryCreateMutable(0n, 0, this.symbolAddress('kCFTypeDictionaryKeyCallBacks'), this.symbolAddress('kCFTypeDictionaryValueCallBacks')));
		for (const [key, item] of Object.entries(value)) this.set(dictionary, key, item, depth + 1);
		return dictionary;
	}
	set(dictionary: CFRef, key: string, value: CFValue, depth = 0): void {
		const name = this.createString(key), ref = this.fromJS(value, depth);
		try { this.symbols.CFDictionarySetValue(dictionary, name, ref); }
		finally { this.release(ref); this.release(name); }
	}
	remove(dictionary: CFRef, key: string): void {
		const name = this.createString(key);
		try { this.symbols.CFDictionaryRemoveValue(dictionary, name); } finally { this.release(name); }
	}
	deepCopy(ref: CFRef, mutable = false): CFRef { return ref ? this.own(this.symbols.CFPropertyListCreateDeepCopy(0n, ref, mutable ? 1 : 0)) : 0n; }
	serialize(ref: CFRef): string | null {
		if (!ref) return null;
		const error = new BigUint64Array(1);
		const data = this.symbols.CFPropertyListCreateData(0n, ref, 200, 0n, ptr(error));
		if (error[0]) this.own(error[0]);
		if (!data) throw new Error('CoreFoundation property list serialization failed');
		this.own(data);
		try { return this.data(data).toString('base64'); } finally { this.release(data); }
	}
	deserialize(encoded: string | null, mutable = false): CFRef {
		if (encoded === null) return 0n;
		const bytes = Buffer.from(encoded, 'base64');
		if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== encoded) throw new Error('Invalid binary property list');
		const data = this.fromJS(bytes), error = new BigUint64Array(1);
		try {
			const ref = this.symbols.CFPropertyListCreateWithData(0n, data, mutable ? 1 : 0, null, ptr(error));
			if (error[0]) this.own(error[0]);
			return this.own(ref);
		} finally { this.release(data); }
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const ref of this.owned.reverse()) this.symbols.CFRelease(ref);
		this.owned.length = 0;
		this.library.close();
	}
}
