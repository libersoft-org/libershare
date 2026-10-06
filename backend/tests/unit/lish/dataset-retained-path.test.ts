import { expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDataset } from '../../../src/lish/safe-dataset-files.ts';
import { openPosixDatasetDirectory } from '../../../src/lish/safe-dataset-files-posix.ts';
import { moveDatasetData } from '../../../src/lish/dataset-transfer.ts';
import type { DatasetDirectoryHandle } from '../../../src/lish/safe-dataset-types.ts';

test.skipIf(process.platform === 'win32')('move cleanup reports a readable full path when a nested captured file cannot be restored', async () => {
	const base = await mkdtemp(join(tmpdir(), 'lish-retained-path-'));
	const source = join(base, 'source');
	const nested = join(source, 'deep', 'nested');
	await mkdir(nested, { recursive: true });
	const path = join(nested, 'data.bin');
	await writeFile(path, 'data');
	const native = await openPosixDatasetDirectory(source);
	const prototype = Object.getPrototypeOf(native) as DatasetDirectoryHandle;
	const remove = prototype.removeFile;
	const spy = spyOn(prototype, 'removeFile').mockImplementation(function (this: DatasetDirectoryHandle, name, identity, guard) {
		renameSync(path, join(nested, 'original.bin'));
		writeFileSync(path, 'captured changes');
		const pending = remove.call(this, name, identity, guard);
		// Native capture runs before its first asynchronous stat.
		writeFileSync(path, 'new occupant');
		return pending;
	});
	try {
		const result = await moveDatasetData(
			{ id: 'retained', created: '2026-01-01', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'deep/nested/data.bin', size: 4, checksums: [new Bun.CryptoHasher('sha256').update('data').digest('hex')] }] },
			{ kind: 'derived', base, component: 'source' },
			{ kind: 'derived', base, component: 'target' },
			() => {},
			() => {}
		);
		expect(result.cleanupWarnings).toHaveLength(1);
		const warning = result.cleanupWarnings[0]!;
		expect(warning.code).toBe('LISH_UNSAFE_PATH');
		expect(warning.retainedDirectory).toMatch(/^\.lish-remove-[a-f0-9-]{36}$/);
		expect(warning.retainedPath).toBe(join(nested, warning.retainedDirectory!, 'entry'));
		expect(await readFile(warning.retainedPath!, 'utf8')).toBe('captured changes');
		expect(await readFile(path, 'utf8')).toBe('new occupant');
		expect(await readFile(join(base, 'target/deep/nested/data.bin'), 'utf8')).toBe('data');
	} finally {
		spy.mockRestore();
		await native.close();
		await rm(base, { recursive: true, force: true });
	}
});

for (const relative of ['', 'deep/nested'])
	test.skipIf(process.platform === 'win32')(`directory recovery reports its full path for ${relative || 'the dataset root'}`, async () => {
		const base = await mkdtemp(join(tmpdir(), 'lish-retained-directory-'));
		const source = join(base, 'source');
		const path = join(source, relative);
		await mkdir(path, { recursive: true });
		const dataset = await openDataset({ kind: 'derived', base, component: 'source' });
		const identity = (await dataset.statDirectory(relative))!.identity;
		const native = await openPosixDatasetDirectory(base);
		const prototype = Object.getPrototypeOf(native) as DatasetDirectoryHandle;
		const remove = prototype.removeDirectory;
		const spy = spyOn(prototype, 'removeDirectory').mockImplementation(function (this: DatasetDirectoryHandle, name, expected) {
			renameSync(path, `${path}-original`);
			mkdirSync(path);
			writeFileSync(join(path, 'saved.txt'), 'preserved contents');
			const pending = remove.call(this, name, expected);
			mkdirSync(path);
			return pending;
		});
		try {
			const error = await dataset.removeDirectory(relative, identity).then(
				() => undefined,
				error => error
			);
			expect(error.code).toBe('LISH_UNSAFE_PATH');
			expect(error.retainedPath).toBeString();
			expect(await readFile(join(error.retainedPath, 'saved.txt'), 'utf8')).toBe('preserved contents');
			expect(error.retainedPath.startsWith(join(path, '..') + '/')).toBe(true);
		} finally {
			spy.mockRestore();
			await dataset.close();
			await native.close();
			await rm(base, { recursive: true, force: true });
		}
	});
