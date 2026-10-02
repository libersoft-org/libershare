import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, rename } from 'node:fs/promises';
import { renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ILISH } from '@shared';
import type { DatasetLinkBinding } from '../../../src/db/lishs-link-bindings.ts';
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

test('removes only recorded materialized copies after repeated moves and deletion', async () => {
	const f = await fixture();
	f.manifest.links = [{ path: 'copy.bin', target: join(f.source, 'data.bin') }];
	let bindings: DatasetLinkBinding[] = [];
	await moveDatasetData(
		f.manifest,
		f.root('source'),
		f.root('first'),
		value => {
			bindings = value;
		},
		() => {}
	);
	expect(bindings[0]?.materializedIdentity).toBeString();
	await writeFile(join(f.base, 'first/unrelated.txt'), 'keep');
	const first = await moveDatasetData(
		f.manifest,
		f.root('first'),
		f.root('second'),
		value => {
			bindings = value;
		},
		() => {},
		'source',
		bindings
	);
	expect(first.cleanupWarnings).toEqual([{ stage: 'source-cleanup', code: 'ENOTEMPTY' }]);
	await expect(stat(join(f.base, 'first/copy.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
	await expect(stat(join(f.base, 'first/data.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
	expect(await readFile(join(f.base, 'first/unrelated.txt'), 'utf8')).toBe('keep');
	await writeFile(join(f.base, 'second/unrelated.txt'), 'keep too');
	await deleteDatasetData(f.manifest, f.root('second'), bindings);
	await expect(stat(join(f.base, 'second/copy.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
	await expect(stat(join(f.base, 'second/data.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
	expect(await readFile(join(f.base, 'second/unrelated.txt'), 'utf8')).toBe('keep too');
});

test('refuses deletion when a recorded materialized copy has been replaced', async () => {
	const f = await fixture();
	f.manifest.links = [{ path: 'copy.bin', target: 'data.bin' }];
	let bindings: DatasetLinkBinding[] = [];
	await moveDatasetData(
		f.manifest,
		f.root('source'),
		f.root('first'),
		value => {
			bindings = value;
		},
		() => {}
	);
	await rename(join(f.base, 'first/copy.bin'), join(f.base, 'first/original-copy.bin'));
	await writeFile(join(f.base, 'first/copy.bin'), 'foreign');
	await expect(deleteDatasetData(f.manifest, f.root('first'), bindings)).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
	expect(await readFile(join(f.base, 'first/copy.bin'), 'utf8')).toBe('foreign');
	expect(await readFile(join(f.base, 'first/data.bin'), 'utf8')).toBe('data');
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


test.each(['edit', 'xy'])('manual moves preserve edited materialized bytes across second and third moves: %j', async contents => {
 const f = await fixture();
 f.manifest.links = [{path: 'copy.bin', target: join(f.source, 'data.bin')}];
 let bindings: DatasetLinkBinding[] = [];
 await moveDatasetData(f.manifest, f.root('source'), f.root('first'), value => { bindings = value; }, () => {});
 const originalIdentity = (await stat(join(f.base, 'first/copy.bin'), {bigint: true})).ino;
 await writeFile(join(f.base, 'first/copy.bin'), contents);
 expect((await stat(join(f.base, 'first/copy.bin'), {bigint: true})).ino).toBe(originalIdentity);
 for (const [source, target] of [['first', 'second'], ['second', 'third']] as const) {
  await moveDatasetData(f.manifest, f.root(source), f.root(target), value => { bindings = value; }, () => {}, 'source', bindings);
  expect(await readFile(join(f.base, target, 'copy.bin'), 'utf8')).toBe(contents);
  expect(await readFile(join(f.base, target, 'data.bin'), 'utf8')).toBe('data');
  expect(bindings[0]?.source).toBe('data.bin');
  expect(bindings[0]?.target).toBe(join(f.source, 'data.bin'));
  await expect(stat(join(f.base, source))).rejects.toMatchObject({code: 'ENOENT'});
 }
});

test('finalization refuses edited materialized bytes before committing or deleting the source', async () => {
 const f = await fixture();
 f.manifest.links = [{path: 'copy.bin', target: join(f.source, 'data.bin')}];
 let bindings: DatasetLinkBinding[] = [];
 await moveDatasetData(f.manifest, f.root('source'), f.root('first'), value => { bindings = value; }, () => {});
 await writeFile(join(f.base, 'first/copy.bin'), 'edit');
 let committed = false;
 await expect(moveDatasetData(f.manifest, f.root('first'), f.root('final'), () => { committed = true; }, () => {}, 'manifest', bindings)).rejects.toMatchObject({code: 'LISH_INVALID_MANIFEST'});
 expect(committed).toBe(false);
 expect(await readFile(join(f.base, 'first/copy.bin'), 'utf8')).toBe('edit');
 expect(await readFile(join(f.base, 'first/data.bin'), 'utf8')).toBe('data');
 await expect(stat(join(f.base, 'final'))).rejects.toMatchObject({code: 'ENOENT'});
});

test('a grown materialized copy is retained when relocation refuses its size', async () => {
 const f = await fixture();
 f.manifest.links = [{path: 'copy.bin', target: 'data.bin'}];
 let bindings: DatasetLinkBinding[] = [];
 await moveDatasetData(f.manifest, f.root('source'), f.root('first'), value => { bindings = value; }, () => {});
 await writeFile(join(f.base, 'first/copy.bin'), 'more data');
 let committed = false;
 await expect(moveDatasetData(f.manifest, f.root('first'), f.root('next'), () => { committed = true; }, () => {}, 'source', bindings)).rejects.toMatchObject({code: 'IO_NOT_FOUND'});
 expect(committed).toBe(false);
 expect(await readFile(join(f.base, 'first/copy.bin'), 'utf8')).toBe('more data');
 expect(await readFile(join(f.base, 'first/data.bin'), 'utf8')).toBe('data');
});
