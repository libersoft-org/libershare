import type { SystemTimeChanges, SystemTimeStatus } from '@shared';

export const NTP_PRESETS: readonly string[] = ['tik.cesnet.cz', 'tak.cesnet.cz'];

/**
 * The two ordering rules the system-time settings form depends on, kept out of the
 * component so they can be exercised without a DOM.
 *
 * Both exist because the form has more than one source of truth in flight at once: a
 * status it asked for, a status the backend broadcast, and the outcome of a write. Which
 * of them wins is not obvious at the call site, and getting it wrong is silent — the user
 * simply sees the wrong thing.
 */

/**
 * Latest-wins guard over the form's status reads.
 *
 * A read is asynchronous and the answer can arrive after something fresher has already
 * been adopted: a `system:timeChanged` broadcast overtaking a re-read issued on reconnect,
 * or a second reconnect issuing a second read while the first is still out. Applying the
 * late answer puts the form back on state the host has already moved past, and it does so
 * whenever the network happens to reorder two messages — so it cannot be reproduced on
 * demand and looks like the page "sometimes" showing stale values.
 */
export interface StatusGate {
	/** Begin a read. The returned check answers false once anything fresher has been adopted. */
	begin: () => () => boolean;
	/** Record that a fresher status was adopted from somewhere other than a read. */
	supersede: () => void;
}

/** Build a {@link StatusGate}. Each gate counts for one form. */
export function createStatusGate(): StatusGate {
	let generation = 0;
	return {
		begin: (): (() => boolean) => {
			const issued = ++generation;
			return () => issued === generation;
		},
		supersede: (): void => {
			generation++;
		},
	};
}

/** What decides whether an answered status read may still fill the form. */
export interface LoadApplicability {
	/** False once anything fresher was adopted — the {@link StatusGate} check. */
	fresh: boolean;
	/** A read nobody asked for (reconnect catch-up), as opposed to one the user's action needs. */
	background: boolean;
	/** A write is in flight. */
	busy: boolean;
	/** The form holds changes the user has not saved. */
	dirty: boolean;
}

/**
 * Whether an answered status read may overwrite the form.
 *
 * The generation check alone is not enough, and this is the half that was missing: it
 * orders several ANSWERS against each other but knows nothing about the user. A reconnect
 * read is issued while the form is clean and idle, and then takes a whole round trip during
 * which the user can type, toggle the switch and press Save — so the conditions have to be
 * re-asked when the answer LANDS, not only when it is sent. Checked only at the start, a
 * reconnect read overwrote an edit made behind it, reset the baseline it would have been
 * compared against, and cleared the `touched` flag a save in flight was relying on.
 *
 * A FOREGROUND read is exempt from the dirty and busy tests, because resetting the form is
 * the point of it: it is the re-read after a refused or half-applied write, where the values
 * on screen are the ones that must not be trusted.
 */
export function loadMayApply({ fresh, background, busy, dirty }: LoadApplicability): boolean {
	if (!fresh) return false;
	return !background || (!busy && !dirty);
}

/**
 * What a status read's failure is allowed to say, given whether that answer may still speak
 * for the form.
 *
 * The guard used to cover only the VALUES. An older background read landing after a failed
 * save was correctly stopped from rewinding the form — and then replaced the save's error
 * with a generic "could not read the time", which is the one message the user needed. The
 * data race was fixed and the same race on the error state was left standing.
 *
 * An answer that may no longer touch the form may no longer touch what the form says either:
 * it is a catch-up nobody asked for, reporting on a request the screen has already moved
 * past.
 */
export function loadFailureMessage(failure: string, mayApply: boolean): string {
	return mayApply ? failure : '';
}

/**
 * Everything a save writes, read off the form ONCE before the first request.
 *
 * `loaded` is the host state the form was filled from, and the comparison that decides
 * which steps run at all.
 */
export interface TimeSavePlan {
	autoSync: boolean;
	syncDirty: boolean;
	ntpServer: string;
	timezone: string;
	clock: { hours: number; minutes: number; seconds: number } | null;
	loaded: { ntpServer: string; timezone: string };
}

/**
 * The changed fields sent in one request. The backend owns their execution order.
 *
 * Derived from a plan rather than from the live form so every field belongs to the save the
 * user pressed. The backend orders these fields and applies them under one lock.
 */
