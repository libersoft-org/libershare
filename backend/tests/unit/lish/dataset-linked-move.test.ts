import { expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveDatasetData } from '../../../src/lish/dataset-transfer.ts';
import { SafeDataset } from '../../../src/lish/safe-dataset-files.ts';
import { CodedError, ErrorCodes, type ILISH } from '@shared';

test.skipIf(process.platform === 'win32')(
	'an existing writer keeps writing to the destination after the source name is removed',
	async () => {
		const base = await mkdtemp(join(tmpdir(), 'lish-late-writer-'));
		const source = join(base, 'source');
		await mkdir(source);
		const path = join(source, 'data.bin');
		await writeFile(path, 'abcd');
		const identity = (await stat(path, { bigint: true })).ino;
		const code = "import {openSync,writeSync,fsyncSync,closeSync} from 'node:fs'; const fd=openSync(process.argv[1],'r+'); console.log('READY'); for await(const bytes of Bun.stdin.stream()){writeSync(fd,Buffer.from('-LATE'),0,5,4);fsyncSync(fd);closeSync(fd);break;}";
		const writer = Bun.spawn([process.execPath, '--eval', code, path], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
		const reader = writer.stdout.getReader();
		let ready = '';
		while (!ready.includes('\n')) {
			const data = await reader.read();
			if (data.done) throw new Error('Writer exited before opening source');
			ready += new TextDecoder().decode(data.value);
		}
		reader.releaseLock();
		let committed = false,
			wrote = false;
		const remove = SafeDataset.prototype.removeFile;
		const spy = spyOn(SafeDataset.prototype, 'removeFile').mockImplementation(async function (this: SafeDataset, p, id, guard) {
			await remove.call(this, p, id, guard);
			if (committed && p === 'data.bin' && !wrote) {
				wrote = true;
				writer.stdin.write('GO\n');
				writer.stdin.end();
				expect(await writer.exited).toBe(0);
			}
		});
		const manifest: ILISH = { id: 'late-writer', created: '2026-01-01', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'data.bin', size: 4, checksums: [new Bun.CryptoHasher('sha256').update('abcd').digest('hex')] }] };
		try {
			const result = await moveDatasetData(
				manifest,
				{ kind: 'derived', base, component: 'source' },
				{ kind: 'derived', base, component: 'target' },
				() => {
					committed = true;
				},
				() => {}
			);
			expect(wrote).toBe(true);
			expect(result.cleanupWarnings).toEqual([]);
			expect(await readFile(join(base, 'target/data.bin'), 'utf8')).toBe('abcd-LATE');
			expect((await stat(join(base, 'target/data.bin'), { bigint: true })).ino).toBe(identity);
			await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
		} finally {
			spy.mockRestore();
			if (writer.exitCode === null) writer.kill();
			await writer.exited;
			await rm(base, { recursive: true, force: true });
		}
	},
	10000
);

for (const collision of [false, true])
	test.skipIf(process.platform === 'win32')(`copy fallback when hardlinks are unavailable, collision=${collision}`, async () => {
		const base = await mkdtemp(join(tmpdir(), 'lish-link-fallback-'));
		const source = join(base, 'source');
		await mkdir(source);
		await writeFile(join(source, 'data.bin'), 'abcd');
		const original = (await stat(join(source, 'data.bin'), { bigint: true })).ino;
		const manifest: ILISH = { id: 'fallback', created: '2026-01-01', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'data.bin', size: 4, checksums: [new Bun.CryptoHasher('sha256').update('abcd').digest('hex')] }], links: [{ path: 'copy.bin', target: 'data.bin' }] };
		const linking = spyOn(SafeDataset.prototype, 'linkFileTo').mockImplementation(async () => {
			if (collision) await writeFile(join(base, 'target/data.bin'), 'foreign');
			throw new CodedError(ErrorCodes.FS_MOVE_UNSUPPORTED);
		});
		let committed = false;
		try {
			const moving = moveDatasetData(
				manifest,
				{ kind: 'derived', base, component: 'source' },
				{ kind: 'derived', base, component: 'target' },
				() => {
					committed = true;
				},
				() => {}
			);
			if (collision) {
				await expect(moving).rejects.toMatchObject({ code: 'EEXIST' });
				expect(committed).toBe(false);
				expect(await readFile(join(base, 'target/data.bin'), 'utf8')).toBe('foreign');
				expect(await readFile(join(source, 'data.bin'), 'utf8')).toBe('abcd');
			} else {
				expect((await moving).cleanupWarnings).toEqual([]);
				expect(committed).toBe(true);
				expect(await readFile(join(base, 'target/data.bin'), 'utf8')).toBe('abcd');
				expect(await readFile(join(base, 'target/copy.bin'), 'utf8')).toBe('abcd');
				expect((await stat(join(base, 'target/data.bin'), { bigint: true })).ino).not.toBe(original);
				await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
			}
		} finally {
			linking.mockRestore();
			await rm(base, { recursive: true, force: true });
		}
	});
