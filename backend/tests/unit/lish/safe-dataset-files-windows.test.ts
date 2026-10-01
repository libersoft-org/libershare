import { describe, expect, test } from 'bun:test';
import { link, lstat, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWindowsDatasetDirectory } from '../../../src/lish/safe-dataset-files-windows.ts';

const windows = process.platform === 'win32' ? describe : describe.skip;

windows('Windows anchored dataset files', () => {
	test('reads and writes exact offsets, preserves existing content, and creates exclusively', async () => {
		const path = await mkdtemp(join(tmpdir(), 'lish-handles-'));
		const root = await openWindowsDatasetDirectory(path);
		try {
			const directory = await root.createDirectory('files');
			try {
				await expect(root.createDirectory('files')).rejects.toMatchObject({ code: 'EEXIST' });
				const file = await directory.openFile('part', 'create');
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
				await directory.removeFile('part');
				await expect(directory.openFile('part', 'read')).rejects.toMatchObject({ code: 'ENOENT' });
			} finally {
				await directory.close();
			}
			await root.removeDirectory('files');
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
			await expect(root.removeFile('redirect')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			await expect(root.removeDirectory('redirect')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
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
				for (const operation of [() => root.openDirectory(name), () => root.createDirectory(name), () => root.openFile(name, 'read'), () => root.openFile(name, 'write'), () => root.openFile(name, 'create'), () => root.removeFile(name), () => root.removeDirectory(name)]) {
					await expect(operation()).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
				}
			}
		} finally {
			await root.close();
			await rm(path, { recursive: true, force: true });
		}
	});
});
