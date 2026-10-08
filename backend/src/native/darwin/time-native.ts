import { FFIType as F, ptr, read, type Library } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';
import { readFileSync } from 'node:fs';
import { parseTzif, tzifOffsetAt, type TzifZone } from '../tzif.ts';
import { createHash } from 'node:crypto';
import { getNativeBootId } from '../process-identity.ts';
import { darwinLocalToUtc } from './time-clock.ts';

export const DARWIN_CORE_TIME: string = '/System/Library/PrivateFrameworks/CoreTime.framework/CoreTime';
export interface DarwinClockParts {
	readonly hours: number;
	readonly minutes: number;
	readonly seconds: number;
}
export interface DarwinClockReference {
	readonly localDate: string;
	readonly zoneSha256: string;
	readonly bootId: string;
}
export interface DarwinClockConversion {
	readonly targetUtcMs: number;
	readonly reference: DarwinClockReference;
}
export interface DarwinClockSnapshot {
	readonly zone: TzifZone;
	readonly reference: DarwinClockReference;
}
export interface DarwinClockConversionDeps {
	snapshot(): DarwinClockSnapshot;
	reference(): DarwinClockReference;
}

export function validDarwinClock(clock: unknown): clock is DarwinClockParts {
	if (!clock || typeof clock !== 'object' || Array.isArray(clock)) return false;
	const value = clock as DarwinClockParts;
	return Object.keys(value).sort().join() === 'hours,minutes,seconds' && [value.hours, value.minutes, value.seconds].every(Number.isInteger) && value.hours >= 0 && value.hours <= 23 && value.minutes >= 0 && value.minutes <= 59 && value.seconds >= 0 && value.seconds <= 59;
}

export function readDarwinClockReference(): DarwinClockReference {
	return readDarwinClockSnapshot().reference;
}

function readDarwinClockSnapshot(): DarwinClockSnapshot {
	const bytes = readFileSync('/private/etc/localtime'),
		zone = parseTzif(bytes),
		now = Date.now();
	const today = new Date(now + tzifOffsetAt(zone, Math.floor(now / 1000)) * 1000),
		bootId = getNativeBootId();
	if (!bootId) throw new Error('Cannot identify the host boot before converting its clock');
	return { zone, reference: { localDate: `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`, zoneSha256: createHash('sha256').update(bytes).digest('hex'), bootId } };
}

export function sameDarwinClockReference(left: DarwinClockReference, right: DarwinClockReference): boolean {
	return left.localDate === right.localDate && left.zoneSha256 === right.zoneSha256 && left.bootId === right.bootId;
}

const coreTimeSymbols = { TMIsAutomaticTimeEnabled: { args: [], returns: 'bool' }, TMSetAutomaticTimeEnabled: { args: ['bool'], returns: 'void' } } as const;
export function openDarwinCoreTime(): Library<typeof coreTimeSymbols> {
	return loadSystemLibrary(DARWIN_CORE_TIME, coreTimeSymbols);
}

export function darwinHostUptimeMs(): number {
	const library = loadSystemLibrary('/usr/lib/libSystem.B.dylib', {
		mach_continuous_time: { args: [], returns: F.u64 },
		mach_timebase_info: { args: [F.ptr], returns: F.i32 },
	});
	try {
		const scale = new Uint32Array(2);
		if (library.symbols.mach_timebase_info(ptr(scale)) !== 0 || !scale[1]) throw new Error('macOS monotonic clock is unavailable');
		const ticks = BigInt(library.symbols.mach_continuous_time());
		return Number((ticks * BigInt(scale[0]!)) / BigInt(scale[1]) / 1000000n);
	} finally {
		library.close();
	}
}

/** Convert one physical TZif snapshot; process TZ and libc's cached zone are irrelevant. */
export function prepareDarwinClock(clock: DarwinClockParts, supplied?: DarwinClockConversionDeps): DarwinClockConversion {
	if (!validDarwinClock(clock)) throw new Error('Invalid clock time');
	const deps = supplied ?? { snapshot: readDarwinClockSnapshot, reference: readDarwinClockReference };
	const { zone, reference } = deps.snapshot();
	const [year, month, day] = reference.localDate.split('-').map(Number);
	const utc = darwinLocalToUtc(zone, { year: year!, month: month!, day: day!, hour: clock.hours, minute: clock.minutes, second: clock.seconds });
	if (!Number.isSafeInteger(utc * 1000) || utc === -1) throw new Error('Darwin clock conversion failed');
	if (!sameDarwinClockReference(reference, deps.reference())) throw new Error('The host date, boot or timezone changed during clock conversion');
	return { targetUtcMs: utc * 1000, reference };
}

export function setDarwinClock(utcMs: number): number {
	const library = loadSystemLibrary('/usr/lib/libSystem.B.dylib', {
		settimeofday: { args: [F.ptr, F.ptr], returns: F.i32 },
		__error: { args: [], returns: F.ptr },
	});
	try {
		const value = Buffer.alloc(16);
		value.writeBigInt64LE(BigInt(Math.floor(utcMs / 1000)), 0);
		value.writeInt32LE((utcMs % 1000) * 1000, 8);
		return library.symbols.settimeofday(ptr(value), null) === 0 ? 0 : read.i32(library.symbols.__error()!);
	} finally {
		library.close();
	}
}

export function notifyDarwinTimezone(): number {
	const library = loadSystemLibrary('/usr/lib/libSystem.B.dylib', { notify_post: { args: [F.ptr], returns: F.u32 } });
	try {
		const name = Buffer.from('com.apple.system.timezone\0');
		return library.symbols.notify_post(ptr(name));
	} finally {
		library.close();
	}
}
