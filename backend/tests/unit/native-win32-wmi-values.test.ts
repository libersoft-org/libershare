import { describe, expect, test } from 'bun:test';
import { FFIType, ptr, type Pointer } from 'bun:ffi';
import { loadSystemLibrary } from '../../src/native/library.ts';
import { withBstr, withComVariant } from '../../src/native/win32/com.ts';
import { decodeWmiVariant, encodeWmiInput, type WmiInput } from '../../src/native/win32/wmi-values.ts';

describe('WMI scalar types', () => {
	test('preserves integer widths, signedness and 64-bit precision', () => {
		const cases: [WmiInput, number][] = [
			[{ type: 'uint8', value: 255 }, 17],
			[{ type: 'uint16', value: 65535 }, 18],
			[{ type: 'uint32', value: 0xffffffff }, 19],
			[{ type: 'sint16', value: -32768 }, 2],
			[{ type: 'sint32', value: -2147483648 }, 3],
			[{ type: 'sint64', value: -(1n << 63n) }, 20],
			[{ type: 'uint64', value: (1n << 64n) - 1n }, 21],
			[{ type: 'boolean', value: true }, 11],
			[{ type: 'boolean', value: false }, 11],
		];
		for (const [input, variantType] of cases) {
			const bytes = new Uint8Array(24);
			encodeWmiInput(bytes, input);
			expect(decodeWmiVariant(bytes)).toEqual({ variantType, value: input.value });
		}
	});

	test('rejects overflow rather than truncating a method parameter', () => {
		for (const input of [
			{ type: 'uint8', value: 256 },
			{ type: 'sint16', value: -32769 },
			{ type: 'uint32', value: -1 },
			{ type: 'sint32', value: 1.5 },
			{ type: 'uint64', value: -1n },
			{ type: 'sint64', value: 1n << 63n },
		] satisfies WmiInput[])
			expect(() => encodeWmiInput(new Uint8Array(24), input)).toThrow('range');
	});

	test('keeps null and empty distinct and rejects unsupported pointer variants', () => {
		const bytes = new Uint8Array(24);
		expect(decodeWmiVariant(bytes)).toEqual({ variantType: 0, value: null });
		new DataView(bytes.buffer).setUint16(0, 1, true);
		expect(decodeWmiVariant(bytes)).toEqual({ variantType: 1, value: null });
		for (const type of [9, 13, 0x200d, 0x4003, 0x6003]) {
			new DataView(bytes.buffer).setUint16(0, type, true);
			expect(() => decodeWmiVariant(bytes)).toThrow('Unsupported');
		}
		new DataView(bytes.buffer).setUint16(0, 0x2008, true);
		expect(decodeWmiVariant(bytes)).toEqual({ variantType: 0x2008, value: [], lowerBound: 0 });
		expect(() => decodeWmiVariant(bytes.subarray(0, 16))).toThrow('24 bytes');
	});
});

describe.skipIf(process.platform !== 'win32')('WMI SAFEARRAY memory (live)', () => {
	test('copies BSTR arrays and preserves a nonzero lower bound through VariantClear', () => {
		const library = loadSystemLibrary('oleaut32.dll', {
			SafeArrayCreateVector: { args: [FFIType.u16, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
			SafeArrayPutElement: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		} as const);
		try {
			const result = withComVariant(bytes => {
				const array = library.symbols.SafeArrayCreateVector(8, -3, 2);
				expect(array).not.toBeNull();
				const view = new DataView(bytes.buffer);
				view.setUint16(0, 0x2008, true);
				view.setBigUint64(8, BigInt(array!), true);
				for (const [index, value] of ['Project A\0tail', '東京'].entries()) {
					const subscript = new Int32Array([index - 3]);
					withBstr(value, text => expect(library.symbols.SafeArrayPutElement(Number(array) as Pointer, ptr(subscript), text)).toBe(0));
				}
				return decodeWmiVariant(bytes);
			});
			expect(result).toEqual({ variantType: 0x2008, value: ['Project A\0tail', '東京'], lowerBound: -3 });
		} finally {
			library.close();
		}
	});

	test('copies unsigned 64-bit arrays without converting them to JS numbers', () => {
		const library = loadSystemLibrary('oleaut32.dll', {
			SafeArrayCreateVector: { args: [FFIType.u16, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
			SafeArrayPutElement: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		} as const);
		try {
			const result = withComVariant(bytes => {
				const array = library.symbols.SafeArrayCreateVector(21, 0, 1);
				expect(array).not.toBeNull();
				const view = new DataView(bytes.buffer);
				view.setUint16(0, 0x2015, true);
				view.setBigUint64(8, BigInt(array!), true);
				const index = new Int32Array([0]),
					value = new BigUint64Array([0xffffffffffffffffn]);
				expect(library.symbols.SafeArrayPutElement(Number(array) as Pointer, ptr(index), ptr(value))).toBe(0);
				return decodeWmiVariant(bytes);
			});
			expect(result).toEqual({ variantType: 0x2015, value: [0xffffffffffffffffn], lowerBound: 0 });
		} finally {
			library.close();
		}
	});
});
