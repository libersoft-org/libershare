import { open, access, mkdir, readFile, realpath, rename, stat, unlink, lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { constants, type BigIntStats } from 'node:fs';
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
		let created = false;
		try {
			await mkdir(level, { mode: 0o755 });
			created = true;
		} catch (err) {
			if ((err as { code?: string }).code !== 'EEXIST') throw err;
		}
		if (created && process.platform !== 'win32') await prepareCreatedDirectory(level);
		await syncDir(dirname(level));
	}
}

/** Correct restrictive umasks only on directories this operation created, using the opened inode. */
async function prepareCreatedDirectory(path: string): Promise<void> {
	const created = await lstat(path, { bigint: true });
	const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const opened = await handle.stat({ bigint: true });
		if (!created.isDirectory() || created.dev !== opened.dev || created.ino !== opened.ino) throw new Error('the new time configuration directory changed before its permissions were set');
		await handle.chmod(0o755);
		await handle.sync().catch((error: { code?: string }) => {
			if (!DIRECTORY_SYNC_UNSUPPORTED.has(error.code ?? '')) throw error;
		});
	} finally {
		await handle.close();
	}
}

interface FileMetadata {
	dev: bigint;
	ino: bigint;
	mode: number;
	uid: number;
	gid: number;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}
interface FileSnapshot extends FileMetadata {
	content: string;
}
function metadata(stats: BigIntStats): FileMetadata {
	return { dev: stats.dev, ino: stats.ino, mode: Number(stats.mode & 0o7777n), uid: Number(stats.uid), gid: Number(stats.gid), size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs };
}
async function readMetadata(path: string): Promise<FileMetadata | null> {
	try {
		const stats = await lstat(path, { bigint: true });
		if (!stats.isFile()) throw new Error('the time configuration is not a regular file');
		return metadata(stats);
	} catch (error) {
		if ((error as { code?: string }).code === 'ENOENT') return null;
		throw error;
	}
}
function sameFile(left: FileMetadata | null, right: FileMetadata | null): boolean {
	return left === null || right === null ? left === right : left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
}
/**
 * The same file AND untouched since it was measured.
 *
 * {@link sameFile} answers identity only — device, inode, mode, ownership — which an edit
 * made in place does not change: `writeFile` truncates the existing inode, so a check built
 * on identity alone waved an administrator's rewrite straight through. Size and the two
 * timestamps are what make it an unchanged-since test rather than a same-name test.
 */
function unchangedSince(current: FileMetadata | null, expected: FileMetadata | null): boolean {
	if (!sameFile(current, expected)) return false;
	return current?.size === expected?.size && current?.mtimeNs === expected?.mtimeNs && current?.ctimeNs === expected?.ctimeNs;
}

async function readSnapshot(path: string, readOriginal: (path: string) => Promise<string>): Promise<FileSnapshot | null> {
	const before = await readMetadata(path);
	const content = await readOriginal(path).catch((error: { code?: string }) => {
		if (error.code === 'ENOENT') return null;
		throw error;
	});
	const after = await readMetadata(path);
	if (!sameFile(before, after) || before?.size !== after?.size || before?.mtimeNs !== after?.mtimeNs || before?.ctimeNs !== after?.ctimeNs || (content === null) !== (after === null)) throw new Error('the time configuration changed while it was being read');
	return after === null || content === null ? null : { ...after, content };
}

/**
 * Why an unprivileged service could not read `path`, or null when it can.
 *
 * The file is written by this process, which is root on the hosts that can set the clock at
 * all — and the daemon that has to READ it is not. `systemd-timesyncd` ships with
 * `User=systemd-timesync` (checked on a running systemd 255), so a drop-in directory an
 * administrator left at 0700 root is invisible to it while every check made from here
 * succeeds: the file is there, its content is right, and `systemd-analyze cat-config` reads
 * it back happily. The save is then reported as applied and the daemon goes on using the
 * old server — the exact class of silent failure the effective-configuration check exists
 * to prevent, arriving through the one door that check does not cover.
 *
 * Directories this operation creates are 0755 already; this is about the ones it finds and
 * deliberately does not widen. Reporting the problem is the fix, not loosening somebody
 * else's permissions behind their back.
 *
 * The walk runs over the RESOLVED path, not over the names as written. `stat` alone was
 * not enough: it answers for what each name points at, but the walk then climbed the
 * WRITTEN parent, so a link's own ancestors were never asked about. With
 * `timesyncd.conf.d` a link to `/opt/private/time-config`, the 0755 target passed and the
 * 0700 `/opt/private` above it — the directory that actually blocks the daemon — was never
 * looked at. Reproduced: this returned "no problem" while a real read as another user got
 * EACCES. Resolving first makes the chain the one the kernel walks.
 *
 * Approximated through the OTHER bits, because the service account is neither the owner nor,
 * on any ordinary host, in the owning group. That can only err towards refusing a
 * configuration that would in fact have worked, which is the harmless direction: the user is
 * told why rather than told a lie.
 */
