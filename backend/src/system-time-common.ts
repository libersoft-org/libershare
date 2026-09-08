import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { win32, isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { type SystemTimeOutcome, type SystemTimezoneSource, type SystemTimeResult, type SystemTimeStep, type SystemTimeCapabilities, type SystemTimeStatus } from '@shared';

const execFileAsync = promisify(execFile);

/** Hard cap on how long any time-related child process may run before we give up. */
const EXEC_TIMEOUT_MS = 5000;

const LINUX_EXECUTABLES: Readonly<Record<string, string>> = {
	timedatectl: '/usr/bin/timedatectl',
	systemctl: '/usr/bin/systemctl',
	'systemd-analyze': '/usr/bin/systemd-analyze',
};

/** Resolve a privileged helper without consulting PATH. Unknown relative names fail closed. */
export function resolveSystemExecutable(platform: string, command: string, systemRoot: string | undefined = process.env['SystemRoot']): string | null {
	if (platform === 'win32') {
		if (win32.isAbsolute(command)) return command;
		const root = systemRoot && win32.isAbsolute(systemRoot) ? systemRoot : 'C:\\Windows';
		const system32 = win32.join(root, 'System32');
		const executables: Readonly<Record<string, string>> = {
			powershell: win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
			tzutil: win32.join(system32, 'tzutil.exe'),
			w32tm: win32.join(system32, 'w32tm.exe'),
			sc: win32.join(system32, 'sc.exe'),
			reg: win32.join(system32, 'reg.exe'),
		};
		return executables[command] ?? null;
	}
	if (isAbsolute(command)) return command;
	return platform === 'linux' ? (LINUX_EXECUTABLES[command] ?? null) : null;
}

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
 * True for an IP literal that is syntactically fine and still cannot be an NTP peer: the
 * unspecified address in either family, and the IPv4 limited broadcast.
 *
 * `net.isIP()` accepts all of them, so without this `0.0.0.0` and `::` were saved as the
 * host's time source. Nothing ever answers there — the daemon simply stops synchronising,
 * with the UI showing a configured server and no error anywhere. IPv6 is matched on the
 * digits rather than on the literal `::`, because the same address also spells as
 * `0:0:0:0:0:0:0:0` and `0000:...`.
 */
function isUnusableNtpAddress(address: string): boolean {
	// The scope index comes off before anything is matched. Whether a scoped address even
	// reaches here as one string is a RUNTIME difference: Bun's `net.isIP()` answers 6 for
	// `::%eth0`, Node's answers 0 and sends it down the zone-index branch instead. On Bun
	// the digits-only match below therefore saw `::%eth0`, did not match it, and the
	// unspecified address was accepted as a peer with an interface pinned to it.
	const percent = address.indexOf('%');
	const bare = percent >= 0 ? address.slice(0, percent) : address;
	if (isIP(bare) === 4) return bare === '0.0.0.0' || bare === '255.255.255.255';
	return /^[0:]+$/.test(bare);
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
	if (isIP(server) !== 0) return !isUnusableNtpAddress(server);
	// Zone index: only ever valid on an IPv6 literal, so `%` cannot reach a host name
	// or a drop-in line through this branch.
	const percent = server.indexOf('%');
	if (percent >= 0) {
		const base = server.slice(0, percent);
		const zone = server.slice(percent + 1);
		// The same usability test as above, on the ADDRESS rather than on the whole string.
		// `net.isIP()` rejects a scope suffix, so `::%eth0` never reached the check that
		// `::` fails and was saved as the host's time source with an interface pinned to it.
		return isIP(base) === 6 && !isUnusableNtpAddress(base) && zone.length > 0 && /^[A-Za-z0-9._-]+$/.test(zone);
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
export function pad2(value: number): string {
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
		// PowerShell's native code survives runtimes that truncate process exit codes to 8 bits.
		if (/^LISH_TIME_WIN32_ERROR=(?:5|1314)\r?$/m.test(output)) return 'permission-denied';
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
		const zones = intlValues.supportedValuesOf?.('timeZone') ?? [];
		// Canonical timezone lists can omit UTC even while the runtime accepts it.
		if (zones.length > 0 && !zones.includes('UTC') && timezoneOffsetMinutes('UTC') !== null) return [...zones, 'UTC'].sort();
		return zones;
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
export function processTimezone(): string {
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
export async function run(cmd: string, args: string[]): Promise<RunOutcome> {
	try {
		const executable = resolveSystemExecutable(process.platform, cmd);
		if (!executable) return { kind: 'missing' };
		// System tools must use the host timezone, not a process-local formatting override.
		const environment = { ...process.env, LC_ALL: 'C' };
		delete environment['TZ'];
		// SIGKILL: the promise settles only after the child actually exits, so a
		// wedged helper ignoring the default SIGTERM would hang the caller forever.
		const { stdout } = await execFileAsync(executable, args, { timeout: EXEC_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, env: environment });
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
export async function tryRead(cmd: string, args: string[]): Promise<string | null> {
	const r = await run(cmd, args);
	return r.kind === 'ok' ? r.output : null;
}

/** Build a result object. `success` is derived so a non-`ok` outcome can never be reported as a success. */
export function result(outcome: SystemTimeOutcome, message: string | null = null): SystemTimeResult {
	return { success: outcome === 'ok', outcome, message };
}

/** Runs a single command and reports how it went. */
export type CommandRunner = (cmd: string, args: string[]) => Promise<RunOutcome>;

/**
 * Run commands in order, stopping at the first one that does not succeed. Returns
 * `ok` only when every command exited 0 or failed with one of its own
 * {@link SystemCommand.benignCodes}.
 *
 * A failure carries what already happened. Stopping at the first bad step does not undo
 * the steps before it — `sc config w32time start= auto` succeeding and `sc start` failing
 * leaves the start mode changed, and `sc stop` succeeding before `sc config ... disabled`
 * fails leaves the service down — so the result reports `changed`, `stateMayHaveChanged`
 * and the per-step outcomes instead of a bare "it failed". A successful result implies
 * all of it and carries none of the extra fields.
 *
 * `exec` is injectable so the sequencing and the outcome mapping can be exercised
 * without spawning anything.
 */
export async function runAll(platform: SystemPlatform, commands: SystemCommand[], exec: CommandRunner = run): Promise<SystemTimeResult> {
	if (commands.length === 0) return result('unsupported', 'no command available for this platform');
	const steps: SystemTimeStep[] = [];
	/** A stopped sequence: the failing step is recorded, and everything before it already ran. */
	const stopped = (command: SystemCommand, outcome: SystemTimeOutcome, message: string, ran = true): SystemTimeResult => {
		steps.push({ command: [command.cmd, ...command.args].join(' '), ok: false });
		// `ran` is false only for a binary that does not exist, which cannot have touched
		// anything. Every other failure was a process that started and refused part-way —
		// as capable of leaving a change behind as one that exited 0.
		return { ...result(outcome, message), changed: steps.some(step => step.ok), stateMayHaveChanged: ran || steps.some(step => step.ok), steps };
	};
	for (const command of commands) {
		const r = await exec(command.cmd, command.args);
		const done = (): void => void steps.push({ command: [command.cmd, ...command.args].join(' '), ok: true });
		if (r.kind === 'ok') {
			// Exit 0 is not the whole story for w32tm: it prints the HRESULT of a refusal
			// and returns zero anyway, so the output has to be read before believing it.
			if (!command.failOnOutput?.test(r.output)) {
				done();
				continue;
			}
			return stopped(command, classifyFailure(platform, 0, r.output), firstLine(r.output) ?? `${command.cmd} reported a failure`);
		}
		if (r.kind === 'failed' && r.code !== null && command.benignCodes?.includes(r.code)) {
			done();
			continue;
		}
		if (r.kind === 'missing') return stopped(command, 'unsupported', `${command.cmd} is not installed`, false);
		if (r.kind === 'timeout') return stopped(command, 'error', `${command.cmd} timed out`);
		return stopped(command, classifyFailure(platform, r.code, r.output), firstLine(r.output) ?? `${command.cmd} exited with ${r.code}`);
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
export type PlatformStatus = Pick<SystemTimeStatus, 'ntpEnabled' | 'ntpSynchronized' | 'ntpServer' | 'capabilities'> & { timezone: string | null; utcOffsetMinutes?: number; timezoneOffsetMode?: 'zone' | 'fixed' };

/** Nothing could be read: every value unknown and every capability off. */
export const UNREADABLE_STATUS: PlatformStatus = { ntpEnabled: null, ntpSynchronized: null, ntpServer: null, timezone: null, capabilities: NO_CAPABILITIES };

/** Reads the OS half of the status. Injectable so the assembly around it can be tested on any host. */
export type PlatformStatusReader = (platform: SystemPlatform) => Promise<PlatformStatus>;
