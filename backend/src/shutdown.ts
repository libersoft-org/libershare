/** Default ceiling for a graceful shutdown, from the first signal. */
export const SHUTDOWN_DEADLINE_MS = 30_000;

/** What the process shutdown drives; injected so it can be tested without exiting the runner. */
export interface ProcessShutdownDeps {
	readonly stopConnectivityCheck: () => void;
	/** Close the API and drain everything it started; rejects when something did not stop. */
	readonly stopApi: () => Promise<void>;
	/** Wait for accepted settings writes; rejects when the last one did not reach the disk. */
	readonly flushSettings: () => Promise<void>;
	readonly closeDatabase: () => void;
	readonly exit: (code: number) => void;
	readonly deadlineMs?: number;
}

/** The handler plus a query the entry point uses to keep the API closed after a signal. */
export interface ProcessShutdown {
	readonly shutdown: () => Promise<void>;
	readonly isShuttingDown: () => boolean;
}

/**
 * Build the SIGINT/SIGTERM handler. The database is closed only after the API has drained
 * every operation that could still read or write it and the settings have been flushed; a
 * phase that fails or does not finish before the deadline exits 1 without that close, and
 * never reports a clean shutdown. A second signal while the first is running forces exit 1.
 */
export function createProcessShutdown(deps: ProcessShutdownDeps): ProcessShutdown {
	let shuttingDown = false;
	let finished = false;
	const finish = (code: number): void => {
		if (finished) return;
		finished = true;
		deps.exit(code);
	};
	async function shutdown(): Promise<void> {
		if (shuttingDown) {
			// Second Ctrl+C → hard kill
			finish(1);
			return;
		}
		shuttingDown = true;
		console.log('Shutting down...');
		let phase = 'api';
		const deadline = setTimeout(() => {
			console.error(`[Shutdown] Did not finish within ${deps.deadlineMs ?? SHUTDOWN_DEADLINE_MS} ms (stuck in: ${phase}); exiting without closing the database.`);
			finish(1);
		}, deps.deadlineMs ?? SHUTDOWN_DEADLINE_MS);
		try {
			deps.stopConnectivityCheck();
			try {
				await deps.stopApi();
			} catch (error) {
				console.error(`[Shutdown] Could not stop the API cleanly: ${(error as Error).message}; exiting without closing the database.`);
				finish(1);
				return;
			}
			if (finished) return;
			phase = 'settings';
			let settingsError: unknown = null;
			try {
				await deps.flushSettings();
			} catch (error) {
				settingsError = error;
				console.error(`[Shutdown] Settings were not saved: ${(error as Error).message}`);
			}
			if (finished) return;
			phase = 'database';
			try {
				deps.closeDatabase();
			} catch (error) {
				console.error('[Shutdown] DB close error:', error);
				finish(1);
				return;
			}
			if (settingsError) {
				finish(1);
				return;
			}
			console.log('Shutdown complete');
			finish(0);
		} finally {
			clearTimeout(deadline);
		}
	}
	return { shutdown, isShuttingDown: () => shuttingDown };
}
