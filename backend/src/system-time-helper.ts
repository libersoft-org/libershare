import { SYSTEM_TIME_OUTCOMES, type SystemTimeChanges, type SystemTimeOutcome, type SystemTimeResult } from '@shared';

/**
 * The privileged side of the system-time writes.
 *
 * Every write here needs rights an ordinary desktop process does not have, and the
 * measured refusals are platform facts rather than bugs: a standard Windows user does
 * not hold `SeSystemtimePrivilege` and cannot open W32Time through the SCM (error 5),
 * and `systemsetup` on macOS refuses every operation to a non-root caller. Only the
 * timezone is different - Windows grants `SeTimeZonePrivilege` to `Users`, so
 * `tzutil /s` works unprivileged and keeps working without any of this.
 *
 * Rather than a second privileged binary, this reuses the one the network settings
 * already ship, elevate and pin: `lish-network-helper`, reached through the UAC
 * launcher on Windows, `osascript` on macOS and `pkexec` on Linux, with its hash
 * baked into the backend at build time and its signature checked before every run.
 * A separate helper would need its own signing, packaging and integrity pinning to
 * arrive at exactly this.
 */

/** Keys {@link SystemTimeChanges} may carry. Anything else is refused at the privilege boundary. */
const CHANGE_KEYS = ['clock', 'expectedOffsetMinutes', 'expectedTimezone', 'ntpEnabled', 'ntpServer', 'timezone'];
const CLOCK_KEYS = ['hours', 'minutes', 'seconds'];
const MAX_VALUE_LENGTH = 64;
/**
 * An NTP address gets its own bound, and it is the one {@link isValidNtpServer} enforces:
 * a DNS name may be 253 characters.
 *
 * 64 was wrong here. `ntp.` + 63 `a`s + `.example.org` is 79 characters, syntactically
 * valid, accepted by the ordinary validator - and refused at this boundary, so the very
 * same address saved on a host that needed no privileges and failed on one that did.
 */
const MAX_NTP_SERVER_LENGTH = 253;
const MAX_MESSAGE_LENGTH = 500;
const MAX_STEPS = 32;
const MAX_COMMAND_LENGTH = 2048;

function isBoundedString(value: unknown, limit: number = MAX_VALUE_LENGTH): boolean {
	return typeof value === 'string' && value.length > 0 && value.length <= limit && !/\p{Cc}/u.test(value);
}

function hasOnlyKeys(value: object, allowed: string[]): boolean {
	return Object.keys(value).every(key => allowed.includes(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Accept only a change set of the exact shape the backend builds.
 *
 * The values are validated again by {@link applySystemTimeSettings} on the other side -
 * this is the shape check that keeps anything unexpected from crossing the boundary in
 * the first place, the same job {@link isNetworkHelperBaseline} does for an address.
 * Ranges are deliberately not enforced here: the privileged side owns that rule, and
 * duplicating it would let the two disagree.
 */
export function isSystemTimeChanges(value: unknown): value is SystemTimeChanges {
	if (!isPlainObject(value) || !hasOnlyKeys(value, CHANGE_KEYS)) return false;
	const changes = value as Partial<Record<keyof SystemTimeChanges, unknown>>;
	if (changes.ntpEnabled !== undefined && typeof changes.ntpEnabled !== 'boolean') return false;
	if (changes.ntpServer !== undefined && !isBoundedString(changes.ntpServer, MAX_NTP_SERVER_LENGTH)) return false;
	if (changes.timezone !== undefined && !isBoundedString(changes.timezone)) return false;
	if (changes.expectedTimezone !== undefined && !isBoundedString(changes.expectedTimezone)) return false;
	if (changes.expectedOffsetMinutes !== undefined && !Number.isInteger(changes.expectedOffsetMinutes)) return false;
	if (changes.clock !== undefined) {
		if (!isPlainObject(changes.clock) || !hasOnlyKeys(changes.clock, CLOCK_KEYS)) return false;
		if (!CLOCK_KEYS.every(key => Number.isInteger((changes.clock as Record<string, unknown>)[key]))) return false;
	}
	return Object.keys(changes).length > 0;
}

/**
 * First exit code that carries a system-time outcome.
 *
 * Above every code the network path already uses (0, 1, and 10 to 14), because the
 * Windows launcher passes the elevated helper's exit code through unchanged and one
 * numbering has to serve both.
 */
export const SYSTEM_TIME_EXIT_BASE = 32;

/**
 * Pack a result into an exit code, which is the whole channel back from an elevated
 * Windows helper: it owns a console the unelevated caller never reads, so the JSON the
 * other two platforms return on stdout does not survive the boundary.
 *
 * The outcome is what the UI renders - it maps each one to its own message - so that is
 * what has to cross, together with the two flags that tell the user whether the host was
 * left changed. The OS's own message is the one thing lost on Windows; it is detail under
 * a message the UI already has.
 */
export function systemTimeExitCode(result: SystemTimeResult): number {
	const index = SYSTEM_TIME_OUTCOMES.indexOf(result.outcome);
	if (index < 0) return SYSTEM_TIME_EXIT_BASE + SYSTEM_TIME_OUTCOMES.indexOf('error') * 4;
	return SYSTEM_TIME_EXIT_BASE + index * 4 + (result.changed === true ? 1 : 0) + (result.stateMayHaveChanged === true ? 2 : 0);
}

/** Unpack {@link systemTimeExitCode}, or null for a code that carries no outcome. */
export function parseSystemTimeExitCode(code: number): SystemTimeResult | null {
	if (!Number.isInteger(code) || code < SYSTEM_TIME_EXIT_BASE) return null;
	const offset = code - SYSTEM_TIME_EXIT_BASE;
	const outcome = SYSTEM_TIME_OUTCOMES[Math.floor(offset / 4)];
	if (outcome === undefined) return null;
	const changed = (offset & 1) === 1;
	const attempted = (offset & 2) === 2;
	return {
		success: outcome === 'ok',
		outcome,
		message: null,
		...(changed ? { changed: true } : {}),
		...(attempted ? { stateMayHaveChanged: true } : {}),
	};
}

/** Accept only a result of the shape the privileged side produces; it crosses the boundary inward. */
export function isSystemTimeResult(value: unknown): value is SystemTimeResult {
	if (!isPlainObject(value) || !hasOnlyKeys(value, ['changed', 'message', 'outcome', 'stateMayHaveChanged', 'steps', 'success'])) return false;
	const result = value as Partial<Record<keyof SystemTimeResult, unknown>>;
	if (typeof result.success !== 'boolean' || typeof result.outcome !== 'string' || !(SYSTEM_TIME_OUTCOMES as readonly string[]).includes(result.outcome)) return false;
	if (result.success !== (result.outcome === 'ok')) return false;
	if (result.message !== null && !isBoundedString(result.message, MAX_MESSAGE_LENGTH)) return false;
	if (result.changed !== undefined && typeof result.changed !== 'boolean') return false;
	if (result.stateMayHaveChanged !== undefined && typeof result.stateMayHaveChanged !== 'boolean') return false;
	if (result.steps !== undefined) {
		if (!Array.isArray(result.steps) || result.steps.length > MAX_STEPS) return false;
		if (!result.steps.every(step => isPlainObject(step) && hasOnlyKeys(step, ['command', 'ok']) && isBoundedString(step['command'], MAX_COMMAND_LENGTH) && typeof step['ok'] === 'boolean')) return false;
	}
	return true;
}

/** The outcome to report when the helper itself could not be run. */
export function systemTimeHelperFailure(outcome: SystemTimeOutcome, message: string): SystemTimeResult {
	return { success: false, outcome, message };
}