export function planTimeChanges(plan: TimeSavePlan): SystemTimeChanges {
	const changes: SystemTimeChanges = {};
	if (plan.syncDirty) changes.ntpEnabled = plan.autoSync;
	if (plan.ntpServer !== plan.loaded.ntpServer) changes.ntpServer = plan.ntpServer;
	if (plan.timezone !== plan.loaded.timezone) changes.timezone = plan.timezone;
	if (plan.clock) changes.clock = { ...plan.clock };
	return changes;
}

export interface HostClock {
	hours: string;
	minutes: string;
	seconds: string;
}

/** Use the OS offset directly when automatic timezone/DST adjustment is disabled. */
function hostTimeParts(nowMs: number, timezone: string, offsetMinutes: number, mode: 'zone' | 'fixed', fields: Intl.DateTimeFormatOptions): Intl.DateTimeFormatPart[] {
	if (mode === 'zone') {
		try { return new Intl.DateTimeFormat('en-GB', { ...fields, timeZone: timezone }).formatToParts(new Date(nowMs)); } catch {}
	}
	return new Intl.DateTimeFormat('en-GB', { ...fields, timeZone: 'UTC' }).formatToParts(new Date(nowMs + offsetMinutes * 60000));
}

/** Format the host wall clock using its reported offset mode, defaulting to normal zone/DST rules. */
export function formatHostClock(nowMs: number, timezone: string, offsetMinutes: number, mode: 'zone' | 'fixed' = 'zone'): HostClock {
	const parts = hostTimeParts(nowMs, timezone, offsetMinutes, mode, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
	const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find(part => part.type === type)?.value ?? '';
	return { hours: value('hour'), minutes: value('minute'), seconds: value('second') };
}

/** ISO calendar date in the same host-local frame as the editable clock fields. */
export function formatHostDate(nowMs: number, timezone: string, offsetMinutes: number, mode: 'zone' | 'fixed' = 'zone'): string {
	const parts = hostTimeParts(nowMs, timezone, offsetMinutes, mode, { year: 'numeric', month: '2-digit', day: '2-digit' });
	return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value ?? '').join('-');
}

/** Configuration changes or corrections beyond 2 s of read/transport jitter invalidate an existing draft. */
export function timeStatusChanged(previous: SystemTimeStatus, next: SystemTimeStatus, elapsedMs: number): boolean {
	return previous.supported !== next.supported
		|| previous.timezone !== next.timezone
		|| previous.utcOffsetMinutes !== next.utcOffsetMinutes
		|| (previous.timezoneOffsetMode ?? 'zone') !== (next.timezoneOffsetMode ?? 'zone')
		|| previous.ntpEnabled !== next.ntpEnabled
		|| (previous.ntpServer ?? '') !== (next.ntpServer ?? '')
		|| previous.capabilities.setClock !== next.capabilities.setClock
		|| previous.capabilities.setTimezone !== next.capabilities.setTimezone
		|| previous.capabilities.setNtpServer !== next.capabilities.setNtpServer
		|| previous.capabilities.setNtpEnabled !== next.capabilities.setNtpEnabled
		|| Math.abs(next.nowMs - previous.nowMs - elapsedMs) > 2000;
}

/**
 * What a failed write leaves on screen.
 *
 * `reason` is why the write failed, and it is the half the user cannot do without — on a
 * save that stopped part-way it is the only thing telling them that some of it may
 * already be on the host. The re-read that follows a failed write can fail too;
 * `reloadFailure` is appended to the reason as a detail and never replaces it. It used to,
 * because the reload assigned the error message itself: a refused save followed by an
 * unreadable status was reported as nothing worse than a status that could not be read.
 */
export function writeFailureMessage(reason: string, reloadFailure: string): string {
	return reloadFailure ? `${reason}: ${reloadFailure}` : reason;
}

/**
 * Whether the automatic-synchronisation switch has something to write.
 *
 * Normally that is simply "it differs from what the host reported". On a host whose sync
 * state could not be read it cannot be, and that is the whole problem: the form shows the
 * switch off and takes off as its baseline, so the two agree by construction, the save
 * button never comes alive, and the one state the screen asks the user to resolve — by
 * switching synchronisation either way — is the one they cannot resolve. On is reachable
 * (on differs from the off it defaulted to), off is not.
 *
 * So with `reported` null the switch is dirty as soon as the user has deliberately used
 * it. They are not editing a known value there, they are asserting one, and asserting the
 * value it happens to be showing is a real request: it writes the state the host would not
 * admit to.
 */
export function syncSwitchIsDirty(shown: boolean, reported: boolean | null, touched: boolean): boolean {
	return reported === null ? touched : shown !== reported;
}
