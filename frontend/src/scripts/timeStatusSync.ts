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
