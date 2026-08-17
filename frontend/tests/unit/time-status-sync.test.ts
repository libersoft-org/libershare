/**
 * Unit tests for the ordering rules of the system-time settings form
 * (`src/scripts/timeStatusSync.ts`).
 *
 * Both rules govern what happens when several answers about the host's time state are in
 * flight at once — a re-read, a broadcast and the outcome of a write. The module is pure,
 * so it runs under `bun test` without the Svelte runtime.
 */
import { test, expect } from 'bun:test';
import { createStatusGate, loadFailureMessage, loadMayApply, planTimeWrites, syncSwitchIsDirty, writeFailureMessage, type TimeSavePlan } from '../../src/scripts/timeStatusSync.ts';

test('a read that nothing overtook is applied', () => {
	const gate = createStatusGate();
	const current = gate.begin();
	expect(current()).toBe(true);
});

/** The reconnect race: the broadcast carries the newer state, the read predates it. */
test('a broadcast adopted mid-read makes that read stale', () => {
	const gate = createStatusGate();
	const current = gate.begin();
	gate.supersede();
	expect(current()).toBe(false);
});

/** Two reconnects in a row: the answers can come back in either order. */
test('an older read stays stale once a newer one has been issued', () => {
	const gate = createStatusGate();
	const first = gate.begin();
	const second = gate.begin();
	expect(first()).toBe(false);
	expect(second()).toBe(true);
	// And the newer one still loses to a broadcast that lands before it is answered.
	gate.supersede();
	expect(second()).toBe(false);
});

/**
 * The reconnect read is issued while the form is clean and idle and answered a round trip
 * later. Checked only at the start, it overwrote whatever the user typed in between.
 */
test('a background read that came back to an edited form does not apply', () => {
	expect(loadMayApply({ fresh: true, background: true, busy: false, dirty: true })).toBe(false);
});

/** Same read, same round trip, but the user pressed Save inside it. */
test('a background read that came back mid-save does not apply', () => {
	expect(loadMayApply({ fresh: true, background: true, busy: true, dirty: false })).toBe(false);
});

test('a background read applies to a form that is still clean and idle', () => {
	expect(loadMayApply({ fresh: true, background: true, busy: false, dirty: false })).toBe(true);
});

/**
 * The re-read after a refused or half-applied write. Resetting the form is the point of it:
 * the values on screen are precisely the ones that must not be trusted, and the form is
 * dirty and was busy by construction.
 */
test('a foreground read applies even to a dirty form', () => {
	expect(loadMayApply({ fresh: false, background: false, busy: false, dirty: false })).toBe(false);
	expect(loadMayApply({ fresh: true, background: false, busy: true, dirty: true })).toBe(true);
});

/**
 * The timezone list is applied under this same answer, so a stale read can no longer
 * replace a newer one's list — or blank it to an empty picker — while its own status is
 * correctly thrown away.
 */
test('a superseded read applies nothing at all, background or not', () => {
	const gate = createStatusGate();
	const older = gate.begin();
	gate.begin();
	expect(loadMayApply({ fresh: older(), background: false, busy: false, dirty: false })).toBe(false);
	expect(loadMayApply({ fresh: older(), background: true, busy: false, dirty: false })).toBe(false);
});

/** The plan a save is built from: everything changed, so every step runs. */
const FULL_PLAN: TimeSavePlan = { autoSync: false, syncDirty: true, ntpServer: 'ntp.example.org', timezone: 'Europe/Prague', clock: { hours: 1, minutes: 2, seconds: 3 }, loaded: { ntpServer: 'old.example.org', timezone: 'UTC' } };

/**
 * Synchronisation off first — the OS refuses a manual clock set while a daemon owns the
 * clock — and the clock after the values it depends on.
 */
test('the writes run in the order the OS requires', () => {
	expect(planTimeWrites(FULL_PLAN)).toEqual([
		{ method: 'system.setNtpEnabled', params: { enabled: false } },
		{ method: 'system.setNtpServer', params: { server: 'ntp.example.org' } },
		{ method: 'system.setTimezone', params: { timezone: 'Europe/Prague' } },
		{ method: 'system.setClock', params: { hours: 1, minutes: 2, seconds: 3 } },
	]);
});

