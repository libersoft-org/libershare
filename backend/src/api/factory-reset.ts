import { type FactoryResetCategory, type FactoryResetResult, type FactoryResetResponse } from '@shared';

/**
 * Operations a factory reset performs. `prepare`/`restart` are best-effort
 * infrastructure run around the wipes (logged but never reported as categories);
 * the five category functions are each run INDEPENDENTLY. Omit a function to skip
 * that step (e.g. an unselected category).
 */
export interface FactoryResetOps {
	/** Stop transfers / networks before the wipes. Best-effort. */
	prepare?: (() => Promise<void> | void) | undefined;
	/** Bring the node + surviving transfers back after the wipes. Best-effort. */
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

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Run a factory reset where every selected category is wiped INDEPENDENTLY: a
 * failure in one category is caught, recorded, and never stops the remaining
 * categories. `prepare` runs first and `restart` last — both best-effort, so their
 * failure is logged but does not abort the wipes (the node is always brought back
 * up). Returns one {@link FactoryResetResult} per selected category plus an overall
 * `success` flag (true iff every selected category passed).
 */
export async function runFactoryReset(ops: FactoryResetOps): Promise<FactoryResetResponse> {
	if (ops.prepare) {
		try {
			await ops.prepare();
		} catch (e) {
			console.error(`[factoryReset] prepare failed (continuing): ${errMsg(e)}`);
		}
	}
	const results: FactoryResetResult[] = [];
	for (const category of CATEGORY_ORDER) {
		const fn = ops[category];
		if (!fn) continue; // category not selected
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
		try {
			await ops.restart();
		} catch (e) {
			console.error(`[factoryReset] restart failed: ${errMsg(e)}`);
		}
	}
	return { success: results.every(r => r.ok), results };
}
