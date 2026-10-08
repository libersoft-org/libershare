import { FFIType, ptr } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';

function wide(value: string): Buffer {
	if (value.includes('\0')) throw new Error('Invalid registry name');
	return Buffer.from(`${value}\0`, 'utf16le');
}

/** Missing values are distinct from a denied or malformed registry read. */
export function readLocalMachineString(subKey: string, name: string): string | null {
	const library = loadSystemLibrary('advapi32.dll', { RegGetValueW: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } } as const);
	try {
		const key = wide(subKey);
		const valueName = wide(name);
		const type = new Uint32Array(1);
		const size = new Uint32Array(1);
		const read = (buffer: Buffer | null): number => library.symbols.RegGetValueW(0xffffffff80000002n, ptr(key), ptr(valueName), 0x10002, ptr(type), buffer ? ptr(buffer) : null, ptr(size));
		let result = read(null);
		if (result === 2 || result === 3) return null;
		if (result !== 0) throw new Error(`Cannot read registry value: ${result}`);
		for (let attempt = 0; attempt < 3; attempt++) {
			if (size[0]! > 1024 * 1024 || size[0]! % 2) throw new Error('Invalid registry string length');
			const buffer = Buffer.alloc(Math.max(2, size[0]!));
			size[0] = buffer.length;
			result = read(buffer);
			if (result === 234) continue;
			if (result === 2 || result === 3) return null;
			if (result !== 0) throw new Error(`Cannot read registry value: ${result}`);
			if (type[0] !== 1 || size[0]! > buffer.length || size[0]! % 2) throw new Error('Invalid registry string type');
			const text = buffer.subarray(0, size[0]).toString('utf16le').replace(/\0+$/, '');
			if (text.includes('\0')) throw new Error('Embedded NUL in registry string');
			return text;
		}
		throw new Error('Registry value kept changing during the read');
	} finally {
		library.close();
	}
}
