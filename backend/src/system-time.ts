import { type SystemPlatform, type LocalDateTime, type SystemCommand, pad2, type PlatformStatus, type PlatformStatusReader, isSupportedPlatform, UNREADABLE_STATUS, processTimezone, timezoneOffsetMinutes, getTimezoneSource, result, type CommandRunner, runWrite, validateClockParts, runAll, listSystemTimezones, isValidNtpServer, withSaveBudget, withReadBudget, remainingSaveBudget } from './system-time-common.ts';
import { macSystemsetup, readMacStatus } from './system-time-macos.ts';
import { windowsClockRefusal, probeLocalMachineKeyWritable, type RegistryWriteState, W32TIME_NTP_CLIENT_SUBKEY, readWindowsStatus, type WindowsModeReader, type WindowsModeState, windowsSyncIsOurs, canConvertTimezoneId, ianaToWindowsTimezoneId, rememberWindowsZone, readWindowsMode, readWindowsTimeZone, readWindowsTimeServiceRunning, type WindowsTimeZoneState } from './system-time-windows.ts';
import { readLinuxStatus, TIMESYNCD_DROPIN_PATH } from './system-time-linux.ts';
import { type SystemTimeStatus, type SystemTimeResult, type SystemTimeChanges, type SystemTimeStep } from '@shared';
import { Mutex } from 'async-mutex';
import { AsyncLocalStorage } from 'node:async_hooks';
import { syncDirectory } from './system-time-files.ts';
import { executeTimesyncdDropIn } from './native/linux/time-mutation-dropin.ts';
import { runLinuxTimeOperation } from './native/linux/time-mutation.ts';
import { runWindowsTimeOperation } from './native/win32/time-mutation.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Compatibility commands for the remaining POSIX adapters and their injected tests. */
export function buildSetClockCommands(platform: SystemPlatform, when: Pick<LocalDateTime, 'hours' | 'minutes' | 'seconds'>): SystemCommand[] {
	const time = `${pad2(when.hours)}:${pad2(when.minutes)}:${pad2(when.seconds)}`;
	if (platform === 'linux') return [{ cmd: 'timedatectl', args: ['set-time', time] }];
	return platform === 'darwin' ? [macSystemsetup(['-settime', time])] : [];
}
export function buildSetTimezoneCommands(platform: SystemPlatform, timezone: string): SystemCommand[] {
	if (platform === 'linux') return [{ cmd: 'timedatectl', args: ['set-timezone', timezone] }];
	return platform === 'darwin' ? [macSystemsetup(['-settimezone', timezone])] : [];
}
export function buildSetNtpServerCommands(platform: SystemPlatform, server: string, daemonRunning: boolean): SystemCommand[] {
	if (platform === 'linux') return daemonRunning ? [{ cmd: 'systemctl', args: ['restart', 'systemd-timesyncd'] }] : [];
	return platform === 'darwin' ? [macSystemsetup(['-setnetworktimeserver', server])] : [];
}
export function buildSetNtpEnabledCommands(platform: SystemPlatform, enabled: boolean): SystemCommand[] {
	if (platform === 'linux') return [{ cmd: 'timedatectl', args: ['set-ntp', enabled ? 'true' : 'false'] }];
	return platform === 'darwin' ? [macSystemsetup(['-setusingnetworktime', enabled ? 'on' : 'off'])] : [];
}

/**
 * Cached per platform: the ICU zone list does not change while the process runs, and
 * the Windows filter below costs one FFI conversion per zone across 450-odd of them.
 */
let hostTimezones: { platform: string; zones: string[] } | null = null;

/**
 * The timezones this HOST can actually be set to.
 *
 * Not the same list as {@link listSystemTimezones}, and the difference is the whole
 * point: `tzutil` speaks Windows identifiers, and CLDR has no Windows equivalent for
 * every IANA zone the runtime offers. On this author's host three of the 455 offered
 * zones convert to nothing — `America/Ciudad_Juarez`, `Antarctica/Troll` and
 * `Asia/Urumqi`.
 *
 * Offering one of those was not merely a picker that fails at the end. The zone passed
 * the membership check in {@link applySystemTimeSettings}, so the save proceeded, and the
 * conversion was only attempted inside {@link setSystemTimezone} — by which time
 * synchronisation had already been switched off and the NTP server already rewritten. A
 * value we can tell is unusable before touching anything must be refused before touching
 * anything, which is what filtering the list at the source achieves for every caller:
 * the picker no longer offers it, and both validation paths reject it as an unknown zone.
 *
 * The same gap exists on the POSIX platforms, for the opposite reason. There the OS takes
 * the IANA name unchanged, but only for a zone its own tzdata carries — and the runtime's
 * ICU list is not that set. Measured on a systemd host: 18 of the 445 zones offered were
 * rejected by `timedatectl set-timezone` with "Invalid or not installed time zone", among
 * them `Asia/Calcutta` and `Europe/Kiev` — the legacy aliases ICU still names canonically
 * while the distribution ships them in a separate package. Those are ordinary picks, not
 * exotic ones, and each of them reproduced the same half-applied save.
 *
 * There the list comes FROM the host's `/usr/share/zoneinfo`, intersected with what this
 * runtime can format. If that directory cannot be read the runtime's list stands in: an
 * empty picker is worse than one that occasionally offers too much, and such a host's
 * writes fail visibly anyway.
 *
 * `platform`, `convert` and `readInstalled` are injectable so both branches can be
 * exercised on either kind of host.
 */
