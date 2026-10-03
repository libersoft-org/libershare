import { requireNativeMutationContext } from './native/mutation-context.ts';
import type { NativeEndRule } from './native/mutation-proof.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isIP } from 'node:net';
import { SYSTEM_TIME_READ_TIMEOUT_MS, type SystemTimeOutcome, type SystemTimezoneSource, type SystemTimeResult, type SystemTimeStep, type SystemTimeCapabilities, type SystemTimeStatus } from '@shared';

/** Hard cap on how long a time-related READ may run before we give up. */
export const EXEC_TIMEOUT_MS = 5000;

/**
 * How long a WRITE may take, as opposed to a read.
 *
 * A privileged write can stop and wait for a person: `timedatectl` and `systemctl` ask
 * polkit, which on a desktop session puts an authentication dialog on screen and blocks
 * until it is answered. The five-second read budget killed that prompt while the user was
 * still reading it, and the kill arrives as a `timeout` - a generic error, so the
 * privileged-helper retry, which only follows a permission refusal, never happened
 * either. Ninety seconds is a human budget that still fits inside the screen's own
 * two-minute save limit.
 */
export const WRITE_TIMEOUT_MS = 90_000;

/**
 * How long one save's whole command sequence may take, across every command in it.
 *
 * The per-command limit alone bounded nothing useful: a save emits up to six commands, so
 * six times 90 seconds is nine minutes during which the screen had already given up at two
 * and told the user the save was interrupted - while the host went on being changed. This is
 * the sequence's own deadline, so what the backend promises is a total and not a per-step
 * figure, and each command gets whatever is left of it.
 *
 * Sized to nest inside `SYSTEM_TIME_SAVE_TIMEOUT_MS` together with the elevation wait, the
 * signature check and the read-back; the arithmetic is asserted by a test so it cannot drift.
 */
export const SEQUENCE_BUDGET_MS = 150_000;

/**
 * How long ONE save may take across every operation in it.
 *
 * A save is not one sequence: switching synchronisation off, writing the server, setting the
 * zone and setting the clock are four separate calls, and each one starting its own
 * {@link SEQUENCE_BUDGET_MS} bounded nothing about their total. Four times 150 s is ten
 * minutes, so the screen's wait was still the shortest limit in the chain even after each
 * sequence got a budget of its own.
 *
 * Sized so this plus the trust check and the read-back fit inside
 * `SYSTEM_TIME_SAVE_TIMEOUT_MS`; a test asserts that arithmetic.
 */
export const SAVE_BUDGET_MS = 200_000;

/**
 * The deadline of the save currently in flight, so every operation inside it shares one.
 *
 * Carried in async context rather than threaded through a dozen signatures, the same way the
 * write lock tracks re-entrance: the writers are exported and used directly as well, and a
 * caller that never heard of budgets still gets a bounded one.
 */
const saveDeadline = new AsyncLocalStorage<{ deadline: number; now: () => number }>();

/**
 * Run `fn` under one deadline for the whole save. A nested call joins the outer one, so the
 * four operations of a combined save share a budget instead of each taking a fresh one.
 */
export function withSaveBudget<T>(fn: () => Promise<T>, now: () => number = elapsedClock, budgetMs: number = SAVE_BUDGET_MS): Promise<T> {
	const existing = saveDeadline.getStore();
	if (existing !== undefined) return fn();
	// The clock travels with the deadline. Every operation inside reads the budget without
	// being handed one, so the two have to arrive together or an injected clock would set the
	// deadline and then be ignored by every reader of it.
	return saveDeadline.run({ deadline: now() + budgetMs, now }, fn);
}

/**
 * How long ONE read of the host's time state may take, across every child process in it.
 *
 * Derived from the wait the screen gives that read, less the room the answer needs to travel
 * back: a read that spends the whole wait is a read whose answer arrives too late to be of
 * use. The individual limits stay where they are - what was missing is a ceiling on their
 * total, because seven commands of 5 s each are 35 s against a 30 s wait even though not one
 * of them is late.
 *
 * Nothing is aborted mid-flight: {@link childLimit} shortens each child to the remainder and
 * refuses to start one that has nothing left, so a slow host answers with the fields it
 * managed to read instead of the screen answering with an error.
 */
