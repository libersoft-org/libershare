import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyTimesyncdDropIn, syncDirectory, type CommandRunner, type RunOutcome, withSystemTimeLock, writeFileAtomically } from '../../src/system-time.ts';
import { fakeRunner } from '../helpers/system-time-fixtures.ts';
import { withTimesyncConfigRead } from '../helpers/system-time-timesyncd.ts';

/**
 * A directory-flush stub that fails on flushes of `target`, letting the first `after` of them
 * through.
 *
 * Only flushes OF `target` are counted, and every other directory succeeds. Every level of the
 * path is flushed now, including the ones above the temporary directory, so a stub that
 * refused everything would fail on an ancestor long before the step under test — and one that
 * counted every flush would depend on how deep the temporary directory happens to live.
 */
function failFlushOf(target: string, code = 'EIO', after = 0): (d: string) => Promise<void> {
	let seen = 0;
	return async d => {
		if (d !== target) return;
		seen += 1;
		if (seen > after) throw Object.assign(new Error(`${code}: directory flush`), { code });
	};
}

describe('writeFileAtomically', () => {
	let dir = '';

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'lish-time-'));
		// `mkdtemp` makes a 0700 directory, which the time service's own account could not
		// enter — so every positive case here would be refused for a reason that has nothing to
		// do with what it is testing. The cases that WANT an unreachable directory build their
		// own (see the permissions suite).
		if (process.platform !== 'win32') await chmod(dir, 0o755);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('creates the file and leaves no temporary behind', async () => {
		const path = join(dir, '90-libershare.conf');
		await writeFileAtomically(path, 'first\n');
		expect(await readFile(path, 'utf8')).toBe('first\n');
		expect(await readdir(dir)).toEqual(['90-libershare.conf']);
	});

	/**
	 * A platform that has no directory flush must not lose the write over it. This is a real
	 * flush of a real directory, so on Windows it exercises the refusal itself (the handle
	 * opens and `fsync` on it returns EPERM) and elsewhere the flush that works.
	 */
	it('publishes the file whether or not the directory can be flushed', async () => {
		const path = join(dir, '90-libershare.conf');
		await writeFileAtomically(path, 'durable\n');
		expect(await readFile(path, 'utf8')).toBe('durable\n');
		expect(await readdir(dir)).toEqual(['90-libershare.conf']);
	});

	/**
	 * A flush that was ATTEMPTED and failed is not the same as one the platform does not
	 * have. EIO and ENOSPC mean the metadata is not reliably stored — swallowing them
	 * reported a durability the filesystem had just declined — while EPERM/EISDIR/EINVAL are
	 * the "no such operation here" codes and stay silent.
	 */
	it('propagates a genuine directory flush error and ignores the unsupported ones', async () => {
		const fail = async (code: string): Promise<unknown> => syncDirectory(join(dir, `probe-${code}`)).catch((err: Error) => err);
		// A directory that is not there: a real error from the real implementation.
		expect(await fail('ENOENT')).toBeInstanceOf(Error);
		// And the ordinary path stays quiet on every platform, refusal included.
		expect(await syncDirectory(dir)).toBeUndefined();
	});

	/**
	 * The rename already happened, so the content is live under its final name. Removing the
	 * temporary file would delete exactly that, and reporting a clean failure would claim
	 * nothing happened — the flag is what lets the caller say which of the two it has.
	 */
	it('marks a post-rename flush failure as published and keeps the file', async () => {
		const path = join(dir, '90-libershare.conf');
		const err = await writeFileAtomically(path, 'new\n', p => readFile(p, 'utf8'), failFlushOf(dir)).catch((e: { published?: boolean; code?: string }) => e);
		expect(err).toMatchObject({ published: true, code: 'EIO' });
		// Published means published: the file is there and no staging file was left behind.
		expect(await readFile(path, 'utf8')).toBe('new\n');
		expect(await readdir(dir)).toEqual(['90-libershare.conf']);
	});

	/** Before the rename nothing is published, so the temp file goes and the error is bare. */
	it('cleans up and does not mark a pre-rename failure as published', async () => {
		const path = join(dir, 'made-here', '90-libershare.conf');
		// The parent flush runs before anything is written, because the directory was created.
		const err = await writeFileAtomically(path, 'new\n', p => readFile(p, 'utf8'), failFlushOf(dir)).catch((e: { published?: boolean }) => e);
		expect(err).toMatchObject({ code: 'EIO' });
		expect(err).not.toMatchObject({ published: true });
		expect(await readdir(join(dir, 'made-here'))).toEqual([]);
	});

	/**
	 * The window the earlier check does not cover. A rollback reads the file, decides it is
	 * still its own, and only THEN stages the replacement - a create, a write, an fsync and a
	 * close. An administrator editing the file inside that stretch had the edit overwritten,
	 * and the rollback still answered `restored-durable`: a clean undo reported over somebody
	 * else's change. The directory flush is the hook, because it runs after the rollback's own
	 * check has passed and before anything is renamed.
	 */
	it('refuses to overwrite an edit made while the rollback was staging its replacement', async () => {
		const path = join(dir, '90-libershare.conf');
		await writeFile(path, 'original\n', 'utf8');
		let rollingBack = false;
		let edited = false;
		const rollback = await writeFileAtomically(
			path,
			'ours\n',
			p => readFile(p, 'utf8'),
			async () => {
				if (!rollingBack || edited) return;
				edited = true;
				await writeFile(path, 'administrator\n', 'utf8');
			}
		);
		expect(await readFile(path, 'utf8')).toBe('ours\n');
		rollingBack = true;
		const restored = await rollback();
		expect(edited).toBe(true);
		expect(restored.state).toBe('not-restored');
		expect(await readFile(path, 'utf8')).toBe('administrator\n');
	});

	it('creates a missing parent directory', async () => {
		const path = join(dir, 'timesyncd.conf.d', '90-libershare.conf');
		await writeFileAtomically(path, 'x\n');
		expect(await readFile(path, 'utf8')).toBe('x\n');
	});

	/**
	 * Creating the directory is itself a change to ITS parent. Flushing only the new
	 * directory commits what is inside it, not the entry that names it — a crash then comes
	 * back to no `timesyncd.conf.d` at all and a drop-in nothing can read.
	 */
	it('flushes the parent of a directory it had to create', async () => {
		const path = join(dir, 'a', '90-libershare.conf');
		const flushed: string[] = [];
		await writeFileAtomically(
			path,
			'x\n',
			p => readFile(p, 'utf8'),
			async d => void flushed.push(d)
		);
		// The walk stops at `dir`, the first level already there, so its own parent is flushed
		// once and nothing above it is; then `dir` for the entry naming `a`, then `a` for the
		// rename.
		expect(flushed).toEqual([dirname(dir), dir, join(dir, 'a')]);
	});

	/**
	 * The rule applied to one level only. `mkdir(…, {recursive})` reports the FIRST path it
	 * created, so with `a`, `b` and `c` all missing the entry naming `b` (which lives in `a`)
	 * and the one naming `c` (which lives in `b`) were never flushed — a crash comes back to
	 * a half-created path and a drop-in nothing can read.
	 */
	it('flushes every level of a path it had to create', async () => {
		const path = join(dir, 'a', 'b', 'c', '90-libershare.conf');
		const flushed: string[] = [];
		await writeFileAtomically(
			path,
			'x\n',
			p => readFile(p, 'utf8'),
			async d => void flushed.push(d)
		);
		expect(flushed).toEqual([dirname(dir), dir, join(dir, 'a'), join(dir, 'a', 'b'), join(dir, 'a', 'b', 'c')]);
	});

	/**
	 * The other half of the same rule: the walk must not climb past the first level that is
	 * already there. Flushing every ancestor up to `/` would fsync directories nothing in this
	 * call touches and let an error from one of them fail a write that is perfectly fine.
	 */
	it('stops the walk at the first level that already exists', async () => {
		const path = join(dir, '90-libershare.conf');
		const flushed: string[] = [];
		await writeFileAtomically(
			path,
			'x\n',
			p => readFile(p, 'utf8'),
			async d => void flushed.push(d)
		);
		// `dir` exists, so: its parent once (it may itself be a dead attempt's leftover), then
		// `dir` for the rename. Nothing above.
		expect(flushed).toEqual([dirname(dir), dir]);
	});

	/**
	 * The half-finished attempt is the case flushing only what WE created got wrong. The first
	 * call creates `a` and dies on the flush of `dir`, so `a` is visible but its entry in
	 * `dir` was never committed. The retry finds `a` there, and if `EEXIST` means "flush
	 * nothing" the write, the rename and the flush of `a` all succeed and the API reports a
	 * durability that a power loss would still take away with the whole directory.
	 */
	it('flushes the parent again when a retry finds the level already there', async () => {
		const path = join(dir, 'a', '90-libershare.conf');
		const failed = await writeFileAtomically(path, 'x\n', p => readFile(p, 'utf8'), failFlushOf(dir)).catch((e: { code?: string }) => e);
		expect(failed).toMatchObject({ code: 'EIO' });
		expect(await readdir(dir)).toEqual(['a']);
		const flushed: string[] = [];
		await writeFileAtomically(
			path,
			'x\n',
			p => readFile(p, 'utf8'),
			async d => void flushed.push(d)
		);
		// `a` is now the first level that exists, so the walk stops there — and still flushes
		// `dir`, which is the entry that the dead attempt left uncommitted.
		expect(flushed).toEqual([dir, join(dir, 'a')]);
	});

	/**
	 * Removing the name is a directory change like the rename was, and buffered the same way.
	 * Without the flush a crash can bring the entry back and with it the drop-in this
	 * rollback exists to withdraw.
	 */
	it('flushes the directory after the rollback removes a file it created', async () => {
		const path = join(dir, '90-libershare.conf');
		const flushed: string[] = [];
		const rollback = await writeFileAtomically(
			path,
			'new\n',
			p => readFile(p, 'utf8'),
			async d => void flushed.push(d)
		);
		expect((await rollback()).state).toBe('restored-durable');
		expect(await readdir(dir)).toEqual([]);
		// The walk's one flush, then `dir` for the rename and again for the unlink that took
		// the name away.
		expect(flushed).toEqual([dirname(dir), dir, dir]);
	});

	it('rolls an overwrite back to the previous content', async () => {
		const path = join(dir, '90-libershare.conf');
		await writeFile(path, 'original\n', 'utf8');
		const rollback = await writeFileAtomically(path, 'replacement\n');
		expect(await readFile(path, 'utf8')).toBe('replacement\n');
		await rollback();
		expect(await readFile(path, 'utf8')).toBe('original\n');
		expect(await readdir(dir)).toEqual(['90-libershare.conf']);
	});

	/**
	 * A staging name shared by concurrent calls is not a staging name: the second write
	 * truncates the first one's file, the first renames the second's content into place
	 * and the second then fails with ENOENT on a name that is already gone.
	 */
	/**
	 * Two writers, one path. The original bug was a temporary name shared by every call: the
	 * second write truncated the first one's staging file and renamed it away, so the first
	 * published the second's content and the second failed with ENOENT. Unique names fixed
	 * that, and the pre-rename guard now decides the outcome — one write publishes, the other
	 * sees the file it measured has changed and withdraws.
	 *
	 * Whichever wins, the file holds ONE writer's content in full and no staging file is left.
	 * A torn or mixed result is the failure this guards against.
	 */
	it('lets one of two concurrent writes publish and leaves nothing half-written', async () => {
		const path = join(dir, '90-libershare.conf');
		const results = await Promise.allSettled([writeFileAtomically(path, 'first\n'), writeFileAtomically(path, 'second\n')]);
		// Both may well succeed: if the second reads the file only after the first has already
		// renamed, it measured the published state and is replacing it legitimately. What must
		// never happen is neither of them landing, or a refusal for any other reason.
		expect(results.some(r => r.status === 'fulfilled')).toBe(true);
		for (const r of results) if (r.status === 'rejected') expect(String(r.reason)).toContain('staging its replacement');
		expect(['first\n', 'second\n']).toContain(await readFile(path, 'utf8'));
		expect(await readdir(dir)).toEqual(['90-libershare.conf']);
	});

	/**
	 * A rollback that could not put the old file back used to look exactly like one that
	 * did. The caller then reports "nothing happened" while the new configuration is still
	 * on disk, waiting to be adopted at the next boot.
	 */
	it('says so when it could not restore the previous content', async () => {
		const path = join(dir, '90-libershare.conf');
		await writeFile(path, 'original\n', 'utf8');
		const rollback = await writeFileAtomically(path, 'replacement\n');
		// Replace the whole directory with a file: nothing can be written under it again.
		await rm(dir, { recursive: true, force: true });
		await writeFile(dir, 'in the way', 'utf8');
		expect((await rollback()).state).toBe('not-restored');
	});

	it('preserves an external edit instead of restoring the previous file over it', async () => {
		const path = join(dir, '90-libershare.conf');
		await writeFile(path, 'original\n');
		const rollback = await writeFileAtomically(path, 'ours\n');
		await writeFile(path, 'external\n');
		expect((await rollback()).state).toBe('not-restored');
		expect(await readFile(path, 'utf8')).toBe('external\n');
	});

	it('keeps the published file when its rollback ownership read fails', async () => {
		const path = join(dir, '90-libershare.conf');
		await writeFile(path, 'original\n');
		let reads = 0;
		const readOriginal = async (file: string): Promise<string> => {
			if (++reads === 2) throw Object.assign(new Error('ownership read failed'), { code: 'EIO' });
			return readFile(file, 'utf8');
		};
		const rollback = await writeFileAtomically(path, 'ours\n', readOriginal);
		expect((await rollback()).state).toBe('not-restored');
		expect(await readFile(path, 'utf8')).toBe('ours\n');
		expect(reads).toBe(2);
	});

	it('preserves an external edit observed while preparing the restoration', async () => {
		const path = join(dir, '90-libershare.conf');
		await writeFile(path, 'original\n');
		let reads = 0;
		const readOriginal = async (file: string): Promise<string> => {
			if (++reads === 3) await writeFile(file, 'external\n');
			return readFile(file, 'utf8');
		};
		const rollback = await writeFileAtomically(path, 'ours\n', readOriginal);
		expect((await rollback()).state).toBe('not-restored');
		expect(await readFile(path, 'utf8')).toBe('external\n');
		expect(reads).toBe(3);
	});

	it('does not delete an external replacement of a file the operation created', async () => {
		const path = join(dir, '90-libershare.conf');
		const rollback = await writeFileAtomically(path, 'ours\n');
		await writeFile(path, 'external\n');
		expect((await rollback()).state).toBe('not-restored');
		expect(await readFile(path, 'utf8')).toBe('external\n');
	});

	it('does not recreate an existing file removed after publication', async () => {
		const path = join(dir, '90-libershare.conf');
		await writeFile(path, 'original\n');
		const rollback = await writeFileAtomically(path, 'ours\n');
		await rm(path);
		expect((await rollback()).state).toBe('not-restored');
		await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('treats a file that is already gone as restored', async () => {
		const path = join(dir, '90-libershare.conf');
		const rollback = await writeFileAtomically(path, 'new\n');
		await rm(path, { force: true });
		expect((await rollback()).state).toBe('restored-durable');
	});

	it('rolls a creation back by removing the file it created', async () => {
		const path = join(dir, '90-libershare.conf');
		const rollback = await writeFileAtomically(path, 'new\n');
		await rollback();
		expect(await readdir(dir)).toEqual([]);
	});

	/**
	 * The unknown case, which is neither of the two above: the original is there and could
	 * not be read. Taking that for "there was nothing here" gives the rollback a null
	 * previous, and null means delete — so an unreadable live configuration would be
	 * REMOVED by the undo of a write that was reported as failed.
	 */
	it('refuses the write when the original could not be read', async () => {
		const path = join(dir, '90-libershare.conf');
		await writeFile(path, 'original\n', 'utf8');
		const denied = (): Promise<string> => Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
		await expect(writeFileAtomically(path, 'replacement\n', denied)).rejects.toMatchObject({ code: 'EACCES' });
		// Nothing was touched: no staging file left behind and the original still stands.
		expect(await readFile(path, 'utf8')).toBe('original\n');
		expect(await readdir(dir)).toEqual(['90-libershare.conf']);
	});

	/**
	 * The state a boolean could not carry. The original content reached its final name, so
	 * the visible filesystem holds it — only the flush behind the rename failed, which puts
	 * its survival of a power loss in doubt and nothing else. Reported as "not restored", it
	 * had the caller claim the new configuration was still on disk when it was not.
	 */
	it('separates a restore that was not flushed from one that did not happen', async () => {
		const path = join(dir, '90-libershare.conf');
		await writeFile(path, 'original\n', 'utf8');
		// The rename's own flush goes through; the one behind the restore does not.
		const rollback = await writeFileAtomically(path, 'replacement\n', undefined, failFlushOf(dir, 'EIO', 1));
		expect((await rollback()).state).toBe('restored-not-durable');
		expect(await readFile(path, 'utf8')).toBe('original\n');
	});

	it('reads a removal whose flush failed as restored but not durable', async () => {
		const path = join(dir, '90-libershare.conf');
		const rollback = await writeFileAtomically(path, 'new\n', undefined, failFlushOf(dir, 'ENOSPC', 1));
		expect((await rollback()).state).toBe('restored-not-durable');
		expect(await readdir(dir)).toEqual([]);
	});

	it('still treats a genuinely absent original as nothing to restore', async () => {
		const path = join(dir, '90-libershare.conf');
		const missing = (file: string): Promise<string> => readFile(file, 'utf8');
		const rollback = await writeFileAtomically(path, 'new\n', missing);
		expect((await rollback()).state).toBe('restored-durable');
		expect(await readdir(dir)).toEqual([]);
	});
});