export function listHostTimezones(platform: string = process.platform, convert: (zone: string) => string | null = ianaToWindowsTimezoneId, canConvert: () => boolean = canConvertTimezoneId, readInstalled: () => string[] | null = readInstalledZones): string[] {
	if (hostTimezones?.platform === platform) return hostTimezones.zones;
	const runtime = listSystemTimezones();
	let usable: string[];
	if (platform === 'win32') {
		// A Windows without ICU converts nothing, and the timezone capability is already off
		// there — an empty list would additionally erase the zone the host is actually in.
		usable = canConvert() ? runtime.filter(zone => convert(zone) !== null) : runtime;
	} else {
		// The HOST's own names, not the runtime's filtered down. Filtering was the wrong shape:
		// ICU still calls the legacy aliases canonical — `Asia/Calcutta`, `Europe/Kiev`,
		// `America/Godthab` — while the distribution ships only `Asia/Kolkata`, `Europe/Kyiv`,
		// `America/Nuuk`. Dropping the name with no file therefore removed the alias AND never
		// offered the one that works, so on a real host no India and no Ukraine zone was
		// selectable at all. Reading the host's database offers the modern name instead.
		//
		// Still intersected with what this runtime can format, or the picker would offer a zone
		// the screen cannot render a clock for.
		const installed = readInstalled();
		usable = installed === null ? runtime : installed.filter(zone => timezoneOffsetMinutes(zone) !== null).sort();
	}
	hostTimezones = { platform, zones: usable };
	return usable;
}

/** Directory every POSIX host keeps its zone database in, and validates a name against. */
const ZONEINFO_DIR = '/usr/share/zoneinfo';

/**
 * The zone names this HOST has, read off its own database. Null when it cannot be read, so
 * the caller falls back to the runtime's list rather than offering nothing.
 *
 * `Area/Location`, which is why an entry has to start with a capital and carry no extension:
 * everything else under there is not a zone — the `posix/` and `right/` trees, `zone.tab`,
 * `leapseconds`, `tzdata.zi`, `localtime`. Measured against `timedatectl list-timezones` on a
 * systemd 255 host: the two agreed exactly, in both directions.
 */
function readInstalledZones(dir: string = ZONEINFO_DIR): string[] | null {
	const zones: string[] = [];
	const walk = (relative: string): void => {
		for (const name of readdirSync(relative ? join(dir, relative) : dir)) {
			if (!/^[A-Z]/.test(name) || name.includes('.')) continue;
			const zone = relative ? `${relative}/${name}` : name;
			if (statSync(join(dir, zone)).isDirectory()) walk(zone);
			else zones.push(zone);
		}
	};
	try {
		walk('');
	} catch {
		return null;
	}
	return zones.length > 0 ? zones : null;
}

/** Forget the cached list. Only for tests that swap the conversion behaviour. */
export function resetHostTimezones(): void {
	hostTimezones = null;
}

/** Dispatch the OS half of the status read to the backend for this platform. */
function readPlatformStatus(platform: SystemPlatform): Promise<PlatformStatus> {
	if (platform === 'linux') return readLinuxStatus();
	if (platform === 'win32') return readWindowsStatus();
	return readMacStatus();
}

/**
 * Read the host's current time configuration. Unreadable state has no capabilities;
 * platforms without an implemented backend also report `supported: false`.
 * The clock comes from Date.now(); the timezone and NTP settings come from the OS,
 * with the process timezone used only when the host timezone cannot be read.
 */
