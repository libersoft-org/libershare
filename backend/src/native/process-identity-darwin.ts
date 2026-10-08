import { FFIType, ptr, read } from 'bun:ffi';
import { loadSystemLibrary } from './library.ts';
import { nativeBootUuid, type NativeProcessRead } from './process-identity.ts';

export interface DarwinProcessIdentityResult {
	readonly size: number;
	readonly error: number;
	readonly data: Uint8Array;
}

function readDarwinUniqueId(pid: number): DarwinProcessIdentityResult {
	const proc = loadSystemLibrary('/usr/lib/libproc.dylib', {
		proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	});
	try {
		const system = loadSystemLibrary('/usr/lib/libSystem.B.dylib', { __error: { args: [], returns: FFIType.ptr } });
		try {
			// XNU 11417.140.69 proc_info_private.h: flavor 17, size 56, uniqueid offset 16.
			const data = new Uint8Array(56);
			const size = proc.symbols.proc_pidinfo(pid, 17, 0, ptr(data), data.length);
			const error = size <= 0 ? read.i32(system.symbols.__error()!) : 0;
			return { size, error, data };
		} finally {
			system.close();
		}
	} finally {
		proc.close();
	}
}

export function readDarwinProcessIdentity(pid: number, query: (pid: number) => DarwinProcessIdentityResult = readDarwinUniqueId): NativeProcessRead {
	const result = query(pid);
	if (result.size <= 0) return { state: result.error === 3 ? 'ended' : 'unknown' };
	if (result.size !== 56 || result.data.byteLength < 56) return { state: 'unknown' };
	const unique = new DataView(result.data.buffer, result.data.byteOffset, result.data.byteLength).getBigUint64(16, true);
	// XNU 11417.140.69 kern_fork.c increments uniqueid on fork and preserves it across exec.
	return unique > 0n ? { state: 'running', started: `darwin-uniqueid:${unique}` } : { state: 'unknown' };
}

export function readDarwinBootId(): string | null {
	const system = loadSystemLibrary('/usr/lib/libSystem.B.dylib', {
		sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
	});
	try {
		const name = Buffer.from('kern.bootsessionuuid\0');
		const data = new Uint8Array(128);
		const size = new BigUint64Array([BigInt(data.length)]);
		if (system.symbols.sysctlbyname(ptr(name), ptr(data), ptr(size), null, 0) !== 0 || size[0] === 0n || size[0]! > BigInt(data.length)) return null;
		const bytes = data.subarray(0, Number(size[0]));
		if (bytes[bytes.length - 1] !== 0) return null;
		return nativeBootUuid(Buffer.from(bytes.subarray(0, -1)).toString('utf8'), 'darwin');
	} finally {
		system.close();
	}
}
