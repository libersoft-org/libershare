/** What the process shutdown drives; injected so it can be tested without exiting the runner. */
export interface ProcessShutdownDeps {
	readonly stopConnectivityCheck: () => void;
	readonly stopApi: () => unknown;
	readonly closeDatabase: () => void;
	readonly exit: (code: number) => void;
	readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Build the SIGINT/SIGTERM handler. The first signal shuts down; a second one while that is
 * still running forces exit 1.
 */
export function createProcessShutdown(deps: ProcessShutdownDeps): () => Promise<void> {
	let shuttingDown = false;
	return async function shutdown(): Promise<void> {
		if (shuttingDown) {
			// Second Ctrl+C → hard kill
			deps.exit(1);
			return;
		}
		shuttingDown = true;
		console.log('Shutting down...');
		// Stop accepting new work (sync)
		deps.stopConnectivityCheck();
		deps.stopApi();
		// Flush SQLite (bun:sqlite is synchronous, so all committed writes are already on disk —
		// close() finalizes any open statements and the WAL).
		try {
			deps.closeDatabase();
		} catch (err) {
			console.error('DB close error:', err);
		}
		// Give a short grace for any in-flight fs writes (download chunks, uploads) to drain.
		// We do NOT wait for libp2p node.stop() — peers get a TCP FIN from OS when the process exits.
		await deps.sleep(200);
		deps.exit(0);
	};
}