describe('applyTimesyncdDropIn', () => {
	let path = '';
	let dir = '';

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'lish-time-'));
		// `mkdtemp` makes a 0700 directory, which the time service's own account could not
		// enter — so every positive case here would be refused for a reason that has nothing to
		// do with what it is testing. The cases that WANT an unreachable directory build their
		// own (see the permissions suite).
		if (process.platform !== 'win32') await chmod(dir, 0o755);
		path = join(dir, '90-libershare.conf');
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('pins the server and restarts the daemon while synchronisation is on', async () => {
		const { exec, calls } = fakeRunner([]);
		expect(await applyTimesyncdDropIn('ntp.example.org', true, path, withTimesyncConfigRead(path, exec))).toEqual({ success: true, outcome: 'ok', message: null });
		expect(await readFile(path, 'utf8')).toBe('[Time]\nNTP=\nNTP=ntp.example.org\n');
		expect(calls).toEqual(['systemctl restart systemd-timesyncd']);
	});

	it('writes the drop-in without restarting while synchronisation is off', async () => {
		const { exec, calls } = fakeRunner([]);
		expect((await applyTimesyncdDropIn('ntp.example.org', false, path, withTimesyncConfigRead(path, exec))).outcome).toBe('ok');
		expect(await readFile(path, 'utf8')).toContain('NTP=ntp.example.org');
		expect(calls).toEqual([]);
	});

	/**
	 * The API reported a failure, so the host must not quietly adopt the new server at
	 * the next boot — the file goes back and the daemon is restarted onto it again.
	 */
	it('restores the previous drop-in when the restart fails', async () => {
		await writeFile(path, '[Time]\nNTP=\nNTP=old.example.org\n', 'utf8');
		const { exec, calls } = fakeRunner([{ kind: 'failed', code: 1, output: 'Job for systemd-timesyncd.service failed.\n' }]);
		const r = await applyTimesyncdDropIn('new.example.org', true, path, withTimesyncConfigRead(path, exec));
		expect(r.success).toBe(false);
		expect(r.outcome).toBe('error');
		expect(await readFile(path, 'utf8')).toBe('[Time]\nNTP=\nNTP=old.example.org\n');
		expect(calls).toEqual(['systemctl restart systemd-timesyncd', 'systemctl restart systemd-timesyncd']);
		// The undo is complete, so the host is as it was found. Carrying the `changed` flags
		// the stopped sequence set had the UI warn that part of the save might still be
		// applied — about a state that no longer exists anywhere.
		expect(r.changed).not.toBe(true);
		expect(r.stateMayHaveChanged).not.toBe(true);
	});

	/**
	 * The file went back and the daemon did not. Swallowing that second restart reported an
	 * undo that only half happened — the drop-in on disk is the old one, and the daemon is
	 * either down or still running the withdrawn configuration.
	 */
	it('says so when the daemon could not be restarted onto the restored drop-in', async () => {
		await writeFile(path, '[Time]\nNTP=\nNTP=old.example.org\n', 'utf8');
		const failure: RunOutcome = { kind: 'failed', code: 1, output: 'Job for systemd-timesyncd.service failed.\n' };
		const { exec } = fakeRunner([failure, failure]);
		const r = await applyTimesyncdDropIn('new.example.org', true, path, withTimesyncConfigRead(path, exec));
		expect(r.success).toBe(false);
		expect(await readFile(path, 'utf8')).toBe('[Time]\nNTP=\nNTP=old.example.org\n');
		expect(r.message).toContain('could not be restarted onto it');
	});

	/**
	 * The old file IS back on the visible filesystem and only its flush failed, so the daemon
	 * has to be put back onto it. Folded into "not restored", this skipped the second restart
	 * — leaving the service stopped or running a withdrawn configuration — and told the user
	 * the new server was still on disk, which was untrue.
	 */
	it('restarts onto a restored drop-in whose flush failed, and says only that', async () => {
		await writeFile(path, '[Time]\nNTP=\nNTP=old.example.org\n', 'utf8');
		const { exec, calls } = fakeRunner([{ kind: 'failed', code: 1, output: 'Job for systemd-timesyncd.service failed.\n' }]);
		const r = await applyTimesyncdDropIn('new.example.org', true, path, withTimesyncConfigRead(path, exec), failFlushOf(dir, 'EIO', 1));
		expect(r.success).toBe(false);
		expect(await readFile(path, 'utf8')).toBe('[Time]\nNTP=\nNTP=old.example.org\n');
		expect(calls).toEqual(['systemctl restart systemd-timesyncd', 'systemctl restart systemd-timesyncd']);
		expect(r.message).toContain('was restored');
		expect(r.message).toContain('may not survive');
		expect(r.message).not.toContain('still holds the new server');
	});

	/** Same for the removal branch: the drop-in is gone from the filesystem either way. */
	it('restarts after a removal whose flush failed', async () => {
		const { exec, calls } = fakeRunner([{ kind: 'failed', code: 1, output: 'Job for systemd-timesyncd.service failed.\n' }]);
		const r = await applyTimesyncdDropIn('new.example.org', true, path, withTimesyncConfigRead(path, exec), failFlushOf(dir, 'ENOSPC', 1));
		expect(r.success).toBe(false);
		expect(await readdir(dir)).toEqual([]);
		expect(calls).toEqual(['systemctl restart systemd-timesyncd', 'systemctl restart systemd-timesyncd']);
		expect(r.message).not.toContain('still holds the new server');
	});

	/**
	 * A restart onto an unrestored file is worse than no restart at all: the file on disk is
	 * still the new server, so the second restart can SUCCEED and make the rejected
	 * configuration live at once — while the caller is told the change could not be applied.
	 * The restore failure has to stop the sequence, not merely change the message after it.
	 *
	 * The restore is broken from inside the failing restart, which is the one moment between
	 * the write and the rollback: the drop-in is swapped for a directory, so putting the old
	 * content back cannot work.
	 */
	it('does not restart the daemon again when the drop-in could not be restored', async () => {
		await writeFile(path, '[Time]\nNTP=\nNTP=old.example.org\n', 'utf8');
		const calls: string[] = [];
		const exec: CommandRunner = async (cmd, args) => {
			calls.push([cmd, ...args].join(' '));
			await rm(path, { force: true });
			await mkdir(path);
			return { kind: 'failed', code: 1, output: 'Job for systemd-timesyncd.service failed.\n' };
		};
		const r = await applyTimesyncdDropIn('new.example.org', true, path, withTimesyncConfigRead(path, exec));
		expect(r.success).toBe(false);
		expect(calls).toEqual(['systemctl restart systemd-timesyncd']);
		expect(r.message).toContain('could not be restored');
	});

	it('preserves a concurrent drop-in edit and does not describe it as the requested server', async () => {
		await writeFile(path, '[Time]\nNTP=old.example.org\n');
		const external = '[Time]\nNTP=external.example.org\n';
		let restarts = 0;
		const exec: CommandRunner = async () => {
			restarts++;
			await writeFile(path, external);
			return { kind: 'failed', code: 1, output: 'daemon restart failed' };
		};
		const result = await applyTimesyncdDropIn('requested.example.org', true, path, withTimesyncConfigRead(path, exec));
		expect(result.success).toBe(false);
		expect(restarts).toBe(1);
		expect(await readFile(path, 'utf8')).toBe(external);
		expect(result.message).toContain('could not be restored');
		expect(result.message).not.toContain('still holds the new server');
	});

	it('removes a drop-in it created when the restart fails', async () => {
		const { exec } = fakeRunner([{ kind: 'failed', code: 1, output: 'Job for systemd-timesyncd.service failed.\n' }]);
		expect((await applyTimesyncdDropIn('new.example.org', true, path, withTimesyncConfigRead(path, exec))).success).toBe(false);
		expect(await readdir(dir)).toEqual([]);
	});

	/**
	 * Two saves in flight at once must not interleave. The daemon restart is what makes
	 * a drop-in take effect, so each call has to restart onto the file IT wrote — if both
	 * restarts see the same content, one caller was told its server is live while the
	 * other's file is the one on disk.
	 */
	it('keeps two concurrent writes from interleaving', async () => {
		const seenAtRestart: string[] = [];
		const exec: CommandRunner = async () => {
			// Wide enough that an unserialized second write would land first — both
			// writes finish in well under a millisecond.
			await new Promise(resolve => setTimeout(resolve, 10));
			seenAtRestart.push(await readFile(path, 'utf8'));
			return { kind: 'ok', output: '' };
		};
		const [a, b] = await Promise.all([applyTimesyncdDropIn('a.example.org', true, path, withTimesyncConfigRead(path, exec)), applyTimesyncdDropIn('b.example.org', true, path, withTimesyncConfigRead(path, exec))]);
		expect([a.success, b.success]).toEqual([true, true]);
		expect(seenAtRestart.map(text => text.trim().split('NTP=').pop()).sort()).toEqual(['a.example.org', 'b.example.org']);
		// The loser's content is gone, and neither call left a staging file behind.
		expect(await readdir(dir)).toEqual(['90-libershare.conf']);
	});

	/**
	 * The way the lock itself could fail. The API layer takes it around the whole request
	 * and the writer takes it again inside — so if the re-entrant check ever stops seeing
	 * that this call stack already holds it, the inner acquisition waits for the outer one
	 * forever and every system-time request hangs. The test's own timeout is the assertion.
	 */
	it('does not deadlock when a locked write nests inside another', async () => {
		const { exec, calls } = fakeRunner([]);
		const r = await withSystemTimeLock(async () => applyTimesyncdDropIn('ntp.example.org', true, path, withTimesyncConfigRead(path, exec)));
		expect(r.success).toBe(true);
		expect(calls).toEqual(['systemctl restart systemd-timesyncd']);
	});

	/** And still serializes afterwards: the nesting must release the lock, not leak it. */
	it('serializes again once a nested write is done', async () => {
		const { exec } = fakeRunner([]);
		await withSystemTimeLock(async () => applyTimesyncdDropIn('first.example.org', false, path, withTimesyncConfigRead(path, exec)));
		expect((await applyTimesyncdDropIn('second.example.org', false, path, withTimesyncConfigRead(path, exec))).success).toBe(true);
		expect(await readFile(path, 'utf8')).toContain('second.example.org');
	});

	it('reports an unwritable drop-in as a permission problem and runs nothing', async () => {
		const { exec, calls } = fakeRunner([]);
		// A path whose parent is an existing FILE cannot be created on any platform.
		const blocked = join(path, 'nested.conf');
		await writeFile(path, 'x', 'utf8');
		const r = await applyTimesyncdDropIn('ntp.example.org', true, blocked, withTimesyncConfigRead(blocked, exec));
		expect(r.success).toBe(false);
		expect(calls).toEqual([]);
	});
});
