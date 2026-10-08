import { FFIType, ptr, read, type Pointer } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';

export const TIME_PARAMETERS = 'SYSTEM\\CurrentControlSet\\Services\\W32Time\\Parameters';
export const TIME_SERVICE = 'SYSTEM\\CurrentControlSet\\Services\\W32Time';
export const TIME_CLIENT: string = `${TIME_SERVICE}\\TimeProviders\\NtpClient`;
const HKLM = 0xffffffff80000002n;
export const timeWide = (value: string): Buffer => {
	if (value.includes('\0')) throw new Error('Invalid Windows string');
	return Buffer.from(`${value}\0`, 'utf16le');
};
export class WindowsTimeNativeError extends Error {
	readonly code: number;
	readonly mayHaveRun: boolean;
	constructor(operation: string, code: number, mayHaveRun = false) {
		super(`${operation} failed: ${code}`);
		this.code = code;
		this.mayHaveRun = mayHaveRun;
	}
}
export interface TimeRegistryValue {
	readonly type: number;
	readonly data: string;
}
export function readTimeRegistry(key: string, name: string): TimeRegistryValue | null {
	const lib = loadSystemLibrary('advapi32.dll', { RegGetValueW: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } } as const);
	try {
		const path = timeWide(key),
			value = timeWide(name),
			type = new Uint32Array(1),
			length = new Uint32Array([16384]),
			bytes = Buffer.alloc(16384);
		const code = lib.symbols.RegGetValueW(HKLM, ptr(path), ptr(value), 0x1000ffff, ptr(type), ptr(bytes), ptr(length));
		if (code === 2 || code === 3) return null;
		if (code !== 0) throw new WindowsTimeNativeError('RegGetValueW', code);
		if (length[0]! > bytes.length) throw new Error('Oversized time registry value');
		return { type: type[0]!, data: bytes.subarray(0, length[0]).toString('base64') };
	} finally {
		lib.close();
	}
}
export function timeRegistryString(value: TimeRegistryValue | null): string | null {
	if (value === null) return null;
	const bytes = Buffer.from(value.data, 'base64');
	if (![1, 2].includes(value.type) || bytes.length % 2) throw new Error('Invalid time registry string');
	const text = bytes.toString('utf16le').replace(/\0+$/, '');
	if (text.includes('\0')) throw new Error('Invalid time registry string');
	return text;
}
export function timeRegistryDword(value: TimeRegistryValue | null): number | null {
	if (value === null) return null;
	const bytes = Buffer.from(value.data, 'base64');
	if (value.type !== 4 || bytes.length !== 4) throw new Error('Invalid time registry DWORD');
	return bytes.readUInt32LE();
}
export function writeTimeRegistry(key: string, name: string, value: string | number): void {
	const lib = loadSystemLibrary('advapi32.dll', { RegSetKeyValueW: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } } as const);
	try {
		const path = timeWide(key),
			item = timeWide(name),
			bytes = typeof value === 'string' ? timeWide(value) : Buffer.alloc(4);
		if (typeof value === 'number') bytes.writeUInt32LE(value);
		const code = lib.symbols.RegSetKeyValueW(HKLM, ptr(path), ptr(item), typeof value === 'string' ? 1 : 4, ptr(bytes), bytes.length);
		if (code !== 0) throw new WindowsTimeNativeError('RegSetKeyValueW', code);
	} finally {
		lib.close();
	}
}

export function withTimePrivilege<T>(name: 'SeSystemtimePrivilege' | 'SeTimeZonePrivilege', action: () => T): T {
	const adv = loadSystemLibrary('advapi32.dll', {
		OpenProcessToken: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		LookupPrivilegeValueW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		AdjustTokenPrivileges: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	} as const);
	try {
		const kernel = loadSystemLibrary('kernel32.dll', { GetCurrentProcess: { args: [], returns: FFIType.u64 }, GetLastError: { args: [], returns: FFIType.u32 }, SetLastError: { args: [FFIType.u32], returns: FFIType.void }, CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 } } as const);
		const token = new BigUint64Array(1),
			previous = new Uint8Array(16),
			needed = new Uint32Array(1);
		let changed = false;
		try {
			if (!adv.symbols.OpenProcessToken(kernel.symbols.GetCurrentProcess(), 0x28, ptr(token))) throw new WindowsTimeNativeError('OpenProcessToken', kernel.symbols.GetLastError());
			const privileges = new Uint8Array(16),
				view = new DataView(privileges.buffer),
				text = timeWide(name);
			view.setUint32(0, 1, true);
			view.setUint32(12, 2, true);
			if (!adv.symbols.LookupPrivilegeValueW(null, ptr(text), ptr(privileges, 4))) throw new WindowsTimeNativeError('LookupPrivilegeValueW', kernel.symbols.GetLastError());
			kernel.symbols.SetLastError(0);
			const success = adv.symbols.AdjustTokenPrivileges(token[0]!, 0, ptr(privileges), previous.length, ptr(previous), ptr(needed));
			const code = kernel.symbols.GetLastError();
			if (!success || code !== 0) throw new WindowsTimeNativeError('AdjustTokenPrivileges', code);
			changed = true;
			return action();
		} finally {
			if (changed) adv.symbols.AdjustTokenPrivileges(token[0]!, 0, ptr(previous), 0, null, null);
			if (token[0] !== 0n) kernel.symbols.CloseHandle(token[0]!);
			kernel.close();
		}
	} finally {
		adv.close();
	}
}

