import { open } from 'node:fs/promises';

/**
 * Errors from a directory flush that mean "there is no such operation here", as opposed
 * to "it was attempted and failed".
 *
 * `EPERM` can occur on Windows when opening or syncing a directory;
 * `EISDIR` is the platforms that refuse the open itself; `EINVAL` and the two "not
 * supported" spellings are filesystems whose `fsync` rejects a directory descriptor.
 * Anything outside this set propagates.
 */
export const DIRECTORY_SYNC_UNSUPPORTED: ReadonlySet<string> = new Set(['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);

/**
 * Flush directory metadata after replacing a file, where the filesystem supports it.
 *
 * Syncing the file does not also confirm that its directory entry reached stable storage.
 * An atomic rename prevents a partially replaced file during normal operation; it does
 * not by itself guarantee that the latest replacement survives an immediate power loss.
 *
 * Unsupported directory sync is tolerated without confirming metadata durability.
 * This does not establish an equivalent power-loss guarantee on Windows. Other errors,
 * including EIO and ENOSPC, propagate to the caller.
 */
export async function syncDirectory(dir: string): Promise<void> {
	try {
		const handle = await open(dir, 'r');
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (err) {
		if (!DIRECTORY_SYNC_UNSUPPORTED.has((err as { code?: string }).code ?? '')) throw err;
	}
}