export const READ_BUDGET_MS: number = SYSTEM_TIME_READ_TIMEOUT_MS - 5_000;

/**
 * Run one host read under {@link READ_BUDGET_MS}, or inside whatever budget already applies.
 *
 * JOINS an existing one on purpose - a read taken in the middle of a save belongs to that
 * save's time, not to a fresh allowance of its own. Only a read nobody else is timing gets
 * this budget.
 */
export function withReadBudget<T>(fn: () => Promise<T>, now: () => number = elapsedClock): Promise<T> {
	return withSaveBudget(fn, now, READ_BUDGET_MS);
}

/**
 * How long the steps AFTER a save's own work may take, counted fresh even when that work is
 * over time.
 *
 * Two of them, and neither is the work the save's budget bounds:
 *
 * - the ROLLBACK, which is what happens when the work fails. Putting the original file back is
 *   only half of it; the daemon has to be put back onto that file for the restore to mean
 *   anything. Inheriting the exhausted budget gave the second half zero time, so `runOperations`
 *   refused the restart before starting it and a host was left with the original configuration
 *   on disk and the service stopped - reported, but never even attempted.
 * - the READ-BACK that tells every open window what the host looks like now. Once child limits
 *   are held to what the save has left, a save that spent all of it would have its own
 *   report refused - so the user would be left looking at a state the host no longer has,
 *   which is the failure the read-back exists to prevent.
 *
 * Small on purpose. It is added to {@link SAVE_BUDGET_MS} in the worst case, and the total
 * still has to leave the screen's wait room for the trust check; a test asserts that
 * arithmetic. A `systemctl restart` that needs longer than this is not going to be rescued by
 * waiting, and the caveat the caller returns says exactly that.
 */
export const FOLLOW_UP_BUDGET_MS = 30_000;

/**
 * Run a follow-up step under {@link FOLLOW_UP_BUDGET_MS}, REPLACING the surrounding save's
 * deadline.
 *
 * Unlike {@link withSaveBudget} this does not join an existing budget - joining is the bug it
 * exists to fix. The lock is deliberately still held around it, so the next save waits for the
 * follow-up to finish rather than racing it; only the deadline is renewed, never the exclusion.
 *
 * The outer store's clock is kept when there is one: the deadline and the clock that reads it
 * have to be the same, or an injected clock would set this budget and then be ignored.
 */
export function withFollowUpBudget<T>(fn: () => Promise<T>, now: () => number = elapsedClock): Promise<T> {
	const existing = saveDeadline.getStore();
	const clock = existing?.now ?? now;
	return saveDeadline.run({ deadline: clock() + FOLLOW_UP_BUDGET_MS, now: clock }, fn);
}

/** What is left of the current save's budget, or null when nothing set one. */
export function remainingSaveBudget(): number | null {
	const store = saveDeadline.getStore();
	return store === undefined ? null : store.deadline - store.now();
}

/**
 * `date +%z` as minutes east of UTC, or null for anything unexpected.
 *
 * No answer means no claim: the status then leaves the field out and falls back to its
 * documented fallback, because stating a made-up number as the host's is the failure this
 * exists to avoid.
 */
export function parseUtcOffsetMinutes(value: string | null): number | null {
	const match = /^([+-])(\d{2})(\d{2})$/.exec((value ?? '').trim());
	if (!match) return null;
	const minutes = Number(match[2]) * 60 + Number(match[3]);
	return match[1] === '-' ? -minutes : minutes;
}

export { windowsSystemLibraryPath } from './native/library.ts';

/** Platforms with an implemented time backend. Anything else is reported as unsupported. */
export type SystemPlatform = 'win32' | 'linux' | 'darwin';

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

