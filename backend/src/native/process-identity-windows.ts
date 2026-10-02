import { FFIType, ptr } from 'bun:ffi';
import { loadSystemLibrary } from './library.ts';
import type { NativeProcessRead } from './process-identity.ts';

export interface WindowsProcessIdentityApi {
	readonly open: (pid: number) => { readonly handle: bigint; readonly error: number };
	readonly creation: (handle: bigint) => bigint | null;
	readonly wait: (handle: bigint) => number;
	readonly close: (handle: bigint) => void;
}

function windowsProcessApi(): { api: WindowsProcessIdentityApi; dispose: () => void } {
	const library = loadSystemLibrary('kernel32.dll', {
		OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
		GetLastError: { args: [], returns: FFIType.u32 },
		GetProcessTimes: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
		CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
	});
	const api: WindowsProcessIdentityApi = {
		open: pid => {
			// QUERY_LIMITED_INFORMATION | SYNCHRONIZE; zero timeout never blocks.
			const handle = BigInt(library.symbols.OpenProcess(0x101000, 0, pid));
			return { handle, error: handle === 0n ? library.symbols.GetLastError() : 0 };
		},
		creation: handle => {
			const times = new Uint8Array(32);
			if (!library.symbols.GetProcessTimes(handle, ptr(times, 0), ptr(times, 8), ptr(times, 16), ptr(times, 24))) return null;
			return new DataView(times.buffer).getBigUint64(0, true);
		},
		wait: handle => library.symbols.WaitForSingleObject(handle, 0),
		close: handle => {
			library.symbols.CloseHandle(handle);
		},
	};
	return { api, dispose: () => library.close() };
}

export function readWindowsProcessIdentity(pid: number, injected?: WindowsProcessIdentityApi): NativeProcessRead {
	const owned = injected ? null : windowsProcessApi();
	const api = injected ?? owned!.api;
	let handle = 0n;
	try {
		const opened = api.open(pid);
		handle = opened.handle;
		// OpenProcess documents ERROR_INVALID_PARAMETER for a nonexistent PID.
		if (handle === 0n) return { state: opened.error === 87 && pid > 0 ? 'ended' : 'unknown' };
		const wait = api.wait(handle);
		if (wait === 0) return { state: 'ended' };
		if (wait !== 258) return { state: 'unknown' };
		const created = api.creation(handle);
		return created !== null && created > 0n ? { state: 'running', started: `win32-filetime:${created}` } : { state: 'unknown' };
	} finally {
		if (handle !== 0n) api.close(handle);
		owned?.dispose();
	}
}

export function readWindowsBootId(): string | null {
	const registry = loadSystemLibrary('advapi32.dll', {
		RegGetValueW: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	});
	try {
		const key = Buffer.from('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters\0', 'utf16le');
		const name = Buffer.from('BootId\0', 'utf16le');
		const type = new Uint32Array(1);
		const data = new Uint32Array(1);
		const size = new Uint32Array([4]);
		// HKEY_LOCAL_MACHINE, DWORD only, native 64-bit view.
		const status = registry.symbols.RegGetValueW(0xffffffff80000002n, ptr(key), ptr(name), 0x10010, ptr(type), ptr(data), ptr(size));
		return status === 0 && type[0] === 4 && size[0] === 4 ? `win32-boot:${data[0]}` : null;
	} finally {
		registry.close();
	}
}
