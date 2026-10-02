import { describe, expect, test } from 'bun:test';
import { FFIType, JSCallback, ptr, type Pointer } from 'bun:ffi';
import { allocBstr, comCall, guidBytes, readBstr, releaseCom, withBstr, withComVariant } from '../../src/native/win32/com.ts';

function objectWithMethod(slot: number, callback: JSCallback): { object: BigUint64Array; vtable: BigUint64Array; pointer: Pointer } {
	const vtable = new BigUint64Array(slot + 1);
	vtable[slot] = BigInt(callback.ptr!);
	const object = new BigUint64Array([BigInt(ptr(vtable))]);
	return { object, vtable, pointer: ptr(object) };
}

describe('COM vtable calls', () => {
	test('encodes the Windows GUID layout', () => {
		expect([...guidBytes('12345678-1234-ABCD-0123-456789ABCDEF')]).toEqual([0x78, 0x56, 0x34, 0x12, 0x34, 0x12, 0xcd, 0xab, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
	});

	test('passes the object before method arguments and preserves signed HRESULTs', () => {
		let received: unknown[] = [];
		const callback = new JSCallback(
			(object, input) => {
				received = [object, input];
				return -2147467259;
			},
			{ args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 }
		);
		const object = objectWithMethod(4, callback);
		try {
			expect(comCall(object.pointer, 4, [FFIType.i32], [42])).toBe(-2147467259);
			expect(received).toEqual([object.pointer, 42]);
		} finally {
			callback.close();
		}
	});

	test('keys cached trampolines by signature as well as address', () => {
		const callback = new JSCallback((_object, value) => value, { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 });
		const object = objectWithMethod(3, callback);
		try {
			expect(comCall(object.pointer, 3, [FFIType.i8], [257])).toBe(1);
			expect(comCall(object.pointer, 3, [FFIType.i32], [257])).toBe(257);
		} finally {
			callback.close();
		}
	});

	test('calls IUnknown Release in slot two', () => {
		const released: number[] = [];
		const callback = new JSCallback(
			object => {
				released.push(object);
				return 0;
			},
			{ args: [FFIType.ptr], returns: FFIType.i32 }
		);
		const object = objectWithMethod(2, callback);
		try {
			releaseCom(object.pointer);
			expect(released).toEqual([object.pointer]);
		} finally {
			callback.close();
		}
	});

	test('preserves scalar audio argument precision and a null event context', () => {
		let received: unknown[] = [];
		const callback = new JSCallback(
			(_object, scalar, context) => {
				received = [scalar, context];
				return 0;
			},
			{ args: [FFIType.ptr, FFIType.f32, FFIType.ptr], returns: FFIType.i32 }
		);
		const object = objectWithMethod(7, callback);
		try {
			expect(comCall(object.pointer, 7, [FFIType.f32, FFIType.ptr], [0.25, null])).toBe(0);
			expect(received).toEqual([0.25, null]);
		} finally {
			callback.close();
		}
	});
});

describe.skipIf(process.platform !== 'win32')('COM Automation memory (live)', () => {
	test('copies length-prefixed BSTRs including Unicode and embedded NUL', () => {
		expect(readBstr(null)).toBeNull();
		for (const value of ['', 'Project A', 'Příliš žluťoučký\0東京 😀']) expect(withBstr(value, pointer => readBstr(pointer))).toBe(value);
	});

	test('clears owned BSTR variants after copying the result', () => {
		let storage: Uint8Array | undefined;
		const copied = withComVariant(variant => {
			storage = variant;
			expect(variant.byteLength).toBe(24);
			const view = new DataView(variant.buffer);
			const text = allocBstr('Project A\0tail');
			view.setUint16(0, 8, true);
			view.setBigUint64(8, BigInt(text), true);
			return readBstr(text);
		});
		expect(copied).toBe('Project A\0tail');
		expect(new DataView(storage!.buffer).getUint16(0, true)).toBe(0);
	});

	test('clears a filled variant when the COM consumer throws', () => {
		let storage: Uint8Array | undefined;
		expect(() =>
			withComVariant(variant => {
				storage = variant;
				const view = new DataView(variant.buffer);
				view.setUint16(0, 8, true);
				view.setBigUint64(8, BigInt(allocBstr('temporary')), true);
				throw new Error('COM call failed');
			})
		).toThrow('COM call failed');
		expect(new DataView(storage!.buffer).getUint16(0, true)).toBe(0);
	});
});
