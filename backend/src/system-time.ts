import { execFile } from 'node:child_process';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { canConvertTimezoneId, ianaToWindowsTimezoneId } from './system-time-windows.ts';
import type { SystemTimeCapabilities, SystemTimeOutcome, SystemTimeResult, SystemTimeStatus, SystemTimezoneSource } from '@shared';

const execFileAsync = promisify(execFile);

/** Hard cap on how long any time-related child process may run before we give up. */
const EXEC_TIMEOUT_MS = 5000;

/** `systemsetup` is not on a default non-root PATH on macOS, so it is always addressed absolutely. */
const MAC_SYSTEMSETUP = '/usr/sbin/systemsetup';

/**
 * Drop-in that carries our NTP server on systemd hosts. A drop-in is used instead of
 * editing the shipped `timesyncd.conf` so a distribution package upgrade never fights
 * our value and removing the feature is a single file deletion.
 *
 * The `90-` prefix is not cosmetic: drop-ins are applied in lexicographic order and a
 * later file re-overrides the same key, so a distribution's `50-*.conf` would silently
 * beat a `10-` prefix while the API still reported success. systemd reserves 60-90 for
 * local administrative overrides in `/etc`, which is exactly what this is.
 */
export const TIMESYNCD_DROPIN_PATH = '/etc/systemd/timesyncd.conf.d/90-libershare.conf';

/** systemd unit that reads {@link TIMESYNCD_DROPIN_PATH}. */
export const TIMESYNCD_UNIT = 'systemd-timesyncd.service';

/** Registry key holding the Windows Time service configuration (NTP peers and sync type). */
const W32TIME_PARAMS_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\W32Time\\Parameters';

/** The service key itself, whose `Start` value is the start type (`sc qc` localizes its output). */
const W32TIME_SERVICE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\W32Time';

/**
 * Group policy's own W32Time configuration. When this key exists at all, an
 * administrator's policy owns the settings and the values under
 * {@link W32TIME_PARAMS_KEY} need not be the ones in effect.
 */
const W32TIME_POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\W32Time\\Parameters';

/** Platforms with an implemented time backend. Anything else is reported as unsupported. */
export type SystemPlatform = 'win32' | 'linux' | 'darwin';

/** A single child process to run: an argv array, never a shell string. */
export interface SystemCommand {
	cmd: string;
	args: string[];
	/**
	 * Exit codes that mean "this step had nothing left to do" — the desired state was
	 * already in place. They are treated as success so the steps behind them still run,
	 * which a plain abort would skip (see {@link buildSetNtpEnabledCommands}).
	 */
	benignCodes?: number[];
	/**
	 * Output that means the step failed even though it exited 0. `w32tm` routinely
	 * refuses a request, prints the reason and still returns a zero exit code, so an
	 * exit status alone would report a refused `/resync` or `/config` as saved.
	 */
	failOnOutput?: RegExp;
}

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
function w32tm(...args: string[]): SystemCommand {
	return { cmd: 'w32tm', args, failOnOutput: W32TM_ERROR_RE };
}

/** ERROR_SERVICE_ALREADY_RUNNING — `sc start` against a service that is already up. */
const SC_ALREADY_RUNNING = 1056;

/** ERROR_SERVICE_NOT_ACTIVE — `sc stop` against a service that is already down. */
const SC_NOT_ACTIVE = 1062;

/** Local wall-clock date and time broken into parts. `month` is 1-12. */
export interface LocalDateTime {
	year: number;
	month: number;
	day: number;
	hours: number;
	minutes: number;
	seconds: number;
}

