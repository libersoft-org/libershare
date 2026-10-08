import { CodedError, ErrorCodes } from '@shared';

/**
 * Pause/resume coordination for a single download.
 *
 * Owns two orthogonal pause axes and their waiter queues:
 *
 *  1. **disable/enable** (owner-driven): the Downloader decides when it is
 *     disabled (user pause, setError, destroy). waiters block in
 *     waitIfDisabled() until the owner calls notifyStateChange().
 *     On destroy, waitIfDisabled() throws DOWNLOAD_CANCELLED.
 *
 *  2. **write-pause** (transient): the peerLoop pauses all writers while it
 *     performs mid-download recovery (ENOENT, disk-full). waiters block in
 *     waitIfWritePaused() until resumeWrites() is called.
 *
 * The owner (Downloader) still holds the primary `disabled` / `destroyed`
 * flags — this class reads them via callbacks so the truth source stays in
 * the Downloader and setError/disable/enable/destroy keep their existing
 * semantics. The controller adds correctness that was missing before:
 *
 *   - On destroy/disable, write-pause waiters are also released so they
 *     don't hang when the owner is shutting down (was Issue #19).
 *   - Draining is always done via a swap-then-iterate pattern so re-entrant
 *     push() during resolve() cannot drop or double-resolve waiters.
 */
export class PauseController {
	private enableResolvers: (() => void)[] = [];
	// Aborted when the owner stops; replaced by a fresh one once it runs again. See stopSignal.
	private stopController = new AbortController();
	private writeResolvers: (() => void)[] = [];
	/**
	 * Number of holders of the write pause, not a flag. Two independent paths pause
	 * writes — the retained-write retry cycle and missing-file recovery — and either
	 * can start while the other is mid-cycle. With a boolean, whichever finished first
	 * opened the gate for both, so a peer could see writes running, claim ownership of
	 * a retry cycle someone else already owned, and share its retry budget.
	 * Counting means the pause lifts only once the last holder has released.
	 */
	private writePauseHolders = 0;
	private _progressPaused = false;
	private readonly isDisabled: () => boolean;
	private readonly isDestroyed: () => boolean;

	constructor(isDisabled: () => boolean, isDestroyed: () => boolean) {
		this.isDisabled = isDisabled;
		this.isDestroyed = isDestroyed;
	}

	get writePaused(): boolean {
		return this.writePauseHolders > 0;
	}

	get progressPaused(): boolean {
		return this._progressPaused;
	}

	pauseWrites(): void {
		this.writePauseHolders++;
	}

	/** Release one hold. Waiters wake only once every holder has released. */
	resumeWrites(): void {
		this.writePauseHolders = Math.max(0, this.writePauseHolders - 1);
		if (this.writePauseHolders === 0) this.drainWriteResolvers();
	}

	pauseProgress(): void {
		this._progressPaused = true;
	}

	resumeProgress(): void {
		this._progressPaused = false;
	}

	/**
	 * Called by the owner AFTER mutating disabled/destroyed flags. Always drains
	 * enable-waiters (they will re-check the flags on wake-up). If the owner is
	 * now disabled or destroyed, also drains write-waiters so they don't hang.
	 */
	notifyStateChange(): void {
		this.drainEnableResolvers();
		if (this.isDisabled() || this.isDestroyed()) {
			this.stopController.abort(new CodedError(ErrorCodes.DOWNLOAD_CANCELLED));
			this.drainWriteResolvers();
		}
	}

	/**
	 * A signal that aborts once the owner is disabled or destroyed, for waits that take an
	 * AbortSignal (byte budget, rate limiter). The Downloader's own abort signal fires only on
	 * destroy, so without this a disabled download would keep waiting on capacity held by
	 * another download. After the owner runs again the next call returns a fresh signal.
	 */
	stopSignal(): AbortSignal {
		const stopped = this.isDisabled() || this.isDestroyed();
		if (stopped) this.stopController.abort(new CodedError(ErrorCodes.DOWNLOAD_CANCELLED));
		else if (this.stopController.signal.aborted) this.stopController = new AbortController();
		return this.stopController.signal;
	}

	/**
	 * Block while `disabled` is true. Throws DOWNLOAD_CANCELLED if destroyed
	 * (either already or while waiting).
	 */
	async waitIfDisabled(): Promise<void> {
		if (!this.isDisabled()) return;
		if (this.isDestroyed()) throw new CodedError(ErrorCodes.DOWNLOAD_CANCELLED);
		await new Promise<void>(resolve => {
			this.enableResolvers.push(resolve);
		});
		if (this.isDestroyed()) throw new CodedError(ErrorCodes.DOWNLOAD_CANCELLED);
	}

	/**
	 * Block while `writePaused` is true. Returns early (without blocking) if
	 * the owner is already disabled/destroyed — callers will handle the exit
	 * via their own destroyed/disabled checks right after.
	 */
	async waitIfWritePaused(): Promise<void> {
		if (this.writePauseHolders === 0) return;
		if (this.isDisabled() || this.isDestroyed()) return;
		await new Promise<void>(resolve => {
			this.writeResolvers.push(resolve);
		});
	}

	private drainEnableResolvers(): void {
		if (this.enableResolvers.length === 0) return;
		const pending = this.enableResolvers;
		this.enableResolvers = [];
		for (const resolve of pending) resolve();
	}

	private drainWriteResolvers(): void {
		if (this.writeResolvers.length === 0) return;
		const pending = this.writeResolvers;
		this.writeResolvers = [];
		for (const resolve of pending) resolve();
	}
}