/** Switching synchronisation back on goes last, or it would step over the clock just set. */
test('synchronisation is switched back on after everything else', () => {
	const writes = planTimeWrites({ ...FULL_PLAN, autoSync: true, clock: null });
	expect(writes[writes.length - 1]).toEqual({ method: 'system.setNtpEnabled', params: { enabled: true } });
	expect(writes.filter(w => w.method === 'system.setNtpEnabled')).toHaveLength(1);
});

test('an unchanged value is not written', () => {
	expect(planTimeWrites({ ...FULL_PLAN, syncDirty: false, ntpServer: 'old.example.org', timezone: 'UTC', clock: null })).toEqual([]);
});

/**
 * The whole reason the plan exists. Whatever a status answer landing mid-save does to the
 * form, the requests were decided from the values the user pressed Save on — so mutating
 * the form afterwards cannot change what is written or skip a step.
 */
test('the writes come from the plan, not from a form that moved underneath it', () => {
	const plan = { ...FULL_PLAN };
	const writes = planTimeWrites(plan);
	plan.ntpServer = 'overwritten.example.org';
	plan.timezone = 'UTC';
	plan.syncDirty = false;
	expect(planTimeWrites(FULL_PLAN)).toEqual(writes);
	expect(writes).toContainEqual({ method: 'system.setNtpServer', params: { server: 'ntp.example.org' } });
});

test('a write failure keeps its own reason when the reload also failed', () => {
	expect(writeFailureMessage('some settings may already be applied', 'the time could not be read')).toBe('some settings may already be applied: the time could not be read');
});

test('a write failure reads unchanged when the reload succeeded', () => {
	expect(writeFailureMessage('automatic synchronisation is enabled', '')).toBe('automatic synchronisation is enabled');
});

test('the sync switch is dirty exactly when it differs from what the host reported', () => {
	expect(syncSwitchIsDirty(true, false, false)).toBe(true);
	expect(syncSwitchIsDirty(false, true, false)).toBe(true);
	expect(syncSwitchIsDirty(true, true, true)).toBe(false);
	expect(syncSwitchIsDirty(false, false, true)).toBe(false);
});

/**
 * The state with no baseline to differ from. The switch defaults to off there, so "off"
 * matched the baseline and could never be saved — the user could assert that
 * synchronisation is on, never that it is off, on the one screen telling them to resolve
 * the state by switching it either way.
 */
test('an unreadable sync state can be asserted off, not only on', () => {
	expect(syncSwitchIsDirty(false, null, true)).toBe(true);
	expect(syncSwitchIsDirty(true, null, true)).toBe(true);
	// Until the user actually touches it, though: opening the page writes nothing.
	expect(syncSwitchIsDirty(false, null, false)).toBe(false);
});

/**
 * The race the last patch left standing. A reconnect read is issued on a clean, idle form;
 * during its round trip the user edits and saves, the save fails with a specific write
 * error, and only then does the older read come back rejected. Its values are already
 * correctly discarded — its FAILURE was not, and it replaced the one message the user
 * needed with a generic "could not read the time".
 */
test('an older background read that failed does not overwrite a newer error', () => {
	const gate = createStatusGate();
	// The reconnect read goes out while the form is clean and idle.
	const reconnect = gate.begin();
	// The user edits and saves; the failed save re-reads the host, which supersedes it.
	const afterSave = gate.begin();
	expect(loadMayApply({ fresh: afterSave(), background: false, busy: true, dirty: true })).toBe(true);
	// Now the reconnect answer lands, rejected.
	const stale = loadMayApply({ fresh: reconnect(), background: true, busy: true, dirty: true });
	expect(stale).toBe(false);
	expect(loadFailureMessage('the time could not be read', stale)).toBe('');
});

test('a read that may still fill the form still reports why it could not', () => {
	expect(loadFailureMessage('the time could not be read', true)).toBe('the time could not be read');
});
