import type { Downloader } from '../protocol/downloader.ts';
import type { TransferRestoreSnapshot } from './transfer.ts';

export class TransferTeardownError extends AggregateError {
	readonly runtimeRestored: boolean;
	readonly restoreSnapshot: TransferRestoreSnapshot | undefined;

	constructor(errors: unknown[], message: string, runtimeRestored: boolean, restoreSnapshot?: TransferRestoreSnapshot) {
		super(errors, message);
		this.name = 'TransferTeardownError';
		this.runtimeRestored = runtimeRestored;
		this.restoreSnapshot = restoreSnapshot;
	}
}

/**
 * Destroy every downloader without hiding failures. Without a restore callback, successful
 * entries are removed and failed ones remain. Factory reset supplies a restore callback so
 * any partial teardown is replaced with a complete fresh runtime set before the error escapes.
 */
export async function destroyAllDownloaders<T extends Pick<Downloader, 'destroy'>>(activeDownloaders: Map<string, T>, restore?: (lishID: string, previous: T) => Promise<T>): Promise<void> {
	const previousDownloaders = [...activeDownloaders];
	const errors: unknown[] = [];
	for (const [lishID, downloader] of previousDownloaders) {
		try {
			await downloader.destroy();
			activeDownloaders.delete(lishID);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length === 0) return;

	const restoreErrors: unknown[] = [];
	if (restore) {
		// destroy() is not reversible: even a call that throws may already have aborted the
		// downloader and disposed its handlers. Replace the whole original set so callers
		// never receive a half-live mixture after a failed reset barrier.
		for (const [lishID, previous] of previousDownloaders) {
			activeDownloaders.delete(lishID);
			try {
				activeDownloaders.set(lishID, await restore(lishID, previous));
			} catch (error) {
				restoreErrors.push(error);
			}
		}
	}

	const restoreDetail = restoreErrors.length > 0 ? `; failed to restore ${restoreErrors.length} download(s)` : '';
	throw new TransferTeardownError([...errors, ...restoreErrors], `Failed to stop ${errors.length} active download(s)${restoreDetail}`, restore !== undefined && restoreErrors.length === 0);
}
