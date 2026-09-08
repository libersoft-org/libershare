import { type SystemPlatform, type LocalDateTime, type SystemCommand, pad2, type PlatformStatus, type PlatformStatusReader, isSupportedPlatform, UNREADABLE_STATUS, processTimezone, timezoneOffsetMinutes, getTimezoneSource, result, type CommandRunner, run, validateClockParts, runAll, listSystemTimezones, isValidNtpServer } from './system-time-common.ts';
import { MAC_SYSTEMSETUP, readMacStatus } from './system-time-macos.ts';
import { w32tm, type WindowsSyncMode, SC_ALREADY_RUNNING, SC_NOT_ACTIVE, readWindowsStatus, type WindowsModeReader, type WindowsModeState, windowsSyncIsOurs, canConvertTimezoneId, ianaToWindowsTimezoneId, rememberWindowsZone, readWindowsMode, windowsSyncEnabled } from './system-time-windows.ts';
import { readLinuxStatus, TIMESYNCD_DROPIN_PATH, buildTimesyncdDropIn } from './system-time-linux.ts';
import { type SystemTimeStatus, type SystemTimeResult, type SystemTimeChanges, type SystemTimeStep } from '@shared';
import { Mutex } from 'async-mutex';
import { AsyncLocalStorage } from 'node:async_hooks';
import { syncDirectory, type RollbackResult, writeFileAtomically } from './system-time-files.ts';

// ---------------------------------------------------------------------------
// Command builders (pure)
// ---------------------------------------------------------------------------

/**
 * Commands that set the wall clock to `when`. Every field is a validated integer,
 * so the formatted date string cannot carry anything but digits and separators.
 * macOS takes only the time — its `-settime` leaves the date alone.
 */