/** Native results distinguish a proven refusal from work that may still be running. */
export type OperationOutcome = { kind: 'ok'; output: string } | { kind: 'missing' } | { kind: 'timeout' } | { kind: 'denied'; output: string; stateMayHaveChanged?: boolean; changed?: boolean } | { kind: 'unknown'; output: string; endRule: NativeEndRule } | { kind: 'failed'; code: number | null; output: string; outcome?: SystemTimeOutcome; stateMayHaveChanged?: boolean; changed?: boolean };

export interface SystemOperation {
	readonly describe: string;
	run(signal: AbortSignal): Promise<OperationOutcome>;
}

/** A budget stops new operations; it never aborts a dispatched native mutation. */
export async function runOperations(platform: SystemPlatform, operations: readonly SystemOperation[], now: () => number = elapsedClock): Promise<SystemTimeResult> {
	if (!operations.length) return result('unsupported', 'no operation available for this platform');
	const steps: SystemTimeStep[] = [];
	const deadline = now() + Math.min(SEQUENCE_BUDGET_MS, remainingSaveBudget() ?? SEQUENCE_BUDGET_MS);
	const signal = new AbortController().signal;
	const stop = (operation: SystemOperation, outcome: SystemTimeOutcome, message: string, mayHaveChanged: boolean, partial = false): SystemTimeResult => {
		steps.push({ command: operation.describe, ok: false });
		const changed = partial || steps.some(step => step.ok);
		return { ...result(outcome, message), changed, stateMayHaveChanged: changed || mayHaveChanged, steps };
	};
	for (const operation of operations) {
		if (now() >= deadline) return stop(operation, 'error', 'the time configuration budget expired before the next operation', false);
		const value = await operation.run(signal);
		if (value.kind === 'unknown') return requireNativeMutationContext().pending(value.endRule);
		if (value.kind === 'ok') {
			steps.push({ command: operation.describe, ok: true });
			continue;
		}
		if (value.kind === 'missing') return stop(operation, 'unsupported', `${operation.describe} is unavailable`, false);
		if (value.kind === 'timeout') return stop(operation, 'error', `${operation.describe} did not start within its budget`, false);
		if (value.kind === 'denied') return stop(operation, 'permission-denied', value.output, value.stateMayHaveChanged === true, value.changed);
		const outcome = 'outcome' in value && value.outcome ? value.outcome : classifyFailure(platform, value.code, value.output);
		return stop(operation, outcome, firstLine(value.output) ?? `${operation.describe} failed`, 'stateMayHaveChanged' in value ? value.stateMayHaveChanged !== false : true, 'changed' in value && value.changed === true);
	}
	return result('ok');
}

/** Build a result object. `success` is derived so a non-`ok` outcome can never be reported as a success. */
export function result(outcome: SystemTimeOutcome, message: string | null = null): SystemTimeResult {
	return { success: outcome === 'ok', outcome, message };
}

/** Monotonic time keeps deadlines independent of clock corrections. */
export const elapsedClock = (): number => performance.now();

/** All capabilities off — the shape returned for a platform with no time backend. */
const NO_CAPABILITIES: SystemTimeCapabilities = { setClock: false, setTimezone: false, setNtpServer: false, setNtpEnabled: false };

/**
 * The half of the status that comes from the OS. `timezone` is the host's own setting,
 * null when it could not be read — the process's zone then stands in for it.
 */
export type PlatformStatus = Pick<SystemTimeStatus, 'ntpEnabled' | 'ntpSynchronized' | 'ntpServer' | 'capabilities' | 'clockHeldByUnmanagedDaemon'> & { timezone: string | null; utcOffsetMinutes?: number; timezoneOffsetMode?: 'zone' | 'fixed' };

/** Nothing could be read: every value unknown and every capability off. */
export const UNREADABLE_STATUS: PlatformStatus = { ntpEnabled: null, ntpSynchronized: null, ntpServer: null, timezone: null, capabilities: NO_CAPABILITIES };

/** Reads the OS half of the status. Injectable so the assembly around it can be tested on any host. */
export type PlatformStatusReader = (platform: SystemPlatform) => Promise<PlatformStatus>;
