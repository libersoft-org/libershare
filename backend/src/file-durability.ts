import { open } from 'node:fs/promises';

/**
 * Errors from a directory flush that mean "there is no such operation here", as opposed
 * to "it was attempted and failed".
 *
 * `EPERM` is Windows, where the directory handle opens and `fsync` on it is then refused;
 * `EISDIR` is the platforms that refuse the open itself; `EINVAL` and the two "not
 * supported" spellings are filesystems whose `fsync` rejects a directory descriptor.
 * Anything outside this set propagates.
 */
export const DIRECTORY_SYNC_UNSUPPORTED: ReadonlySet<string> = new Set(['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);

/**
 * Flush a directory's own contents so a name created in it survives a power loss.
 *
 * `fsync` on the FILE only commits its data; the entry that gives it its name lives in the
 * directory and is buffered just like everything else. Without this a crash moments after
 * the rename can come back to the old file, or to no file at all — the one outcome the
 * atomic swap exists to rule out.
 *
 * A platform that has no such operation refuses here, and that is not a failure: Windows
 * journals the metadata itself, which is the same guarantee by other means. Every OTHER
 * error is a flush that was attempted and did not happen — `EIO` and `ENOSPC` say the
 * metadata is not reliably stored — and swallowing those reported a durability the
 * filesystem had just declined to provide.
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
