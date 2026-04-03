import { ErrorCodes } from '@shared';
import { mkdir } from 'fs/promises';

export interface RecoveryState {
	downloadWasEnabled: boolean;
	uploadWasEnabled: boolean;
	errorCode: string;
	retryCount: number;
	nextRetryDelay: number;
	timer: ReturnType<typeof setTimeout> | null;
	scheduledAt: number;
}

interface RecoveryDeps {
	attemptRecover: (lishID: string, downloadWasEnabled: boolean, uploadWasEnabled: boolean) => Promise<boolean>;
	broadcast: (event: string, data: any) => void;
	getLISH: (lishID: string) => { directory?: string; id: string } | null;
	checkAccess: (path: string) => Promise<void>;
}

/** Only these error codes trigger auto-recovery (IO-related, may self-resolve). */
const RECOVERABLE_CODES = new Set([ErrorCodes.IO_NOT_FOUND, ErrorCodes.DISK_FULL, ErrorCodes.DIRECTORY_ACCESS_DENIED]);

const FAST_DELAY = 7_000;   // IO_NOT_FOUND: 7 seconds
const SLOW_DELAY = 60_000;  // Other errors: 60 seconds

function getDelay(errorCode: string): number {
	return errorCode === ErrorCodes.IO_NOT_FOUND ? FAST_DELAY : SLOW_DELAY;
}

export class ErrorRecovery {
	private readonly entries = new Map<string, RecoveryState>();
	private readonly deps: RecoveryDeps;

	constructor(deps: RecoveryDeps) {
		this.deps = deps;
	}

	/** Returns true if this error code is recoverable. */
	static isRecoverable(errorCode: string): boolean {
		return RECOVERABLE_CODES.has(errorCode as any);
	}

	start(lishID: string, errorCode: string, prev: { downloadEnabled: boolean; uploadEnabled: boolean }): void {
		if (!RECOVERABLE_CODES.has(errorCode as any)) return;
		// Re-entrancy guard: if recovery already active, don't restart (retryCount would reset)
		if (this.entries.has(lishID)) return;
		const delay = getDelay(errorCode);
		const entry: RecoveryState = {
			downloadWasEnabled: prev.downloadEnabled,
			uploadWasEnabled: prev.uploadEnabled,
			errorCode,
			retryCount: 0,
			nextRetryDelay: delay,
			timer: null,
			scheduledAt: Date.now(),
		};
		this.entries.set(lishID, entry);
		this.deps.broadcast('transfer.recovery:scheduled', { lishID, delayMs: delay, retryCount: 0 });
		this.schedule(lishID, delay);
	}

	stop(lishID: string): void {
		const entry = this.entries.get(lishID);
		if (!entry) return;
		if (entry.timer) clearTimeout(entry.timer);
		this.entries.delete(lishID);
	}

	stopAll(): void {
		for (const [lishID] of this.entries) this.stop(lishID);
	}

	getState(lishID: string): RecoveryState | undefined {
		return this.entries.get(lishID);
	}

	private schedule(lishID: string, delay: number): void {
		const entry = this.entries.get(lishID);
		if (!entry) return;
		entry.scheduledAt = Date.now();
		entry.nextRetryDelay = delay;
		entry.timer = setTimeout(() => this.attempt(lishID), delay);
	}

	private async attempt(lishID: string): Promise<void> {
		const entry = this.entries.get(lishID);
		if (!entry) return;
		entry.retryCount++;
		entry.timer = null;

		const lish = this.deps.getLISH(lishID);
		if (!lish || !lish.directory) {
			console.debug(`[Recovery] ${lishID.slice(0, 8)}: LISH deleted or no directory, stopping recovery`);
			this.stop(lishID);
			return;
		}

		// For IO_NOT_FOUND: try to recreate directory before checking
		if (entry.errorCode === ErrorCodes.IO_NOT_FOUND) {
			try {
				await mkdir(lish.directory, { recursive: true });
			} catch { /* best effort */ }
		}

		// Check if directory is accessible
		try {
			await this.deps.checkAccess(lish.directory);
		} catch {
			console.warn(`[Recovery] ${lishID.slice(0, 8)}: still inaccessible (attempt ${entry.retryCount}), retry in 60s`);
			this.deps.broadcast('transfer.recovery:scheduled', { lishID, delayMs: SLOW_DELAY, retryCount: entry.retryCount });
			this.schedule(lishID, SLOW_DELAY);
			return;
		}

		// Directory accessible — attempt re-enable
		console.debug(`[Recovery] ${lishID.slice(0, 8)}: directory accessible, attempting recovery (attempt ${entry.retryCount})`);
		this.deps.broadcast('transfer.recovery:attempting', { lishID, retryCount: entry.retryCount });

		// Save state before stopping (stop deletes the entry)
		const { downloadWasEnabled, uploadWasEnabled } = entry;
		// Stop recovery BEFORE calling enableDownload to prevent re-entrancy
		this.stop(lishID);

		const success = await this.deps.attemptRecover(lishID, downloadWasEnabled, uploadWasEnabled);
		if (success) {
			console.log(`[Recovery] ${lishID.slice(0, 8)}: recovered successfully`);
			this.deps.broadcast('transfer.recovery:recovered', { lishID });
		} else {
			console.warn(`[Recovery] ${lishID.slice(0, 8)}: re-enable failed (attempt will restart via error handler)`);
			// Don't reschedule here — the failed enableDownload/enableUpload call will
			// trigger a new error which will call recovery.start() again
		}
	}
}
