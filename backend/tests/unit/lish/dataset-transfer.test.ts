import { afterEach, expect, test, spyOn } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, link } from 'node:fs/promises';
import { renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ILISH } from '@shared';
import { deleteDatasetData, moveDatasetData } from '../../../src/lish/dataset-transfer.ts';
import { SafeDataset, type DatasetRoot } from '../../../src/lish/safe-dataset-files.ts';

const scratch: string[] = [];
afterEach(async () => {
	for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});
const hash = (value: string): string => new Bun.CryptoHasher('sha256').update(value).digest('hex');
async function fixture() {
	const base = await mkdtemp(join(tmpdir(), 'dataset-copy-'));
	scratch.push(base);
	const source = join(base, 'source');
	await mkdir(source);
	await writeFile(join(source, 'data.bin'), 'abcdefgh');
	const manifest: ILISH = { id: 'copy-test', created: '2026-01-01', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'data.bin', size: 8, checksums: [hash('abcd'), hash('efgh')] }], directories: [{ path: 'empty' }] };
	await mkdir(join(source, 'empty'));
	const root: DatasetRoot = { kind: 'derived', base, component: 'source' };
	const target: DatasetRoot = { kind: 'derived', base, component: 'target' };
	return { base, source, manifest, root, target };
}

test('copies verified bytes and empty directories, commits, and preserves unrelated source files', async () => {
	const f = await fixture();
	await writeFile(join(f.source, 'unrelated'), 'keep');
	let committed = false;
	await moveDatasetData(
		f.manifest,
		f.root,
		f.target,
		() => {
			committed = true;
		},
		() => {}
	);
	expect(committed).toBe(true);
	expect(await readFile(join(f.base, 'target/data.bin'), 'utf8')).toBe('abcdefgh');
	expect((await stat(join(f.base, 'target/empty'))).isDirectory()).toBe(true);
	expect(await readFile(join(f.source, 'unrelated'), 'utf8')).toBe('keep');
	expect(await Bun.file(join(f.source, 'data.bin')).exists()).toBe(false);
});

test('never replaces an existing destination directory', async () => {
	const f = await fixture();
	await mkdir(join(f.base, 'target'));
	await writeFile(join(f.base, 'target/keep'), 'untouched');
	let committed = false;
	await expect(
		moveDatasetData(
			f.manifest,
			f.root,
			f.target,
			() => {
				committed = true;
			},
			() => {}
		)
	).rejects.toMatchObject({ code: 'EEXIST' });
	expect(committed).toBe(false);
	expect(await readFile(join(f.base, 'target/keep'), 'utf8')).toBe('untouched');
	expect(await readFile(join(f.source, 'data.bin'), 'utf8')).toBe('abcdefgh');
});

test.each(['abcd\0\0\0\0', 'abc'])('moves unfinished bytes unchanged when relocating a download: %j', async contents => {
	const f = await fixture();
	await writeFile(join(f.source, 'data.bin'), contents);
	let committed = false;
	await moveDatasetData(
		f.manifest,
		f.root,
		f.target,
		() => {
			committed = true;
		},
		() => {},
		'source'
	);
	expect(committed).toBe(true);
	expect(await readFile(join(f.base, 'target/data.bin'), 'utf8')).toBe(contents);
	expect(await Bun.file(join(f.source, 'data.bin')).exists()).toBe(false);
});