function serviceApi() {
	return loadSystemLibrary('advapi32.dll', {
		OpenSCManagerW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u64 },
		OpenServiceW: { args: [FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.u64 },
		CloseServiceHandle: { args: [FFIType.u64], returns: FFIType.i32 },
		QueryServiceStatusEx: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		ChangeServiceConfigW: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		ChangeServiceConfig2W: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		StartServiceW: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		ControlService: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
	} as const);
}
export type WindowsTimeServiceWrite = { kind: 'start-mode'; value: 2 | 3 | 4 } | { kind: 'delayed-start'; enabled: boolean } | { kind: 'start' | 'stop' | 'notify'; timeoutMs: number };

export function writeWindowsTimeService(request: WindowsTimeServiceWrite): void {
	const api = serviceApi();
	try {
		const kernel = loadSystemLibrary('kernel32.dll', { GetLastError: { args: [], returns: FFIType.u32 } } as const);
		let manager = 0n,
			service = 0n;
		try {
			manager = BigInt(api.symbols.OpenSCManagerW(null, null, 1));
			if (!manager) throw new WindowsTimeNativeError('OpenSCManagerW', kernel.symbols.GetLastError());
			const name = timeWide('W32Time'),
				access = request.kind === 'start-mode' || request.kind === 'delayed-start' ? 2 : request.kind === 'start' ? 0x14 : request.kind === 'stop' ? 0x24 : 0x44;
			service = BigInt(api.symbols.OpenServiceW(manager, ptr(name), access));
			if (!service) throw new WindowsTimeNativeError('OpenServiceW', kernel.symbols.GetLastError());
			const bytes = new Uint8Array(36),
				needed = new Uint32Array(1);
			let success: number;
			if (request.kind === 'start-mode') success = api.symbols.ChangeServiceConfigW(service, 0xffffffff, request.value, 0xffffffff, null, null, null, null, null, null, null);
			else if (request.kind === 'delayed-start') {
				const flag = new Uint32Array([request.enabled ? 1 : 0]);
				success = api.symbols.ChangeServiceConfig2W(service, 3, ptr(flag));
			} else if (request.kind === 'start') success = api.symbols.StartServiceW(service, 0, null);
			else success = api.symbols.ControlService(service, request.kind === 'stop' ? 1 : 6, ptr(bytes));
			const code = success ? 0 : kernel.symbols.GetLastError();
			const benign = request.kind === 'start' ? code === 1056 : (request.kind === 'stop' || request.kind === 'notify') && code === 1062;
			if (code && !benign) throw new WindowsTimeNativeError(request.kind, code, ![5, 87, 1058, 1060, 1314].includes(code));
			if (request.kind !== 'start' && request.kind !== 'stop') return;
			const deadline = performance.now() + request.timeoutMs;
			for (;;) {
				if (!api.symbols.QueryServiceStatusEx(service, 0, ptr(bytes), bytes.length, ptr(needed))) throw new WindowsTimeNativeError('QueryServiceStatusEx after control', kernel.symbols.GetLastError(), true);
				if (new DataView(bytes.buffer).getUint32(4, true) === (request.kind === 'start' ? 4 : 1)) return;
				if (performance.now() >= deadline) throw new WindowsTimeNativeError('Service transition', 1460, true);
				Bun.sleepSync(100);
			}
		} finally {
			if (service) api.symbols.CloseServiceHandle(service);
			if (manager) api.symbols.CloseServiceHandle(manager);
			kernel.close();
		}
	} finally {
		api.close();
	}
}

export function windowsTimeSyncStatus(): boolean | null {
	const lib = loadSystemLibrary('w32time.dll', { W32TimeQueryStatus: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 }, W32TimeBufferFree: { args: [FFIType.ptr], returns: FFIType.void } } as const);
	const output = new BigUint64Array(1);
	try {
		if (lib.symbols.W32TimeQueryStatus(null, ptr(output)) !== 0 || !output[0]) return null;
		const value = Number(output[0]) as Pointer;
		if (read.u32(value, 0) < 32) return null;
		const leap = read.u32(value, 4);
		return leap > 3 ? null : leap !== 3 && read.u64(value, 24) !== 0n;
	} finally {
		if (output[0]) lib.symbols.W32TimeBufferFree(Number(output[0]) as Pointer);
		lib.close();
	}
}
export function resyncWindowsTime(allowStopped: boolean): void {
	const lib = loadSystemLibrary('w32time.dll', { W32TimeSyncNow: { args: [FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u32 } } as const);
	try {
		const code = lib.symbols.W32TimeSyncNow(null, 1, 1),
			native = code & 0xffff;
		if (code && !(allowStopped && [1062, 1717].includes(native))) throw new WindowsTimeNativeError('W32TimeSyncNow', code, ![5, 87, 1062, 1314].includes(native));
	} finally {
		lib.close();
	}
}
