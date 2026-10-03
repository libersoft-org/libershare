import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile, link, stat } from 'node:fs/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { openPosixDatasetDirectory } from '../../../src/lish/safe-dataset-files-posix';
import type { DatasetDirectoryHandle } from '../../../src/lish/safe-dataset-types';

async function fixture(run: (directory: DatasetDirectoryHandle, path: string) => Promise<void>): Promise<void> {
	const sandbox = await mkdtemp(join(tmpdir(), 'lish-posix-'));
	const path = join(sandbox, 'dataset');
	await mkdir(path);
	const directory = await openPosixDatasetDirectory(path);
	try {
		await run(directory, path);
	} finally {
		await directory.close();
		await rm(sandbox, { recursive: true, force: true });
	}
}

describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('POSIX dataset handles', () => {
	test('creates files with private readable and writable permissions', async () => {
		await fixture(async (directory, path) => {
			await (await directory.openFile('private', 'create')).close();
			expect((await stat(join(path, 'private'))).mode & 0o777).toBe(0o600 & ~process.umask());
			const reopened = await directory.openFile('private', 'write');
			try {
				expect(await reopened.write(Buffer.from('x'), 0)).toBe(1);
			} finally {
				await reopened.close();
			}
		});
	});

	test('positioned reads and writes, truncate and inode identity use the opened file', async () => {
		await fixture(async (directory, path) => {
			const child = await directory.createDirectory('child');
			const file = await child.openFile('data', 'create');
			try {
				expect(await file.write(Buffer.from('abcd'), 0)).toBe(4);
				expect(await file.write(Buffer.from('XY'), 1)).toBe(2);
				const data = new Uint8Array(3);
				expect(await file.read(data, 1)).toBe(3);
				expect(Buffer.from(data).toString()).toBe('XYd');
				await file.truncate(3);
				const before = await file.stat();
				expect(before.kind).toBe('file');
				expect(before.size).toBe(3);
				await rename(join(path, 'child', 'data'), join(path, 'child', 'renamed'));
				await writeFile(join(path, 'child', 'data'), 'replacement');
				expect((await file.stat()).identity).toBe(before.identity);
				expect(await file.write(Buffer.from('Z'), 0)).toBe(1);
				expect(await readFile(join(path, 'child', 'data'), 'utf8')).toBe('replacement');
				expect(await readFile(join(path, 'child', 'renamed'), 'utf8')).toBe('ZXY');
			} finally {
				await file.close();
				await child.close();
			}
		});
	});

	test('exclusive creation preserves existing entries and missing opens stay ENOENT', async () => {
		await fixture(async directory => {
			const child = await directory.createDirectory('child');
			const childIdentity = (await child.stat()).identity;
			await child.close();
			const data = await directory.openFile('data', 'create');
			const dataIdentity = (await data.stat()).identity;
			await data.close();
			await expect(directory.createDirectory('child')).rejects.toMatchObject({ code: 'EEXIST' });
			await expect(directory.openFile('data', 'create')).rejects.toMatchObject({ code: 'EEXIST' });
			await expect(directory.openFile('missing', 'write')).rejects.toMatchObject({ code: 'ENOENT' });
			await directory.removeFile('data', dataIdentity);
			await directory.removeDirectory('child', childIdentity);
			await expect(directory.openDirectory('child')).rejects.toMatchObject({ code: 'ENOENT' });
		});
	});

	test('child symlinks are refused while the explicitly chosen root may be a symlink', async () => {
		await fixture(async (directory, path) => {
			const outside = join(path, '..', 'outside');
			await mkdir(outside);
			await writeFile(join(outside, 'data'), 'unchanged');
			await symlink(outside, join(path, 'parent-link'));
			await symlink(join(outside, 'data'), join(path, 'leaf-link'));
			await expect(directory.openDirectory('parent-link')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			await expect(directory.openFile('leaf-link', 'write')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			await expect(directory.removeFile('leaf-link', 'unused')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			const selected = await openPosixDatasetDirectory(join(path, 'parent-link'));
			try {
				expect((await selected.stat()).kind).toBe('directory');
			} finally {
				await selected.close();
			}
			expect(await readFile(join(outside, 'data'), 'utf8')).toBe('unchanged');
		});
	});

	test('restores a replacement captured after the caller checked the original identity', async () => {
		await fixture(async (directory, path) => {
			await writeFile(join(path, 'data'), 'original');
			const original = await directory.openFile('data', 'read');
			const identity = (await original.stat()).identity;
			await original.close();
			await rename(join(path, 'data'), join(path, 'saved'));
			await writeFile(join(path, 'data'), 'replacement');
			await expect(directory.removeFile('data', identity)).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			expect(await readFile(join(path, 'data'), 'utf8')).toBe('replacement');
			expect(await readFile(join(path, 'saved'), 'utf8')).toBe('original');
			expect((await readdir(path)).sort()).toEqual(['data', 'saved']);
		});
	});

	test('deletes only the captured file when a replacement arrives during its inspection', async () => {
		await fixture(async (directory, path) => {
			const file = await directory.openFile('data', 'create');
			const identity = (await file.stat()).identity;
			await file.close();
			const removal = directory.removeFile('data', identity);
			// Capture is synchronous; fstat yields before the captured name is removed.
			writeFileSync(join(path, 'data'), 'replacement');
			await removal;
			expect(await readFile(join(path, 'data'), 'utf8')).toBe('replacement');
			expect(await readdir(path)).toEqual(['data']);
		});
	});

	test('preserves captured data if restoring a mismatched identity would overwrite a new name', async () => {
		await fixture(async (directory, path) => {
			await writeFile(join(path, 'data'), 'captured replacement');
			const removal = directory.removeFile('data', 'old-identity');
			writeFileSync(join(path, 'data'), 'new arrival');
			await expect(removal).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			const retained = (await readdir(path)).find(name => name.startsWith('.lish-remove-'))!;
			expect(typeof retained).toBe('string');
			expect((await stat(join(path, retained))).mode & 0o777).toBe(0o700 & ~process.umask());
			expect(await readFile(join(path, retained, 'entry'), 'utf8')).toBe('captured replacement');
			expect(await readFile(join(path, 'data'), 'utf8')).toBe('new arrival');
		});
	});

	test('directory removal checks captured identity and preserves a new directory at the old name', async () => {
		await fixture(async (directory, path) => {
			const child = await directory.createDirectory('child');
			const identity = (await child.stat()).identity;
			await child.close();
			const removal = directory.removeDirectory('child', identity);
			mkdirSync(join(path, 'child'));
			writeFileSync(join(path, 'child', 'keep'), 'untouched');
			await removal;
			expect(await readFile(join(path, 'child', 'keep'), 'utf8')).toBe('untouched');
			await expect(directory.removeDirectory('child', identity)).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			expect(await readFile(join(path, 'child', 'keep'), 'utf8')).toBe('untouched');
		});
	});

	test('restores a nonempty directory after its removal is refused', async () => {
		await fixture(async (directory, path) => {
			const child = await directory.createDirectory('child');
			const identity = (await child.stat()).identity;
			await child.close();
			await writeFile(join(path, 'child', 'keep'), 'untouched');
			await expect(directory.removeDirectory('child', identity)).rejects.toMatchObject({ code: 'ENOTEMPTY' });
			expect(await readFile(join(path, 'child', 'keep'), 'utf8')).toBe('untouched');
			expect(await readdir(path)).toEqual(['child']);
		});
	});

	test('replacing the parent pathname does not redirect a held directory', async () => {
		await fixture(async (directory, path) => {
			const outside = join(path, '..', 'outside');
			await mkdir(outside);
			await writeFile(join(outside, 'data'), 'unchanged');
			const child = await directory.createDirectory('child');
			try {
				await rename(join(path, 'child'), join(path, 'original'));
				await symlink(outside, join(path, 'child'));
				const file = await child.openFile('data', 'create');
				try {
					await file.write(Buffer.from('inside'), 0);
				} finally {
					await file.close();
				}
				expect(await readFile(join(path, 'original', 'data'), 'utf8')).toBe('inside');
				expect(await readFile(join(outside, 'data'), 'utf8')).toBe('unchanged');
			} finally {
				await child.close();
			}
		});
	});

	test('FIFO and wrong object types are refused without blocking', async () => {
		await fixture(async (directory, path) => {
			execFileSync('mkfifo', [join(path, 'pipe')]);
			const started = performance.now();
			await expect(directory.openFile('pipe', 'read')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			await expect(directory.openFile('pipe', 'write')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			expect(performance.now() - started).toBeLessThan(1000);
			await mkdir(join(path, 'child'));
			await expect(directory.openFile('child', 'read')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			await expect(directory.openFile('child', 'write')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
		});
	}, 2000);

	test('reports hard-link counts without silently choosing a write policy', async () => {
		await fixture(async (directory, path) => {
			await writeFile(join(path, 'data'), 'content');
			await link(join(path, 'data'), join(path, 'alias'));
			const file = await directory.openFile('data', 'read');
			try {
				expect((await file.stat()).links).toBe(2);
			} finally {
				await file.close();
			}
		});
	});

	test('close waits for pending I/O, is idempotent and prevents descriptor reuse', async () => {
		await fixture(async directory => {
			const file = await directory.openFile('data', 'create');
			const pending = file.write(new Uint8Array(1024 * 1024), 0);
			const closed = file.close();
			expect(await pending).toBe(1024 * 1024);
			await closed;
			await file.close();
			await expect(file.stat()).rejects.toMatchObject({ code: 'EBADF' });
			await expect(file.read(new Uint8Array(1), 0)).rejects.toMatchObject({ code: 'EBADF' });
			await directory.close();
			await expect(directory.openDirectory('child')).rejects.toMatchObject({ code: 'EBADF' });
		});
	});

	test('rejects path traversal, separators and NUL before any filesystem access', async () => {
		await fixture(async directory => {
			for (const name of ['', '.', '..', '../outside', 'a/b', 'a\\b', 'a\0b']) {
				expect(() => directory.openFile(name, 'create')).toThrow('Invalid dataset path component');
			}
		});
	});
});
