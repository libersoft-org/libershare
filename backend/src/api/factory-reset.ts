import { type FactoryResetCategory, type FactoryResetResult, type FactoryResetPhaseResult, type FactoryResetResponse } from '@shared';

/**
 * Operations a factory reset performs. `prepare` and `restart` are not categories but
 * the infrastructure around the wipes; the five category functions are each run
 * independently of one another. Omit a function to skip that step (e.g. an unselected
 * category).
 */
export interface FactoryResetOps {
	/**
	 * Stop transfers / networks before the wipes. A PREREQUISITE, not a best-effort
	 * extra: everything in {@link REQUIRES_PREPARE} is only safe once it has succeeded.
	 */
	prepare?: (() => Promise<void> | void) | undefined;
	/** Bring the node + surviving transfers back after the wipes. Skipped if `prepare` failed. */
	restart?: (() => Promise<void> | void) | undefined;
	settings?: (() => Promise<void> | void) | undefined;
	identity?: (() => Promise<void> | void) | undefined;
	downloads?: (() => Promise<void> | void) | undefined;
	networks?: (() => Promise<void> | void) | undefined;
	/** Wipe discovered peerstore records only; the identity private key is preserved. */
	peers?: (() => Promise<void> | void) | undefined;
}

// Fixed execution order. Wipes are mutually independent, but a stable order keeps
// the per-category notifications predictable on the FE.
const CATEGORY_ORDER: FactoryResetCategory[] = ['downloads', 'networks', 'peers', 'identity', 'settings'];

/**
 * Categories that may only run once `prepare` has actually stopped the transfers and the
 * node. Four of the five wipe state the running node owns — its datastore, its peerstore,
 * its identity, the files live transfers are writing — so running them over a node that
 * could not be stopped is the corruption this barrier exists to prevent. `settings` is the
 * only wipe that touches neither the node nor the transfers.
 */
const REQUIRES_PREPARE: ReadonlySet<FactoryResetCategory> = new Set<FactoryResetCategory>(['downloads', 'networks', 'peers', 'identity']);

const PREPARE_FAILED_SKIP = 'skipped: transfers and the node could not be stopped safely';
const RESTART_SKIPPED = 'skipped: nothing was stopped, so nothing may be started';

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Run a factory reset.
 *
 * `prepare` is a hard barrier. It stops the transfers and the libp2p node, and every
 * destructive category listed in {@link REQUIRES_PREPARE} depends on that having actually
 * happened — a wipe of the datastore, the peerstore or the download tables underneath a
 * node still holding them corrupts both. So a failed `prepare` skips those categories,
 * skips the restart (there is nothing safe to restart onto) and forces `success: false`.
 * It used to be merely logged, which let the reset proceed to wipe and then bring up a
 * second node over whatever the first one still owned.
 *
 * Categories that DO run are independent of each other: a failure in one is recorded and
 * never stops the rest. Returns one {@link FactoryResetResult} per selected category, one
 * {@link FactoryResetPhaseResult} per phase, and an overall `success` that is true only
 * when every one of them passed.
 */
export async function runFactoryReset(ops: FactoryResetOps): Promise<FactoryResetResponse> {
	const phases: FactoryResetPhaseResult[] = [];
	let prepared = true;
	if (ops.prepare) {
		try {
			await ops.prepare();
			phases.push({ phase: 'prepare', ok: true });
		} catch (e) {
			const detail = errMsg(e);
			console.error(`[factoryReset] prepare failed — destructive categories skipped: ${detail}`);
			phases.push({ phase: 'prepare', ok: false, detail });
			prepared = false;
		}
	}
	const results: FactoryResetResult[] = [];
	for (const category of CATEGORY_ORDER) {
		const fn = ops[category];
		if (!fn) continue; // category not selected
		if (!prepared && REQUIRES_PREPARE.has(category)) {
			results.push({ category, ok: false, detail: PREPARE_FAILED_SKIP });
			continue;
		}
		try {
			await fn();
			results.push({ category, ok: true });
		} catch (e) {
			const detail = errMsg(e);
			console.error(`[factoryReset] ${category} failed (continuing): ${detail}`);
			results.push({ category, ok: false, detail });
		}
	}
	if (ops.restart) {
		if (!prepared) {
			// The node was never proved down. Starting it again would put a second one over
			// the identity, port and datastore the first may still hold.
			phases.push({ phase: 'restart', ok: false, detail: RESTART_SKIPPED });
		} else {
			try {
				await ops.restart();
				phases.push({ phase: 'restart', ok: true });
			} catch (e) {
				const detail = errMsg(e);
				console.error(`[factoryReset] restart failed: ${detail}`);
				phases.push({ phase: 'restart', ok: false, detail });
			}
		}
	}
	return { success: results.every(r => r.ok) && phases.every(p => p.ok), results, phases };
}
