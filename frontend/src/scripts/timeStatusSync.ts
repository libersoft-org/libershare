/**
 * Ordering rules the system-time settings form depends on, kept out of the component so
 * they can be exercised without a DOM.
 *
 * They exist because the form has more than one source of truth in flight at once: a
 * status it asked for, a status the backend broadcast, and the outcome of a write. Which
 * of them wins is not obvious at the call site, and getting it wrong is silent — the user
 * simply sees the wrong thing.
 */

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