test('checksum mismatch preserves the source and removes only the incomplete copy', async () => {
	const f = await fixture();
	await writeFile(join(f.source, 'data.bin'), 'badbytes');
	let committed = false;
	await expect(
		moveDatasetData(
			f.manifest,
			f.root,
			f.target,
			() => {
				committed = true;
			},
			() => {}
		)
	).rejects.toMatchObject({ code: 'LISH_INVALID_MANIFEST' });
	expect(committed).toBe(false);
	expect(await readFile(join(f.source, 'data.bin'), 'utf8')).toBe('badbytes');
	await expect(stat(join(f.base, 'target'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a replaced copy target is neither written nor deleted by cleanup', async () => {
	const f = await fixture();
	let committed = false;
	await expect(
		moveDatasetData(
			f.manifest,
			f.root,
			f.target,
			() => {
				committed = true;
			},
			event => {
				if (event.type !== 'file-list') return;
				renameSync(join(f.base, 'target/data.bin'), join(f.base, 'reserved-file'));
				writeFileSync(join(f.base, 'target/data.bin'), 'replacement');
			}
		)
	).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
	expect(committed).toBe(false);
	expect(await readFile(join(f.base, 'target/data.bin'), 'utf8')).toBe('replacement');
	expect(await readFile(join(f.source, 'data.bin'), 'utf8')).toBe('abcdefgh');
});

test('a child directory link is rejected before copying or deleting any files', async () => {
	const f = await fixture();
	const outside = join(f.base, 'outside');
	await mkdir(outside);
	await writeFile(join(outside, 'sentinel'), 'safe');
	await symlink(outside, join(f.source, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
	f.manifest.files!.push({ path: 'redirect/sentinel', size: 4, checksums: [hash('safe')] });
	await expect(
		moveDatasetData(
			f.manifest,
			f.root,
			f.target,
			() => {},
			() => {}
		)
	).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
	await expect(deleteDatasetData(f.manifest, f.root)).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
	expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('safe');
	expect(await readFile(join(f.source, 'data.bin'), 'utf8')).toBe('abcdefgh');
});

test('deleting a hardlink leaves its outside file intact', async () => {
	const f = await fixture();
	await writeFile(join(f.base, 'outside'), 'safe');
	await link(join(f.base, 'outside'), join(f.source, 'hard'));
	f.manifest.files!.push({ path: 'hard', size: 4, checksums: [hash('safe')] });
	await deleteDatasetData(f.manifest, f.root);
	expect(await Bun.file(join(f.source, 'data.bin')).exists()).toBe(false);
	expect(await readFile(join(f.base, 'outside'), 'utf8')).toBe('safe');
});

test('materializes declared local link targets from verified file handles', async () => {
	const f = await fixture();
	f.manifest.links = [
		{ path: 'copy.bin', target: join(f.source, 'data.bin') },
		{ path: 'hardcopy.bin', target: 'data.bin', hardlink: true },
	];
	await link(join(f.source, 'data.bin'), join(f.source, 'hardcopy.bin'));
	await moveDatasetData(
		f.manifest,
		f.root,
		f.target,
		() => {},
		() => {}
	);
	expect(await readFile(join(f.base, 'target/copy.bin'), 'utf8')).toBe('abcdefgh');
	expect(await readFile(join(f.base, 'target/hardcopy.bin'), 'utf8')).toBe('abcdefgh');
});

test('rejects external link targets before creating a destination', async () => {
	const f = await fixture();
	f.manifest.links = [{ path: 'outside-link', target: join(f.base, 'outside') }];
	await expect(
		moveDatasetData(
			f.manifest,
			f.root,
			f.target,
			() => {},
			() => {}
		)
	).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
	expect(await readFile(join(f.source, 'data.bin'), 'utf8')).toBe('abcdefgh');
	await expect(stat(join(f.base, 'target'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a failed database commit retains both verified copies', async () => {
	const f = await fixture();
	await expect(
		moveDatasetData(
			f.manifest,
			f.root,
			f.target,
			() => {
				throw new Error('Database write failed');
			},
			() => {}
		)
	).rejects.toThrow('Database write failed');
	expect(await readFile(join(f.source, 'data.bin'), 'utf8')).toBe('abcdefgh');
	expect(await readFile(join(f.base, 'target/data.bin'), 'utf8')).toBe('abcdefgh');
});

test('a close failure after commit is a warning and still closes the other dataset', async () => {
	const f = await fixture();
	let committed = false;
	let postCommitCloses = 0;
	const close = SafeDataset.prototype.close;
	const closing = spyOn(SafeDataset.prototype, 'close').mockImplementation(async function (this: SafeDataset) {
		await close.call(this);
		if (committed && ++postCommitCloses === 1) throw Object.assign(new Error('close failed'), { code: 'EIO' });
	});
	try {
		const result = await moveDatasetData(
			f.manifest,
			f.root,
			f.target,
			() => {
				committed = true;
			},
			() => {}
		);
		expect(result.cleanupWarnings).toContainEqual({ stage: 'target-close', code: 'EIO' });
		expect(postCommitCloses).toBe(2);
		expect(await readFile(join(f.base, 'target/data.bin'), 'utf8')).toBe('abcdefgh');
	} finally {
		closing.mockRestore();
	}
});

test('a precommit native error remains the result when closing also fails', async () => {
	const f = await fixture();
	await mkdir(join(f.base, 'target'));
	const close = SafeDataset.prototype.close;
	let closed = 0;
	const closing = spyOn(SafeDataset.prototype, 'close').mockImplementation(async function (this: SafeDataset) {
		await close.call(this);
		if (++closed > 1) throw Object.assign(new Error('close failed'), { code: 'EIO' });
	});
	try {
		await expect(
			moveDatasetData(
				f.manifest,
				f.root,
				f.target,
				() => {},
				() => {}
			)
		).rejects.toMatchObject({ code: 'EEXIST' });
		expect(await readFile(join(f.source, 'data.bin'), 'utf8')).toBe('abcdefgh');
	} finally {
		closing.mockRestore();
	}
});
