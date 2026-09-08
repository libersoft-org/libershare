import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmod, chown, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileAtomically } from '../../src/system-time-files.ts';

async function restrictiveUmask<T>(action: () => Promise<T>): Promise<T> {
	const previous = process.umask(0o077);
	try {
		return await action();
	} finally {
		process.umask(previous);
	}
}
async function mode(path: string): Promise<number> {
	return (await stat(path)).mode & 0o7777;
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
});
