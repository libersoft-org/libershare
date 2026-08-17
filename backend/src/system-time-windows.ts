import { dlopen, FFIType, ptr } from 'bun:ffi';

/**
 * Windows-only helpers that need an in-process system call rather than a child process:
 * the ICU timezone conversion below, and the registry key probe at the bottom of the file.
 */

/**
 * IANA to Windows timezone identifier conversion, done in-process through the ICU
 * library Windows itself ships (`icu.dll`) via `bun:ffi`. No child process, no
 * PowerShell, and no CLDR table bundled into the repository that would go stale with
 * every timezone rule change.
 *
 * `icu.dll` arrived in Windows 10 1903. The releases before it (1703-1809) did expose
 * ICU, but as `icuuc.dll`/`icuin.dll` with version-suffixed export names
 * (`ucal_getWindowsTimeZoneID_63`) that differ per build and cannot be bound blindly, so
 * they are deliberately not attempted. Those hosts land in the same place as a host with
 * no ICU at all: {@link canConvertTimezoneId} is false, the timezone capability is off
 * and the UI disables the picker rather than offering a change that cannot be expressed.
 *
 * The conversion is needed because `tzutil` only understands Windows identifiers
 * ("Central Europe Standard Time") while every other platform — and our UI — speaks
 * IANA ("Europe/Prague"), and the mapping is a curated CLDR table that cannot be
 * derived from UTC offsets. Only this direction is implemented: the reverse mapping
 * is lossy (several IANA zones share one Windows zone, and ICU answers with the
 * region's representative, which is usually a different city than the user picked),
 * so the current zone is always read from the runtime's own ICU instead.
 */

/** ICU string arguments are UTF-16 code-unit arrays, not NUL-terminated C strings. */
function toUtf16(value: string): Uint16Array {
	const buffer = new Uint16Array(value.length);
	for (let i = 0; i < value.length; i++) buffer[i] = value.charCodeAt(i);
	return buffer;
}

interface Icu {
	ucal_getWindowsTimeZoneID: (id: number, len: number, winid: number, capacity: number, status: number) => number;
}

// null means "tried and unavailable" — the probe runs at most once either way.
let icu: Icu | null | undefined;

/** Load the system ICU once, lazily. Returns null when the host has no `icu.dll` (anything before Windows 10 1903). */
function getIcu(): Icu | null {
	if (icu === undefined) {
		try {
			const lib = dlopen('icu.dll', {
				ucal_getWindowsTimeZoneID: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
			});
			icu = lib.symbols as unknown as Icu;
		} catch {
			icu = null;
		}
	}
	return icu;
}

/** True when this host can convert IANA identifiers, i.e. when the timezone can be set at all. */
export function canConvertTimezoneId(): boolean {
	return getIcu() !== null;
}

/**
 * Convert an IANA timezone identifier to the Windows one `tzutil /s` expects.
 * Returns null when the host has no ICU or when CLDR knows no Windows equivalent
 * for that zone. Never throws.
 */
export function ianaToWindowsTimezoneId(timezone: string): string | null {
	const lib = getIcu();
	if (!lib) return null;
	try {
		const source = toUtf16(timezone);
		// Windows identifiers are short; 128 code units is far beyond the longest.
		const out = new Uint16Array(128);
		const status = new Int32Array(1);
		const length = lib.ucal_getWindowsTimeZoneID(ptr(source), source.length, ptr(out), out.length, ptr(status));
		// UErrorCode: negative values are warnings, positive ones are failures.
		if (status[0]! > 0 || length <= 0 || length > out.length) return null;
		return String.fromCharCode(...out.subarray(0, length));
	} catch {
		return null;
	}
}

/**
 * What a registry key turned out to be.
 *
 * `absent` is a PROVEN absence — the key is not there. `unreadable` covers a key that
 * exists but this process may not open, and every other failure. The distinction is the
 * whole reason this probe exists: a policy branch we could not read may well be a policy
 * about to be overridden, while one that is definitely not there is not.
 */
export type RegistryKeyState = 'present' | 'absent' | 'unreadable';

/** Opens a key under `HKEY_LOCAL_MACHINE` and reports what it found. Injectable for tests. */
export type RegistryKeyProbe = (subKey: string) => RegistryKeyState;

/**
 * `HKEY_LOCAL_MACHINE` as `winreg.h` spells it: `(HKEY)(ULONG_PTR)((LONG)0x80000002)`,
 * i.e. a negative LONG widened to a pointer, hence the leading `ffffffff` on 64-bit.
 */
const HKEY_LOCAL_MACHINE = 0xffffffff80000002n;

/**
 * `KEY_READ | KEY_WOW64_64KEY`. Opening for read alone is enough — the question is whether
 * the key is there, not what is in it — and the explicit 64-bit view keeps the answer the
 * same whatever this process's bitness is: policy lives in the 64-bit hive, and a 32-bit
 * process asking without the flag is redirected into `Wow6432Node`, where it is not.
 */
const KEY_READ_64 = 0x20019 | 0x0100;

/** ERROR_FILE_NOT_FOUND — the only code that proves a key is not there. */
const ERROR_FILE_NOT_FOUND = 2;

interface Advapi32 {
	RegOpenKeyExW: (hKey: bigint, subKey: number, options: number, sam: number, out: number) => number;
	RegCloseKey: (hKey: bigint) => number;
}

// null means "tried and unavailable" — the probe runs at most once either way.
let advapi32: Advapi32 | null | undefined;

