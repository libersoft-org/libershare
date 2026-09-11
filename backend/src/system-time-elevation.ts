import type { SystemTimeChanges, SystemTimeResult } from '@shared';
import { runElevatedSystemTime } from './network-helper-client.ts';
import { applySystemTimeSettings, withSystemTimeLock } from './system-time.ts';
import { readMacLocaltimeZone } from './system-time-macos.ts';
import { ianaToWindowsTimezoneId, readWindowsTimeZone, rememberWindowsZone, windowsProcessElevated } from './system-time-windows.ts';

/** A refused write worth asking for rights over. */
export function needsElevation(outcome: SystemTimeResult): boolean {
	// `changed` is the only safe gate. A step that COMPLETED before the refusal has
	// already moved the host, and re-running the whole save elevated would apply that
	// step a second time against a state it was not composed against. `permission-denied`
	// with nothing changed is the clean case: the very first write was refused.
	//
	// `stateMayHaveChanged` deliberately does NOT block the retry - it is set for any
	// command that merely STARTED, which includes every process that exited with access
	// denied having done nothing at all, so gating on it would disable elevation entirely.
	return outcome.outcome === 'permission-denied' && outcome.changed !== true;
}

/**
 * True where an unprivileged attempt at THIS change set cannot finish, so the rights have
 * to be arranged before anything is written.
 *
 * The gap this closes: the retry above is refused once a step has completed, and that is
 * the right rule - but it made a perfectly ordinary save unreachable. On Windows, a save
 * of a timezone AND a clock applies the timezone unprivileged (`Users` hold
 * `SeTimeZonePrivilege`, and `tzutil /s` really does write), then meets
 * `SeSystemtimePrivilege`, which they do not hold. The result carries `changed: true`, so
 * no prompt ever appeared: the zone moved and the clock did not. The same shape exists on
 * Linux, where `timedatectl set-ntp` goes through polkit and the drop-in that follows is a
 * direct write into `/etc`.
 *
 * Deciding up front is what the network screen already does. The per-platform rules are
 * measured, not assumed:
 *
 * - **macOS**: below root, nothing at all works - even `systemsetup`'s READS are refused.
 * - **Windows**: without an elevated token only the timezone works. Everything else - the
 *   clock, `w32tm`, the service, the registry - is denied.
 * - **Linux**: the unprivileged path IS the authorized one, because `timedatectl` and
 *   `systemctl` ask polkit themselves. The exception is the NTP server, whose change is a
 *   direct file write into `/etc` that no polkit rule covers.
 */
export function requiresPrivilegesUpFront(platform: NodeJS.Platform, uid: number | undefined, changes: SystemTimeChanges, elevated: boolean): boolean {
	if (platform === 'darwin') return localAttemptIsPointless(platform, uid);
	if (platform === 'win32') return !elevated && writesMoreThanTimezone(changes);
	if (platform === 'linux') return uid !== 0 && changes.ntpServer !== undefined;
	return false;
}

/** Whether the set asks for anything a `Users` member cannot write on Windows. The `expected*` fields are guards, not writes. */
function writesMoreThanTimezone(changes: SystemTimeChanges): boolean {
	return changes.ntpEnabled !== undefined || changes.ntpServer !== undefined || changes.clock !== undefined;
}

/**
 * True where trying unprivileged first cannot even produce a usable refusal.
 *
 * macOS below root is that case. `systemsetup` needs root for its READS too - measured on
 * macOS 15.7.4, every `-get...` answers "You need administrator access to run this
 * tool... exiting!" - so the status carries `ntpEnabled: null`, and a clock write is then
 * refused by `clockWriteRefusal` for not knowing whether synchronisation owns the clock.
 * That refusal is an `error`, not a permission problem, so the retry never fired: a user
 * could switch synchronisation off through the helper and STILL not set the clock, because
 * the confirming read was unprivileged again.
 */
export function localAttemptIsPointless(platform: NodeJS.Platform, uid: number | undefined): boolean {
	return platform === 'darwin' && uid !== 0;
}

/**
 * Apply a system-time save, asking for privileges when this process cannot finish the job
 * itself.
 *
 * Anything the process CAN do alone is still done alone, which is why the decision is
 * per-change-set rather than "always elevate": a Windows timezone change needs no
 * privileges and must raise no prompt, and on Linux `timedatectl` asking polkit is better
 * than a second, coarser prompt over it.
 *
 * The retry after a refusal stays as the safety net for whatever the rules above did not
 * predict. Both attempts happen inside one {@link withSystemTimeLock} section: releasing
 * it between them would let another client's save land in the gap, and the elevated
 * attempt would then be composed against state that no longer holds.
 */