export function buildSetClockCommands(platform: SystemPlatform, when: LocalDateTime): SystemCommand[] {
	const date = `${when.year}-${pad2(when.month)}-${pad2(when.day)}`;
	const time = `${pad2(when.hours)}:${pad2(when.minutes)}:${pad2(when.seconds)}`;
	if (platform === 'linux') return [{ cmd: 'timedatectl', args: ['set-time', `${date} ${time}`] }];
	if (platform === 'darwin') return [{ cmd: MAC_SYSTEMSETUP, args: ['-settime', time] }];
	return [{ cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', `Set-Date -Date '${date}T${time}'`] }];
}

/**
 * Commands that set the system timezone. `windowsId` is the converted identifier
 * from {@link ianaToWindowsTimezoneId} and is required on Windows only; passing null
 * there yields an empty list, meaning "this change cannot be expressed on this host"
 * — the caller reports that as unsupported rather than running anything.
 */
export function buildSetTimezoneCommands(platform: SystemPlatform, timezone: string, windowsId: string | null): SystemCommand[] {
	if (platform === 'linux') return [{ cmd: 'timedatectl', args: ['set-timezone', timezone] }];
	if (platform === 'darwin') return [{ cmd: MAC_SYSTEMSETUP, args: ['-settimezone', timezone] }];
	return windowsId ? [{ cmd: 'tzutil', args: ['/s', windowsId] }] : [];
}

/**
 * Commands that apply a new NTP server. On Linux the address itself lives in the
 * timesyncd drop-in ({@link buildTimesyncdDropIn}) and only the daemon restart is a
 * command — a reload is not enough for timesyncd to pick the file up. Windows needs
 * an explicit resync afterwards, otherwise the new peer is not contacted until the
 * next poll interval (which defaults to hours).
 *
 * `syncRunning` says whether automatic synchronisation is currently on. When it is
 * off there is deliberately nothing to run on Linux: `systemctl restart` STARTS a
 * stopped unit, so restarting here would switch the sync daemon back on behind the
 * user's back and let it step the clock they are about to set by hand. The drop-in
 * is on disk either way and is read the next time the daemon starts.
 *
 * Windows drops the resync AND the `/update` for the same reason. Both are requests to
 * the RUNNING Windows Time service — `/update` is documented as notifying it that the
 * configuration changed — so with the service stopped they can only fail, and the UI
 * reaches this path exactly that way: it switches synchronisation off before writing a
 * server. Sending them anyway is how a peer list that WAS written came back as an error.
 * Without them `w32tm /config` still writes the registry, and the service reads it when
 * it next starts (which is what switching synchronisation back on does).
 */
export function buildSetNtpServerCommands(platform: SystemPlatform, server: string, syncRunning: boolean): SystemCommand[] {
	if (platform === 'linux') return syncRunning ? [{ cmd: 'systemctl', args: ['restart', 'systemd-timesyncd'] }] : [];
	if (platform === 'darwin') return [{ cmd: MAC_SYSTEMSETUP, args: ['-setnetworktimeserver', server] }];
	// 0x8 is the plain client flag. 0x9 would add 0x1 (SpecialInterval), which makes the
	// peer poll at SpecialPollInterval — a standalone host defaults that to 604800s, so
	// the peer would be contacted weekly instead of on the normal poll interval.
	const peers = `/manualpeerlist:${server},0x8`;
	if (!syncRunning) return [w32tm('/config', peers, '/syncfromflags:manual')];
	return [w32tm('/config', peers, '/syncfromflags:manual', '/update'), w32tm('/resync')];
}

/**
 * Commands that switch automatic time synchronisation on or off. Windows has no
 * single switch: the sync type lives in the service start mode plus the running
 * state, so both are set and the service is resynced once it is up.
 *
 * `sc` rather than `net` for the service control: `sc` exits with the underlying
 * Win32 error code (5 for access denied), while `net` exits 2 for every problem and
 * only says which one in a localized message we must not parse.
 *
 * Those two service steps carry {@link SystemCommand.benignCodes}, because a service
 * that is already in the requested run state makes `sc` exit non-zero. Aborting there
 * would skip the steps that carry the actual change — the sync type on the way on, the
 * start mode on the way off — and the toggle would report a failure while leaving the
 * host half-configured. A real refusal still surfaces: the following steps hit the same
 * permission and fail with it.
 *
 * `mode` is the host's CURRENT Windows time source and decides whether the source is
 * rewritten at all. It defaults to `unknown`, which rewrites nothing — the safe default
 * for a caller that could not determine it.
 */
export function buildSetNtpEnabledCommands(platform: SystemPlatform, enabled: boolean, mode: WindowsSyncMode = 'unknown'): SystemCommand[] {
	if (platform === 'linux') return [{ cmd: 'timedatectl', args: ['set-ntp', enabled ? 'true' : 'false'] }];
	if (platform === 'darwin') return [{ cmd: MAC_SYSTEMSETUP, args: ['-setusingnetworktime', enabled ? 'on' : 'off'] }];
	if (enabled) {
		return [
			{ cmd: 'sc', args: ['config', 'w32time', 'start=', 'auto'] },
			{ cmd: 'sc', args: ['start', 'w32time'], benignCodes: [SC_ALREADY_RUNNING] },
			// ONLY for a host with no time source at all (Type=NoSync), which is the one
			// case where "switch synchronisation on" has to invent one. On every other
			// mode this REPLACES the source: run unconditionally on a domain member it
			// switches Type from NT5DS to a manual peer list, detaching the machine from
			// the Active Directory time hierarchy — which is what Kerberos ticket
			// validity depends on. Enabling synchronisation must never mean "and also
			// change where the time comes from".
			...(mode === 'none' ? [w32tm('/config', '/syncfromflags:manual', '/update')] : []),
			w32tm('/resync'),
		];
	}
	return [
		{ cmd: 'sc', args: ['stop', 'w32time'], benignCodes: [SC_NOT_ACTIVE] },
		{ cmd: 'sc', args: ['config', 'w32time', 'start=', 'disabled'] },
	];
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
export async function getSystemTimeStatus(readPlatform: PlatformStatusReader = readPlatformStatus): Promise<SystemTimeStatus> {
	const platform = process.platform;
	const supported = isSupportedPlatform(platform);
	let specific: PlatformStatus = UNREADABLE_STATUS;
	if (supported) {
		try {
			specific = await readPlatform(platform);
		} catch (err) {
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
		supported,
		nowMs,
		timezone,
		// getTimezoneOffset() counts the other way (minutes to add to LOCAL to get UTC)
		// and answers for the process, so it is only the fallback for an unknown zone.
		utcOffsetMinutes: timezoneOffsetMinutes(timezone) ?? -new Date().getTimezoneOffset(),
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

/** Apply one settings snapshot without allowing another client's save to interleave. */
export function applySystemTimeSettings(changes: SystemTimeChanges, writers: SystemTimeWriters = defaultSystemTimeWriters): Promise<SystemTimeResult> {
	// Validate the complete input before an earlier field can change the host.
	if (changes.ntpServer !== undefined && !isValidNtpServer(changes.ntpServer)) return Promise.resolve(result('invalid-input', 'the NTP server must be a host name or IP address without spaces or special characters'));
	if (changes.timezone !== undefined) {
		const known = listSystemTimezones();
		if (known.length === 0) return Promise.resolve(result('unsupported', 'this runtime has no timezone database'));
		if (!known.includes(changes.timezone)) return Promise.resolve(result('invalid-input', `unknown timezone: ${changes.timezone}`));
	}
	if (changes.clock !== undefined) {
		const invalid = validateClockParts(changes.clock.hours, changes.clock.minutes, changes.clock.seconds);
		if (invalid) return Promise.resolve(result('invalid-input', invalid));
	}
	return withSystemTimeLock(async () => {
		const operations: Array<() => Promise<SystemTimeResult>> = [];
		if (changes.ntpEnabled === false) operations.push(() => writers.setNtpEnabled(false));
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
	});
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
	return null;
}

/**
 * Today's date in the zone that is `utcOffsetMinutes` from UTC at `nowMs`.
 *
 * Not `new Date().getFullYear()` and friends: those answer in the PROCESS's zone, which
 * is fixed at startup and can be overridden by an inherited `TZ`, while the clock being
 * set belongs to the HOST's zone. The two disagree for part of every day, and near
 * midnight they disagree about the date — so a user in one zone setting 00:10 on a host
 * in another would have the time written onto yesterday's or tomorrow's date, moving the
 * clock by a whole day.
 */
export function hostDateParts(nowMs: number, utcOffsetMinutes: number): Pick<LocalDateTime, 'year' | 'month' | 'day'> {
	const local = new Date(nowMs + utcOffsetMinutes * 60000);
	return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() };
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
export async function setSystemClock(hours: number, minutes: number, seconds: number, readStatus: () => Promise<SystemTimeStatus> = getSystemTimeStatus, exec: CommandRunner = run): Promise<SystemTimeResult> {
	const invalid = validateClockParts(hours, minutes, seconds);
	if (invalid) return result('invalid-input', invalid);
	const platform = process.platform;
	if (!isSupportedPlatform(platform)) return result('unsupported', `setting the clock is not implemented on ${platform}`);
	return withSystemTimeLock(async () => {
		const status = await readStatus();
		const refusal = clockWriteRefusal(status);
		if (refusal) return refusal;
		// The same status the refusal was decided from carries the host's zone offset, so the
		// date comes from the host rather than from this process.
		return runAll(platform, buildSetClockCommands(platform, { ...hostDateParts(status.nowMs, status.utcOffsetMinutes), hours, minutes, seconds }), exec);
	});
}

/**
 * Set the system timezone from an IANA identifier. The value must be one the host
 * listed ({@link listSystemTimezones}) — that membership check is also what keeps an
 * arbitrary string out of the Windows conversion command.
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
export async function setSystemTimezone(timezone: string, exec: CommandRunner = run): Promise<SystemTimeResult> {
	const known = listSystemTimezones();
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
		const r = await runAll(platform, buildSetTimezoneCommands(platform, timezone, windowsId), exec);
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
export async function setSystemNtpServer(server: string, readStatus: () => Promise<SystemTimeStatus> = getSystemTimeStatus, readMode: WindowsModeReader = readWindowsMode, exec: CommandRunner = run): Promise<SystemTimeResult> {
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
		let syncRunning = status.ntpEnabled === true;
		if (platform === 'win32') {
			const state = await checkWindowsWritable(readMode);
			if (state.refusal) return state.refusal;
			syncRunning = windowsSyncEnabled(state.mode, state.start) === true;
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
export async function applyTimesyncdDropIn(server: string, syncRunning: boolean, path: string = TIMESYNCD_DROPIN_PATH, exec: CommandRunner = run, syncDir: (dir: string) => Promise<void> = syncDirectory): Promise<SystemTimeResult> {
	return withSystemTimeLock(async () => {
		let rollback: () => Promise<RollbackResult>;
		try {
			rollback = await writeFileAtomically(path, buildTimesyncdDropIn(server), undefined, syncDir);
		} catch (err) {
			const e = err as { code?: string; message?: string; published?: boolean };
			// The content reached its final name and only the flush afterwards failed, so this
			// is not "nothing happened": the file is on disk, the daemon was never restarted
			// onto it, and the host adopts it at the next start unless somebody removes it.
			if (e.published) return { ...result('error', `${path} now holds the new server but could not be flushed to disk (${e.message ?? 'the directory flush failed'}), so systemd-timesyncd was not restarted onto it`), changed: true, stateMayHaveChanged: true };
			if (e.code === 'EACCES' || e.code === 'EPERM') return result('permission-denied', `cannot write ${path}`);
			return result('error', e.message ?? `cannot write ${path}`);
		}
		const commands = buildSetNtpServerCommands('linux', server, syncRunning);
		// Synchronisation is off, so there is deliberately no restart — the drop-in on disk
		// IS the whole change and is read when the daemon next starts. Nothing to roll back.
		if (commands.length === 0) return result('ok');
		const r = await runAll('linux', commands, exec);
		if (!r.success) {
			const restored = await rollback();
			const reason = r.message ?? 'the change could not be applied';
			// A restart would load the current file, which may be our rejected value or a
			// later administrator's edit. Do not activate either after a failed rollback.
			if (restored.state === 'not-restored') return { ...r, changed: true, stateMayHaveChanged: true, message: `${reason} (${path} could not be restored safely; its current configuration and systemd-timesyncd were left as they are)` };
			// Both restored states get the restart: the visible file is the original one either
			// way, and only its durability is in question. Skipping it over a failed flush left
			// the daemon stopped, or running the configuration just withdrawn, while the file
			// on disk was in fact the old one.
			//
			// The daemon has to be put back onto the restored file for the rollback to mean
			// anything, so this restart is part of it and its outcome is part of the answer.
			// Discarded, a rollback that put the file back and left the daemon down reported as
			// a clean undo.
			const back = await runAll('linux', commands, exec);
			const caveats: string[] = [];
			if (!back.success) caveats.push('systemd-timesyncd could not be restarted onto it');
			if (restored.state === 'restored-not-durable') caveats.push('the restore could not be flushed to disk, so it may not survive a crash or a power loss');
			if (caveats.length > 0) return { ...r, message: `${reason} (${path} was restored, but ${caveats.join(', and ')})` };
		}
		return r;
	});
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
export async function setSystemNtpEnabled(enabled: boolean, readStatus: () => Promise<SystemTimeStatus> = getSystemTimeStatus, exec: CommandRunner = run, readMode: WindowsModeReader = readWindowsMode): Promise<SystemTimeResult> {
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
		let mode: WindowsSyncMode = 'unknown';
		if (platform === 'win32') {
			const state = await checkWindowsWritable(readMode);
			if (state.refusal) return state.refusal;
			mode = state.mode;
		}
		return runAll(platform, buildSetNtpEnabledCommands(platform, enabled, mode), exec);
	});
}
export { resolveSystemExecutable, type SystemPlatform, type SystemCommand, type LocalDateTime, isSupportedPlatform, isValidNtpServer, validateClockParts, parseTimedatectlShow, parseYesNo, classifyFailure, firstLine, listSystemTimezones, getTimezoneSource, timezoneOffsetMinutes, type RunOutcome, type CommandRunner, runAll, type PlatformStatus, type PlatformStatusReader } from './system-time-common.ts';

export { TIMESYNCD_DROPIN_PATH, TIMESYNCD_UNIT, parseTimesyncServer, type UnitState, parseUnitLoadStates, canonicalUnitName, unitIsLoaded, COMPETING_NTP_UNITS, competingNtpUnits, parseAnyUnitActive, type ExtractedWords, extractWordsChecked, extractWords, readTimedatedEnvironment, readNtpUnitsList, firstUsableNtpUnit, canConfigureTimesyncdServer, buildTimesyncdDropIn } from './system-time-linux.ts';

export { syncDirectory, type RollbackResult, writeFileAtomically } from './system-time-files.ts';

export { parseSystemsetupValue, parseSystemsetupOnOff } from './system-time-macos.ts';

export { W32TM_ERROR_RE, parseRegValue, parseWindowsNtpServer, type WindowsSyncMode, type WindowsStartMode, parseWindowsSyncMode, parseWindowsStartMode, windowsSyncIsOurs, windowsSyncEnabled, parseWindowsSyncStatus, rememberWindowsZone, windowsToIanaTimezone, parseTzutilZone, readWindowsPolicyManaged, type WindowsModeState, type WindowsModeReader } from './system-time-windows.ts';
