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
	private writeResolvers: (() => void)[] = [];
	private _writePaused = false;
	private _progressPaused = false;
	private readonly isDisabled: () => boolean;
	private readonly isDestroyed: () => boolean;

	constructor(isDisabled: () => boolean, isDestroyed: () => boolean) {
		this.isDisabled = isDisabled;
		this.isDestroyed = isDestroyed;
	}

	get writePaused(): boolean {
		return this._writePaused;
	}

	get progressPaused(): boolean {
		return this._progressPaused;
	}

	pauseWrites(): void {
		this._writePaused = true;
	}

	resumeWrites(): void {
		this._writePaused = false;
		this.drainWriteResolvers();
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
		if (this.isDisabled() || this.isDestroyed()) this.drainWriteResolvers();
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
		if (!this._writePaused) return;
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
