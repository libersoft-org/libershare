import { FFIType, ptr } from 'bun:ffi';
import { createHash } from 'node:crypto';
import { loadSystemLibrary } from '../library.ts';
import { parseWindowsTimeZone, ianaToWindowsTimezoneId, type WindowsTimeZoneState } from '../../system-time-windows.ts';
import { readTimeRegistry, timeRegistryString, withTimePrivilege, WindowsTimeNativeError } from './time-native.ts';

export interface WindowsNativeZone extends WindowsTimeZoneState {
	readonly bytes: string;
	readonly hash: string;
}
export interface WindowsClockParts {
	readonly hours: number;
	readonly minutes: number;
	readonly seconds: number;
}
export function windowsZoneHash(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes.subarray(0, 4)).update(bytes.subarray(68, 88)).update(bytes.subarray(152, 429)).digest('hex');
}
export function readWindowsNativeZone(): WindowsNativeZone {
	const lib = loadSystemLibrary('kernel32.dll', { GetDynamicTimeZoneInformation: { args: [FFIType.ptr], returns: FFIType.u32 } } as const);
	try {
		const bytes = new Uint8Array(432),
			state = lib.symbols.GetDynamicTimeZoneInformation(ptr(bytes)),
			zone = parseWindowsTimeZone(bytes, state);
		if (!zone) throw new Error('Cannot read the Windows timezone');
		return { ...zone, bytes: Buffer.from(bytes).toString('base64'), hash: windowsZoneHash(bytes) };
	} finally {
		lib.close();
	}
}
export function windowsTimezoneTarget(timezone: string, daylightDisabled: boolean): WindowsNativeZone {
	const windowsId = ianaToWindowsTimezoneId(timezone);
	if (!windowsId || windowsId.includes('\\')) throw new Error('Unknown Windows timezone');
	const key = `SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Time Zones\\${windowsId}`;
	const value = readTimeRegistry(key, 'TZI');
	if (value?.type !== 3) throw new Error('Missing Windows timezone rules');
	const tzi = Buffer.from(value.data, 'base64');
	if (tzi.length !== 44) throw new Error('Invalid Windows timezone rules');
	const bytes = Buffer.alloc(432);
	tzi.copy(bytes, 0, 0, 4);
	tzi.copy(bytes, 84, 4, 8);
	tzi.copy(bytes, 168, 8, 12);
	tzi.copy(bytes, 68, 12, 28);
	tzi.copy(bytes, 152, 28, 44);
	for (const [name, offset] of [
		['Std', 4],
		['Dlt', 88],
	] as const)
		bytes.set(Buffer.from((timeRegistryString(readTimeRegistry(key, name)) ?? '').slice(0, 31), 'utf16le'), offset);
	bytes.set(Buffer.from(windowsId, 'utf16le'), 172);
	bytes[428] = daylightDisabled ? 1 : 0;
	return { windowsId, daylightDisabled, utcOffsetMinutes: -bytes.readInt32LE(0), bytes: bytes.toString('base64'), hash: windowsZoneHash(bytes) };
}
export function systemTimeFromMs(ms: number): Uint16Array {
	const value = new Date(ms);
	return new Uint16Array([value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDay(), value.getUTCDate(), value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(), value.getUTCMilliseconds()]);
}
function systemTimeMs(value: Uint16Array): number {
	return Date.UTC(value[0]!, value[1]! - 1, value[3]!, value[4]!, value[5]!, value[6]!, value[7]!);
}

/** .NET chooses the standard occurrence of a fold; the Win32 conversion chooses the first. */
export function windowsLocalClockToUtc(bytes: Uint8Array, local: Uint16Array): number {
	if (bytes.length !== 432 || local.length !== 8) throw new Error('Invalid Windows clock structures');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes[428] === 1) return systemTimeMs(local) + view.getInt32(0, true) * 60000;
	const lib = loadSystemLibrary('kernel32.dll', { TzSpecificLocalTimeToSystemTimeEx: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 }, SystemTimeToTzSpecificLocalTimeEx: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } } as const);
	try {
		const utc = new Uint16Array(8);
		if (!lib.symbols.TzSpecificLocalTimeToSystemTimeEx(ptr(bytes), ptr(local), ptr(utc))) throw new Error('Cannot convert the local Windows clock');
		const first = systemTimeMs(utc),
			delta = (view.getInt32(84, true) - view.getInt32(168, true)) * 60000;
		const candidate = systemTimeFromMs(first + delta),
			back = new Uint16Array(8);
		return delta !== 0 && lib.symbols.SystemTimeToTzSpecificLocalTimeEx(ptr(bytes), ptr(candidate), ptr(back)) && systemTimeMs(back) === systemTimeMs(local) ? first + delta : first;
	} finally {
		lib.close();
	}
}
export function prepareWindowsClock(zone: WindowsNativeZone, clock: WindowsClockParts): { targetUtcMs: number; localDate: string } {
	if (![clock.hours, clock.minutes, clock.seconds].every(Number.isInteger) || clock.hours < 0 || clock.hours > 23 || clock.minutes < 0 || clock.minutes > 59 || clock.seconds < 0 || clock.seconds > 59) throw new Error('Invalid clock');
	const lib = loadSystemLibrary('kernel32.dll', { GetLocalTime: { args: [FFIType.ptr], returns: FFIType.void } } as const);
	try {
		const local = new Uint16Array(8);
		lib.symbols.GetLocalTime(ptr(local));
		const localDate = `${local[0]}-${local[1]}-${local[3]}`;
		local[4] = clock.hours;
		local[5] = clock.minutes;
		local[6] = clock.seconds;
		local[7] = 0;
		return { targetUtcMs: windowsLocalClockToUtc(Buffer.from(zone.bytes, 'base64'), local), localDate };
	} finally {
		lib.close();
	}
}
export function windowsHostUptimeMs(): number {
	const lib = loadSystemLibrary('kernel32.dll', { GetTickCount64: { args: [], returns: FFIType.u64 } } as const);
	try {
		return Number(lib.symbols.GetTickCount64());
	} finally {
		lib.close();
	}
}
export function writeWindowsClock(utcMs: number): void {
	withTimePrivilege('SeSystemtimePrivilege', () => {
		const lib = loadSystemLibrary('kernel32.dll', { SetSystemTime: { args: [FFIType.ptr], returns: FFIType.i32 }, GetLastError: { args: [], returns: FFIType.u32 } } as const);
		try {
			const value = systemTimeFromMs(utcMs);
			if (!lib.symbols.SetSystemTime(ptr(value))) throw new WindowsTimeNativeError('SetSystemTime', lib.symbols.GetLastError());
		} finally {
			lib.close();
		}
	});
}
export function writeWindowsTimezone(zone: WindowsNativeZone): void {
	const bytes = Buffer.from(zone.bytes, 'base64');
	if (bytes.length !== 432 || windowsZoneHash(bytes) !== zone.hash) throw new Error('Invalid timezone target');
	withTimePrivilege('SeTimeZonePrivilege', () => {
		const lib = loadSystemLibrary('kernel32.dll', { SetDynamicTimeZoneInformation: { args: [FFIType.ptr], returns: FFIType.i32 }, GetLastError: { args: [], returns: FFIType.u32 } } as const);
		try {
			if (!lib.symbols.SetDynamicTimeZoneInformation(ptr(bytes))) throw new WindowsTimeNativeError('SetDynamicTimeZoneInformation', lib.symbols.GetLastError());
		} finally {
			lib.close();
		}
	});
}