const lastTimeStatus = new WeakMap<PlatformStatusReader, { platform: string; status: PlatformStatus }>();
export async function getSystemTimeStatus(readPlatform: PlatformStatusReader = readPlatformStatus): Promise<SystemTimeStatus> {
	const platform = process.platform;
	const supported = isSupportedPlatform(platform);
	let specific: PlatformStatus = UNREADABLE_STATUS;
	let stale = false;
	if (supported) {
		try {
			// Under one budget for the whole read. Each child had its own limit and their total
			// had none, so seven commands that each answered in time added up to more than the
			// screen was waiting for - and it reported a failed read for a host that was only
			// slow. Inside a save this joins that save's remaining time instead.
			specific = await withReadBudget(() => readPlatform(platform));
			lastTimeStatus.set(readPlatform, { platform, status: structuredClone(specific) });
		} catch (err) {
			stale = true;
			const previous = lastTimeStatus.get(readPlatform);
			if (previous?.platform === platform) specific = structuredClone(previous.status);
			console.warn('[system-time] Failed to read time status:', (err as Error).message);
		}
	}
	// Sampled AFTER the reads, not before. Those are up to six child processes — registry
	// queries, `w32tm`, `systemctl` — and a clock read taken before them is already that
	// much in the past by the time it is sent, so the UI starts its own second-by-second
	// count from a time the host had a moment ago and stays behind it for as long as the
	// page is open.
	const nowMs = Date.now();
	// The process's own zone is the fallback only: it is fixed at startup and an
	// inherited TZ can override the host's real setting (see processTimezone).
	const timezone = specific.timezone ?? processTimezone();
	const { timezone: _osZone, ...rest } = specific;
	return {
		...rest,
		...(stale ? { stale: true } : {}),
		supported,
		nowMs,
		timezone,
		// getTimezoneOffset() counts the other way (minutes to add to LOCAL to get UTC)
		// and answers for the process, so it is only the fallback for an unknown zone.
		utcOffsetMinutes: specific.utcOffsetMinutes ?? timezoneOffsetMinutes(timezone) ?? -new Date().getTimezoneOffset(),
		timezoneSource: getTimezoneSource(),
	};
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Serializes every system-time mutation in this process. See {@link withSystemTimeLock}. */
const systemTimeWriteLock = new Mutex();

/** Set while the current async context already owns {@link systemTimeWriteLock}. */
const lockHeld = new AsyncLocalStorage<true>();

/**
 * Run `fn` as the only system-time mutation in flight in this process.
 *
 * The whole "read the current state → decide → write → restart → read back →
 * broadcast" sequence has to be one critical section, not just the file write. Two
 * concurrent requests otherwise interleave their halves: both verify against the same
 * pre-state, the second one's file lands before the first one's daemon restart, and the
 * first request reports success for a configuration that is no longer on disk. A
 * rollback running against a newer successful write is the same bug with the older
 * value winning.
 *
 * Re-entrant: the API layer takes the lock around the entire request, and the writers it
 * calls take it again for their own sake (they are exported and used directly). A nested
 * acquisition runs inline instead of waiting for a lock this very call stack is holding.
 *
 * "The writers" is all four of them — {@link setSystemClock}, {@link setSystemTimezone},
 * {@link setSystemNtpServer} and {@link setSystemNtpEnabled} — plus
 * {@link applyTimesyncdDropIn}. The clock and the timezone were left out while this text
 * already claimed them, and they are the two that need it most: the clock decides whether
 * it may be written from a status read a moment earlier, and the zone is what that clock
 * reading is interpreted against. Anything added here takes the lock or this comment
 * stops being true.
 *
 * ponytail: one process-wide lock, not one per resource. System-time writes are rare,
 * human-driven and already seconds long; split it per path only if that ever changes.
 */
export function withSystemTimeLock<T>(fn: () => Promise<T>): Promise<T> {
	if (lockHeld.getStore()) return fn();
	return systemTimeWriteLock.runExclusive(() => lockHeld.run(true, fn));
}

export interface SystemTimeWriters {
	setNtpEnabled: (enabled: boolean) => Promise<SystemTimeResult>;
	setNtpServer: (server: string) => Promise<SystemTimeResult>;
	setTimezone: (timezone: string) => Promise<SystemTimeResult>;
	setClock: (clock: NonNullable<SystemTimeChanges['clock']>) => Promise<SystemTimeResult>;
}

const defaultSystemTimeWriters: SystemTimeWriters = {
	setNtpEnabled: enabled => setSystemNtpEnabled(enabled),
	setNtpServer: server => setSystemNtpServer(server),
	setTimezone: timezone => setSystemTimezone(timezone),
	setClock: clock => setSystemClock(clock.hours, clock.minutes, clock.seconds),
};

/**
 * Whether two IANA names describe the same zone AS THIS HOST CAN TELL.
 *
 * Everywhere but Windows that is string equality. Windows stores a zone the user picked as
 * one identifier shared by several IANA names - `Europe/Prague` and `Europe/Budapest` are
 * both `Central Europe Standard Time` - and which name a given process reports back for it
 * depends on a per-process memory (see `rememberWindowsZone`). Two processes therefore
 * disagree about the NAME while describing the same host setting, and the privileged helper
 * is always a fresh process.
 *
 * That turned an ordinary clock save into `stale`: the backend remembered the Budapest the
 * user had picked, the helper resolved the same identifier to its own process zone, the
 * names differed and the write was refused before it started - every time, because the
 * backend kept reporting the remembered name. Comparing the identifiers instead compares
 * what the host actually stores.
 *
 * The offset check at the call site is deliberately NOT relaxed: it is what still catches a
 * real change, including Windows switching automatic daylight saving off for a zone, which
 * moves the offset while the identifier stays put.
 *
 * Falls back to comparing the names whenever a conversion is unavailable, which is the
 * strict direction.
 */
export function sameHostZone(platform: NodeJS.Platform, current: string, expected: string): boolean {
	if (current === expected) return true;
	if (platform !== 'win32') return false;
	const currentId = ianaToWindowsTimezoneId(current);
	const expectedId = ianaToWindowsTimezoneId(expected);
	return currentId !== null && currentId === expectedId;
}

/** Apply one settings snapshot without allowing another client's save to interleave. */
/**
 * Why a change set cannot be applied at all, or null when every value is usable.
 *
 * Separate from the apply so it can also run BEFORE the decision to elevate. That decision
 * sends a whole set to the privileged helper without a local attempt, and the helper's
 * boundary check only knows shapes: it refuses an empty NTP address as
 * "invalid network helper time changes", a generic `error`. The screen keeps a filled-in
 * form only for `invalid-input`, so clearing the address while also picking a new timezone
 * threw the timezone away too - the user lost work over a typo, and was told the wrong
 * reason for it.
 *
 * The privileged side still validates: it re-runs this through {@link applySystemTimeSettings},
 * which is what keeps a request that did not come from this screen honest.
 */
export function validateSystemTimeChanges(changes: SystemTimeChanges): SystemTimeResult | null {
	if (changes.ntpServer !== undefined && !isValidNtpServer(changes.ntpServer)) return result('invalid-input', 'the NTP server must be a host name or IP address without spaces or special characters');
	if (changes.timezone !== undefined) {
		// The host's own list, not the runtime's: a zone this platform cannot express has
		// to fail here, before the first operation below changes anything.
		const known = listHostTimezones();
		if (known.length === 0) return result('unsupported', 'this runtime has no timezone database');
		if (!known.includes(changes.timezone)) return result('invalid-input', `unknown timezone: ${changes.timezone}`);
	}
	if (changes.clock !== undefined) {
		const invalid = validateClockParts(changes.clock.hours, changes.clock.minutes, changes.clock.seconds);
		if (invalid) return result('invalid-input', invalid);
	}
	return null;
}

export function applySystemTimeSettings(changes: SystemTimeChanges, writers: SystemTimeWriters = defaultSystemTimeWriters, readStatus: () => Promise<SystemTimeStatus> = getSystemTimeStatus, readMode: WindowsModeReader = readWindowsMode): Promise<SystemTimeResult> {
	// Validate the complete input before an earlier field can change the host.
	const invalidInput = validateSystemTimeChanges(changes);
	if (invalidInput) return Promise.resolve(invalidInput);
	// One deadline for every operation below, not one per operation: a combined save runs four
	// of them, and each starting its own sequence budget added up to ten minutes - past the
	// wait the screen is allowed, so it reported an interrupted save while the host was still
	// being changed. Taken INSIDE the lock, so time spent queueing behind another save is not
	// charged to this one's commands.
	return withSystemTimeLock(() =>
		withSaveBudget(async () => {
			// Inside the lock and before the first write: a clock is a wall-clock reading, and the
			// zone it was read in is what turns it into an instant. Another client switching the
			// host's zone between this form being filled and this request running makes the same
			// digits mean a different moment — measured as a host left two hours off real time by a
			// save whose whole purpose was to correct it. Both requests are individually valid, so
			// serialising them cannot catch it; only the expectation can.
			// A clock that will be refused must be refused before the zone or NTP server in the same
			// request is written: otherwise the save fails halfway, with the host already changed.
			// Disabling managed sync cannot release a clock held by another daemon.
			const checkClock = changes.clock !== undefined;
			const current = changes.expectedTimezone !== undefined || checkClock ? await readStatus() : null;
			if (current && changes.expectedTimezone !== undefined) {
				if (!sameHostZone(process.platform, current.timezone, changes.expectedTimezone)) return result('stale', `the host timezone is now ${current.timezone}, not ${changes.expectedTimezone} as this request was composed against`);
				// The offset too, and for the same reason: Windows can switch automatic daylight saving
				// off for a zone, which moves the offset while the name stays put. Same name at +120 and
				// at +60 turns the same digits into instants an hour apart.
				if (changes.expectedOffsetMinutes !== undefined && current.utcOffsetMinutes !== changes.expectedOffsetMinutes) return result('stale', `the host is now ${current.utcOffsetMinutes} minutes from UTC, not ${changes.expectedOffsetMinutes} as this request was composed against`);
			}
			if (current && checkClock) {
				const refusal = changes.ntpEnabled === false ? clockWriteRefusal({ ...current, ntpEnabled: false }) : await clockRefusal(current, process.platform, readMode);
				if (refusal) return refusal;
			}
			const operations: Array<() => Promise<SystemTimeResult>> = [];
			if (changes.ntpEnabled === false) {
				operations.push(() => writers.setNtpEnabled(false));
				// Recheck before changing the server or zone; retain the clock writer's final guard.
				if (checkClock) operations.push(async () => (await clockRefusal(await readStatus(), process.platform, readMode)) ?? result('ok'));
			}
			const ntpServer = changes.ntpServer;
			const timezone = changes.timezone;
			const clock = changes.clock;
			if (ntpServer !== undefined) operations.push(() => writers.setNtpServer(ntpServer));
			if (timezone !== undefined) operations.push(() => writers.setTimezone(timezone));
			if (clock !== undefined) operations.push(() => writers.setClock(clock));
			if (changes.ntpEnabled === true) operations.push(() => writers.setNtpEnabled(true));
			if (operations.length === 0) return result('invalid-input', 'no system-time setting was provided');

			let completed = false;
			const steps: SystemTimeStep[] = [];
			for (const operation of operations) {
				const operationResult = await operation();
				if (operationResult.steps) steps.push(...operationResult.steps);
				if (!operationResult.success) {
					const partial = completed || operationResult.changed === true;
					const attempted = completed || operationResult.stateMayHaveChanged === true;
					return {
						...operationResult,
						...(partial ? { changed: true } : {}),
						...(attempted ? { stateMayHaveChanged: true } : {}),
						...(steps.length > 0 ? { steps } : {}),
					};
				}
				completed = true;
			}
			return result('ok');
		})
	);
}

/** Why a host whose time source somebody else owns is left alone. */
const NOT_OURS_MESSAGE = 'time synchronisation here is not ours to switch: this host has no such service, it belongs to a domain, or its time source is managed by group policy';

/**
 * Re-read the Windows time source immediately before mutating it and refuse when it is
 * not ours to change.
 *
 * The capability in a previously read status is a snapshot: between reading it and
 * running the commands the host can be joined to a domain, have a policy applied or have
 * its source switched by another administrator, and every one of those turns the write
 * into an act of detaching the machine from a time source it depends on. So ownership is
 * decided on a read taken inside the write lock, not on the one the decision started from.
 *
 * Returns the fresh state alongside the refusal so the caller builds its commands from
 * the same read it was authorised by.
 */
async function checkWindowsWritable(readMode: WindowsModeReader): Promise<WindowsModeState & { refusal: SystemTimeResult | null }> {
	const state = await readMode();
	return { ...state, refusal: windowsSyncIsOurs(state.mode, state.membership) ? null : result('unsupported', NOT_OURS_MESSAGE) };
}

/**
 * Reason a clock write must be refused given `status`, or null when it may proceed.
 *
 * Automatic synchronisation blocks the write on every platform, not only on the one
 * that rejects it itself: Linux refuses outright, while Windows and macOS accept the
 * write and let the sync daemon overwrite it minutes later. Reported as
 * `auto-sync-enabled` so the caller can offer the actual fix (switch it off first).
 *
 * An UNKNOWN sync state blocks it too. Treating "could not read" as "off" is the
 * dangerous direction: the write would be accepted, the daemon would step the clock
 * back moments later, and the user would be left with a change that silently undid
 * itself. Only a definite `false` releases the clock.
 */
export function clockWriteRefusal(status: SystemTimeStatus): SystemTimeResult | null {
	if (!status.capabilities.setClock) return result('unsupported', 'this host has no facility for setting the clock');
	if (status.ntpEnabled === null) return result('error', 'cannot determine whether automatic time synchronisation is enabled, so the clock is left alone');
	if (status.ntpEnabled) return result('auto-sync-enabled', 'automatic time synchronisation is enabled');
	// A definite `false` from the host's own time manager is not the whole answer: on Linux it
	// speaks only for the providers it manages, and a daemon started outside that list steps
	// the clock back all the same. The read already found it - refusing here is what makes
	// that finding count, instead of writing a clock somebody else owns.
	if (status.clockHeldByUnmanagedDaemon === true) return result('auto-sync-enabled', 'another time synchronisation daemon is running outside the one this host manages, so it would step a hand-set clock back; stop that service first');
	// And an unanswered question is not a yes. Same rule as the `ntpEnabled === null` refusal
	// above: only a definite "nothing is steering this clock" releases it.
	if (status.clockHeldByUnmanagedDaemon === null) return result('error', 'cannot determine whether another time synchronisation daemon is running, so the clock is left alone');
	return null;
}

/**
 * Reason the clock cannot be set right now, or null: {@link clockWriteRefusal} on `status`,
 * then, on Windows, what the sync SERVICE is doing. That is not in the shared status, which
 * carries the registry's view of synchronisation — a service that is up despite it, or still
 * starting or stopping, owns the clock. Called inside the time lock by both the combined save
 * (before its first write) and the clock writer itself.
 */
async function clockRefusal(status: SystemTimeStatus, platform: NodeJS.Platform, readMode: WindowsModeReader): Promise<SystemTimeResult | null> {
	const refusal = clockWriteRefusal(status);
	if (refusal) return refusal;
	if (platform === 'win32') {
		const objection = windowsClockRefusal(await readMode());
		if (objection) return result('auto-sync-enabled', objection);
	}
	return null;
}

/**
 * Set the wall clock to `hours:minutes:seconds`, keeping the host's current date.
 *
 * Under {@link withSystemTimeLock} from the status read onwards, not merely around the
 * command: the whole point of the read is the refusal decided from it, and a
 * `setNtpEnabled(true)` landing between the two turns "synchronisation is off, the clock
 * is the user's to set" into a clock the daemon steps back seconds later.
 *
 * The validation stays outside the lock — a rejected value never touches the host, so
 * queueing it behind another write would only make it slower.
 *
 * `readStatus` and `exec` are injectable so the ordering can be exercised without setting
 * the clock of the machine running the tests.
 */
export async function setSystemClock(hours: number, minutes: number, seconds: number, readStatus: () => Promise<SystemTimeStatus> = getSystemTimeStatus, exec: CommandRunner = runWrite, readMode: WindowsModeReader = readWindowsMode): Promise<SystemTimeResult> {
	const invalid = validateClockParts(hours, minutes, seconds);
	if (invalid) return result('invalid-input', invalid);
	const platform = process.platform;
	if (!isSupportedPlatform(platform)) return result('unsupported', `setting the clock is not implemented on ${platform}`);
	return withSystemTimeLock(async () => {
		const refusal = await clockRefusal(await readStatus(), platform, readMode);
		if (refusal) return refusal;
		// Only the time of day is sent. Every platform resolves "today" at the moment of the
		// write - systemd for a bare `HH:MM:SS`, `systemsetup -settime`, and `Get-Date` inside
		// the PowerShell command - so no date computed here can be stale by the time it lands.
		if (platform === 'win32') return runWindowsTimeOperation(api => api.clock({ hours, minutes, seconds }));
		return platform === 'linux' && exec === runWrite ? runLinuxTimeOperation(api => api.clock({ hours, minutes, seconds })) : runAll(platform, buildSetClockCommands(platform, { hours, minutes, seconds }), exec);
	});
}

/**
 * Set the system timezone from an IANA identifier. The value must be one the host
 * listed ({@link listHostTimezones}) — that membership check is also what keeps an
 * arbitrary string out of the Windows conversion command, and on Windows it is already
 * restricted to the zones `tzutil` can be given.
 *
 * On success `process.env.TZ` is updated: writing the OS timezone does not
 * invalidate the running process's ICU cache, so without this the backend would keep
 * formatting in the old zone until it restarts.
 *
 * Under {@link withSystemTimeLock} like every other write. The zone is what turns the
 * host's clock reading into a wall-clock time, so a change to it running alongside a
 * clock set has that set land on a date and hour decided under the other zone.
 *
 * `exec` is injectable so the ordering can be exercised without moving the host's zone.
 */
export async function setSystemTimezone(timezone: string, exec: CommandRunner = runWrite, readWindowsZone: () => WindowsTimeZoneState | null = readWindowsTimeZone): Promise<SystemTimeResult> {
	const known = listHostTimezones();
	if (known.length === 0) return result('unsupported', 'this runtime has no timezone database');
	if (!known.includes(timezone)) return result('invalid-input', `unknown timezone: ${timezone}`);
	const platform = process.platform;
	if (!isSupportedPlatform(platform)) return result('unsupported', `setting the timezone is not implemented on ${platform}`);

	let windowsId: string | null = null;
	if (platform === 'win32') {
		if (!canConvertTimezoneId()) return result('unsupported', 'this Windows version has no ICU timezone database');
		windowsId = ianaToWindowsTimezoneId(timezone);
		if (!windowsId) return result('error', `no Windows timezone matches ${timezone}`);
	}

	return withSystemTimeLock(async () => {
		const currentZone = platform === 'win32' ? readWindowsZone() : null;
		if (platform === 'win32' && currentZone === null) return result('error', 'cannot read the Windows daylight saving preference, so the timezone was left unchanged');
		const r = platform === 'win32' ? await runWindowsTimeOperation(api => api.timezone(timezone)) : platform === 'linux' && exec === runWrite ? await runLinuxTimeOperation(api => api.timezone(timezone)) : await runAll(platform, buildSetTimezoneCommands(platform, timezone), exec);
		// Only so this process FORMATS in the new zone: writing the OS timezone does not
		// invalidate a running process's ICU cache. What the status reports is read back
		// from the OS, so an inherited or stale TZ can no longer misrepresent the host.
		if (r.success) {
			process.env['TZ'] = timezone;
			// The next status read maps the host's Windows identifier back to IANA through a
			// cache keyed on that identifier — which this change need not have altered.
			if (windowsId) rememberWindowsZone(windowsId, timezone);
		}
		return r;
	});
}

/**
 * Point the host's time synchronisation at `server`. A single server is configured;
 * that is all macOS supports through `systemsetup`, and it is what the UI offers.
 */
export async function setSystemNtpServer(server: string, readStatus: () => Promise<SystemTimeStatus> = getSystemTimeStatus, readMode: WindowsModeReader = readWindowsMode, exec: CommandRunner = runWrite): Promise<SystemTimeResult> {
	if (!isValidNtpServer(server)) return result('invalid-input', 'the NTP server must be a host name or IP address without spaces or special characters');
	const platform = process.platform;
	if (!isSupportedPlatform(platform)) return result('unsupported', `configuring an NTP server is not implemented on ${platform}`);
	return withSystemTimeLock(async () => {
		const status = await readStatus();
		if (!status.capabilities.setNtpServer) return result('unsupported', 'the NTP server can only be configured where this application owns the time synchronisation service');
		if (platform === 'linux') return applyTimesyncdDropIn(server, status.ntpEnabled === true, TIMESYNCD_DROPIN_PATH, exec);
		// Windows writes the peer list into the service's own registry key, so the source
		// has to still be ours at the moment of writing — not merely when the status the
		// capability came from was read (see checkWindowsWritable).
		const syncRunning = status.ntpEnabled === true;
		if (platform === 'win32') {
			const state = await checkWindowsWritable(readMode);
			if (state.refusal) return state.refusal;
			return runWindowsTimeOperation(api => api.server(server));
		}
		const commands = buildSetNtpServerCommands(platform, server, syncRunning);
		// A platform whose whole change is the file write above has no command to run, and
		// runAll would read the empty list as "unsupported on this platform".
		if (commands.length === 0) return result('ok');
		return runAll(platform, commands, exec);
	});
}

/**
 * Pin `server` in the systemd-timesyncd drop-in and make the daemon read it.
 *
 * The file is written atomically and rolled back when the restart fails: leaving it
 * on disk after a failed save would apply the change at the next boot anyway, long
 * after the user was told nothing had happened. The daemon is restarted a second time
 * on that path so it also goes back to the configuration it was running with.
 *
 * `path`, `exec` and `syncDir` are injectable so the rollback — including a restore whose
 * durability flush fails — can be exercised without a systemd host.
 *
 * The write, the restart and the rollback are one critical section
 * ({@link withSystemTimeLock}): a second request landing between the write and the
 * restart would have the daemon pick up ITS file while this call reports success for a
 * server that is no longer on disk, and a rollback interleaved that way restores an old
 * configuration over a newer successful write.
 */
export function applyTimesyncdDropIn(server: string, syncRunning: boolean, path: string = TIMESYNCD_DROPIN_PATH, exec: CommandRunner = runWrite, syncDir: (dir: string) => Promise<void> = syncDirectory, checkAccess?: (path: string) => Promise<string | null>): Promise<SystemTimeResult> {
	return withSystemTimeLock(() => executeTimesyncdDropIn(server, syncRunning, path, exec, syncDir, checkAccess));
}

/**
 * Switch automatic time synchronisation on or off.
 *
 * A failed step stays failed. This used to re-read the host afterwards and report `ok`
 * whenever the single `ntpEnabled` boolean matched the request — which erased precisely
 * the failures worth reporting: a `/resync` that never reached a peer, or a start-mode
 * change that was refused while the service happened to stop anyway. One boolean cannot
 * confirm every dimension a sequence touched (source mode, start mode, peer list, the
 * sync itself), so it must not be allowed to overrule any of them.
 *
 * The one thing that reconciliation legitimately covered — a service already in the
 * requested run state making `sc` exit non-zero — is handled at the source instead, by
 * {@link SystemCommand.benignCodes} on exactly those two steps.
 *
 * `readStatus` and `exec` are injectable so the sequencing and the outcome mapping can
 * be exercised without touching the host's time service.
 */
export async function setSystemNtpEnabled(enabled: boolean, readStatus: () => Promise<SystemTimeStatus> = getSystemTimeStatus, exec: CommandRunner = runWrite, readMode: WindowsModeReader = readWindowsMode, pause: (ms: number) => Promise<void> = sleep, now: () => number = () => performance.now(), probeNtpClientKey: () => RegistryWriteState = () => probeLocalMachineKeyWritable(W32TIME_NTP_CLIENT_SUBKEY)): Promise<SystemTimeResult> {
	const platform = process.platform;
	if (!isSupportedPlatform(platform)) return result('unsupported', `time synchronisation cannot be switched on ${platform}`);
	return withSystemTimeLock(async () => {
		const status = await readStatus();
		if (!status.capabilities.setNtpEnabled) return result('unsupported', NOT_OURS_MESSAGE);
		// Windows needs its CURRENT time source to decide whether it may be rewritten; every
		// other platform has a single switch that changes nothing else. The re-read also has
		// to be re-judged: the capability above came from an earlier snapshot, and stopping
		// and disabling W32Time on a host that has since become a domain member or gained a
		// policy is exactly the change this must never make.
		let clientEnabled = true;
		if (platform === 'win32') {
			const state = await checkWindowsWritable(readMode);
			if (state.refusal) return state.refusal;
			clientEnabled = state.ntpClientEnabled !== false;
			// Asked before the first command, because this is the one path that begins with a
			// REGISTRY write - switching the NTP client provider back on - and `reg.exe` cannot
			// report its own refusal usably: exit 1 for every failure, and a localized sentence
			// with no error number. Without this the whole save came back as a generic `error`,
			// which is not the outcome that asks for privileges.
			if (enabled && !clientEnabled && probeNtpClientKey() === 'denied') return result('permission-denied', 'the NTP client provider is switched off and this application may not write it; the change needs administrator rights');
		}
		if (platform === 'linux' && exec === runWrite) return runLinuxTimeOperation(api => api.ntpEnabled(enabled));
		if (platform === 'win32') return runWindowsTimeOperation(api => api.ntpEnabled(enabled));
		const commands = buildSetNtpEnabledCommands(platform, enabled);
		const outcome = await runAll(platform, commands, exec);
		// `timedatectl set-ntp` exits 0 even when the provider it tried to start was SKIPPED.
		// A container blocks systemd-timesyncd through `ConditionVirtualization=!container`,
		// and this reported `ok` while the service stayed inactive and the clock was never
		// synchronised — measured in a privileged systemd container, which is a shape this
		// application is deployed in.
		//
		// Confirmed here and deliberately NOT on Windows: there a toggle is a sequence touching
		// the source mode, the start mode, the peer list and the synchronisation itself, and one
		// boolean cannot speak for all four (see the comment above). Here the command and the
		// boolean are the same thing, so reading it back adds a fact instead of hiding three.
		if (!outcome.success) return outcome;
		// Polled, not read once. `timedatectl set-ntp` returns as soon as timedated has
		// ACCEPTED the request, and the NTP property flips - and the sync service actually
		// stops or starts - a moment later. Measured on arm64 Ubuntu 24.04 with
		// systemd-timesyncd running: the immediate read after a successful `set-ntp false`
		// still answered `NTP=yes`, so a write that had in fact worked was reported as
		// "the host accepted the request but synchronisation is still on". The very next
		// call succeeded. The wait is the same shape as the Windows one
		// ({@link waitForWindowsTimeService}) and for the same reason.
		if (await settlesToNtpEnabled(enabled, readStatus, pause, now)) return outcome;
		return { ...result('error', `the host accepted the request but automatic time synchronisation is still ${enabled ? 'off' : 'on'}; its time service may be unable to run here`), changed: true, stateMayHaveChanged: true };
	});
}

/** How long a service is given to settle into the state it was just asked for. */
const SERVICE_SETTLE_MS = 15_000;

/**
 * How long the settle wait below may actually take: the usual 15 s, or what the save has
 * left, whichever is less.
 *
 * The two waits ran on a fresh 15 s of their own, and nothing above them could cut that
 * short: the command they follow is held to the save's remaining time, the next command
 * checks it again, but the wait sits between the two. Inside the privileged Windows helper
 * that gap is the whole reserve: the helper's budget is 45 s against a launcher that
 * terminates it at 60 s, and a start accepted at 44.9 s still waited until 59.9 s - so the
 * helper could be killed with the structured "this may already be applied" answer unsent.
 * Zero or less means the save is already out of time: nothing is waited for, and the caller
 * reports the transition as unconfirmed, which is the honest answer.
 *
 * Null is a wait outside any save - a writer used directly - and keeps the plain 15 s.
 */
function settleAllowance(): number {
	const remaining = remainingSaveBudget();
	return remaining === null ? SERVICE_SETTLE_MS : Math.min(SERVICE_SETTLE_MS, remaining);
}

/**
 * Wait for the host's own `NTP=` flag to reach `enabled`, for as long as {@link settleAllowance} gives.
 *
 * True when it got there, false when it is definitely the opposite the whole time. An
 * UNREADABLE state (null) also returns true: it is not evidence of failure, and inventing
 * one from it would report a write that may well have worked as broken.
 *
 * Monotonic clock, because this runs around a change to the wall clock.
 */
export async function settlesToNtpEnabled(enabled: boolean, readStatus: () => Promise<SystemTimeStatus>, pause: (ms: number) => Promise<void> = sleep, now: () => number = () => performance.now()): Promise<boolean> {
	const allowance = settleAllowance();
	if (allowance <= 0) return false;
	const deadline = now() + allowance;
	while (true) {
		const after = await readStatus();
		if (after.ntpEnabled !== !enabled) return true;
		const remaining = deadline - now();
		if (remaining <= 0) return false;
		await pause(Math.min(250, remaining));
	}
}

/** SCM accepts start/stop before completion. Poll for as long as {@link settleAllowance} gives, under the time-write lock. */
export async function waitForWindowsTimeService(running: boolean, read: () => boolean | null = readWindowsTimeServiceRunning, pause: (ms: number) => Promise<void> = sleep, now: () => number = () => performance.now()): Promise<boolean> {
	const allowance = settleAllowance();
	if (allowance <= 0) return false;
	const deadline = now() + allowance;
	while (true) {
		if (read() === running) return true;
		const remaining = deadline - now();
		if (remaining <= 0) return false;
		await pause(Math.min(250, remaining));
	}
}
export { resolveSystemExecutable, decodeCommandOutput, windowsSystemLibraryPath, run, runWrite, EXEC_TIMEOUT_MS, WRITE_TIMEOUT_MS, SAVE_BUDGET_MS, SEQUENCE_BUDGET_MS, FOLLOW_UP_BUDGET_MS, READ_BUDGET_MS, withSaveBudget, withFollowUpBudget, withReadBudget, remainingSaveBudget, elapsedClock, type SystemPlatform, type SystemCommand, type LocalDateTime, isSupportedPlatform, isValidNtpServer, validateClockParts, parseTimedatectlShow, parseYesNo, classifyFailure, firstLine, listSystemTimezones, getTimezoneSource, timezoneOffsetMinutes, type RunOutcome, type CommandRunner, runAll, runOperations, type SystemOperation, type OperationOutcome, type PlatformStatus, type PlatformStatusReader } from './system-time-common.ts';

export { TIMESYNCD_DROPIN_PATH, TIMESYNCD_UNIT, parseTimesyncConfig, type UnitState, parseUnitLoadStates, canonicalUnitName, unitIsLoaded, COMPETING_NTP_UNITS, competingNtpUnits, parseAnyUnitActive, type ExtractedWords, extractWordsChecked, extractWords, readTimedatedEnvironment, readNtpUnitsList, firstUsableNtpUnit, canConfigureTimesyncdServer, buildTimesyncdDropIn } from './system-time-linux.ts';

export { syncDirectory, type RollbackResult, writeFileAtomically } from './system-time-files.ts';

export { parseSystemsetupValue, parseSystemsetupOnOff, MAC_NEEDS_ROOT_RE, macSystemsetup } from './system-time-macos.ts';

export { W32TM_ERROR_RE, W32TM_SERVICE_INACTIVE_RE, SC_ALREADY_RUNNING_RE, SC_NOT_ACTIVE_RE, scFailureOutput, probeLocalMachineKeyWritable, windowsProcessElevated, ianaToWindowsTimezoneId, type RegistryWriteState, W32TIME_NTP_CLIENT_SUBKEY, type WindowsServiceState, parseWindowsServiceState, readWindowsTimeServiceState, readWindowsMode, windowsServiceRunning, windowsClockRefusal, parseRegValue, parseWindowsNtpServer, type WindowsSyncMode, type WindowsStartMode, parseWindowsSyncMode, parseWindowsStartMode, windowsSyncIsOurs, windowsSyncEnabled, parseWindowsSyncStatus, rememberWindowsZone, windowsToIanaTimezone, parseTzutilZone, readWindowsPolicyManaged, type WindowsModeState, type WindowsModeReader } from './system-time-windows.ts';
