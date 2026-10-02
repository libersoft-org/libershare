import { describe, expect, test } from 'bun:test';
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SafeDataset } from '../../../src/lish/safe-dataset-files.ts';
import { openWindowsDatasetDirectory } from '../../../src/lish/safe-dataset-files-windows.ts';

const windows = process.platform === 'win32' ? describe : describe.skip;

windows('Windows anchored dataset files', () => {
	test.each(['file', 'directory'] as const)('does not delete a %s replaced after the facade metadata check', async kind => {
		const path = await mkdtemp(join(tmpdir(), 'lish-delete-handles-'));
		const native = await openWindowsDatasetDirectory(path);
		const dataset = new SafeDataset(native);
		try {
			if (kind === 'file') await writeFile(join(path, 'target'), 'original');
			else await mkdir(join(path, 'target'));
			const expected = kind === 'file' ? await dataset.statFile('target') : await dataset.statDirectory('target');
			expect(expected).not.toBeNull();
			const method = kind === 'file' ? 'removeFile' : 'removeDirectory';
			const remove = native[method].bind(native);
			let intercepted = false;
			native[method] = async (name, identity) => {
				intercepted = true;
				await rename(join(path, name), join(path, 'original'));
				if (kind === 'file') await writeFile(join(path, name), 'replacement');
				else await mkdir(join(path, name));
				await remove(name, identity);
			};
			await expect(dataset[method]('target', expected!.identity)).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			expect(intercepted).toBe(true);
			if (kind === 'file') {
				expect(await readFile(join(path, 'target'), 'utf8')).toBe('replacement');
				expect(await readFile(join(path, 'original'), 'utf8')).toBe('original');
			} else {
				expect((await lstat(join(path, 'target'))).isDirectory()).toBe(true);
				expect((await lstat(join(path, 'original'))).isDirectory()).toBe(true);
			}
		} finally {
			await dataset.close();
			await rm(path, { recursive: true, force: true });
		}
	});

	test('reads and writes exact offsets, preserves existing content, and creates exclusively', async () => {
		const path = await mkdtemp(join(tmpdir(), 'lish-handles-'));
		const root = await openWindowsDatasetDirectory(path);
		try {
			const directory = await root.createDirectory('files');
			const directoryIdentity = (await directory.stat()).identity;
			try {
				await expect(root.createDirectory('files')).rejects.toMatchObject({ code: 'EEXIST' });
				const file = await directory.openFile('part', 'create');
				const fileIdentity = (await file.stat()).identity;
				try {
					expect(await file.write(Buffer.from('abcdef'), 0)).toBe(6);
					expect(await file.write(Buffer.from('XY'), 2)).toBe(2);
					const bytes = Buffer.alloc(3);
					expect(await file.read(bytes, 1)).toBe(3);
					expect(bytes.toString()).toBe('bXY');
					expect(await file.read(bytes, 0x100000001)).toBe(0);
					await expect(file.write(bytes, Number.MAX_SAFE_INTEGER + 1)).rejects.toMatchObject({ code: 'EINVAL' });
					expect((await file.stat()).size).toBe(6);
					await expect(directory.openFile('part', 'create')).rejects.toMatchObject({ code: 'EEXIST' });
					await file.truncate(4);
				} finally {
					await file.close();
				}
				const reopened = await directory.openFile('part', 'write');
				await reopened.close();
				expect(await readFile(join(path, 'files', 'part'), 'utf8')).toBe('abXY');
				const reader = await directory.openFile('part', 'read');
				try {
					await expect(reader.write(Buffer.from('!'), 0)).rejects.toMatchObject({ code: 'EACCES' });
				} finally {
					await reader.close();
				}
				await directory.removeFile('part', fileIdentity);
				await expect(directory.openFile('part', 'read')).rejects.toMatchObject({ code: 'ENOENT' });
			} finally {
				await directory.close();
			}
			await root.removeDirectory('files', directoryIdentity);
			await expect(root.openDirectory('files')).rejects.toMatchObject({ code: 'ENOENT' });
		} finally {
			await root.close();
			await rm(path, { recursive: true, force: true });
		}
	});

	test('denies parent replacement and retains ancestors until the last child closes', async () => {
		const path = await mkdtemp(join(tmpdir(), 'lish-handles-'));
		const root = await openWindowsDatasetDirectory(path);
		const child = await root.createDirectory('parent');
		const file = await child.openFile('part', 'create');
		try {
			await expect(rename(join(path, 'parent'), join(path, 'moved'))).rejects.toBeDefined();
			await child.close();
			await root.close();
			await expect(rename(join(path, 'parent'), join(path, 'moved'))).rejects.toBeDefined();
			await expect(rename(path, `${path}-moved`)).rejects.toBeDefined();
			await file.write(Buffer.from('anchored'), 0);
		} finally {
			await file.close();
			await child.close();
			await root.close();
		}
		try {
			await rename(join(path, 'parent'), join(path, 'moved'));
			expect(await readFile(join(path, 'moved', 'part'), 'utf8')).toBe('anchored');
			await expect(file.stat()).rejects.toMatchObject({ code: 'EBADF' });
		} finally {
			await rm(path, { recursive: true, force: true });
		}
	});


 test('orders concurrent writes and closes without detaching caller buffers', async () => {
  const path = await mkdtemp(join(tmpdir(), 'lish-queued-io-'));
  const root = await openWindowsDatasetDirectory(path);
  const file = await root.openFile('data.bin', 'create');
  try {
   const first = Buffer.from('abcd');
   const second = Buffer.from('EFGH');
   const writes = [file.write(first, 0), file.write(second, 4)];
   await root.close();
   const closing = file.close();
   expect(file.close()).toBe(closing);
   expect(await Promise.all(writes)).toEqual([4, 4]);
   await closing;
   expect(first.toString()).toBe('abcd');
   expect(second.toString()).toBe('EFGH');
   expect(await readFile(join(path, 'data.bin'), 'utf8')).toBe('abcdEFGH');
   await expect(file.read(Buffer.alloc(4), 0)).rejects.toMatchObject({ code: 'EBADF' });
  } finally {
   await file.close();
   await root.close();
   await rm(path, { recursive: true, force: true });
  }
 });

	test('returns the same exact file identity and link count for hardlinks', async () => {
		const path = await mkdtemp(join(tmpdir(), 'lish-handles-'));
		await writeFile(join(path, 'one'), 'original');
		await link(join(path, 'one'), join(path, 'two'));
		const root = await openWindowsDatasetDirectory(path);
		try {
			const one = await root.openFile('one', 'read');
			const two = await root.openFile('two', 'read');
			try {
				const metadata = await one.stat();
				expect(metadata.identity).toMatch(/^[0-9a-f]{48}$/);
				expect(Buffer.from(metadata.identity, 'hex').readBigUInt64LE(8)).toBe((await stat(join(path, 'one'), { bigint: true })).ino);
				expect((await two.stat()).identity).toBe(metadata.identity);
				expect(metadata.links).toBe(2);
				expect((await two.stat()).links).toBe(2);
			} finally {
				await one.close();
				await two.close();
			}
		} finally {
			await root.close();
			await rm(path, { recursive: true, force: true });
		}
	});

	test.each(['junction', 'dir', 'file'] as const)('refuses %s children without touching their targets', async type => {
		const path = await mkdtemp(join(tmpdir(), 'lish-handles-'));
		const outside = await mkdtemp(join(tmpdir(), 'lish-outside-'));
		await writeFile(join(outside, 'valuable'), 'unchanged');
		const root = await openWindowsDatasetDirectory(path);
		try {
			await symlink(type === 'file' ? join(outside, 'valuable') : outside, join(path, 'redirect'), type);
			await expect(root.openDirectory('redirect')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			await expect(root.openFile('redirect', 'write')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			await expect(root.removeFile('redirect', 'unused')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			await expect(root.removeDirectory('redirect', 'unused')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			expect((await lstat(join(path, 'redirect'))).isSymbolicLink()).toBe(true);
			expect(await readFile(join(outside, 'valuable'), 'utf8')).toBe('unchanged');
		} finally {
			await root.close();
			await rm(path, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	test('resolves an explicitly selected root junction once', async () => {
		const path = await mkdtemp(join(tmpdir(), 'lish-handles-'));
		const outside = await mkdtemp(join(tmpdir(), 'lish-selected-'));
		await symlink(outside, join(path, 'selected'), 'junction');
		try {
			const root = await openWindowsDatasetDirectory(join(path, 'selected'));
			try {
				const file = await root.openFile('part', 'create');
				await file.write(Buffer.from('selected root'), 0);
				await file.close();
			} finally {
				await root.close();
			}
			expect(await readFile(join(outside, 'part'), 'utf8')).toBe('selected root');
		} finally {
			await rm(path, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	test('rejects traversal, streams and Windows device names in every child operation', async () => {
		const path = await mkdtemp(join(tmpdir(), 'lish-handles-'));
		const root = await openWindowsDatasetDirectory(path);
		try {
			for (const name of ['', '.', '..', '../outside', 'child\\outside', 'part:stream', 'NUL', 'COM1.log', 'part.', 'part ', 'x\0y']) {
				for (const operation of [() => root.openDirectory(name), () => root.createDirectory(name), () => root.openFile(name, 'read'), () => root.openFile(name, 'write'), () => root.openFile(name, 'create'), () => root.removeFile(name, 'unused'), () => root.removeDirectory(name, 'unused')]) {
					await expect(operation()).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
				}
			}
		} finally {
			await root.close();
			await rm(path, { recursive: true, force: true });
		}
	});
});
