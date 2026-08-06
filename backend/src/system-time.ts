import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
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
 */
export const TIMESYNCD_DROPIN_PATH = '/etc/systemd/timesyncd.conf.d/10-libershare.conf';

/** systemd unit that reads {@link TIMESYNCD_DROPIN_PATH}. */
export const TIMESYNCD_UNIT = 'systemd-timesyncd.service';

/** Registry key holding the Windows Time service configuration (NTP peers and sync type). */
const W32TIME_PARAMS_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\W32Time\\Parameters';

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
 * Hostname, IPv4 or IPv6 literal. Deliberately a strict allow-list of
 * alphanumerics, dot, hyphen and colon: it rejects whitespace and every shell
 * metacharacter, so the value stays harmless even though it is only ever passed
 * as a single argv element (defence in depth — see {@link buildSetNtpServerCommands}).
 */
const NTP_SERVER_RE = /^[A-Za-z0-9]([A-Za-z0-9.:-]{0,251}[A-Za-z0-9])?$/;

/** True when `server` is a plausible, safely quotable NTP host name or IP address. */
export function isValidNtpServer(server: string): boolean {
	return NTP_SERVER_RE.test(server);
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
 * True when `sc query <service>` reports the service as running. Matched on the
 * numeric state (`STATE : 4 RUNNING`) because the word next to it is localized.
 */
export function parseServiceRunning(output: string): boolean {
	return /STATE\s*:\s*4\b/.test(output);
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

/** Content of the systemd-timesyncd drop-in pinning `server` as the NTP source. */
export function buildTimesyncdDropIn(server: string): string {
	return `[Time]\nNTP=${server}\n`;
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
 */
export function buildSetNtpServerCommands(platform: SystemPlatform, server: string, syncRunning: boolean): SystemCommand[] {
	if (platform === 'linux') return syncRunning ? [{ cmd: 'systemctl', args: ['restart', 'systemd-timesyncd'] }] : [];
	if (platform === 'darwin') return [{ cmd: MAC_SYSTEMSETUP, args: ['-setnetworktimeserver', server] }];
	return [
		{ cmd: 'w32tm', args: ['/config', `/manualpeerlist:${server},0x9`, '/syncfromflags:manual', '/update'] },
		{ cmd: 'w32tm', args: ['/resync'] },
	];
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
 * would skip the steps that carry the actual change — the registry sync type on the
 * way on, the start mode on the way off — and the toggle would report a failure while
 * leaving the host half-configured. A real refusal still surfaces: the following
 * steps hit the same permission and fail with it.
 */
export function buildSetNtpEnabledCommands(platform: SystemPlatform, enabled: boolean): SystemCommand[] {
	if (platform === 'linux') return [{ cmd: 'timedatectl', args: ['set-ntp', enabled ? 'true' : 'false'] }];
	if (platform === 'darwin') return [{ cmd: MAC_SYSTEMSETUP, args: ['-setusingnetworktime', enabled ? 'on' : 'off'] }];
	if (enabled) {
		return [
			{ cmd: 'sc', args: ['config', 'w32time', 'start=', 'auto'] },
			{ cmd: 'sc', args: ['start', 'w32time'], benignCodes: [SC_ALREADY_RUNNING] },
			// Clears a registry Type of NoSync, which the service state alone does not
			// touch. Without it, a host left on NoSync (domain policy, or set outside
			// this app) reports synchronisation as still off right after we turned it
			// on, and the toggle looks like it did not stick.
			{ cmd: 'w32tm', args: ['/config', '/syncfromflags:manual', '/update'] },
			{ cmd: 'w32tm', args: ['/resync'] },
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

/** The timezone the process currently resolves to, as an IANA identifier. */
function currentTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
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
		if (r.kind === 'ok') continue;
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

/** Read the Linux (systemd-timedated) part of the status. */
async function readLinuxStatus(): Promise<Pick<SystemTimeStatus, 'ntpEnabled' | 'ntpSynchronized' | 'ntpServer' | 'capabilities'>> {
	const show = await tryRead('timedatectl', ['show']);
	if (show === null) {
		// ponytail: no systemd-timedated means no supported backend here. The
		// `date -s` / `/etc/localtime` symlink fallback is deliberately not
		// implemented — the hosts that lack timedatectl are containers, which have
		// no CAP_SYS_TIME and cannot set the clock at all. Add it if a non-systemd
		// bare-metal target ever appears.
		return { ntpEnabled: false, ntpSynchronized: null, ntpServer: null, capabilities: NO_CAPABILITIES };
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
	return {
		ntpEnabled: parseYesNo(map['NTP']) ?? false,
		ntpSynchronized: parseYesNo(map['NTPSynchronized']),
		ntpServer: timesync === null ? null : parseTimesyncServer(timesync),
		capabilities: { setClock: true, setTimezone: true, setNtpEnabled: canNtp, setNtpServer: timesync !== null || (unit !== null && parseUnitInstalled(unit, TIMESYNCD_UNIT)) },
	};
}

/** Read the Windows (W32Time) part of the status. */
async function readWindowsStatus(): Promise<Pick<SystemTimeStatus, 'ntpEnabled' | 'ntpSynchronized' | 'ntpServer' | 'capabilities'>> {
	// The registry and `sc query` are readable unelevated; `w32tm /query /configuration`
	// is not, which is why the peer list is taken from the registry instead.
	const params = await tryRead('reg', ['query', W32TIME_PARAMS_KEY, '/v', 'NtpServer']);
	const type = await tryRead('reg', ['query', W32TIME_PARAMS_KEY, '/v', 'Type']);
	const service = await tryRead('sc', ['query', 'w32time']);
	const status = await tryRead('w32tm', ['/query', '/status']);
	const syncType = type === null ? null : parseRegValue(type, 'Type');
	const running = service !== null && parseServiceRunning(service);
	return {
		ntpEnabled: running && syncType !== null && syncType !== 'NoSync',
		ntpSynchronized: status === null ? null : parseWindowsSyncStatus(status),
		ntpServer: parseWindowsNtpServer(params === null ? null : parseRegValue(params, 'NtpServer')),
		capabilities: { setClock: true, setTimezone: canConvertTimezoneId(), setNtpServer: true, setNtpEnabled: true },
	};
}

/** Read the macOS (`systemsetup`) part of the status. Every subcommand, reads included, needs root. */
async function readMacStatus(): Promise<Pick<SystemTimeStatus, 'ntpEnabled' | 'ntpSynchronized' | 'ntpServer' | 'capabilities'>> {
	const server = await tryRead(MAC_SYSTEMSETUP, ['-getnetworktimeserver']);
	const using = await tryRead(MAC_SYSTEMSETUP, ['-getusingnetworktime']);
	// An unreadable systemsetup is an unprivileged process, not a missing facility:
	// the capabilities stay true so the UI keeps offering the controls and the write
	// reports the permission problem.
	return {
		ntpEnabled: using === null ? false : (parseSystemsetupOnOff(using) ?? false),
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
	const base = {
		nowMs: Date.now(),
		timezone: currentTimezone(),
		// getTimezoneOffset() counts the other way (minutes to add to LOCAL to get UTC).
		utcOffsetMinutes: -new Date().getTimezoneOffset(),
		timezoneSource: getTimezoneSource(),
	};
	if (!isSupportedPlatform(platform)) return { ...base, supported: false, ntpEnabled: false, ntpSynchronized: null, ntpServer: null, capabilities: NO_CAPABILITIES };
	try {
		const specific = platform === 'linux' ? await readLinuxStatus() : platform === 'win32' ? await readWindowsStatus() : await readMacStatus();
		return { ...base, supported: true, ...specific };
	} catch (err) {
		console.warn('[system-time] Failed to read time status:', (err as Error).message);
		return { ...base, supported: true, ntpEnabled: false, ntpSynchronized: null, ntpServer: null, capabilities: NO_CAPABILITIES };
	}
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
 */
export function clockWriteRefusal(status: SystemTimeStatus): SystemTimeResult | null {
	if (!status.capabilities.setClock) return result('unsupported', 'this host has no facility for setting the clock');
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
	// Pin the identifier the user picked, never one read back from the OS: the
	// Windows to IANA reverse mapping is lossy and would report a different zone.
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
	if (!status.capabilities.setNtpServer) return result('unsupported', 'this host has no configurable time synchronisation service');
	if (platform === 'linux') {
		try {
			await mkdir(dirname(TIMESYNCD_DROPIN_PATH), { recursive: true });
			await writeFile(TIMESYNCD_DROPIN_PATH, buildTimesyncdDropIn(server), 'utf8');
		} catch (err) {
			const e = err as { code?: string; message?: string };
			if (e.code === 'EACCES' || e.code === 'EPERM') return result('permission-denied', `cannot write ${TIMESYNCD_DROPIN_PATH}`);
			return result('error', e.message ?? `cannot write ${TIMESYNCD_DROPIN_PATH}`);
		}
	}
	const commands = buildSetNtpServerCommands(platform, server, status.ntpEnabled);
	// Linux with synchronisation switched off has no command to run — writing the
	// drop-in above IS the whole operation, and runAll would read the empty list as
	// "unsupported on this platform".
	if (commands.length === 0) return result('ok');
	return runAll(platform, commands);
}

/**
 * Switch automatic time synchronisation on or off.
 *
 * A step can fail benignly — starting an already-running Windows Time service exits
 * non-zero — so a plain error is re-checked against the live state before being
 * reported. A permission or support problem is never re-checked away: those are the
 * answers the operator needs.
 */
export async function setSystemNtpEnabled(enabled: boolean): Promise<SystemTimeResult> {
	const platform = process.platform;
	if (!isSupportedPlatform(platform)) return result('unsupported', `time synchronisation cannot be switched on ${platform}`);
	const status = await getSystemTimeStatus();
	if (!status.capabilities.setNtpEnabled) return result('unsupported', 'this host has no time synchronisation service');
	const r = await runAll(platform, buildSetNtpEnabledCommands(platform, enabled));
	if (r.success || r.outcome !== 'error') return r;
	const after = await getSystemTimeStatus();
	return after.ntpEnabled === enabled ? result('ok') : r;
}
