import { expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveDatasetData } from '../../../src/lish/dataset-transfer.ts';
import type { ILISH } from '@shared';
import { openDataset } from '../../../src/lish/safe-dataset-files.ts';

const crossFilesystem = process.platform === 'linux' && existsSync('/dev/shm') && statSync(tmpdir()).dev !== statSync('/dev/shm').dev;

for (const writerOpen of [false, true])
	test.skipIf(!crossFilesystem)(`cross-filesystem move with existing writer=${writerOpen}`, async () => {
		const base = await mkdtemp(join(tmpdir(), 'lish-copy-lease-'));
		let targetBase: string | undefined;
		const source = join(base, 'source');
		await mkdir(source);
		await writeFile(join(source, 'data.bin'), 'abcd');
		let writer: Awaited<ReturnType<typeof open>> | undefined;
		try {
			targetBase = await mkdtemp('/dev/shm/lish-copy-lease-');
			expect((await stat(base)).dev).not.toBe((await stat(targetBase)).dev);
			const manifest: ILISH = { id: 'cross-filesystem', created: '2026-01-01', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'data.bin', size: 4, checksums: [new Bun.CryptoHasher('sha256').update('abcd').digest('hex')] }] };
			if (writerOpen) writer = await open(join(source, 'data.bin'), 'r+');
			let committed = false;
			const moved = moveDatasetData(
				manifest,
				{ kind: 'derived', base, component: 'source' },
				{ kind: 'derived', base: targetBase, component: 'target' },
				() => {
					committed = true;
				},
				() => {}
			);
			if (writerOpen) {
				await expect(moved).rejects.toMatchObject({ code: 'FS_BUSY' });
				expect(committed).toBe(false);
				await writer!.write(Buffer.from('NEW'), 0, 3, 4);
				expect(await readFile(join(source, 'data.bin'), 'utf8')).toBe('abcdNEW');
				await expect(stat(join(targetBase, 'target'))).rejects.toMatchObject({ code: 'ENOENT' });
			} else {
				expect((await moved).cleanupWarnings).toEqual([]);
				expect(committed).toBe(true);
				expect(await readFile(join(targetBase, 'target/data.bin'), 'utf8')).toBe('abcd');
				await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
			}
		} finally {
			await writer?.close();
			await rm(base, { recursive: true, force: true });
			if (targetBase) await rm(targetBase, { recursive: true, force: true });
		}
	});

test.skipIf(process.platform !== 'darwin')('macOS copy preflight checks identity without promising an exclusive lease', async () => {
	const root = await mkdtemp(join(tmpdir(), 'lish-mac-lease-'));
	await writeFile(join(root, 'data.bin'), 'keep');
	const dataset = await openDataset(root);
	try {
		const info = await dataset.statFile('data.bin');
		await dataset.checkFileForCopyMove('data.bin', info!.identity);
		await expect(dataset.checkFileForCopyMove('data.bin', 'different-identity')).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
		expect(await readFile(join(root, 'data.bin'), 'utf8')).toBe('keep');
	} finally {
		await dataset.close();
		await rm(root, { recursive: true, force: true });
	}
});
