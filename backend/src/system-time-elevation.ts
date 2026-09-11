import type { SystemTimeChanges, SystemTimeResult } from '@shared';
import { runElevatedSystemTime } from './network-helper-client.ts';
import { applySystemTimeSettings, withSystemTimeLock } from './system-time.ts';

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
 * Apply a system-time save, asking for privileges only if the host refuses without them.
 *
 * Tried unprivileged first rather than probing for rights up front, which is what the
 * network screen does. Three measured reasons:
 *
 * - A save that only changes the TIMEZONE needs no privileges at all on Windows:
 *   `SeTimeZonePrivilege` is granted to `Users`, and `tzutil /s` really does apply.
 *   Probing first would raise an authorization prompt for a change that was going to
 *   succeed on its own.
 * - On Linux the unprivileged path IS the authorized path: `timedatectl` asks polkit
 *   itself, with the host's own per-action rules. Elevating ahead of it would replace
 *   that with a second, coarser prompt.
 * - The refusal is unambiguous when it happens - `permission-denied` from the OS's own
 *   words - so nothing is guessed from a probe that could disagree with the write.
 *
 * The retry is one prompt for one press of Save, because the whole change set crosses as
 * a single request. The privileged side re-reads this host and re-checks the staleness
 * expectations against it, so a change made while the prompt was open is refused there
 * too rather than applied over.
 *
 * Both attempts happen inside one {@link withSystemTimeLock} section: releasing it
 * between them would let another client's save land in the gap, and the elevated retry
 * would then be composed against state that no longer holds.
 */
export function applySystemTimeSettingsWithElevation(changes: SystemTimeChanges, elevate: (changes: SystemTimeChanges) => Promise<SystemTimeResult> = runElevatedSystemTime, apply: (changes: SystemTimeChanges) => Promise<SystemTimeResult> = applySystemTimeSettings): Promise<SystemTimeResult> {
	return withSystemTimeLock(async () => {
		const local = await apply(changes);
		if (!needsElevation(local)) return local;
		return elevate(changes);
	});
}
