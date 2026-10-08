import { CFunction, FFIType, ptr, read, toArrayBuffer, type Pointer } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';

/** Canonical GUID text to the 16-byte Windows memory layout. */
export function guidBytes(guid: string): Uint8Array {
	const hex = guid.replace(/-/g, '');
	const bytes = new Uint8Array(16);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, parseInt(hex.slice(0, 8), 16), true);
	view.setUint16(4, parseInt(hex.slice(8, 12), 16), true);
	view.setUint16(6, parseInt(hex.slice(12, 16), 16), true);
	for (let i = 0; i < 8; i++) bytes[8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
	return bytes;
}

type ComMethod = (...args: unknown[]) => number;
const methods = new Map<string, ComMethod>();

/** argTypes and values exclude the implicit COM this pointer. */
export function comCall(object: Pointer, slot: number, argTypes: readonly FFIType[], values: readonly unknown[]): number {
	const vtable = read.ptr(object, 0) as Pointer;
	const address = read.ptr(vtable, slot * 8) as Pointer;
	// Different interface methods can share machine code while using different signatures.
	const key = `${address}:${argTypes.join(',')}`;
	let method = methods.get(key);
	if (!method) {
		method = CFunction({ ptr: address, returns: FFIType.i32, args: [FFIType.ptr, ...argTypes] }) as unknown as ComMethod;
		methods.set(key, method);
	}
	return method(object, ...values);
}

export function releaseCom(object: Pointer): void {
	comCall(object, 2, [], []);
}

interface Automation {
	SysAllocStringLen: (value: Pointer, length: number) => Pointer | bigint | null;
	SysFreeString: (value: Pointer) => void;
	SysStringLen: (value: Pointer) => number;
	VariantClear: (value: Pointer) => number;
}

let automation: Automation | undefined;

function getAutomation(): Automation {
	if (!automation) {
		const library = loadSystemLibrary('oleaut32.dll', {
			SysAllocStringLen: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
			SysFreeString: { args: [FFIType.ptr], returns: FFIType.void },
			SysStringLen: { args: [FFIType.ptr], returns: FFIType.u32 },
			VariantClear: { args: [FFIType.ptr], returns: FFIType.i32 },
		} as const);
		automation = library.symbols;
	}
	return automation;
}

/** The caller owns the BSTR until SysFreeString or VariantClear releases it. */
export function allocBstr(value: string): Pointer {
	const wide = Buffer.from(`${value}\0`, 'utf16le');
	const result = getAutomation().SysAllocStringLen(ptr(wide), value.length);
	if (result === null) throw new Error('SysAllocStringLen failed');
	return Number(result) as Pointer;
}

export function freeBstr(value: Pointer): void {
	getAutomation().SysFreeString(value);
}

export function readBstr(value: Pointer | null): string | null {
	if (value === null) return null;
	const length = getAutomation().SysStringLen(value);
	return length === 0 ? '' : Buffer.from(toArrayBuffer(value, 0, length * 2)).toString('utf16le');
}

/** The callback is synchronous; its borrowed BSTR is freed before return. */
export function withBstr<T>(value: string, fn: (value: Pointer) => T): T {
	const bstr = allocBstr(value);
	try {
		return fn(bstr);
	} finally {
		freeBstr(bstr);
	}
}

/** Synchronous callback over a 24-byte VARIANT; owned values are cleared even on failure. */
export function withComVariant<T>(fn: (value: Uint8Array) => T): T {
	const library = getAutomation();
	const variant = new Uint8Array(24);
	try {
		return fn(variant);
	} finally {
		const hr = library.VariantClear(ptr(variant));
		if (hr < 0) throw new Error(`VariantClear failed: 0x${(hr >>> 0).toString(16)}`);
	}
}