export async function unreadableByServiceAccount(path: string): Promise<string | null> {
	// Resolved before the climb, and the file's own target too — the drop-in may itself be a
	// link somewhere else entirely. An unresolvable path is left to the write to report.
	const resolved =
		(await realpath(path).catch(() => null)) ??
		(await realpath(dirname(path))
			.then(dir => join(dir, basename(path)))
			.catch(() => null));
	if (resolved === null) return null;
	const parts: string[] = [];
	for (let current = dirname(resolved); ; current = dirname(current)) {
		parts.unshift(current);
		if (dirname(current) === current) break;
	}
	for (const directory of parts) {
		const stats = await stat(directory).catch(() => null);
		// Unreadable to us is not evidence about anyone else; leave that to the write itself.
		if (!stats) return null;
		if ((stats.mode & 0o001) === 0) return `${directory} cannot be entered by the time service's own account`;
	}
	const file = await stat(resolved).catch(() => null);
	if (file && (file.mode & 0o004) === 0) return `${resolved} cannot be read by the time service's own account`;
	return null;
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
	return publishFile(path, content, { mode: 0o644 }, readOriginal, syncDir);
}

async function publishFile(path: string, content: string, permissions: { mode: number; uid?: number; gid?: number }, readOriginal: (path: string) => Promise<string>, syncDir: (dir: string) => Promise<void>, expected?: FileMetadata | null): Promise<() => Promise<RollbackResult>> {
	const previous = await readSnapshot(path, readOriginal);
	// The first write guards the same window the rollback does. It was left open on the way
	// IN: the original is read, the replacement is staged, and an edit landing between the two
	// was overwritten without a word — and then the rollback, which does check, faithfully
	// restored the content from before that edit, so the administrator's change was gone twice
	// over. `expected` defaults to what was just read, which refuses only a change made DURING
	// this call; replacing a file that was already different is still the whole point.
	const guard = expected === undefined ? previous : expected;
	await makeDirectoryDurably(dirname(path), syncDir);
	// Same directory, or the rename would cross a filesystem boundary and stop being atomic.
	const temp = `${path}.libershare-${process.pid}-${randomUUID()}.tmp`;
	let renamed = false;
	let written: FileMetadata;
	// Measured AFTER the swap, not on the staging file: the rename itself moves ctime, so a
	// staged measurement compares unequal to the very file it just published.
	let published: FileMetadata | null = null;
	try {
		// `wx`, not `w`: an existing name is a collision to report, never one to overwrite.
		const handle = await open(temp, 'wx');
		try {
			await handle.writeFile(content, 'utf8');
			if (process.platform !== 'win32' && permissions.uid !== undefined && permissions.gid !== undefined) {
				const owner = await handle.stat();
				if (owner.uid !== permissions.uid || owner.gid !== permissions.gid) await handle.chown(permissions.uid, permissions.gid);
			}
			// chown can clear permission bits, so restore/set the mode after ownership and before fsync.
			await handle.chmod(permissions.mode);
			await handle.sync();
			written = metadata(await handle.stat({ bigint: true }));
		} finally {
			await handle.close();
		}
		// Re-checked HERE, immediately before the swap, and not only when the operation began.
		// Staging the replacement takes a create, a write, an fsync and a close, and an edit
		// landing anywhere in that stretch was overwritten by a rollback that then reported a
		// clean restore. This narrows the window to the gap between the check and the rename;
		// it does not close it. There is no compare-and-swap for a rename on POSIX, so the
		// honest claim is "an observed change is preserved", never "no concurrent writer can
		// lose an edit".
		// NOT `.catch(() => null)`. `readMetadata` answers null for a genuine absence and throws
		// for everything else — including a path that is no longer a regular file. Swallowing
		// that turned "an administrator just put a symlink here" into "nothing is here", which
		// matched the absence this write started from, so the rename went ahead and replaced the
		// link with our file. Reproduced: a regular file created at the same instant was
		// correctly refused while a symlink was not.
		if (!unchangedSince(await readMetadata(path), guard)) throw new Error('the time configuration changed while this operation was staging its replacement; it was left untouched');
		await rename(temp, path);
		renamed = true;
		published = await readMetadata(path).catch(() => null);
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
			const current = await readSnapshot(path, readOriginal);
			// Preserve observed content, inode, permission or ownership changes made outside our lock.
			// This remains a checked update, not an atomic filesystem compare-and-swap.
			if (current === null ? previous !== null : current.content !== content || !sameFile(current, written)) throw new Error('the time configuration changed after this operation wrote it; it was left untouched');
			if (previous !== null) {
				await publishFile(
					path,
					previous.content,
					previous,
					async target => {
						const latest = await readOriginal(target);
						if (latest !== content || !sameFile(await readMetadata(target), written)) throw new Error('the time configuration changed before restoration; it was left untouched');
						return latest;
					},
					syncDir,
					published
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
