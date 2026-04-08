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

const FAST_DELAY = 7_000;   // IO_NOT_FOUND: 7 seconds (base)
const SLOW_DELAY = 60_000;  // Other errors: 60 seconds (base)
const MAX_DELAY = 300_000;  // Cap: 5 minutes
const MAX_RECOVERY_ATTEMPTS = 5;

function getDelay(errorCode: string, retryCount: number): number {
	const base = errorCode === ErrorCodes.IO_NOT_FOUND ? FAST_DELAY : SLOW_DELAY;
	return Math.min(base * Math.pow(2, retryCount), MAX_DELAY);
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
		const delay = getDelay(errorCode, 0);
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
		console.debug(`[Recovery] ${lishID.slice(0, 8)}: scheduling recovery for ${errorCode}, delay ${delay / 1000}s`);
		this.deps.broadcast('transfer.recovery:scheduled', { lishID, delayMs: delay, retryCount: 0 });
		this.schedule(lishID, delay);
	}

	stop(lishID: string): void {
		const entry = this.entries.get(lishID);
		if (!entry) return;
		if (entry.timer) clearTimeout(entry.timer);
		this.entries.delete(lishID);
		console.debug(`[Recovery] ${lishID.slice(0, 8)}: recovery stopped`);
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

		// Max retries: stop permanently after exhausting attempts
		if (entry.retryCount > MAX_RECOVERY_ATTEMPTS) {
			console.error(`[Recovery] ${lishID.slice(0, 8)}: max recovery attempts (${MAX_RECOVERY_ATTEMPTS}) exceeded for ${entry.errorCode}, giving up`);
			this.deps.broadcast('transfer.recovery:exhausted', { lishID, errorCode: entry.errorCode, attempts: entry.retryCount - 1 });
			this.stop(lishID);
			return;
		}

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
			const nextDelay = getDelay(entry.errorCode, entry.retryCount);
			console.warn(`[Recovery] ${lishID.slice(0, 8)}: still inaccessible (attempt ${entry.retryCount}/${MAX_RECOVERY_ATTEMPTS}), retry in ${Math.round(nextDelay / 1000)}s`);
			this.deps.broadcast('transfer.recovery:scheduled', { lishID, delayMs: nextDelay, retryCount: entry.retryCount });
			this.schedule(lishID, nextDelay);
			return;
		}

		// Directory accessible — attempt re-enable
		console.debug(`[Recovery] ${lishID.slice(0, 8)}: directory accessible, attempting recovery (attempt ${entry.retryCount}/${MAX_RECOVERY_ATTEMPTS})`);
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
		}
	}
}
