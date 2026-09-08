import { type SystemCommand, processTimezone, listSystemTimezones, tryRead, type PlatformStatus } from './system-time-common.ts';

import { dlopen, FFIType, ptr } from 'bun:ffi';
import { win32 } from 'node:path';

/**
 * Windows time policy and native readers. ICU, registry, SCM and timezone APIs avoid
 * localized command output where it cannot establish ownership or actual host state.
 */

/** Address a Windows system DLL directly so an elevated process never searches for it. */
export function windowsSystemLibraryPath(name: string, systemRoot: string | undefined = process.env['SystemRoot']): string {
	const root = systemRoot && win32.isAbsolute(systemRoot) ? systemRoot : 'C:\\Windows';
	return win32.join(root, 'System32', name);
}

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
			const lib = dlopen(windowsSystemLibraryPath('icu.dll'), {
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
	OpenSCManagerW: (machine: null, database: null, access: number) => bigint;
	OpenServiceW: (manager: bigint, name: number, access: number) => bigint;
	QueryServiceStatusEx: (service: bigint, level: number, data: number, size: number, needed: number) => number;
	CloseServiceHandle: (handle: bigint) => number;
}

// null means "tried and unavailable" — the probe runs at most once either way.
let advapi32: Advapi32 | null | undefined;

/** Load `advapi32.dll` once, lazily. Null anywhere it is not there, which is everywhere but Windows. */
function getAdvapi32(): Advapi32 | null {
	if (advapi32 === undefined) {
		try {
			const lib = dlopen(windowsSystemLibraryPath('advapi32.dll'), {
				RegOpenKeyExW: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
				RegCloseKey: { args: [FFIType.u64], returns: FFIType.i32 },
				OpenSCManagerW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u64 },
				OpenServiceW: { args: [FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.u64 },
				QueryServiceStatusEx: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
				CloseServiceHandle: { args: [FFIType.u64], returns: FFIType.i32 },
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
			const lib = dlopen(windowsSystemLibraryPath('netapi32.dll'), {
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

/** Registry key holding the Windows Time service configuration (NTP peers and sync type). */
const W32TIME_PARAMS_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\W32Time\\Parameters';

/** The service key itself, whose `Start` value is the start type (`sc qc` localizes its output). */
const W32TIME_SERVICE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\W32Time';

/**
 * Root of group policy's own W32Time configuration, relative to `HKEY_LOCAL_MACHINE`
 * ({@link probeLocalMachineKey} takes the subkey, not a full path). When this key exists, an
 * administrator's policy owns the settings and the values under
 * {@link W32TIME_PARAMS_KEY} need not be the ones in effect — policy values override the
 * local W32Time configuration.
 *
 * The ROOT rather than the individual branches under it. Policy lands in several of
 * them — "Configure Windows NTP Client" writes `TimeProviders\NtpClient`, "Global
 * Configuration Settings" writes `Config`, a couple of older values land in
 * `Parameters` — and enumerating a hand-picked set answers "unmanaged" for every branch
 * not on the list, `TimeProviders\NtpServer` included. A subkey cannot exist without its
 * parent, so the parent is the one question that covers all of them, present and future.
 */
const W32TIME_POLICY_KEY = 'SOFTWARE\\Policies\\Microsoft\\W32Time';

/**
 * A failure HRESULT in command output: `0x8` followed by seven hex digits
 * (`0x80070005` access denied, `0x80070522` privilege not held, `0x800706B5` the
 * service is not running).
 *
 * Matched on the code, never on the sentence around it — `w32tm` localizes its
 * messages, so a Czech or German host prints a translated reason next to the same
 * number. Success output cannot collide: it carries no HRESULT, and the identifiers it
 * does print (`ReferenceId: 0xC0000210`) are not in the `0x8` failure range.
 */
export const W32TM_ERROR_RE: RegExp = /0x8[0-9A-Fa-f]{7}/;

/** A `w32tm` step, with the output check that its zero exit code makes necessary. */
export function w32tm(...args: string[]): SystemCommand {
	return { cmd: 'w32tm', args, failOnOutput: W32TM_ERROR_RE };
}

/** ERROR_SERVICE_ALREADY_RUNNING — `sc start` against a service that is already up. */
export const SC_ALREADY_RUNNING = 1056;

/** ERROR_SERVICE_NOT_ACTIVE — `sc stop` against a service that is already down. */
export const SC_NOT_ACTIVE = 1062;

/**
 * Extract the value of a `REG_SZ`/`REG_DWORD` entry from `reg query ... /v NAME`
 * output, whose payload line is `    NAME    REG_SZ    value`. Returns null when the
 * entry is absent.
 */
export function parseRegValue(output: string, name: string): string | null {
	for (const line of output.split('\n')) {
		const match = line.trim().match(/^(\S+)\s+REG_\w+\s+(.*)$/);
		if (match && match[1] === name) return (match[2] ?? '').trim();
	}
	return null;
}

/**
 * Turn the Windows `NtpServer` registry value (`time.windows.com,0x9 other.example.org,0x9`)
 * into the first plain host name, dropping the trailing `,0x<flags>` suffix.
 */
export function parseWindowsNtpServer(value: string | null): string | null {
	if (!value) return null;
	const first = value.trim().split(/\s+/)[0];
	if (!first) return null;
	const host = first.split(',')[0];
	return host ? host : null;
}

/**
 * How Windows Time is configured to obtain the time, from the `Type` registry value.
 *
 * - `domain-hierarchy` (`NT5DS`): the Active Directory time hierarchy. The default on
 *   a domain member and the one thing this application must never overwrite.
 * - `manual` (`NTP`): a configured peer list.
 * - `all` (`AllSync`): the domain hierarchy plus the peer list.
 * - `none` (`NoSync`): no time source at all.
 * - `managed`: group policy owns the configuration, so the registry under
 *   `Services\W32Time` is not the effective one and writing it is pointless at best.
 * - `unknown`: the value could not be read, which is never assumed to be safe.
 */
export type WindowsSyncMode = 'domain-hierarchy' | 'manual' | 'all' | 'none' | 'managed' | 'unknown';

/** Service start type from the `Start` registry value. `disabled` means it cannot run at all. */
export type WindowsStartMode = 'automatic' | 'on-demand' | 'disabled' | 'unknown';

/**
 * Classify the Windows time source. Group policy wins over the service's own registry
 * values: when a policy is present those values need not be the effective configuration
 * (finding: the raw key is not the same thing as what W32Time actually uses).
 */
export function parseWindowsSyncMode(typeValue: string | null, policyManaged: boolean): WindowsSyncMode {
	if (policyManaged) return 'managed';
	if (typeValue === 'NT5DS') return 'domain-hierarchy';
	if (typeValue === 'NTP') return 'manual';
	if (typeValue === 'AllSync') return 'all';
	if (typeValue === 'NoSync') return 'none';
	return 'unknown';
}

/**
 * Read the service start type out of `reg query ...\Services\W32Time /v Start`.
 * `0x0`-`0x2` all start without being asked, `0x3` is trigger/demand start and `0x4`
 * is disabled.
 */
export function parseWindowsStartMode(output: string | null): WindowsStartMode {
	const raw = output === null ? null : parseRegValue(output, 'Start');
	if (raw === '0x0' || raw === '0x1' || raw === '0x2') return 'automatic';
	if (raw === '0x3') return 'on-demand';
	if (raw === '0x4') return 'disabled';
	return 'unknown';
}

/**
 * Whether Windows is set up to synchronise the clock, or null when that cannot be told.
 *
 * Deliberately NOT "the service is running right now". Windows Time is trigger-started
 * on a workgroup machine: it synchronises, stops again, and is still fully configured —
 * reading the live run state would show synchronisation as off, let the UI offer a
 * manual clock set, and have W32Time overwrite it at the next trigger.
 */
/**
 * True when this application may change the host's time source.
 *
 * False for a domain member, for a group-policy-managed host and whenever the mode
 * could not be read. Those are configurations an administrator owns: switching a domain
 * member off `NT5DS`, or disabling W32Time on one, detaches it from the forest's time
 * and eventually breaks Kerberos, and neither the previous mode nor the peer list is
 * anywhere we could restore it from.
 *
 * `AllSync` is in that group too. Windows defines it as using EVERY available source,
 * which on a domain member includes the AD hierarchy — so it is not the "just a peer
 * list" that `NTP` is, and disabling W32Time on such a host detaches it exactly as
 * disabling it on an `NT5DS` one does.
 *
 * The mode alone decides none of this, which is why `membership` is asked for and why
 * only a PROVEN `standalone` passes. A forest-root PDC pointed at an external time
 * source is configured the Microsoft-documented way — local `Type=NTP`, no policy branch
 * — and so reads here as an ordinary `manual` host, while being the machine every clock
 * in the forest follows. Stopping and disabling W32Time on it takes the root out of the
 * domain time hierarchy for good, and Kerberos fails as the clocks drift apart. A domain
 * member that is NOT the authority is refused along with it: nothing available here
 * separates the two, and mistaking the authority for a plain member is the expensive
 * direction of that guess. `unknown` — an unreadable join state — is refused for the
 * same reason.
 */
export function windowsSyncIsOurs(mode: WindowsSyncMode, membership: DomainMembership): boolean {
	if (membership !== 'standalone') return false;
	return mode === 'manual' || mode === 'none';
}

export function windowsSyncEnabled(mode: WindowsSyncMode, start: WindowsStartMode): boolean | null {
	// Policy ownership does not reveal the effective client configuration.
	if (mode === 'managed') return null;
	if (start === 'disabled') return false;
	if (mode === 'none') return false;
	if (mode === 'unknown' || start === 'unknown') return null;
	return true;
}

/** Read current synchronization from recognized w32tm fields; unknown localized labels remain unknown. */
export function parseWindowsSyncStatus(output: string): boolean | null {
	const fields = new Map<string, string>();
	for (const line of output.split(/\r?\n/)) {
		const match = /^[ \t]*(Leap Indicator|Last Successful Sync Time):[ \t]*(.*)$/.exec(line);
		if (!match) continue;
		if (fields.has(match[1]!)) return null;
		fields.set(match[1]!, match[2]!.trim());
	}
	const leap = /^([0-3])(?:[ \t]*\([^()]*\))?$/.exec(fields.get('Leap Indicator') ?? '');
	if (!leap) return null;
	// LI=3 means unsynchronized even when Windows retains an earlier successful timestamp.
	if (leap[1] === '3') return false;
	const value = fields.get('Last Successful Sync Time');
	if (!value) return null;
	if (/^unspecified$/i.test(value)) return false;
	return /\p{Nd}/u.test(value) ? true : null;
}

/** Last resolved Windows-to-IANA pair. The scan below is not free, and the zone rarely changes. */
let windowsZoneCache: { windowsId: string; iana: string } | null = null;

/**
 * IANA identifier for a Windows timezone ID, found by scanning the runtime's zone list
 * for one that converts back to it — CLDR maps only IANA to Windows, and the reverse is
 * many-to-one.
 *
 * The zone the process already reports is tried first and wins when it maps to the same
 * Windows ID: several IANA zones share one, and picking CLDR's representative would
 * rename the user's `Europe/Prague` to another city in the same Windows zone.
 */
/**
 * Point the cache at the zone that was just written.
 *
 * Several IANA zones share one Windows identifier, so a change from `Europe/Prague` to
 * `Europe/Budapest` leaves `tzutil /g` answering exactly as before — and the cache, keyed
 * on that identifier, kept handing back the zone from before the change. The host was
 * correctly reconfigured while the UI showed the old city and the user's change looked
 * like it had been undone.
 */
export function rememberWindowsZone(windowsId: string, iana: string): void {
	windowsZoneCache = { windowsId, iana };
}

export function windowsToIanaTimezone(windowsId: string): string | null {
	if (windowsZoneCache?.windowsId === windowsId) return windowsZoneCache.iana;
	const own = processTimezone();
	const match = ianaToWindowsTimezoneId(own) === windowsId ? own : (listSystemTimezones().find(zone => ianaToWindowsTimezoneId(zone) === windowsId) ?? null);
	if (match !== null) windowsZoneCache = { windowsId, iana: match };
	return match;
}

/**
 * Read the host timezone out of `tzutil /g`. The suffix Windows appends when daylight
 * saving is switched off for the zone is not part of the identifier.
 */
export function parseTzutilZone(output: string | null): string | null {
	const id = (output ?? '').trim().replace(/_dstoff$/, '');
	return id.length > 0 ? id : null;
}

/**
 * True when group policy owns this host's time configuration — or when that could not be
 * established, which is treated the same way.
 *
 * Failing closed is the whole point: "no policy" lets the application stop, disable and
 * reconfigure W32Time, so it may only be concluded from a branch that DEFINITELY is not
 * there. Only `absent` is that proof; `present` and `unreadable` alike yield a managed
 * host, the capabilities go false and the UI shows the controls as somebody else's to
 * change.
 *
 * This used to ask `reg query` and read its exit code. That code cannot carry the answer:
 * `reg` documents only 0 and 1, and exits 1 both for a key that is absent and for one this
 * process may not open — so a policy branch carrying its own restrictive ACL, which is
 * exactly the branch an administrator locks down, arrived here spelled "absent" and the
 * host was declared ours to reconfigure. Probing the key itself replaces that guess with
 * the Win32 error code, which distinguishes the two (see {@link probeLocalMachineKey}).
 */
export function readWindowsPolicyManaged(probe: RegistryKeyProbe = probeLocalMachineKey): boolean {
	return probe(W32TIME_POLICY_KEY) !== 'absent';
}

/**
 * The Windows time source and service start type, as read from the registry, plus the
 * host's domain join state — which no registry value under `W32Time` carries and which
 * decides ownership just as much as the mode does (see {@link windowsSyncIsOurs}).
 */
export interface WindowsModeState {
	mode: WindowsSyncMode;
	start: WindowsStartMode;
	membership: DomainMembership;
	/** Actual SCM state, separate from start policy. Missing or null is unknown. */
	running?: boolean | null;
}

/** Reads {@link WindowsModeState}. Injectable so a write's safety check can be tested off a real host. */
export type WindowsModeReader = () => Promise<WindowsModeState>;

/**
 * Read the Windows time source and service start type. Both the status read and the
 * enable/disable write need them — the write to decide whether it may rewrite the
 * source at all, which is not something it can infer from the requested value.
 */
export async function readWindowsMode(): Promise<WindowsModeState> {
	const type = await tryRead('reg', ['query', W32TIME_PARAMS_KEY, '/v', 'Type']);
	const start = await tryRead('reg', ['query', W32TIME_SERVICE_KEY, '/v', 'Start']);
	const policyManaged = readWindowsPolicyManaged();
	// Read here rather than by the caller so a write's safety check gets the join state
	// from the same read it gets the mode from, inside the same lock.
	const membership = probeDomainMembership();
	return { mode: parseWindowsSyncMode(type === null ? null : parseRegValue(type, 'Type'), policyManaged), start: parseWindowsStartMode(start), membership, running: readWindowsTimeServiceRunning() };
}

/** Read the Windows (W32Time) part of the status. */
export async function readWindowsStatus(readZone: () => WindowsTimeZoneState | null = readWindowsTimeZone, readMode: WindowsModeReader = readWindowsMode): Promise<PlatformStatus> {
	// Registry names establish policy; SCM and timezone APIs supply actual runtime state.
	const params = await tryRead('reg', ['query', W32TIME_PARAMS_KEY, '/v', 'NtpServer']);
	const status = await tryRead('w32tm', ['/query', '/status']);
	const { mode, start, membership, running } = await readMode();
	// Sample the native offset after asynchronous reads, near the final clock sample.
	const zone = readZone();
	// A time source an administrator owns is read-only here, so the UI disables the
	// controls instead of offering a change that would detach the host from its domain.
	const ours = windowsSyncIsOurs(mode, membership);
	return {
		timezone: zone?.windowsId ? windowsToIanaTimezone(zone.windowsId) : null,
		...(zone ? { utcOffsetMinutes: zone.utcOffsetMinutes, timezoneOffsetMode: 'fixed' as const } : {}),
		ntpEnabled: windowsSyncEnabled(mode, start),
		ntpSynchronized: status === null ? null : parseWindowsSyncStatus(status),
		ntpServer: mode === 'manual' || mode === 'none' ? parseWindowsNtpServer(params === null ? null : parseRegValue(params, 'NtpServer')) : null,
		capabilities: { setClock: zone !== null && running !== null && running !== undefined && !(windowsSyncEnabled(mode, start) === false && running && mode !== 'none'), setTimezone: zone !== null && canConvertTimezoneId(), setNtpServer: ours, setNtpEnabled: ours },
	};
}

/** QueryServiceStatusEx returns SERVICE_STATUS_PROCESS: nine DWORDs, current state at offset 4. */
export function parseWindowsServiceRunning(bytes: Uint8Array): boolean | null {
	if (bytes.byteLength < 36) return null;
	const state = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
	return state === 4 ? true : state === 1 ? false : null;
}

/** Query only W32Time status; no service start, stop or configuration access is requested. */
export function readWindowsTimeServiceRunning(): boolean | null {
	const api = getAdvapi32();
	if (!api) return null;
	let manager = 0n;
	let service = 0n;
	try {
		manager = api.OpenSCManagerW(null, null, 0x0001); // SC_MANAGER_CONNECT
		if (manager === 0n) return null;
		const name = toWideCString('W32Time');
		service = api.OpenServiceW(manager, ptr(name), 0x0004); // SERVICE_QUERY_STATUS
		if (service === 0n) return null;
		const bytes = new Uint8Array(36);
		const needed = new Uint32Array(1);
		if (!api.QueryServiceStatusEx(service, 0, ptr(bytes), bytes.length, ptr(needed))) return null;
		return parseWindowsServiceRunning(bytes);
	} catch {
		return null;
	} finally {
		if (service !== 0n) api.CloseServiceHandle(service);
		if (manager !== 0n) api.CloseServiceHandle(manager);
	}
}

export interface WindowsTimeZoneState {
	windowsId: string | null;
	utcOffsetMinutes: number;
	daylightDisabled: boolean;
}

/** DYNAMIC_TIME_ZONE_INFORMATION is 432 bytes; biases are minutes west of UTC. */
export function parseWindowsTimeZone(bytes: Uint8Array, state: number): WindowsTimeZoneState | null {
	if (bytes.byteLength < 432 || ![0, 1, 2].includes(state)) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const bias = view.getInt32(0, true);
	// GetDynamicTimeZoneInformation tells which bias applies NOW, including disabled DST.
	const seasonalBias = state === 1 ? view.getInt32(84, true) : state === 2 ? view.getInt32(168, true) : 0;
	const utcOffsetMinutes = -(bias + seasonalBias) || 0;
	const disabled = view.getUint8(428);
	if (Math.abs(utcOffsetMinutes) > 24 * 60 || disabled > 1) return null;
	let windowsId = '';
	for (let index = 0; index < 128; index++) {
		const character = view.getUint16(172 + index * 2, true);
		if (character === 0) break;
		windowsId += String.fromCharCode(character);
	}
	return { windowsId: windowsId || null, utcOffsetMinutes, daylightDisabled: disabled === 1 };
}

interface WindowsTimezoneApi {
	GetDynamicTimeZoneInformation: (data: number) => number;
}
let timezoneApi: WindowsTimezoneApi | null | undefined;

/** Read the effective OS timezone without relying on process TZ or IANA DST rules. */
export function readWindowsTimeZone(): WindowsTimeZoneState | null {
	if (timezoneApi === undefined) {
		try {
			timezoneApi = dlopen(windowsSystemLibraryPath('kernel32.dll'), {
				GetDynamicTimeZoneInformation: { args: [FFIType.ptr], returns: FFIType.u32 },
			}).symbols as unknown as WindowsTimezoneApi;
		} catch {
			timezoneApi = null;
		}
	}
	if (!timezoneApi) return null;
	try {
		const bytes = new Uint8Array(432);
		return parseWindowsTimeZone(bytes, timezoneApi.GetDynamicTimeZoneInformation(ptr(bytes)));
	} catch {
		return null;
	}
}