/** Load `advapi32.dll` once, lazily. Null anywhere it is not there, which is everywhere but Windows. */
function getAdvapi32(): Advapi32 | null {
	if (advapi32 === undefined) {
		try {
			const lib = dlopen('advapi32.dll', {
				RegOpenKeyExW: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
				RegCloseKey: { args: [FFIType.u64], returns: FFIType.i32 },
			});
			advapi32 = lib.symbols as unknown as Advapi32;
		} catch {
			advapi32 = null;
		}
	}
	return advapi32;
}

/** A NUL-terminated UTF-16 string, which is what the `W` entry points take. */
function toWideCString(value: string): Uint16Array {
	const buffer = new Uint16Array(value.length + 1);
	for (let i = 0; i < value.length; i++) buffer[i] = value.charCodeAt(i);
	return buffer;
}

/**
 * Whether `subKey` exists under `HKEY_LOCAL_MACHINE`, asked through `RegOpenKeyExW`.
 *
 * `reg.exe` cannot answer this: it documents 0 for success and 1 for failure, and exits 1
 * for a key that is absent and for one that is merely denied alike — with a LOCALIZED
 * message that cannot be parsed either. Deciding a security question from that exit code
 * meant reading a denied policy branch as an absent one. The Win32 call returns
 * `ERROR_FILE_NOT_FOUND` and `ERROR_ACCESS_DENIED` as distinct codes precisely so the two
 * can be told apart, which is the only reason this goes through FFI at all.
 *
 * Never throws: anything unexpected is `unreadable`, the answer that makes the caller
 * fail closed.
 */
export function probeLocalMachineKey(subKey: string): RegistryKeyState {
	const lib = getAdvapi32();
	if (!lib) return 'unreadable';
	try {
		const name = toWideCString(subKey);
		const handle = new BigUint64Array(1);
		const code = lib.RegOpenKeyExW(HKEY_LOCAL_MACHINE, ptr(name), 0, KEY_READ_64, ptr(handle));
		if (code === 0) {
			lib.RegCloseKey(handle[0]!);
			return 'present';
		}
		return code === ERROR_FILE_NOT_FOUND ? 'absent' : 'unreadable';
	} catch {
		return 'unreadable';
	}
}

/**
 * Whether this host belongs to an Active Directory domain.
 *
 * `standalone` is a PROVEN non-membership: Windows itself answered "workgroup" or "joined
 * to nothing". `domain` and `unknown` both mean the host may be a domain member — and a
 * domain member may be the very machine the rest of the forest takes its time from — so
 * they are the same answer to every caller that is about to touch W32Time.
 */
export type DomainMembership = 'domain' | 'standalone' | 'unknown';

/** Reports {@link DomainMembership}. Injectable for tests. */
export type DomainMembershipProbe = () => DomainMembership;

/** `NETSETUP_JOIN_STATUS` from `lmjoin.h`. 0 is `NetSetupUnknownStatus`. */
const NET_SETUP_UNJOINED = 1;
const NET_SETUP_WORKGROUP_NAME = 2;
const NET_SETUP_DOMAIN_NAME = 3;

interface Netapi32 {
	NetGetJoinInformation: (server: bigint, nameBuffer: number, bufferType: number) => number;
	NetApiBufferFree: (buffer: bigint) => number;
}

// null means "tried and unavailable" — the probe runs at most once either way.
let netapi32: Netapi32 | null | undefined;

/** Load `netapi32.dll` once, lazily. Null anywhere it is not there, which is everywhere but Windows. */
function getNetapi32(): Netapi32 | null {
	if (netapi32 === undefined) {
		try {
			const lib = dlopen('netapi32.dll', {
				NetGetJoinInformation: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
				NetApiBufferFree: { args: [FFIType.u64], returns: FFIType.i32 },
			});
			netapi32 = lib.symbols as unknown as Netapi32;
		} catch {
			netapi32 = null;
		}
	}
	return netapi32;
}

/**
 * Ask Windows whether this machine is domain-joined, through `NetGetJoinInformation`.
 *
 * Neither the registry nor `Type=NTP` can answer this. A forest-root PDC synchronising
 * against an external source is configured exactly as a workgroup machine with a peer
 * list is — local `Type=NTP`, no group policy involved — and it is also the machine whose
 * clock the whole domain follows. Told apart by nothing else, the two need this separate
 * question asked before W32Time is stopped on either.
 *
 * `NetGetJoinInformation` needs no elevation — it reports the join state this machine
 * holds locally. Never throws — anything unexpected,
 * a status other than `NERR_Success` included, is `unknown`, which makes the caller
 * fail closed.
 */
export function probeDomainMembership(): DomainMembership {
	const lib = getNetapi32();
	if (!lib) return 'unknown';
	try {
		const nameBuffer = new BigUint64Array(1);
		const bufferType = new Int32Array(1);
		// A NULL server name is the local machine, and a 64-bit zero is that NULL pointer.
		const code = lib.NetGetJoinInformation(0n, ptr(nameBuffer), ptr(bufferType));
		if (code !== 0) return 'unknown';
		// The name itself is of no interest here, only the join status — but the call
		// allocated it and only NetApiBufferFree may release it.
		if (nameBuffer[0] !== 0n) lib.NetApiBufferFree(nameBuffer[0]!);
		const status = bufferType[0];
		if (status === NET_SETUP_DOMAIN_NAME) return 'domain';
		if (status === NET_SETUP_UNJOINED || status === NET_SETUP_WORKGROUP_NAME) return 'standalone';
		return 'unknown';
	} catch {
		return 'unknown';
	}
}
