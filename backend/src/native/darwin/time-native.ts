import { FFIType as F, ptr, read, type Library } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';
import { readFileSync } from 'node:fs';
import { parseTzif, tzifOffsetAt } from '../tzif.ts';

export const DARWIN_CORE_TIME: string = '/System/Library/PrivateFrameworks/CoreTime.framework/CoreTime';
export interface DarwinClockParts { readonly hours: number; readonly minutes: number; readonly seconds: number }

const coreTimeSymbols = { TMIsAutomaticTimeEnabled: { args: [], returns: 'bool' }, TMSetAutomaticTimeEnabled: { args: ['bool'], returns: 'void' } } as const;
export function openDarwinCoreTime(): Library<typeof coreTimeSymbols> { return loadSystemLibrary(DARWIN_CORE_TIME, coreTimeSymbols); }

export function darwinHostUptimeMs(): number {
	const library = loadSystemLibrary('/usr/lib/libSystem.B.dylib', {
		mach_continuous_time: { args: [], returns: F.u64 }, mach_timebase_info: { args: [F.ptr], returns: F.i32 },
	});
	try {
		const scale = new Uint32Array(2);
		if (library.symbols.mach_timebase_info(ptr(scale)) !== 0 || !scale[1]) throw new Error('macOS monotonic clock is unavailable');
		const ticks = BigInt(library.symbols.mach_continuous_time());
		return Number(ticks * BigInt(scale[0]!) / BigInt(scale[1]) / 1000000n);
	} finally { library.close(); }
}

/** Darwin mktime chooses the host's DST rule; the helper must have no process-local TZ. */
export function prepareDarwinClock(clock: DarwinClockParts): number {
	if (process.env['TZ'] !== undefined) throw new Error('A native macOS clock write requires an environment without TZ');
	if (![clock.hours, clock.minutes, clock.seconds].every(Number.isInteger) || clock.hours < 0 || clock.hours > 23 || clock.minutes < 0 || clock.minutes > 59 || clock.seconds < 0 || clock.seconds > 59) throw new Error('Invalid clock time');
	const library = loadSystemLibrary('/usr/lib/libSystem.B.dylib', {
		tzset: { args: [], returns: F.void }, mktime: { args: [F.ptr], returns: F.i64 },
	});
	try {
		library.symbols.tzset();
		const zone = parseTzif(readFileSync('/private/etc/localtime')), now = Date.now();
		const today = new Date(now + tzifOffsetAt(zone, Math.floor(now / 1000)) * 1000);
		// Darwin struct tm: nine int fields, padding, tm_gmtoff and tm_zone (56 bytes).
		const fields = Buffer.alloc(56);
		fields.writeInt32LE(today.getUTCDate(), 12); fields.writeInt32LE(today.getUTCMonth(), 16); fields.writeInt32LE(today.getUTCFullYear() - 1900, 20);
		fields.writeInt32LE(clock.seconds, 0); fields.writeInt32LE(clock.minutes, 4); fields.writeInt32LE(clock.hours, 8); fields.writeInt32LE(-1, 32);
		const utc = Number(library.symbols.mktime(ptr(fields)));
		if (!Number.isSafeInteger(utc) || utc === -1) throw new Error('macOS mktime failed');
		// A cached libc zone must never turn a correct wall-clock request into an hours-wide jump.
		if (Number(fields.readBigInt64LE(40)) !== tzifOffsetAt(zone, utc)) throw new Error('libc timezone does not match the host timezone file');
		return utc * 1000;
	} finally { library.close(); }
}

export function setDarwinClock(utcMs: number): number {
	const library = loadSystemLibrary('/usr/lib/libSystem.B.dylib', {
		settimeofday: { args: [F.ptr, F.ptr], returns: F.i32 }, __error: { args: [], returns: F.ptr },
	});
	try {
		const value = Buffer.alloc(16);
		value.writeBigInt64LE(BigInt(Math.floor(utcMs / 1000)), 0); value.writeInt32LE((utcMs % 1000) * 1000, 8);
		return library.symbols.settimeofday(ptr(value), null) === 0 ? 0 : read.i32(library.symbols.__error()!);
	} finally { library.close(); }
}

export function notifyDarwinTimezone(): number {
	const library = loadSystemLibrary('/usr/lib/libSystem.B.dylib', { notify_post: { args: [F.ptr], returns: F.u32 } });
	try { const name = Buffer.from('com.apple.system.timezone\0'); return library.symbols.notify_post(ptr(name)); }
	finally { library.close(); }
}