export function applySystemTimeSettingsWithElevation(changes: SystemTimeChanges, elevate: (changes: SystemTimeChanges) => Promise<SystemTimeResult> = runElevatedSystemTime, apply: (changes: SystemTimeChanges) => Promise<SystemTimeResult> = applySystemTimeSettings, platform: NodeJS.Platform = process.platform, uid: () => number | undefined = () => process.getuid?.(), elevated: () => boolean = () => process.platform === 'win32' && windowsProcessElevated(), readZone: HostZoneReader = readHostTimezone): Promise<SystemTimeResult> {
	const elevateAndAdopt = async (): Promise<SystemTimeResult> => adoptTimezone(await elevate(changes), changes, platform, readZone);
	return withSystemTimeLock(async () => {
		if (requiresPrivilegesUpFront(platform, uid(), changes, elevated())) return elevateAndAdopt();
		const local = await apply(changes);
		if (!needsElevation(local)) return local;
		return elevateAndAdopt();
	});
}

/**
 * True when the privileged side never started, so the host is untouched.
 *
 * The helper reports a declined authorization and an untrusted binary with NEITHER change
 * flag, because in both cases nothing was run; every outcome that got as far as the host
 * carries one. That distinction is what keeps a CANCELLED prompt from being adopted: on
 * Windows the confirmation below can only check that the requested zone converts to the
 * identifier the host reports, and when two cities share one identifier - Prague and
 * Budapest do - that is true before the change as well as after it. So a user who picked
 * Budapest, was asked for administrator rights and said no would have had Budapest
 * recorded anyway, and every open window would have seen the switch move on its own.
 */
function nothingRan(outcome: SystemTimeResult): boolean {
	return outcome.outcome === 'permission-denied' && outcome.changed !== true && outcome.stateMayHaveChanged !== true;
}

/** Reads the zone the host is ACTUALLY in, given the zone that was asked for. */
export type HostZoneReader = (platform: NodeJS.Platform, requested: string) => string | null;

/**
 * The host's real timezone, read through something that works without privileges.
 *
 * - POSIX: `/etc/localtime`, a world-readable symlink into a zoneinfo tree, which follows
 *   the change immediately. On macOS it is the ONLY unprivileged source - `systemsetup`
 *   refuses its reads.
 * - Windows: the timezone API answers unprivileged, but only in Windows identifiers, and
 *   several IANA zones share one. So the requested zone is confirmed rather than derived:
 *   if it converts to the identifier the host now reports, the host is in it.
 */
export function readHostTimezone(platform: NodeJS.Platform, requested: string): string | null {
	if (platform === 'win32') {
		const current = readWindowsTimeZone()?.windowsId ?? null;
		return current !== null && ianaToWindowsTimezoneId(requested) === current ? requested : null;
	}
	return readMacLocaltimeZone();
}

/**
 * Carry an elevated timezone change back into THIS process - the zone the host ENDED UP
 * in, never the one that was asked for.
 *
 * Writing the OS timezone does not invalidate a running process's ICU cache, so
 * `setSystemTimezone` sets `process.env.TZ` after its own write. When the write happens in
 * the privileged helper instead, that assignment lands in a process that then exits, and
 * the backend keeps formatting in the old zone - which is not only a wrong display: the
 * next clock save sends the stale zone as `expectedTimezone`, and the helper refuses it as
 * composed against state that has changed.
 *
 * Two reasons this MEASURES instead of adopting `changes.timezone`:
 *
 * - A save can stop after the zone and before the clock, and then it is a FAILURE that
 *   nevertheless moved the zone. Adopting only on success left exactly that case stale.
 * - A save can also fail BEFORE the zone step, and then adopting the requested value would
 *   record a zone the host is not in.
 * - And a save that never ran at all - a declined prompt, an untrusted helper - must record
 *   nothing, which the measurement alone cannot establish on Windows (see `nothingRan`).
 *
 * On Windows it also repoints the Windows-to-IANA memory. That cache is keyed on the
 * Windows identifier, and `Europe/Prague` and `Europe/Budapest` share one: without this the
 * host really moved to Budapest while the screen kept offering Prague, which is what
 * `setSystemTimezone` calls `rememberWindowsZone` for on the direct path.
 */
function adoptTimezone(outcome: SystemTimeResult, changes: SystemTimeChanges, platform: NodeJS.Platform, readZone: HostZoneReader): SystemTimeResult {
	const requested = changes.timezone;
	if (requested === undefined || nothingRan(outcome)) return outcome;
	const actual = readZone(platform, requested);
	if (actual === null) return outcome;
	process.env['TZ'] = actual;
	if (platform === 'win32') {
		const windowsId = ianaToWindowsTimezoneId(actual);
		if (windowsId !== null) rememberWindowsZone(windowsId, actual);
	}
	return outcome;
}
