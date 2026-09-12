import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmod, chown, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unreadableByServiceAccount, writeFileAtomically, type ServiceAccountAccess } from '../../src/system-time-files.ts';

async function restrictiveUmask<T>(action: () => Promise<T>): Promise<T> {
	const previous = process.umask(0o077);
	try {
		return await action();
	} finally {
		process.umask(previous);
	}
}
async function permissiveUmask<T>(action: () => Promise<T>): Promise<T> {
	const previous = process.umask(0o000);
	try {
		return await action();
	} finally {
		process.umask(previous);
	}
}
async function mode(path: string): Promise<number> {
	return (await stat(path)).mode & 0o7777;
}

/**
 * Every mode the staging file was seen with while `action` published, OR'd together.
 *
 * Sampled from this process rather than from a second one: the point is which bits the
 * file was CREATED with, and a poller racing the same event loop observes that window
 * without needing a helper process to win a race for it.
 */
async function stagingModesDuring(directory: string, action: () => Promise<unknown>): Promise<{ widest: number; samples: number }> {
	let widest = 0;
	let samples = 0;
	let polling = true;
	const poller = (async () => {
		while (polling) {
			for (const entry of await readdir(directory).catch(() => [])) {
				if (!entry.endsWith('.tmp')) continue;
				const observed = (await stat(join(directory, entry)).catch(() => null))?.mode;
				if (observed === undefined) continue;
				samples++;
				widest |= observed & 0o7777;
			}
			await new Promise(resolve => setImmediate(resolve));
		}
	})();
	try {
		await action();
	} finally {
		polling = false;
		await poller;
	}
	return { widest, samples };
}

/** No shell or service changes: read the file as the standard unprivileged Linux nobody UID/GID. */
async function readAsNobody(path: string, denied = false): Promise<string> {
	const child = Bun.spawn(['/usr/bin/setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', '/bin/cat', path], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LC_ALL: 'C' } });
	const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
	try {
		const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		if (denied) {
			expect(code).toBe(1);
			expect(stdout).toBe('');
			expect(stderr).toContain('Permission denied');
		} else {
			expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
		}
		return stdout;
	} finally {
		clearTimeout(deadline);
		if (child.exitCode === null) {
			child.kill('SIGKILL');
			await child.exited;
		}
	}
}

