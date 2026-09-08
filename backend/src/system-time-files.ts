import { open, access, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Errors from a directory flush that mean "there is no such operation here", as opposed
 * to "it was attempted and failed".
 *
 * `EPERM` is Windows, where the directory handle opens and `fsync` on it is then refused;
 * `EISDIR` is the platforms that refuse the open itself; `EINVAL` and the two "not
 * supported" spellings are filesystems whose `fsync` rejects a directory descriptor.
 * Anything outside this set propagates.
 */
const DIRECTORY_SYNC_UNSUPPORTED: ReadonlySet<string> = new Set(['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);

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

/**
 * Replace `path` with `content` so a reader never observes a partial file, and return
 * a rollback that restores whatever was there before (deleting the file when there was
 * nothing).
 *
 * A plain `writeFile` to the final path truncates it first, so a crash or a full disk
 * mid-write leaves the live configuration truncated. Writing a sibling temporary file,
 * flushing it and renaming makes the swap atomic — and BOTH `fsync`s are needed: the one
 * on the file, or a power loss leaves the new name pointing at an empty file, and the one
 * on the directory afterwards ({@link syncDirectory}), or the name itself may never have
 * been written.
 *
 * `readOriginal` is injectable so the unreadable-original case can be exercised: a real
 * EACCES on the live file is not something a test can arrange on every platform.
 *
 * The temporary name is unique per call and created with `wx` (fail if it exists). A
 * name shared by every call — a bare pid suffix is shared by every call in one process —
 * lets a second write truncate the first one's staging file and then rename it away, so
 * the first write publishes the second's content and the second fails with ENOENT.
 */
/**
 * Create `dir` and every missing level above it, flushing the parent of each one.
 *
 * A directory entry lives in its PARENT, so that is where its durability comes from — and
 * the rule has to be applied to every level, not just the first. `mkdir(…, {recursive})`
 * answers with the first path it had to create, so flushing that path's parent alone left
 * `/root/a/b/c` with the entries for `b` and `c` unflushed: a crash comes back to a
 * drop-in directory that is not there and a configuration nothing ever read.
 *
 * Every level in the walk has its parent flushed, whether this call created it or found it
 * there. Flushing only what we created was right for a clean first pass and wrong for the
 * second: an attempt that created `b` and then failed to flush `a` leaves `b` visible but
 * not committed, and the retry sees `EEXIST`, flushes nothing and reports a durability the
 * filesystem never gave. A level that has always been there and one a dead attempt left
 * behind look exactly alike from here, so both are flushed.
 *
 * The walk stops at the first level that already exists, INCLUDING it — that one is flushed,
 * everything above it is not. It has to be included, because it is the level a previous
 * attempt may have created and failed to commit. Above it nothing is owed by any attempt of
 * OURS: this function stops at the first flush that fails, so a level we created always has
 * an unflushed parent no higher than the one just below the first existing level. What it
 * does not repair is a whole chain some other process created without flushing its own
 * parents — walking to `/` for that would fsync directories we never touch and let an error
 * from one of them fail a write that is otherwise fine, which is the worse trade.
 *
 * `dir` itself is deliberately not flushed here — it has no entry in it yet. The rename
 * that follows puts one there and flushes it.
 */
async function makeDirectoryDurably(dir: string, syncDir: (d: string) => Promise<void>): Promise<void> {
	const levels: string[] = [];
	for (let current = dir; ; current = dirname(current)) {
		levels.unshift(current);
		// A level we cannot even ask about counts as missing: the walk goes one higher and
		// `mkdir` below reports the real reason.
		const exists = await access(current).then(
			() => true,
			() => false
		);
		if (exists || dirname(current) === current) break;
	}
	for (const level of levels) {
		// One level at a time instead of `{recursive: true}`, because the recursive call
		// reports only the first path it created — and on Windows it reports it in
		// extended-length form, so the rest of the chain cannot be derived from its answer.
		// An `EEXIST` here means the level was already there; anything else (a file in the
		// way, no permission) is a real failure.
		await mkdir(level).catch((err: { code?: string }) => {
			if (err.code !== 'EEXIST') throw err;
		});
		await syncDir(dirname(level));
	}
}

/**
 * What a rollback actually achieved.
 *
 * A boolean could not say this. Restoring is a rename (or an unlink) followed by a directory
 * flush, and when only the flush fails the original file IS back on the visible filesystem —
 * just not guaranteed to survive a power loss. Folded into `false`, that told the caller
 * nothing had been restored, which was untrue, and cost the second restart that puts the
 * daemon back onto the configuration it was running with.
 */
export type RollbackResult = { state: 'restored-durable' } | { state: 'restored-not-durable'; error: unknown } | { state: 'not-restored'; error: unknown };

export async function writeFileAtomically(path: string, content: string, readOriginal: (p: string) => Promise<string> = p => readFile(p, 'utf8'), syncDir: (dir: string) => Promise<void> = syncDirectory): Promise<() => Promise<RollbackResult>> {
	// ENOENT is the ONLY error that means "there was nothing here". Reading every other
	// one — EACCES, EIO, EISDIR — as absence hands the rollback a `previous` of null, and
	// null makes it DELETE the file: a permission fault on a live configuration would
	// have the rollback remove it rather than restore it. An unknown original means the
	// write cannot be undone, so it does not happen at all.
	const previous = await readOriginal(path).catch((err: { code?: string }) => {
		if (err.code === 'ENOENT') return null;
		throw err;
	});
	await makeDirectoryDurably(dirname(path), syncDir);
	// Same directory, or the rename would cross a filesystem boundary and stop being atomic.
	const temp = `${path}.libershare-${process.pid}-${randomUUID()}.tmp`;
	let renamed = false;
	try {
		// `wx`, not `w`: an existing name is a collision to report, never one to overwrite.
		const handle = await open(temp, 'wx');
		try {
			await handle.writeFile(content, 'utf8');
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, path);
		renamed = true;
		await syncDir(dirname(path));
	} catch (err) {
		// Only up to the rename is the temporary file the thing to remove. Afterwards it IS
		// the live file under its final name, so unlinking it would delete the configuration —
		// and there is nothing to undo anyway: the content is published, and only the
		// durability of its NAME is in doubt. The flag says which of the two the caller has,
		// because "nothing happened" and "it happened and may not survive a power loss" are
		// different things to tell a user.
		if (!renamed) {
			await unlink(temp).catch(() => {});
			throw err;
		}
		throw Object.assign(err as object, { published: true });
	}
	// Reports whether the previous state is actually back. Swallowing that told the caller
	// the host had been left as it was found while the new configuration was still on disk,
	// to be adopted at the next boot — long after the user was told nothing had happened.
	return async (): Promise<RollbackResult> => {
		// Set once the visible filesystem already holds the original state, so a directory
		// flush failing after that point is a durability warning and not a failed restore.
		let visible = false;
		try {
			const current = await readOriginal(path).catch((err: { code?: string }) => {
				if (err.code === 'ENOENT') return null;
				throw err;
			});
			// The process lock cannot protect edits made by another administrator.
			// This check preserves observed foreign changes, but is not an atomic filesystem CAS.
			if (current !== content && !(previous === null && current === null)) throw new Error('the time configuration changed after this operation wrote it; it was left untouched');
			if (previous !== null) {
				await writeFileAtomically(
					path,
					previous,
					async target => {
						const latest = await readOriginal(target);
						if (latest !== content) throw new Error('the time configuration changed before restoration; it was left untouched');
						return latest;
					},
					syncDir
				);
			} else {
				// Already gone is the state being restored to, not a failure.
				await unlink(path).catch((err: { code?: string }) => (err.code === 'ENOENT' ? undefined : Promise.reject(err)));
				visible = true;
				// The removal is a directory change like the rename was, and buffered the same
				// way: without this a crash can bring the entry back and with it the drop-in
				// this rollback exists to withdraw.
				await syncDir(dirname(path));
			}
			return { state: 'restored-durable' };
		} catch (err) {
			// The nested write marks its own published-but-unflushed failure the same way the
			// outer one does, and it means the same thing here: the original content reached
			// its final name and only the flush behind it did not.
			if (visible || (err as { published?: boolean }).published === true) return { state: 'restored-not-durable', error: err };
			return { state: 'not-restored', error: err };
		}
	};
}