/** True when the given `process.platform` value has an implemented time backend. */
export function isSupportedPlatform(platform: string): platform is SystemPlatform {
	return platform === 'win32' || platform === 'linux' || platform === 'darwin';
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

/**
 * Characters an NTP address may consist of at all. Checked before anything else so
 * whitespace, newlines and every shell metacharacter are gone regardless of which
 * branch below accepts the value — the address is passed as a single argv element,
 * but it is also written verbatim into a systemd drop-in, where a newline would
 * inject a configuration directive (see {@link buildTimesyncdDropIn}).
 */
const NTP_SERVER_CHARSET_RE = /^[A-Za-z0-9._:%-]+$/;

/** One DNS label: 1-63 alphanumerics and hyphens, never starting or ending with a hyphen. */
const DNS_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * True when `name` is a syntactically valid DNS name: at most 253 characters, each
 * label at most 63. A single trailing dot (the explicit root, `ntp.example.org.`) is
 * accepted and ignored.
 *
 * An all-digit last label is rejected: such a name can only have been meant as an IPv4
 * address, and `1.2.3.999` reaching the resolver as a host name produces a late and
 * confusing failure instead of the input error it is.
 */
function isValidDnsName(name: string): boolean {
	const bare = name.endsWith('.') ? name.slice(0, -1) : name;
	if (bare.length === 0 || bare.length > 253) return false;
	const labels = bare.split('.');
	if (!labels.every(label => DNS_LABEL_RE.test(label))) return false;
	return !/^\d+$/.test(labels[labels.length - 1]!);
}

/**
 * True when `server` is a usable NTP host name or IP address.
 *
 * IP literals are checked with `net.isIP()` rather than a character class, so
 * `192.0.2.999` and `2001:db8:::1` are rejected where a "digits, dots and colons"
 * pattern would let them through and fail much later, inside the OS tooling. A
 * link-local IPv6 address may carry a zone index (`fe80::1%eth0`).
 */
export function isValidNtpServer(server: string): boolean {
	if (!NTP_SERVER_CHARSET_RE.test(server)) return false;
	if (isIP(server) !== 0) return true;
	// Zone index: only ever valid on an IPv6 literal, so `%` cannot reach a host name
	// or a drop-in line through this branch.
	const percent = server.indexOf('%');
	if (percent >= 0) {
		const zone = server.slice(percent + 1);
		return isIP(server.slice(0, percent)) === 6 && zone.length > 0 && /^[A-Za-z0-9._-]+$/.test(zone);
	}
	return isValidDnsName(server);
}

/**
 * Check a requested wall-clock time. Returns null when the value is usable, or a
 * human-readable reason why it is not.
 */
export function validateClockParts(hours: number, minutes: number, seconds: number): string | null {
	const check = (label: string, value: number, max: number): string | null => {
		if (!Number.isInteger(value)) return `${label} must be an integer`;
		if (value < 0 || value > max) return `${label} must be between 0 and ${max}`;
		return null;
	};
	return check('hours', hours, 23) ?? check('minutes', minutes, 59) ?? check('seconds', seconds, 59);
}

/** Zero-pad to two digits — the width every platform's date/time argument expects. */
function pad2(value: number): string {
	return String(value).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Output parsers (pure)
// ---------------------------------------------------------------------------

/**
 * Parse the bare `key=value` lines of `timedatectl show` / `show-timesync` into a
 * map. There are no sections and no quoting; a line without `=` is ignored.
 */
export function parseTimedatectlShow(output: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of output.split('\n')) {
		const eq = line.indexOf('=');
		if (eq <= 0) continue;
		result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return result;
}

/** systemd prints booleans as the literals `yes`/`no`; anything else is unknown. */
export function parseYesNo(value: string | undefined): boolean | null {
	if (value === 'yes') return true;
	if (value === 'no') return false;
	return null;
}

/**
 * Pick the NTP server to display from `timedatectl show-timesync`. `ServerName` is
 * the peer actually in use and wins, because a DHCP-supplied `LinkNTPServers` entry
 * silently overrides the configured `SystemNTPServers` list — showing the configured
 * value alone would claim a server that is not being used. Only the first entry is
 * reported: the UI configures exactly one server.
 */
export function parseTimesyncServer(output: string): string | null {
	const map = parseTimedatectlShow(output);
	const first = (value: string | undefined): string | null => {
		const token = (value ?? '').trim().split(/\s+/)[0];
		return token ? token : null;
	};
	return first(map['ServerName']) ?? first(map['SystemNTPServers']) ?? first(map['LinkNTPServers']) ?? first(map['FallbackNTPServers']);
}

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
 */
export function windowsSyncIsOurs(mode: WindowsSyncMode): boolean {
	return mode === 'manual' || mode === 'all' || mode === 'none';
}

export function windowsSyncEnabled(mode: WindowsSyncMode, start: WindowsStartMode): boolean | null {
	if (start === 'disabled') return false;
	if (mode === 'none') return false;
	if (mode === 'unknown' || start === 'unknown') return null;
	return true;
}

/**
 * Read the sync result out of `w32tm /query /status`. The field names stay English
 * on a localized host, only the timestamp is localized — so the presence of a real
 * value is the signal, never its format. Returns null when the line is missing.
 */
export function parseWindowsSyncStatus(output: string): boolean | null {
	const match = output.match(/Last Successful Sync Time:\s*(.*)/);
	if (!match) return null;
	const value = (match[1] ?? '').trim();
	if (!value) return null;
	return !/unspecified/i.test(value);
}

/**
 * Pull the value out of a `systemsetup -get...` line (`Network Time Server: time.apple.com`).
 * Returns null when the tool printed an error instead of a `label: value` pair.
 */
export function parseSystemsetupValue(output: string): string | null {
	const line = output.trim().split('\n')[0];
	if (!line) return null;
	const colon = line.indexOf(':');
	if (colon < 0) return null;
	const value = line.slice(colon + 1).trim();
	return value ? value : null;
}

/** `systemsetup -getusingnetworktime` prints `Network Time: On|Off`. */
export function parseSystemsetupOnOff(output: string): boolean | null {
	const value = parseSystemsetupValue(output);
	if (value === null) return null;
	if (/^on$/i.test(value)) return true;
	if (/^off$/i.test(value)) return false;
	return null;
}

/**
 * Classify a failed command into an actionable outcome.
 *
 * Windows is matched on exit codes and HRESULTs, never on the message: the text is
 * localized (a Czech host prints "Přístup byl odepřen") and `w32tm` writes it to
 * stdout rather than stderr. Linux and macOS are matched on their English messages,
 * which is safe because every child runs with `LC_ALL=C` (see {@link run}).
 */
export function classifyFailure(platform: SystemPlatform, code: number | null, output: string): SystemTimeOutcome {
	const text = output.toLowerCase();
	// A clock write refused because the sync daemon owns the clock is a state
	// conflict, not a failure of ours — it has its own fix (turn sync off first).
	if (text.includes('automatic time synchronization is enabled')) return 'auto-sync-enabled';
	// Deliberately the full phrase, not a bare "not supported": Windows reports
	// ERROR_NOT_SUPPORTED (0x80070032) with that substring for plain failures, and
	// calling those "unsupported" would tell the user to stop trying on a host that
	// simply hit an error.
	if (text.includes('ntp not supported')) return 'unsupported';
	if (platform === 'win32') {
		// Codes only, never the message: it is localized and w32tm even writes it to
		// stdout. 5 = ERROR_ACCESS_DENIED (sc), 1314 = ERROR_PRIVILEGE_NOT_HELD, and
		// the HRESULT forms of both as returned by w32tm and Set-Date — those arrive
		// as signed int32, hence the negative literals.
		if (code === 5 || code === 1314 || code === -2147024891 || code === -2147023582) return 'permission-denied';
		// The HRESULT is also printed by w32tm, whose own exit code can be 1 or 0.
		if (text.includes('0x80070005') || text.includes('0x80070522')) return 'permission-denied';
		return 'error';
	}
	if (text.includes('interactive authentication required') || text.includes('access denied') || text.includes('permission denied') || text.includes('operation not permitted') || text.includes('must be run as root') || text.includes('administrator access')) return 'permission-denied';
	return 'error';
}

/** Collapse command output to a single line suitable for an error message. */
export function firstLine(output: string): string | null {
	const line = output
		.split('\n')
		.map(l => l.trim())
		.find(l => l.length > 0);
	return line ?? null;
}

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
 * Whether `systemctl list-unit-files <unit>` reports the unit as installed and usable.
 *
 * A masked unit is listed but can never start, so it is treated as absent — writing a
 * drop-in for it would silently do nothing. The header and the trailing "N unit files
 * listed." summary are skipped by requiring the line to begin with the unit name.
 */
export function parseUnitInstalled(output: string, unit: string): boolean {
	for (const line of output.split(/\r?\n/)) {
		if (!line.startsWith(unit)) continue;
		const state = line.slice(unit.length).trim().split(/\s+/)[0] ?? '';
		return state !== 'masked' && state !== 'masked-runtime' && state !== 'not-found';
	}
	return false;
}

/**
 * systemd units of the other NTP implementations systemd-timedated can hand the clock
 * to. `NTP=yes` only says that SOME managed service is synchronising; when one of these
 * is the one running, a timesyncd drop-in is read by nobody.
 */
export const COMPETING_NTP_UNITS: string[] = ['chronyd.service', 'chrony.service', 'ntpd.service', 'ntpsec.service', 'openntpd.service'];

/**
 * True when `systemctl show -p ActiveState --value <units...>` reports any of them as
 * running. A unit that does not exist on the host reports `inactive`, so an absent
 * chrony is indistinguishable from a stopped one — which is the correct answer here.
 */
export function parseAnyUnitActive(output: string): boolean {
	return output.split(/\r?\n/).some(line => {
		const state = line.trim();
		return state === 'active' || state === 'activating' || state === 'reloading';
	});
}

/**
 * Whether writing the timesyncd drop-in would actually change the host's time source.
 *
 * Two things must hold: timesyncd has to be usable here at all, and no other NTP daemon
 * may be the one in charge. Without the second check a host running chrony would get a
 * drop-in nothing reads, timesyncd restarted alongside chrony, and a success reported
 * for a server that never became effective.
 *
 * `timesyncReadable` comes from `timedatectl show-timesync`, which only answers while
 * the daemon runs — and the UI switches synchronisation off before writing a server, so
 * the unit catalogue (`unitOutput`) is what answers for a stopped daemon.
 */
export function canConfigureTimesyncdServer(timesyncReadable: boolean, unitOutput: string | null, competingOutput: string | null): boolean {
	if (competingOutput !== null && parseAnyUnitActive(competingOutput)) return false;
	return timesyncReadable || (unitOutput !== null && parseUnitInstalled(unitOutput, TIMESYNCD_UNIT));
}

/**
 * Content of the systemd-timesyncd drop-in pinning `server` as the NTP source.
 *
 * `NTP=` is a list setting: a drop-in is parsed after the shipped configuration, so a
 * bare assignment APPENDS to whatever the distribution already configured instead of
 * replacing it. The empty assignment first resets the list, which is what makes this
 * a pin rather than an addition.
 */
export function buildTimesyncdDropIn(server: string): string {
	return `[Time]\nNTP=\nNTP=${server}\n`;
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
 * Windows drops the resync for the same reason. `w32tm /resync` asks the Windows Time
 * service to contact its peer now, so with the service stopped it can only fail — and
 * the UI reaches this path exactly that way, by switching synchronisation off before
 * writing a server. The peer list is in the registry either way and is read when the
 * service next starts.
 */
export function buildSetNtpServerCommands(platform: SystemPlatform, server: string, syncRunning: boolean): SystemCommand[] {
	if (platform === 'linux') return syncRunning ? [{ cmd: 'systemctl', args: ['restart', 'systemd-timesyncd'] }] : [];
	if (platform === 'darwin') return [{ cmd: MAC_SYSTEMSETUP, args: ['-setnetworktimeserver', server] }];
	// 0x8 is the plain client flag. 0x9 would add 0x1 (SpecialInterval), which makes the
	// peer poll at SpecialPollInterval — a standalone host defaults that to 604800s, so
	// the peer would be contacted weekly instead of on the normal poll interval.
	const config: SystemCommand = w32tm('/config', `/manualpeerlist:${server},0x8`, '/syncfromflags:manual', '/update');
	return syncRunning ? [config, w32tm('/resync')] : [config];
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

// ---------------------------------------------------------------------------
// Timezone list
// ---------------------------------------------------------------------------

// Intl.supportedValuesOf is newer than the configured ES2020 lib, and it is absent
// in runtimes built without the full ICU timezone database.
const intlValues = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };

/**
 * IANA timezone identifiers the host will accept. Sourced from the runtime's ICU
 * database on every platform, including Windows: `tzutil /l` would return Windows
 * identifiers with localized display names in the OEM codepage, while ICU gives the
 * same IANA list everywhere and matches what Linux and macOS take natively.
 * Returns an empty array on a runtime without the timezone database.
 */
export function listSystemTimezones(): string[] {
	try {
		return intlValues.supportedValuesOf?.('timeZone') ?? [];
	} catch {
		return [];
	}
}

/** Where {@link listSystemTimezones} got its data — `unavailable` when the runtime has no timezone database. */
export function getTimezoneSource(): SystemTimezoneSource {
	return listSystemTimezones().length > 0 ? 'intl' : 'unavailable';
}

/**
 * The timezone this PROCESS resolves to. Only a fallback for a host that could not be
 * asked: it is fixed at startup, an inherited `TZ` overrides the real host setting, and
 * a zone changed outside this application never reaches it.
 */
function processTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Minutes to ADD to UTC to get local time in `zone` at the given instant — positive
 * east of Greenwich. Null when the runtime does not know the zone.
 *
 * Computed for the named zone rather than taken from `Date.getTimezoneOffset()`, which
 * answers for the PROCESS: once the host's zone is read from the OS the two can differ,
 * and pairing an OS zone with a process offset would put the displayed clock hours out.
 */
export function timezoneOffsetMinutes(zone: string, at: Date = new Date()): number | null {
	try {
		const parts: Record<string, string> = {};
		for (const part of new Intl.DateTimeFormat('en-US', { timeZone: zone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at)) parts[part.type] = part.value;
		// `hour12: false` renders midnight as 24 in some ICU versions.
		const local = Date.UTC(Number(parts['year']), Number(parts['month']) - 1, Number(parts['day']), Number(parts['hour']) % 24, Number(parts['minute']), Number(parts['second']));
		if (!Number.isFinite(local)) return null;
		// Both sides truncated to the second: the reconstruction carries no milliseconds.
		return Math.round((local - Math.floor(at.getTime() / 1000) * 1000) / 60000);
	} catch {
		return null;
	}
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

// ---------------------------------------------------------------------------
// Child process layer (impure)
// ---------------------------------------------------------------------------

/**
 * Outcome of running one command.
 * - `ok`: exit 0, with stdout.
 * - `missing`: the binary does not exist — a definitive "this facility is absent".
 * - `failed`: it ran and refused; `code` and `output` feed {@link classifyFailure}.
 * - `timeout`: the child was killed after {@link EXEC_TIMEOUT_MS}; the facility exists
 *   but is wedged, which is a transient error and never an absence.
 */
export type RunOutcome = { kind: 'ok'; output: string } | { kind: 'missing' } | { kind: 'failed'; code: number | null; output: string } | { kind: 'timeout' };

/**
 * Run a binary with an argv array — never a shell string, so no input can be
 * interpreted as a command. `LC_ALL=C` pins the child's messages to English, which
 * is what {@link classifyFailure} matches on for Linux and macOS.
 */
async function run(cmd: string, args: string[]): Promise<RunOutcome> {
	try {
		// SIGKILL: the promise settles only after the child actually exits, so a
		// wedged helper ignoring the default SIGTERM would hang the caller forever.
		const { stdout } = await execFileAsync(cmd, args, { timeout: EXEC_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, env: { ...process.env, LC_ALL: 'C' } });
		return { kind: 'ok', output: stdout.toString() };
	} catch (err) {
		const e = err as { code?: number | string; killed?: boolean; signal?: string | null; stdout?: string; stderr?: string; message?: string };
		if (e.killed || e.signal) return { kind: 'timeout' };
		if (e.code === 'ENOENT') return { kind: 'missing' };
		// w32tm prints its errors to stdout, timedatectl to stderr — read both.
		const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || (e.message ?? '');
		return { kind: 'failed', code: typeof e.code === 'number' ? e.code : null, output };
	}
}

/** Run a command and return its stdout, or null when it was missing or refused. Used for reads, where any failure just means "no value". */
async function tryRead(cmd: string, args: string[]): Promise<string | null> {
	const r = await run(cmd, args);
	return r.kind === 'ok' ? r.output : null;
}

/** Build a result object. `success` is derived so a non-`ok` outcome can never be reported as a success. */
function result(outcome: SystemTimeOutcome, message: string | null = null): SystemTimeResult {
	return { success: outcome === 'ok', outcome, message };
}

/** Runs a single command and reports how it went. */
export type CommandRunner = (cmd: string, args: string[]) => Promise<RunOutcome>;

/**
 * Run commands in order, stopping at the first one that does not succeed. Returns
 * `ok` only when every command exited 0 or failed with one of its own
 * {@link SystemCommand.benignCodes}.
 *
 * `exec` is injectable so the sequencing and the outcome mapping can be exercised
 * without spawning anything.
 */
export async function runAll(platform: SystemPlatform, commands: SystemCommand[], exec: CommandRunner = run): Promise<SystemTimeResult> {
	if (commands.length === 0) return result('unsupported', 'no command available for this platform');
	for (const command of commands) {
		const r = await exec(command.cmd, command.args);
		if (r.kind === 'ok') {
			// Exit 0 is not the whole story for w32tm: it prints the HRESULT of a refusal
			// and returns zero anyway, so the output has to be read before believing it.
			if (!command.failOnOutput?.test(r.output)) continue;
			return result(classifyFailure(platform, 0, r.output), firstLine(r.output) ?? `${command.cmd} reported a failure`);
		}
		if (r.kind === 'failed' && r.code !== null && command.benignCodes?.includes(r.code)) continue;
		if (r.kind === 'missing') return result('unsupported', `${command.cmd} is not installed`);
		if (r.kind === 'timeout') return result('error', `${command.cmd} timed out`);
		return result(classifyFailure(platform, r.code, r.output), firstLine(r.output) ?? `${command.cmd} exited with ${r.code}`);
	}
	return result('ok');
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** All capabilities off — the shape returned for a platform with no time backend. */
const NO_CAPABILITIES: SystemTimeCapabilities = { setClock: false, setTimezone: false, setNtpServer: false, setNtpEnabled: false };

/**
 * The half of the status that comes from the OS. `timezone` is the host's own setting,
 * null when it could not be read — the process's zone then stands in for it.
 */
type PlatformStatus = Pick<SystemTimeStatus, 'ntpEnabled' | 'ntpSynchronized' | 'ntpServer' | 'capabilities'> & { timezone: string | null };

/** Nothing could be read: every value unknown and every capability off. */
const UNREADABLE_STATUS: PlatformStatus = { ntpEnabled: null, ntpSynchronized: null, ntpServer: null, timezone: null, capabilities: NO_CAPABILITIES };

/** Read the Linux (systemd-timedated) part of the status. */
async function readLinuxStatus(): Promise<PlatformStatus> {
	const show = await tryRead('timedatectl', ['show']);
	if (show === null) {
		// ponytail: no systemd-timedated means no supported backend here. The
		// `date -s` / `/etc/localtime` symlink fallback is deliberately not
		// implemented — the hosts that lack timedatectl are containers, which have
		// no CAP_SYS_TIME and cannot set the clock at all. Add it if a non-systemd
		// bare-metal target ever appears.
		return UNREADABLE_STATUS;
	}
	const map = parseTimedatectlShow(show);
	const canNtp = parseYesNo(map['CanNTP']) ?? false;
	const timesync = canNtp ? await tryRead('timedatectl', ['show-timesync', '--all']) : null;
	// Only timesyncd's configuration file is written by us, so the capability is
	// "is timesyncd the sync service here" — a chrony host would ignore the drop-in.
	// `show-timesync` answers that, but ONLY while the daemon runs, and the UI turns
	// synchronisation off before writing a server. Asking the unit catalogue instead
	// answers the same question about a stopped daemon, which is exactly the state
	// the write happens in.
	const unit = canNtp ? await tryRead('systemctl', ['list-unit-files', TIMESYNCD_UNIT]) : null;
	// timedated manages several NTP implementations; a host where chrony is the active
	// one would ignore our drop-in entirely (see canConfigureTimesyncdServer).
	const competing = canNtp ? await tryRead('systemctl', ['show', '-p', 'ActiveState', '--value', ...COMPETING_NTP_UNITS]) : null;
	return {
		// `timedatectl show` was read above and already carries it — no extra probe.
		timezone: map['Timezone'] ?? null,
		ntpEnabled: parseYesNo(map['NTP']),
		ntpSynchronized: parseYesNo(map['NTPSynchronized']),
		ntpServer: timesync === null ? null : parseTimesyncServer(timesync),
		capabilities: { setClock: true, setTimezone: true, setNtpEnabled: canNtp, setNtpServer: canConfigureTimesyncdServer(timesync !== null, unit, competing) },
	};
}

/**
 * Read the Windows time source and service start type. Both the status read and the
 * enable/disable write need them — the write to decide whether it may rewrite the
 * source at all, which is not something it can infer from the requested value.
 */
async function readWindowsMode(): Promise<{ mode: WindowsSyncMode; start: WindowsStartMode }> {
	const type = await tryRead('reg', ['query', W32TIME_PARAMS_KEY, '/v', 'Type']);
	const start = await tryRead('reg', ['query', W32TIME_SERVICE_KEY, '/v', 'Start']);
	const policy = await tryRead('reg', ['query', W32TIME_POLICY_KEY]);
	return { mode: parseWindowsSyncMode(type === null ? null : parseRegValue(type, 'Type'), policy !== null), start: parseWindowsStartMode(start) };
}

/** Read the Windows (W32Time) part of the status. */
async function readWindowsStatus(): Promise<PlatformStatus> {
	// Everything here is read from the registry rather than from `sc query` / `w32tm
	// /query /configuration`: the first localizes its field NAMES as well as its values
	// (a German host prints `ZUSTAND`, not `STATE`), and the second needs elevation.
	// Registry value names are identifiers and are the same in every language.
	const params = await tryRead('reg', ['query', W32TIME_PARAMS_KEY, '/v', 'NtpServer']);
	const status = await tryRead('w32tm', ['/query', '/status']);
	// tzutil answers with a Windows identifier, which has to be mapped back to IANA.
	const zone = parseTzutilZone(await tryRead('tzutil', ['/g']));
	const { mode, start } = await readWindowsMode();
	// A time source an administrator owns is read-only here, so the UI disables the
	// controls instead of offering a change that would detach the host from its domain.
	const ours = windowsSyncIsOurs(mode);
	return {
		timezone: zone === null ? null : windowsToIanaTimezone(zone),
		ntpEnabled: windowsSyncEnabled(mode, start),
		ntpSynchronized: status === null ? null : parseWindowsSyncStatus(status),
		ntpServer: parseWindowsNtpServer(params === null ? null : parseRegValue(params, 'NtpServer')),
		capabilities: { setClock: true, setTimezone: canConvertTimezoneId(), setNtpServer: ours, setNtpEnabled: ours },
	};
}

/** Read the macOS (`systemsetup`) part of the status. Every subcommand, reads included, needs root. */
async function readMacStatus(): Promise<PlatformStatus> {
	const zone = await tryRead(MAC_SYSTEMSETUP, ['-gettimezone']);
	const server = await tryRead(MAC_SYSTEMSETUP, ['-getnetworktimeserver']);
	const using = await tryRead(MAC_SYSTEMSETUP, ['-getusingnetworktime']);
	// An unreadable systemsetup is an unprivileged process, not a missing facility:
	// the capabilities stay true so the UI keeps offering the controls and the write
	// reports the permission problem.
	return {
		timezone: zone === null ? null : parseSystemsetupValue(zone),
		ntpEnabled: using === null ? null : parseSystemsetupOnOff(using),
		// macOS exposes no "last sync succeeded" flag.
		ntpSynchronized: null,
		ntpServer: server === null ? null : parseSystemsetupValue(server),
		capabilities: { setClock: true, setTimezone: true, setNtpServer: true, setNtpEnabled: true },
	};
}

/**
 * Read the host's current time configuration. Never throws — an unreadable or
 * unsupported host yields a status with `supported: false` and no capabilities, so
 * a kiosk failure cannot crash the backend.
 *
 * The clock and the timezone always come from the process itself (`Date.now()` and
 * ICU); only the NTP state needs the OS tooling.
 */
export async function getSystemTimeStatus(): Promise<SystemTimeStatus> {
	const platform = process.platform;
	const nowMs = Date.now();
	const supported = isSupportedPlatform(platform);
	let specific: PlatformStatus = UNREADABLE_STATUS;
	if (supported) {
		try {
			specific = platform === 'linux' ? await readLinuxStatus() : platform === 'win32' ? await readWindowsStatus() : await readMacStatus();
		} catch (err) {
			console.warn('[system-time] Failed to read time status:', (err as Error).message);
		}
	}
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

/** Set the wall clock to `hours:minutes:seconds`, keeping today's date. */
export async function setSystemClock(hours: number, minutes: number, seconds: number): Promise<SystemTimeResult> {
	const invalid = validateClockParts(hours, minutes, seconds);
	if (invalid) return result('invalid-input', invalid);
	const platform = process.platform;
	if (!isSupportedPlatform(platform)) return result('unsupported', `setting the clock is not implemented on ${platform}`);
	const refusal = clockWriteRefusal(await getSystemTimeStatus());
	if (refusal) return refusal;
	const now = new Date();
	return runAll(platform, buildSetClockCommands(platform, { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hours, minutes, seconds }));
}

/**
 * Set the system timezone from an IANA identifier. The value must be one the host
 * listed ({@link listSystemTimezones}) — that membership check is also what keeps an
 * arbitrary string out of the Windows conversion command.
 *
 * On success `process.env.TZ` is updated: writing the OS timezone does not
 * invalidate the running process's ICU cache, so without this the backend would keep
 * formatting in the old zone until it restarts.
 */
export async function setSystemTimezone(timezone: string): Promise<SystemTimeResult> {
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

	const r = await runAll(platform, buildSetTimezoneCommands(platform, timezone, windowsId));
	// Only so this process FORMATS in the new zone: writing the OS timezone does not
	// invalidate a running process's ICU cache. What the status reports is read back
	// from the OS, so an inherited or stale TZ can no longer misrepresent the host.
	if (r.success) process.env['TZ'] = timezone;
	return r;
}

/**
 * Point the host's time synchronisation at `server`. A single server is configured;
 * that is all macOS supports through `systemsetup`, and it is what the UI offers.
 */
export async function setSystemNtpServer(server: string): Promise<SystemTimeResult> {
	if (!isValidNtpServer(server)) return result('invalid-input', 'the NTP server must be a host name or IP address without spaces or special characters');
	const platform = process.platform;
	if (!isSupportedPlatform(platform)) return result('unsupported', `configuring an NTP server is not implemented on ${platform}`);
	const status = await getSystemTimeStatus();
	if (!status.capabilities.setNtpServer) return result('unsupported', 'the NTP server can only be configured where this application owns the time synchronisation service');
	if (platform === 'linux') return applyTimesyncdDropIn(server, status.ntpEnabled === true);
	const commands = buildSetNtpServerCommands(platform, server, status.ntpEnabled === true);
	// A platform whose whole change is the file write above has no command to run, and
	// runAll would read the empty list as "unsupported on this platform".
	if (commands.length === 0) return result('ok');
	return runAll(platform, commands);
}

/**
 * Replace `path` with `content` so a reader never observes a partial file, and return
 * a rollback that restores whatever was there before (deleting the file when there was
 * nothing).
 *
 * A plain `writeFile` to the final path truncates it first, so a crash or a full disk
 * mid-write leaves the live configuration truncated. Writing a sibling temporary file,
 * flushing it and renaming makes the swap atomic — and the `fsync` is not optional: a
 * rename only guarantees the *name* change, so without it a power loss can leave the
 * new name pointing at an empty file.
 */
export async function writeFileAtomically(path: string, content: string): Promise<() => Promise<void>> {
	const previous = await readFile(path, 'utf8').catch(() => null);
	await mkdir(dirname(path), { recursive: true });
	// Same directory, or the rename would cross a filesystem boundary and stop being atomic.
	const temp = `${path}.libershare-${process.pid}.tmp`;
	try {
		const handle = await open(temp, 'w');
		try {
			await handle.writeFile(content, 'utf8');
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, path);
	} catch (err) {
		await unlink(temp).catch(() => {});
		throw err;
	}
	return async () => {
		if (previous === null) await unlink(path).catch(() => {});
		else await writeFileAtomically(path, previous).catch(() => {});
	};
}

/**
 * Pin `server` in the systemd-timesyncd drop-in and make the daemon read it.
 *
 * The file is written atomically and rolled back when the restart fails: leaving it
 * on disk after a failed save would apply the change at the next boot anyway, long
 * after the user was told nothing had happened. The daemon is restarted a second time
 * on that path so it also goes back to the configuration it was running with.
 *
 * `path` and `exec` are injectable so the rollback can be exercised without a systemd
 * host.
 */
export async function applyTimesyncdDropIn(server: string, syncRunning: boolean, path: string = TIMESYNCD_DROPIN_PATH, exec: CommandRunner = run): Promise<SystemTimeResult> {
	let rollback: () => Promise<void>;
	try {
		rollback = await writeFileAtomically(path, buildTimesyncdDropIn(server));
	} catch (err) {
		const e = err as { code?: string; message?: string };
		if (e.code === 'EACCES' || e.code === 'EPERM') return result('permission-denied', `cannot write ${path}`);
		return result('error', e.message ?? `cannot write ${path}`);
	}
	const commands = buildSetNtpServerCommands('linux', server, syncRunning);
	// Synchronisation is off, so there is deliberately no restart — the drop-in on disk
	// IS the whole change and is read when the daemon next starts. Nothing to roll back.
	if (commands.length === 0) return result('ok');
	const r = await runAll('linux', commands, exec);
	if (!r.success) {
		await rollback();
		await runAll('linux', commands, exec);
	}
	return r;
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
export async function setSystemNtpEnabled(enabled: boolean, readStatus: () => Promise<SystemTimeStatus> = getSystemTimeStatus, exec: CommandRunner = run): Promise<SystemTimeResult> {
	const platform = process.platform;
	if (!isSupportedPlatform(platform)) return result('unsupported', `time synchronisation cannot be switched on ${platform}`);
	const status = await readStatus();
	if (!status.capabilities.setNtpEnabled) return result('unsupported', 'time synchronisation here is not ours to switch: this host has no such service, or its time source is managed by a domain or by group policy');
	// Windows needs its CURRENT time source to decide whether it may be rewritten; every
	// other platform has a single switch that changes nothing else.
	const mode = platform === 'win32' ? (await readWindowsMode()).mode : 'unknown';
	return runAll(platform, buildSetNtpEnabledCommands(platform, enabled, mode), exec);
}