describe.skipIf(process.platform === 'win32')('POSIX time configuration permissions', () => {
	let root = '';
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'lish-time-permissions-'));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('publishes readable files and searchable new directories despite umask 077', async () => {
		const parent = join(root, 'systemd', 'timesyncd.conf.d');
		const file = join(parent, '90-libershare.conf');
		await restrictiveUmask(() => writeFileAtomically(file, '[Time]\nNTP=example.org\n'));
		expect(await mode(join(root, 'systemd'))).toBe(0o755);
		expect(await mode(parent)).toBe(0o755);
		expect(await mode(file)).toBe(0o644);
		expect(await mode(root)).toBe(0o700);
	});

	/**
	 * The mode the staging file is CREATED with, which the final mode cannot show.
	 *
	 * `open()` without an explicit mode creates 0666 masked by the INHERITED umask, so under
	 * a permissive umask the replacement was world-writable from its creation until the chmod
	 * that follows the write. `wx` does not help: it refuses an existing NAME, not another
	 * user opening the file this call just made — and a descriptor taken in that window stays
	 * usable through the chmod and the rename, so the writer goes on editing what the service
	 * now reads as its configuration. Measured on Linux under umask 000: 0666 before the fix,
	 * 0600 after it, with the published file 0644 either way.
	 */
	it('never stages the replacement shared-writable, even under a permissive umask', async () => {
		const file = join(root, '90-libershare.conf');
		// Large enough that the write yields to the loop, so the staging window is observable
		// at all: a payload that lands in one go leaves nothing to sample.
		const content = ['[Time]', ...Array.from({ length: 400_000 }, () => 'NTP=tik.cesnet.cz'), ''].join('\n');
		const observed = await permissiveUmask(() => stagingModesDuring(root, () => writeFileAtomically(file, content)));
		expect(observed.samples).toBeGreaterThan(0);
		expect(observed.widest & 0o022).toBe(0);
		expect(await mode(file)).toBe(0o644);
		expect(await readFile(file, 'utf8')).toBe(content);
	});

	it('publishes the documented mode under a permissive umask', async () => {
		const file = join(root, 'systemd', 'timesyncd.conf.d', '90-libershare.conf');
		await permissiveUmask(() => writeFileAtomically(file, '[Time]\nNTP=example.org\n'));
		expect(await mode(file)).toBe(0o644);
	});

	/**
	 * What the mode bits cannot see.
	 *
	 * An ACL entry naming the service account takes precedence over the `other` class, so a
	 * file at 0644 with `user:systemd-timesync:---` looks world-readable and is refused to the
	 * one reader that matters. Measured on Debian 12 against the real thing: the bit check
	 * reported no problem while `test -r` as uid 997 and `cat` both failed. The answer now
	 * comes from the kernel under those ids, and the bits are only the fallback for a host
	 * that cannot be asked.
	 */
	describe('readability for the time service account', () => {
		const answering =
			(verdict: boolean | null): ServiceAccountAccess =>
			async () =>
				verdict;
		// mkdtemp leaves the fixture root at 0700, which the traversal check reports before any
		// of this is reached. These cases are about the file and its own directory.
		beforeEach(() => chmod(root, 0o755));

		it('reports a file the kernel refuses to that account, whatever the bits say', async () => {
			const file = join(root, '90-libershare.conf');
			await writeFile(file, 'x\n');
			await chmod(file, 0o644);
			// Refused for the file alone: the directory it lives in lists fine, so this is the ACL
			// case and not the one the mode bits already catch.
			const fileRefused: ServiceAccountAccess = async path => path !== file;
			expect(await unreadableByServiceAccount(file, fileRefused)).toContain('cannot be read');
		});

		/** The kernel's yes also overrides the approximation: the bits are the weaker evidence. */
		it('accepts what the kernel allows even when the other bits are clear', async () => {
			const file = join(root, '90-libershare.conf');
			await writeFile(file, 'x\n');
			await chmod(file, 0o600);
			expect(await unreadableByServiceAccount(file, answering(true))).toBeNull();
		});

		it('falls back to the other bits when the host cannot be asked', async () => {
			const file = join(root, '90-libershare.conf');
			await writeFile(file, 'x\n');
			await chmod(file, 0o644);
			expect(await unreadableByServiceAccount(file, answering(null))).toBeNull();
			await chmod(file, 0o600);
			expect(await unreadableByServiceAccount(file, answering(null))).toContain('cannot be read');
		});

		it('reports a directory that account cannot list, so a drop-in in it is never found', async () => {
			const parent = join(root, 'timesyncd.conf.d');
			await mkdir(parent, { mode: 0o755 });
			const file = join(parent, '90-libershare.conf');
			await writeFile(file, 'x\n');
			await chmod(file, 0o644);
			// Only the listing is refused; the file itself reads fine, which is exactly the shape
			// that passes every other check while the daemon never sees the drop-in.
			const listingRefused: ServiceAccountAccess = async path => (path === parent ? false : true);
			expect(await unreadableByServiceAccount(file, listingRefused)).toContain('cannot be listed');
		});
	});

	it('does not widen a pre-existing private parent directory', async () => {
		const parent = join(root, 'private');
		await mkdir(parent, { mode: 0o700 });
		await restrictiveUmask(() => writeFileAtomically(join(parent, '90-libershare.conf'), 'new\n'));
		expect(await mode(parent)).toBe(0o700);
	});

	it.each([0o600, 0o640, 0o644])('publishes 0644 then restores the original mode %i under restrictive umask', async originalMode => {
		const file = join(root, '90-libershare.conf');
		await writeFile(file, 'original\n');
		await chmod(file, originalMode);
		await restrictiveUmask(async () => {
			const rollback = await writeFileAtomically(file, 'replacement\n');
			expect(await mode(file)).toBe(0o644);
			expect((await rollback()).state).toBe('restored-durable');
			expect(await mode(file)).toBe(originalMode);
			expect(await readFile(file, 'utf8')).toBe('original\n');
		});
	});

	it('preserves an observed foreign permission edit during rollback', async () => {
		const file = join(root, '90-libershare.conf');
		await writeFile(file, 'original\n');
		const rollback = await writeFileAtomically(file, 'replacement\n');
		await chmod(file, 0o600);
		expect((await rollback()).state).toBe('not-restored');
		expect(await mode(file)).toBe(0o600);
		expect(await readFile(file, 'utf8')).toBe('replacement\n');
	});

	it('does not overwrite another inode with identical content and permissions', async () => {
		const file = join(root, '90-libershare.conf');
		await writeFile(file, 'original\n');
		const rollback = await writeFileAtomically(file, 'replacement\n');
		const other = join(root, 'external.conf');
		await writeFile(other, 'replacement\n');
		await chmod(other, 0o644);
		await rename(other, file);
		const inode = (await stat(file)).ino;
		expect((await rollback()).state).toBe('not-restored');
		expect((await stat(file)).ino).toBe(inode);
	});

	it('rejects a metadata change while snapshotting the original file', async () => {
		const file = join(root, '90-libershare.conf');
		await writeFile(file, 'original\n');
		await chmod(file, 0o640);
		await expect(
			writeFileAtomically(file, 'replacement\n', async path => {
				const content = await readFile(path, 'utf8');
				await chmod(path, 0o600);
				return content;
			})
		).rejects.toThrow('changed while it was being read');
		expect(await readFile(file, 'utf8')).toBe('original\n');
		expect(await mode(file)).toBe(0o600);
	});

	it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0).each([
		{ directoryMode: 0o755, fileMode: 0o600 },
		{ directoryMode: 0o700, fileMode: 0o644 },
	])('denies the cross-user reader access to root-only fixtures: %j', async permissions => {
		await chmod(root, permissions.directoryMode);
		const file = join(root, 'root-only.conf');
		await writeFile(file, 'private\n');
		await chown(file, 0, 0);
		await chmod(file, permissions.fileMode);
		await readAsNobody(file, true);
		await chmod(root, 0o755);
		await chmod(file, 0o644);
		expect(await readAsNobody(file)).toBe('private\n');
	});

	it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)('permits a different user to read newly published configuration under umask 077', async () => {
		await chmod(root, 0o755); // The test owns this outer fixture directory as well.
		const file = join(root, 'systemd', 'timesyncd.conf.d', '90-libershare.conf');
		await restrictiveUmask(() => writeFileAtomically(file, '[Time]\nNTP=example.org\n'));
		expect(await readAsNobody(file)).toBe('[Time]\nNTP=example.org\n');
	});

	it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0).each([
		{ uid: 65534, gid: 65534, permissions: 0o600 },
		{ uid: 0, gid: 65534, permissions: 0o640 },
	])('restores original ownership and cross-user access: %j', async original => {
		await chmod(root, 0o755);
		const file = join(root, '90-libershare.conf');
		await writeFile(file, 'original\n');
		await chown(file, original.uid, original.gid);
		await chmod(file, original.permissions);
		expect(await readAsNobody(file)).toBe('original\n');
		await restrictiveUmask(async () => {
			const rollback = await writeFileAtomically(file, 'replacement\n');
			expect(await readAsNobody(file)).toBe('replacement\n');
			expect((await rollback()).state).toBe('restored-durable');
			const restored = await stat(file);
			expect({ uid: restored.uid, gid: restored.gid, permissions: restored.mode & 0o7777 }).toEqual(original);
			expect(await readAsNobody(file)).toBe('original\n');
		});
	});

	it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)('preserves a foreign ownership edit during rollback', async () => {
		const file = join(root, '90-libershare.conf');
		const rollback = await writeFileAtomically(file, 'replacement\n');
		await chown(file, 65534, 65534);
		expect((await rollback()).state).toBe('not-restored');
		expect((await stat(file)).uid).toBe(65534);
	});

	/**
	 * systemd-timesyncd runs as `systemd-timesync`, not as root (checked on a running systemd
	 * 255), so a drop-in directory an administrator left at 0700 is invisible to it - while
	 * every check made from a root process succeeds and the save is reported as applied.
	 */
	it('spots a configuration the time service could never read', async () => {
		const parent = join(root, 'private');
		const file = join(parent, '90-libershare.conf');
		await mkdir(parent, { mode: 0o700 });
		await writeFile(file, '[Time]', 'utf8');
		await chmod(file, 0o644);
		expect(await unreadableByServiceAccount(file)).toContain('cannot be entered');
		// The fixture root is itself 0700 under umask 077, and the walk is right to say so.
		await chmod(root, 0o755);
		await chmod(parent, 0o755);
		expect(await unreadableByServiceAccount(file)).toBeNull();
		await chmod(file, 0o640);
		expect(await unreadableByServiceAccount(file)).toContain('cannot be read');
	});

	/**
	 * A path component is often a symlink, and `lstat` answers about the LINK — 0777 on every
	 * one of them — so a drop-in directory that is really a link into a private tree passed
	 * the check while the daemon still could not enter it.
	 */
	it('follows a symlink to the directory whose permissions actually apply', async () => {
		await chmod(root, 0o755);
		const hidden = join(root, 'hidden');
		const link = join(root, 'conf.d');
		await mkdir(hidden, { mode: 0o700 });
		await symlink(hidden, link);
		const file = join(link, '90-libershare.conf');
		await writeFile(file, '[Time]', 'utf8');
		await chmod(file, 0o644);
		// The link itself is world-everything; what matters is the 0700 directory behind it.
		expect((await lstat(link)).mode & 0o777).toBe(0o777);
		expect(await unreadableByServiceAccount(file)).toContain('cannot be entered');
		await chmod(hidden, 0o755);
		expect(await unreadableByServiceAccount(file)).toBeNull();
	});

	/**
	 * Both sides of a link. Resolution walks the name as written AND, where a component is a
	 * link, the target's own chain — so a 0700 directory blocks the daemon whichever side it
	 * sits on. Each direction was missed by a fix aimed at the other.
	 *
	 * Mode bits only, so this needs no privileges and runs wherever POSIX permissions do.
	 */
	it.each([
		['the directory holding the link', 'locked'],
		['the directory above the target', 'private'],
	])('refuses when %s is closed', async (_side, closed) => {
		await chmod(root, 0o755);
		const locked = join(root, 'locked');
		const private_ = join(root, 'private');
		const target = join(private_, 'time-config');
		for (const directory of [locked, private_, target]) {
			await mkdir(directory);
			// umask 077 strips the mode `mkdir` was asked for, so set it explicitly.
			await chmod(directory, 0o755);
		}
		const link = join(locked, 'conf.d');
		await symlink(target, link);
		const file = join(link, '90-libershare.conf');
		await writeFile(file, '[Time]', 'utf8');
		await chmod(file, 0o644);
		// Everything open: nothing to report.
		expect(await unreadableByServiceAccount(file)).toBeNull();
		await chmod(join(root, closed), 0o700);
		expect(await unreadableByServiceAccount(file)).toContain(closed);
	});

	/**
	 * The same arrangement read for real, which is the only thing that proves the mode bits
	 * were the right question. Needs root to become another user, like every other cross-user
	 * case here, so it carries the same guard rather than the suite-level one.
	 */
	it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)('agrees with a real read through the link', async () => {
		await chmod(root, 0o755);
		const locked = join(root, 'locked');
		const target = join(root, 'public');
		for (const directory of [locked, target]) {
			await mkdir(directory);
			await chmod(directory, 0o755);
		}
		const link = join(locked, 'conf.d');
		await symlink(target, link);
		await writeFile(join(target, '90-libershare.conf'), '[Time]', 'utf8');
		await chmod(join(target, '90-libershare.conf'), 0o644);
		const file = join(link, '90-libershare.conf');
		expect(await readAsNobody(file)).toBe('[Time]');
		await chmod(locked, 0o700);
		expect(await unreadableByServiceAccount(file)).toContain('locked');
		await readAsNobody(file, true);
	});

	/**
	 * A chain, which every shortcut missed: `conf.d` points at `middle/hop`, `hop` points at
	 * `public`, and the 0700 sits on `middle` — a directory that appears in neither the written
	 * path nor the fully resolved one. Only walking hop by hop sees it.
	 */
	it('sees a closed directory in the middle of a symlink chain', async () => {
		await chmod(root, 0o755);
		const middle = join(root, 'middle');
		const target = join(root, 'public');
		for (const directory of [middle, target]) {
			await mkdir(directory);
			await chmod(directory, 0o755);
		}
		await symlink(target, join(middle, 'hop'));
		await symlink(join(middle, 'hop'), join(root, 'conf.d'));
		const file = join(root, 'conf.d', '90-libershare.conf');
		await writeFile(join(target, '90-libershare.conf'), '[Time]', 'utf8');
		await chmod(join(target, '90-libershare.conf'), 0o644);
		expect(await unreadableByServiceAccount(file)).toBeNull();
		await chmod(middle, 0o700);
		expect(await unreadableByServiceAccount(file)).toContain('middle');
	});

	/** A chain that eats itself must run out of hops rather than the event loop. */
	it('gives up on a symlink loop instead of following it', async () => {
		await chmod(root, 0o755);
		await symlink(join(root, 'b'), join(root, 'a'));
		await symlink(join(root, 'a'), join(root, 'b'));
		expect(await unreadableByServiceAccount(join(root, 'a', '90-libershare.conf'))).toBeNull();
	});

	it('reports nothing for an ordinary readable path', async () => {
		await chmod(root, 0o755);
		const directory = join(root, 'timesyncd.conf.d');
		await mkdir(directory);
		await chmod(directory, 0o755);
		const file = join(directory, '90-libershare.conf');
		await writeFile(file, '[Time]', 'utf8');
		await chmod(file, 0o644);
		expect(await unreadableByServiceAccount(file)).toBeNull();
	});

	/**
	 * Entering a directory and listing it are different permissions, and drop-ins are FOUND by
	 * listing. At 0711 the file is perfectly readable by name and never named at all — measured
	 * on a real host, where `cat` on the known path succeeded as another user while `ls` on the
	 * directory was refused.
	 */
	it('refuses a drop-in directory that cannot be listed, even though the file reads', async () => {
		await chmod(root, 0o755);
		const directory = join(root, 'timesyncd.conf.d');
		await mkdir(directory);
		await chmod(directory, 0o755);
		const file = join(directory, '90-libershare.conf');
		await writeFile(file, '[Time]', 'utf8');
		await chmod(file, 0o644);
		expect(await unreadableByServiceAccount(file)).toBeNull();
		// Traversable but not listable.
		await chmod(directory, 0o711);
		expect(await unreadableByServiceAccount(file)).toContain('cannot be listed');
	});

	it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)('agrees that the file itself still reads at 0711', async () => {
		await chmod(root, 0o755);
		const directory = join(root, 'timesyncd.conf.d');
		await mkdir(directory);
		await chmod(directory, 0o711);
		const file = join(directory, '90-libershare.conf');
		await writeFile(file, '[Time]', 'utf8');
		await chmod(file, 0o644);
		// This is the trap: reading by name works, so a read-only probe would call it fine.
		expect(await readAsNobody(file)).toBe('[Time]');
		expect(await unreadableByServiceAccount(file)).toContain('cannot be listed');
	});

	/**
	 * `..` inside a relative link target must stay a component. `path.join` collapses it, and
	 * the collapse removed a directory the kernel does traverse: a target of `locked/../public`
	 * became `public`, so a 0700 `locked` was never asked about while a real read got EACCES.
	 */
	it('applies a relative target .. instead of normalising it away', async () => {
		await chmod(root, 0o755);
		const open = join(root, 'open');
		await mkdir(open);
		await chmod(open, 0o755);
		const locked = join(open, 'locked');
		const target = join(open, 'public');
		for (const directory of [locked, target]) {
			await mkdir(directory);
			await chmod(directory, 0o755);
		}
		await symlink('locked/../public', join(open, 'conf.d'));
		const file = join(open, 'conf.d', '90-libershare.conf');
		await writeFile(join(target, '90-libershare.conf'), '[Time]', 'utf8');
		await chmod(join(target, '90-libershare.conf'), 0o644);
		expect(await unreadableByServiceAccount(file)).toBeNull();
		await chmod(locked, 0o700);
		expect(await unreadableByServiceAccount(file)).toContain('locked');
	});
});
