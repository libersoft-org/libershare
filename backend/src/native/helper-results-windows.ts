import { FFIType, ptr, read, type Pointer } from 'bun:ffi';
import { loadSystemLibrary } from './library.ts';

export interface HelperAclEntry {
	readonly type: number;
	readonly mask: number;
	readonly sid: string;
	readonly flags?: number;
}
const PRIVILEGED = new Set(['S-1-5-18', 'S-1-5-32-544']);
const WRITE_RIGHTS = 0x500d0156;
const SDDL = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;BU)';
const wide = (value: string): Buffer => Buffer.from(`${value}\0`, 'utf16le');

export function trustedHelperAcl(owner: string, entries: readonly HelperAclEntry[], present: boolean, programDataAnchor: boolean = false): boolean {
	return present && PRIVILEGED.has(owner) && entries.every(entry => entry.type === 1 || (entry.type === 0 && (PRIVILEGED.has(entry.sid) || (programDataAnchor && entry.sid === 'S-1-3-0' && (entry.flags! & 8) !== 0) || (entry.mask & (programDataAnchor ? WRITE_RIGHTS & ~0x116 : WRITE_RIGHTS)) === 0)));
}

function withProtectedDescriptor<T>(fn: (descriptor: Pointer) => T): T {
	const advapi = loadSystemLibrary('advapi32.dll', { ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } } as const);
	try {
		const kernel = loadSystemLibrary('kernel32.dll', { LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr } } as const);
		const out = new BigUint64Array(1);
		try {
			const sddl = wide(SDDL);
			if (!advapi.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(ptr(sddl), 1, ptr(out), null)) throw new Error('Cannot create helper result security descriptor');
			return fn(Number(out[0]) as Pointer);
		} finally {
			if (out[0] !== 0n) kernel.symbols.LocalFree(Number(out[0]) as Pointer);
			kernel.close();
		}
	} finally {
		advapi.close();
	}
}

/** ProgramData allows creating directories; publish the protected DACL atomically with creation. */
export function createWindowsHelperResultDirectory(path: string): boolean {
	return withProtectedDescriptor(descriptor => {
		const kernel = loadSystemLibrary('kernel32.dll', {
			CreateDirectoryW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			GetLastError: { args: [], returns: FFIType.u32 },
		} as const);
		try {
			const attributes = new Uint8Array(24),
				view = new DataView(attributes.buffer),
				name = wide(path);
			view.setUint32(0, 24, true);
			view.setBigUint64(8, BigInt(descriptor), true);
			if (kernel.symbols.CreateDirectoryW(ptr(name), ptr(attributes))) return true;
			const error = kernel.symbols.GetLastError();
			if (error === 183) return false;
			throw new Error(`Cannot create helper result directory (${error})`);
		} finally {
			kernel.close();
		}
	});
}

export function assertWindowsHelperResultAccess(path: string, programDataAnchor: boolean = false): void {
	const advapi = loadSystemLibrary('advapi32.dll', {
		GetNamedSecurityInfoW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
		ConvertSidToStringSidW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		GetAclInformation: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
		GetAce: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
	} as const);
	try {
		const kernel = loadSystemLibrary('kernel32.dll', { LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr } } as const);
		const descriptor = new BigUint64Array(1),
			owner = new BigUint64Array(1),
			dacl = new BigUint64Array(1);
		const pointer = (value: bigint): Pointer => Number(value) as Pointer;
		const sid = (address: Pointer): string => {
			const out = new BigUint64Array(1);
			if (!advapi.symbols.ConvertSidToStringSidW(address, ptr(out)) || out[0] === 0n) throw new Error('Cannot inspect helper result SID');
			try {
				const chars: number[] = [];
				for (let i = 0; i < 256; i++) {
					const char = read.u16(pointer(out[0]!), i * 2);
					if (char === 0) return String.fromCharCode(...chars);
					chars.push(char);
				}
				throw new Error('Invalid helper result SID');
			} finally {
				kernel.symbols.LocalFree(pointer(out[0]!));
			}
		};
		try {
			const name = wide(path);
			const status = advapi.symbols.GetNamedSecurityInfoW(ptr(name), 1, 5, ptr(owner), null, ptr(dacl), null, ptr(descriptor));
			if (status !== 0 || owner[0] === 0n || dacl[0] === 0n) throw new Error('Cannot establish helper result permissions');
			const size = new Uint32Array(3);
			if (!advapi.symbols.GetAclInformation(pointer(dacl[0]!), ptr(size), 12, 2) || size[0]! > 4096) throw new Error('Invalid helper result ACL');
			const entries: HelperAclEntry[] = [];
			for (let index = 0; index < size[0]!; index++) {
				const out = new BigUint64Array(1);
				if (!advapi.symbols.GetAce(pointer(dacl[0]!), index, ptr(out)) || out[0] === 0n) throw new Error('Cannot inspect helper result ACL');
				const ace = pointer(out[0]!);
				const type = read.u8(ace, 0),
					bytes = read.u16(ace, 2);
				if ((type !== 0 && type !== 1) || bytes < 16) throw new Error('Unsupported helper result ACL entry');
				entries.push({ type, mask: read.u32(ace, 4), sid: sid((Number(ace) + 8) as Pointer), flags: read.u8(ace, 1) });
			}
			if (!trustedHelperAcl(sid(pointer(owner[0]!)), entries, true, programDataAnchor)) throw new Error('Untrusted helper result permissions');
		} finally {
			if (descriptor[0] !== 0n) kernel.symbols.LocalFree(pointer(descriptor[0]!));
			kernel.close();
		}
	} finally {
		advapi.close();
	}
}

