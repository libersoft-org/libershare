/**
 * Restore a batch of stored downloads after a network restart, all or nothing.
 *
 * Every download is prepared first — built and initialised, but not registered, not started
 * and not reported. Only when the whole batch is prepared is it accepted, every download handed
 * over before any of them is awaited. A failure while preparing destroys every prepared candidate, so no download is left
 * running for a batch that failed, and the stored "download enabled" intent is never touched:
 * this path never writes it.
 */

/** How one stored download comes back. */
export type RestorePlan =
	/** Start it on these lishnets; `originalNetworkIDs` is the binding it keeps for later rejoins. */
	| { kind: 'resume'; networkIDs: string[]; originalNetworkIDs: string[] }
	/** None of its lishnets is joined: keep it suspended on them. */
	| { kind: 'suspend'; networkIDs: string[] }
	/** Already complete on disk: nothing to run. */
	| { kind: 'complete' };

/** A prepared download the batch owns until it is accepted or rolled back. */
export interface PreparedRestore {
	destroy(): Promise<void>;
}

/** What the batch needs from the transfer handlers, which keep owning the maps. */
export interface TransferRestoreDeps<P extends PreparedRestore> {
	/** Downloads currently running; a restore only starts on an empty runtime. */
	readonly activeCount: () => number;
	/** How this download comes back; throws when it cannot (a missing LISH or manifest). */
	readonly plan: (lishID: string) => Promise<RestorePlan>;
	/** Build and initialise without starting; resolves to null when the start window abandoned it (it recorded its own suspension). */
	readonly prepare: (lishID: string, plan: Extract<RestorePlan, { kind: 'resume' }>, signal: AbortSignal) => Promise<P | null>;
	/** Register and start a prepared download. Every accept is issued before any is awaited. */
	readonly accept: (lishID: string, prepared: P) => Promise<unknown>;
	/** Record a download that stays suspended on its lishnets. */
	readonly suspend: (lishID: string, networkIDs: string[]) => void;
	/** Record a download that is already complete. */
	readonly complete: (lishID: string) => void;
}

/** A failed restore whose rollback also failed: prepared downloads may still be alive. */
export class TransferRestoreRollbackError extends AggregateError {
	constructor(errors: unknown[]) {
		super(errors, 'Restoring downloads failed and could not be rolled back; the transfer runtime is unsafe until the process restarts');
		this.name = 'TransferRestoreRollbackError';
	}
}

/**
 * Prepare every download in `lishIDs`, then accept them together. Throws before anything is
 * accepted when one of them cannot be prepared — an `AggregateError` with each failure — after
 * destroying all prepared candidates; a {@link TransferRestoreRollbackError} when that cleanup
 * fails too.
 */
export async function restoreTransferBatch<P extends PreparedRestore>(lishIDs: Iterable<string>, deps: TransferRestoreDeps<P>, signal: AbortSignal = new AbortController().signal): Promise<void> {
	if (deps.activeCount() > 0) throw new Error('downloads are already running; a restore starts only on an empty transfer runtime');
	const prepared: Array<{ lishID: string; prepared: P }> = [];
	const settled: Array<{ lishID: string; plan: RestorePlan }> = [];
	const failures: unknown[] = [];
	for (const lishID of lishIDs) {
		try {
			signal.throwIfAborted();
			const plan = await deps.plan(lishID);
			if (plan.kind !== 'resume') {
				settled.push({ lishID, plan });
				continue;
			}
			const candidate = await deps.prepare(lishID, plan, signal);
			if (candidate) prepared.push({ lishID, prepared: candidate });
		} catch (error) {
			failures.push(error instanceof Error ? error : new Error(String(error)));
			break;
		}
	}
	if (failures.length === 0 && signal.aborted) failures.push(signal.reason ?? new Error('restore aborted'));
	if (failures.length > 0) {
		const cleanup = await Promise.allSettled(prepared.map(entry => entry.prepared.destroy()));
		const rollbackFailures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
		if (rollbackFailures.length > 0) throw new TransferRestoreRollbackError([...failures, ...rollbackFailures]);
		throw new AggregateError(failures, `Failed to restore ${failures.length} persisted download(s)`);
	}
	// Accept: every download of the batch is handed over before any of them is awaited.
	for (const { lishID, plan } of settled) {
		if (plan.kind === 'suspend') deps.suspend(lishID, plan.networkIDs);
		else if (plan.kind === 'complete') deps.complete(lishID);
	}
	await Promise.all(prepared.map(entry => deps.accept(entry.lishID, entry.prepared)));
}
