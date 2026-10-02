import { FFIType, ptr, toArrayBuffer, type Pointer } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';
import { allocBstr, readBstr } from './com.ts';

export type WmiScalar = string | number | bigint | boolean | null;
export interface WmiVariant {
	readonly variantType: number;
	readonly value: WmiScalar | readonly WmiScalar[];
	readonly lowerBound?: number;
}
export interface WmiProperty extends WmiVariant {
	readonly cimType: number;
}
export type WmiRow = Record<string, WmiProperty>;
export type WmiInput = { readonly type: 'string'; readonly value: string } | { readonly type: 'boolean'; readonly value: boolean } | { readonly type: 'uint8' | 'uint16' | 'uint32' | 'sint16' | 'sint32'; readonly value: number } | { readonly type: 'uint64'; readonly value: bigint } | { readonly type: 'sint64'; readonly value: bigint };

function scalar(type: number, data: DataView, at: number): WmiScalar {
	switch (type) {
		case 0:
		case 1:
			return null;
		case 2:
			return data.getInt16(at, true);
		case 3:
		case 22:
			return data.getInt32(at, true);
		case 4:
			return data.getFloat32(at, true);
		case 5:
		case 7:
			return data.getFloat64(at, true);
		case 8: {
			const address = data.getBigUint64(at, true);
			return readBstr(address === 0n ? null : (Number(address) as Pointer));
		}
		case 11:
			return data.getInt16(at, true) !== 0;
		case 16:
			return data.getInt8(at);
		case 17:
			return data.getUint8(at);
		case 18:
			return data.getUint16(at, true);
		case 19:
		case 23:
			return data.getUint32(at, true);
		case 20:
			return data.getBigInt64(at, true);
		case 21:
			return data.getBigUint64(at, true);
		default:
			throw new Error(`Unsupported WMI VARIANT type ${type}`);
	}
}

function elementSize(type: number): number {
	switch (type) {
		case 16:
		case 17:
			return 1;
		case 2:
		case 11:
		case 18:
			return 2;
		case 3:
		case 4:
		case 19:
		case 22:
		case 23:
			return 4;
		case 5:
		case 7:
		case 8:
		case 20:
		case 21:
			return 8;
		default:
			throw new Error(`Unsupported WMI SAFEARRAY type ${type}`);
	}
}

function arrayValue(address: Pointer | null, type: number): { value: WmiScalar[]; lowerBound: number } {
	const width = elementSize(type);
	if (address === null) return { value: [], lowerBound: 0 };
	const library = loadSystemLibrary('oleaut32.dll', {
		SafeArrayGetDim: { args: [FFIType.ptr], returns: FFIType.u32 },
		SafeArrayGetElemsize: { args: [FFIType.ptr], returns: FFIType.u32 },
		SafeArrayGetLBound: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		SafeArrayGetUBound: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		SafeArrayAccessData: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		SafeArrayUnaccessData: { args: [FFIType.ptr], returns: FFIType.i32 },
	} as const);
	try {
		if (library.symbols.SafeArrayGetDim(address) !== 1 || library.symbols.SafeArrayGetElemsize(address) !== width) throw new Error('Invalid WMI SAFEARRAY shape');
		const lo = new Int32Array(1),
			hi = new Int32Array(1);
		if (library.symbols.SafeArrayGetLBound(address, 1, ptr(lo)) !== 0 || library.symbols.SafeArrayGetUBound(address, 1, ptr(hi)) !== 0) throw new Error('Cannot read WMI SAFEARRAY bounds');
		const count = hi[0]! - lo[0]! + 1;
		if (count < 0 || count > 1_000_000) throw new Error('Invalid WMI SAFEARRAY length');
		const out = new BigUint64Array(1);
		if (library.symbols.SafeArrayAccessData(address, ptr(out)) !== 0) throw new Error('Cannot access WMI SAFEARRAY data');
		try {
			if (count === 0) return { value: [], lowerBound: lo[0]! };
			if (out[0] === 0n) throw new Error('Missing WMI SAFEARRAY data');
			const data = new DataView(toArrayBuffer(Number(out[0]) as Pointer, 0, count * width));
			return { value: Array.from({ length: count }, (_, index) => scalar(type, data, index * width)), lowerBound: lo[0]! };
		} finally {
			if (library.symbols.SafeArrayUnaccessData(address) !== 0) throw new Error('Cannot unlock WMI SAFEARRAY');
		}
	} finally {
		library.close();
	}
}

export function decodeWmiVariant(variant: Uint8Array): WmiVariant {
	if (variant.byteLength !== 24) throw new Error('WMI VARIANT must contain 24 bytes');
	const view = new DataView(variant.buffer, variant.byteOffset, variant.byteLength);
	const variantType = view.getUint16(0, true);
	if ((variantType & 0xf000) === 0x2000) {
		const raw = view.getBigUint64(8, true);
		const address = raw === 0n ? null : (Number(raw) as Pointer);
		return { variantType, ...arrayValue(address, variantType & 0xfff) };
	}
	return { variantType, value: scalar(variantType, view, 8) };
}

/** The target must be a fresh VARIANT owned by withComVariant. */
export function encodeWmiInput(variant: Uint8Array, input: WmiInput): void {
	const view = new DataView(variant.buffer, variant.byteOffset, variant.byteLength);
	if (input.type === 'string') {
		const text = allocBstr(input.value);
		view.setUint16(0, 8, true);
		view.setBigUint64(8, BigInt(text), true);
		return;
	}
	if (input.type === 'boolean') {
		view.setUint16(0, 11, true);
		view.setInt16(8, input.value ? -1 : 0, true);
		return;
	}
	if (input.type === 'sint64' || input.type === 'uint64') {
		const min = input.type === 'sint64' ? -(1n << 63n) : 0n;
		const max = input.type === 'sint64' ? (1n << 63n) - 1n : (1n << 64n) - 1n;
		if (input.value < min || input.value > max) throw new RangeError('WMI integer out of range');
		view.setUint16(0, input.type === 'sint64' ? 20 : 21, true);
		if (input.type === 'sint64') view.setBigInt64(8, input.value, true);
		else view.setBigUint64(8, input.value, true);
		return;
	}
	const formats = { uint8: [17, 0, 255], uint16: [18, 0, 65535], uint32: [19, 0, 0xffffffff], sint16: [2, -32768, 32767], sint32: [3, -2147483648, 2147483647] } as const;
	const [type, min, max] = formats[input.type];
	if (!Number.isInteger(input.value) || input.value < min || input.value > max) throw new RangeError('WMI integer out of range');
	view.setUint16(0, type, true);
	if (input.type === 'uint8') view.setUint8(8, input.value);
	else if (input.type === 'uint16') view.setUint16(8, input.value, true);
	else if (input.type === 'uint32') view.setUint32(8, input.value, true);
	else if (input.type === 'sint16') view.setInt16(8, input.value, true);
	else view.setInt32(8, input.value, true);
}
