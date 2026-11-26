import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ILISH } from '@shared';
import { moveDatasetData, deleteDatasetData } from '../../../src/lish/dataset-transfer.ts';
import type { DatasetRoot } from '../../../src/lish/safe-dataset-files.ts';

const scratch: string[] = [];
afterEach(async () => {
	for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
	const base = await mkdtemp(join(tmpdir(), 'dataset-cleanup-'));
	scratch.push(base);
	const source = join(base, 'source');
	await mkdir(source);
	await writeFile(join(source, 'data.bin'), 'data');
	const manifest: ILISH = { id: 'cleanup', created: '2026-01-01', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'data.bin', size: 4, checksums: [new Bun.CryptoHasher('sha256').update('data').digest('hex')] }] };
	const root = (component: string): DatasetRoot => ({ kind: 'derived', base, component });
	return { base, source, manifest, root };
}

test('removes only the files of the manifest after repeated moves and deletion', async () => {
	const f = await fixture();
	await moveDatasetData(
		f.manifest,
		f.root('source'),
		f.root('first'),
		() => {},
		() => {}
	);
	await writeFile(join(f.base, 'first/unrelated.txt'), 'keep');
	const first = await moveDatasetData(
		f.manifest,
		f.root('first'),
		f.root('second'),
		() => {},
		() => {},
		'source'
	);
	expect(first.cleanupWarnings).toEqual([{ stage: 'source-cleanup', code: 'ENOTEMPTY' }]);
	await expect(stat(join(f.base, 'first/data.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
	expect(await readFile(join(f.base, 'first/unrelated.txt'), 'utf8')).toBe('keep');
	await writeFile(join(f.base, 'second/unrelated.txt'), 'keep too');
	await deleteDatasetData(f.manifest, f.root('second'));
	await expect(stat(join(f.base, 'second/data.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
	expect(await readFile(join(f.base, 'second/unrelated.txt'), 'utf8')).toBe('keep too');
});

test.skipIf(process.platform === 'win32')('does not commit a renamed destination or remove the source', async () => {
	const f = await fixture();
	let replaced = false;
	let committed = false;
	await expect(
		moveDatasetData(
			f.manifest,
			f.root('source'),
			f.root('target'),
			() => {
				committed = true;
			},
			progress => {
				if (progress.type !== 'file' || replaced) return;
				replaced = true;
				renameSync(join(f.base, 'target'), join(f.base, 'moved-target'));
				mkdirSync(join(f.base, 'target'));
			}
		)
	).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
	expect(replaced).toBe(true);
	expect(committed).toBe(false);
	expect(await readFile(join(f.source, 'data.bin'), 'utf8')).toBe('data');
	expect((await stat(join(f.base, 'target'))).isDirectory()).toBe(true);
});