export function replaceWindowsHelperResult(source: string, target: string): void {
	const kernel = loadSystemLibrary('kernel32.dll', {
		MoveFileExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	} as const);
	try {
		const from = wide(source),
			to = wide(target);
		if (!kernel.symbols.MoveFileExW(ptr(from), ptr(to), 0x9)) throw new Error('Cannot atomically publish helper result');
	} finally {
		kernel.close();
	}
}

function protectedFile<T>(path: string, disposition: number, share: number, fn: (handle: bigint, kernel: ReturnType<typeof fileKernel>) => T): T {
	return withProtectedDescriptor(descriptor => {
		const kernel = fileKernel();
		let handle = 0xffffffffffffffffn;
		try {
			const attributes = new Uint8Array(24),
				view = new DataView(attributes.buffer),
				name = wide(path);
			view.setUint32(0, 24, true);
			view.setBigUint64(8, BigInt(descriptor), true);
			handle = BigInt(kernel.symbols.CreateFileW(ptr(name), 0xc0000000, share, ptr(attributes), disposition, 0x80, null));
			if (handle === 0xffffffffffffffffn) throw Object.assign(new Error('Cannot open protected helper file'), { code: kernel.symbols.GetLastError() === 32 ? 'EBUSY' : 'EACCES' });
			return fn(handle, kernel);
		} finally {
			if (handle !== 0xffffffffffffffffn) kernel.symbols.CloseHandle(handle);
			kernel.close();
		}
	});
}

function fileKernel() {
	return loadSystemLibrary('kernel32.dll', {
		CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
		WriteFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		FlushFileBuffers: { args: [FFIType.u64], returns: FFIType.i32 },
		CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
		GetLastError: { args: [], returns: FFIType.u32 },
	} as const);
}

export function writeProtectedWindowsHelperFile(path: string, text: string): void {
	protectedFile(path, 1, 1, (handle, kernel) => {
		const bytes = Buffer.from(text),
			written = new Uint32Array(1);
		if (bytes.length && (!kernel.symbols.WriteFile(handle, ptr(bytes), bytes.length, ptr(written), null) || written[0] !== bytes.length)) throw new Error('Cannot write helper result');
		if (!kernel.symbols.FlushFileBuffers(handle)) throw new Error('Cannot flush helper result');
	});
}

export async function withWindowsHelperLock<T>(path: string, action: () => Promise<T>): Promise<T> {
	// Keep the native handle and DLL alive across the asynchronous helper transaction.
	const kernel = fileKernel();
	let handle = 0xffffffffffffffffn;
	try {
		handle = withProtectedDescriptor(descriptor => {
			const attributes = new Uint8Array(24),
				view = new DataView(attributes.buffer),
				name = wide(path);
			view.setUint32(0, 24, true);
			view.setBigUint64(8, BigInt(descriptor), true);
			const value = BigInt(kernel.symbols.CreateFileW(ptr(name), 0xc0000000, 0, ptr(attributes), 4, 0x80, null));
			if (value === 0xffffffffffffffffn) throw Object.assign(new Error('Another privileged helper owns this mutation'), { code: kernel.symbols.GetLastError() === 32 ? 'EBUSY' : 'EACCES' });
			return value;
		});
		assertWindowsHelperResultAccess(path);
		return await action();
	} finally {
		if (handle !== 0xffffffffffffffffn) kernel.symbols.CloseHandle(handle);
		kernel.close();
	}
}
