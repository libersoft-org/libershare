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

export async function sha256File(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		const stream = createReadStream(path);
		stream.on('error', reject);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}
