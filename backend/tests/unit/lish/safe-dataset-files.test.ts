import { describe, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodedError, type IStoredLISH } from '@shared';
import { createDataset, openDataset, type SafeDataset } from '../../../src/lish/safe-dataset-files.ts';
import { FileAllocator } from '../../../src/protocol/file-allocator.ts';

async function fixture(run: (dataset: SafeDataset, path: string, outer: string) => Promise<void>): Promise<void> {
	const outer = await mkdtemp(join(tmpdir(), 'lish-safe-files-'));
	const path = join(outer, 'dataset');
	await mkdir(path);
	const dataset = await openDataset(path);
	try {
		await run(dataset, path, outer);
	} finally {
		await dataset.close();
		await rm(outer, { recursive: true, force: true });
	}
}

function manifest(files: { path: string; size: number }[], directories: string[] = []): IStoredLISH {
	return { id: 'test', created: '2026-01-01T00:00:00Z', checksumAlgo: 'sha256', chunkSize: 4, files: files.map(file => ({ ...file, checksums: [] })), directories: directories.map(path => ({ path })) } as IStoredLISH;
}

describe('safe dataset namespace', () => {
	test('rejects absolute and traversal paths independently of the host platform', async () => {
		await fixture(async (dataset, path) => {
			for (const entry of ['C:/outside', 'C:outside', '/absolute', '../outside', 'a\\b', 'a//b']) {
				await expect(dataset.prepare(manifest([{ path: entry, size: 1 }]), { reserve: true })).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			}
			expect(await readdir(path)).toEqual([]);
		});
	});

	test('reserves nested files and explicit empty directories before content writes', async () => {
		await fixture(async (dataset, path) => {
			await dataset.prepare(manifest([{ path: 'a/data', size: 3 }], ['empty']), { reserve: true });
			expect(await readdir(path)).toEqual(['a', 'empty']);
			const file = await dataset.openFile('a/data', 'write');
			try {
				expect(await file.write(Buffer.from('abc'), 0)).toBe(3);
			} finally {
				await file.close();
			}
			expect(await readFile(join(path, 'a', 'data'), 'utf8')).toBe('abc');
		});
	});

	test('refuses duplicate paths and file/directory overlap before creating entries', async () => {
		await fixture(async (dataset, path) => {
			for (const paths of [
				['same', 'same'],
				['parent', 'parent/child'],
			]) {
				await expect(dataset.prepare(manifest(paths.map(path => ({ path, size: 1 }))), { reserve: true })).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
				expect(await readdir(path)).toEqual([]);
			}
		});
	});

	test('requires complete preparation before a write and detects a replaced file', async () => {
		await fixture(async (dataset, path) => {
			await writeFile(join(path, 'data'), 'old');
			await expect(dataset.openFile('data', 'write')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			await dataset.prepare(manifest([{ path: 'data', size: 3 }]));
			await rename(join(path, 'data'), join(path, 'original'));
			await writeFile(join(path, 'data'), 'replacement');
			await expect(dataset.openFile('data', 'write')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			expect(await readFile(join(path, 'data'), 'utf8')).toBe('replacement');
		});
	});

	test('rejects linked parents as a coded error and leaves outside contents untouched', async () => {
		await fixture(async (dataset, path, outer) => {
			await mkdir(join(outer, 'outside'));
			await writeFile(join(outer, 'outside', 'data'), 'KEEP');
			await symlink(join(outer, 'outside'), join(path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
			let caught: unknown;
			try {
				await dataset.prepare(manifest([{ path: 'linked/data', size: 1 }]));
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(CodedError);
			expect(caught).toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			expect(await readFile(join(outer, 'outside', 'data'), 'utf8')).toBe('KEEP');
		});
	});

	test('a derived root refuses a junction but an explicit user root may resolve it', async () => {
		await fixture(async (_dataset, path, outer) => {
			await symlink(path, join(outer, 'selected'), process.platform === 'win32' ? 'junction' : 'dir');
			await expect(openDataset({ kind: 'derived', base: outer, component: 'selected' }, true)).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			await (await openDataset({ kind: 'explicit', path: join(outer, 'selected') })).close();
			await expect(createDataset({ kind: 'derived', base: outer, component: 'dataset' })).rejects.toMatchObject({ code: 'EEXIST' });
		});
	});

	test('allows read-only hardlinks but refuses the complete write namespace', async () => {
		await fixture(async (dataset, path, outer) => {
			await writeFile(join(outer, 'outside'), 'KEEP');
			await link(join(outer, 'outside'), join(path, 'linked'));
			const lish = manifest([{ path: 'linked', size: 4 }]);
			await dataset.prepare(lish, { writable: false });
			const file = await dataset.openFile('linked', 'read');
			try {
				expect((await file.stat()).links).toBe(2);
			} finally {
				await file.close();
			}
			await expect(dataset.prepare(lish)).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
		});
	});

	test.skipIf(process.platform !== 'win32')('detects actual case aliases, including previously missing names', async () => {
		for (const exists of [false, true])
			await fixture(async (dataset, path) => {
				if (exists) await writeFile(join(path, 'File.bin'), 'KEEP');
				await expect(
					dataset.prepare(
						manifest([
							{ path: 'File.bin', size: 2 },
							{ path: 'file.bin', size: 2 },
						]),
						{ reserve: true }
					)
				).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
				if (exists) expect(await readFile(join(path, 'File.bin'), 'utf8')).toBe('KEEP');
				else expect(await readdir(path)).toEqual([]);
			});
	});

	test.skipIf(process.platform !== 'win32')('detects actual directory aliases before writing their different files', async () => {
		await fixture(async (dataset, path) => {
			await mkdir(join(path, 'Folder'));
			await expect(
				dataset.prepare(
					manifest([
						{ path: 'Folder/a', size: 1 },
						{ path: 'folder/b', size: 1 },
					]),
					{ reserve: true }
				)
			).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			expect(await readdir(join(path, 'Folder'))).toEqual([]);
		});
	});

	test('removes only the expected identity and exclusively creates a derived root', async () => {
		await fixture(async (_dataset, _path, outer) => {
			const dataset = await createDataset({ kind: 'derived', base: outer, component: 'new' });
			try {
				await dataset.prepare(manifest([{ path: 'file', size: 0 }]), { reserve: true });
				await expect(dataset.removeFile('file', 'wrong')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
				await dataset.removeFile('file', (await dataset.statFile('file'))!.identity);
				await dataset.removeDirectory('', (await dataset.statDirectory())!.identity);
			} finally {
				await dataset.close();
			}
			expect(await readdir(outer)).toEqual(['dataset']);
		});
	});
});

describe('allocator whole namespace protection', () => {
	for (const operation of ['allocateStructure', 'allocateFiles', 'allocateFile'] as const) {
		test(`${operation} checks an unsafe later file before truncating the selected first file`, async () => {
			await fixture(async (_dataset, path, outer) => {
				await writeFile(join(path, 'first'), 'FIRST');
				await writeFile(join(outer, 'outside'), 'KEEP');
				await link(join(outer, 'outside'), join(path, 'later'));
				const lish = manifest([
					{ path: 'first', size: 1 },
					{ path: 'later', size: 4 },
				]);
				const allocator = new FileAllocator(path);
				const result = operation === 'allocateStructure' ? allocator.allocateStructure(lish) : operation === 'allocateFiles' ? allocator.allocateFiles(lish, [0]) : allocator.allocateFile(lish, 0);
				await expect(result).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
				expect(await readFile(join(path, 'first'), 'utf8')).toBe('FIRST');
				expect(await readFile(join(outer, 'outside'), 'utf8')).toBe('KEEP');
			});
		});
	}

	test('zero-fills at explicit offsets, counts empty files and preserves cancellation', async () => {
		await fixture(async (_dataset, path) => {
			const allocator = new FileAllocator(path);
			const lish = manifest(
				[
					{ path: 'nested/large', size: 2 * 1024 * 1024 + 3 },
					{ path: 'empty', size: 0 },
				],
				['empty-dir']
			);
			expect(await allocator.allocateStructure(lish)).toEqual({ created: 2, skipped: 0 });
			expect((await readFile(join(path, 'nested', 'large'))).every(byte => byte === 0)).toBe(true);
			expect(await allocator.allocateStructure(lish)).toEqual({ created: 0, skipped: 2 });
			const controller = new AbortController();
			controller.abort();
			expect(await allocator.allocateStructure(manifest([{ path: 'cancelled', size: 1 }]), undefined, controller.signal)).toEqual({ created: 0, skipped: 0 });
			expect(await readdir(path)).not.toContain('cancelled');
		});
	});
});
