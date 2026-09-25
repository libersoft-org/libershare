import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

declare const LISH_NETWORK_HELPER_SHA256: string | undefined;

export function expectedNetworkHelperHash(): string | null {
	const value = typeof LISH_NETWORK_HELPER_SHA256 === 'string' ? LISH_NETWORK_HELPER_SHA256.toLowerCase() : '';
	return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/** One file as the trust check identifies it: the path plus everything that changes when it does. */
export interface TrustedFileIdentity {
	readonly path: string;
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
	readonly ino: number | bigint;
}

/**
 * The identity of a set of binaries as one comparable string, so a verification that
 * already passed can be recognised instead of repeated.
 *
 * The point is cost: verifying the Windows chain re-reads three single-file builds of a
 * runtime, roughly a third of a gigabyte, and measured on an idle test machine that is
 * 9-14 seconds on EVERY save — which the user experiences as a screen that does nothing
 * before the elevation prompt appears. Worse, after the host clock was set the same read
 * took 167 seconds while holding the system-time lock, so the next save timed out and the
 * screen could not even show the current status.
 *
 * Path, size, both timestamps and the inode change whenever the file does, so an identity
 * that matches is the same file. It is not a substitute for the verification: replacing
 * these binaries requires writing to Program Files, which is administrator-only, and that
 * is the trust boundary the location check already relies on (see the note on
 * `windowsInstalledSibling`). Within one process run, an unchanged identity is therefore
 * as good as the check that passed on it.
 */
export function trustIdentity(files: readonly TrustedFileIdentity[]): string {
	return files.map(file => `${file.path.toLowerCase()}|${file.size}|${file.mtimeMs}|${file.ctimeMs}|${file.ino}`).join(';');
}

/** Upper bound on one helper hash read; a shorter remaining budget takes precedence. */
export const HASH_READ_LIMIT_MS = 10_000;

/**
 * The helper could not be verified in time — the read ran out of time or was cancelled. Not a
 * verdict about the helper: a hash that does not match stays a plain "untrusted".
 */
export class HelperVerificationTimeoutError extends Error {
	constructor(message: string = 'verifying the privileged helper took too long') {
		super(message);
		this.name = 'HelperVerificationTimeoutError';
	}
}

/**
 * SHA-256 of a file, read within `timeoutMs` (at most {@link HASH_READ_LIMIT_MS}) and
 * cancellable through `signal`. On timeout or cancellation the read is stopped, not merely
 * abandoned, and the promise rejects with {@link HelperVerificationTimeoutError}; a late end
 * or error of the stream is ignored.
 */
export function sha256File(path: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const limit = Math.max(0, Math.min(options.timeoutMs ?? HASH_READ_LIMIT_MS, HASH_READ_LIMIT_MS));
		const hash = createHash('sha256');
		const stream = createReadStream(path);
		let settled = false;
		const finish = (outcome: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener('abort', onAbort);
			outcome();
		};
		const stop = (): void =>
			finish(() => {
				stream.destroy();
				reject(new HelperVerificationTimeoutError());
			});
		const onAbort = (): void => stop();
		const timer = setTimeout(stop, limit);
		if (options.signal?.aborted) return stop();
		options.signal?.addEventListener('abort', onAbort, { once: true });
		stream.on('error', error => finish(() => reject(error)));
		stream.on('data', chunk => hash.update(chunk));
		stream.on('end', () => finish(() => resolve(hash.digest('hex'))));
	});
}
