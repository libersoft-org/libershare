/**
 * What the API shutdown needs from the rest of the backend. Every entry is an existing
 * building block; this module only fixes the order they run in.
 */
export interface ShutdownDeps {
	/** Stop searches and the system polling that could still save settings. */
	readonly stopBackgroundWork: () => void;
	/** Signal every LISH creation to stop, without waiting for it. */
	readonly stopAllCreates: () => Promise<unknown>;
	/** Resolve once every API request accepted before the gate closed has finished. */
	readonly drainAcceptedRequests: () => Promise<void>;
	/** Close lishnet writes; the lease drains the ones already running. */
	readonly prepareMaintenance: () => Promise<{ drain: () => Promise<void>; release: () => void }>;
	readonly pauseAllTransfers: () => Promise<void>;
	readonly pauseAllLISHMutations: () => Promise<void>;
	readonly stopVerifyAll: () => Promise<unknown>;
	readonly clearAllTransfers: () => Promise<unknown>;
	readonly cancelRunOperations: () => void;
	readonly stopAllNetworks: () => Promise<void>;
	readonly clearUploadRuntime: () => void;
	/** Wait for API uploads and remove their temporary files. */
	readonly drainUploads: () => Promise<void>;
	/** Close client sockets and the server once nothing can answer them any more. */
	readonly closeServer: () => void;
}

/**
 * Drain the API and everything it started, in the order the database needs: accepted requests
 * first (they may be a reset or an import holding the gates), then transfers and LISH work,
 * then the networks, then uploads, and only then the sockets. The caller closes the database
 * after this resolves; a rejection means something did not stop and the database must stay
 * open. Aborting a phase is not the same as it having finished — every step awaits the work,
 * including its `finally`.
 */
export async function drainForShutdown(deps: ShutdownDeps): Promise<void> {
	deps.stopBackgroundWork();
	// Not awaited on its own: a long creation would otherwise hold the request drain.
	const creationsStopped = deps.stopAllCreates();
	await deps.drainAcceptedRequests();
	const maintenance = await deps.prepareMaintenance();
	try {
		// Both gates close synchronously before the first await, as in the factory reset.
		await Promise.all([deps.pauseAllTransfers(), deps.pauseAllLISHMutations(), deps.stopAllCreates(), creationsStopped]);
		await deps.stopVerifyAll();
		await deps.clearAllTransfers();
		deps.cancelRunOperations();
		await maintenance.drain();
		await deps.stopAllNetworks();
		deps.clearUploadRuntime();
	} finally {
		maintenance.release();
	}
	await deps.drainUploads();
	deps.closeServer();
}
