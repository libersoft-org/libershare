import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDataset } from '../../src/lish/safe-dataset-files.ts';
import { moveDatasetData } from '../../src/lish/dataset-transfer.ts';
import type { ILISH } from '@shared';

const base = await mkdtemp(join(tmpdir(), 'lish-native-smoke-'));
const other = process.argv[2] ? await mkdtemp(join(process.argv[2], 'lish-native-target-')) : undefined;
const hash = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');
const manifest: ILISH = { id: 'native-smoke', created: '2026-01-01', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'data.bin', size: 4, checksums: [hash('data')] }] };
try {
	const ioPath = join(base, 'io');
	const dataset = await openDataset(ioPath, true);
	try {
		await dataset.prepare(manifest, { reserve: true, writable: true });
		const file = await dataset.openFile('data.bin', 'write');
		let identity: string;
		try {
			assert.equal(await file.write(Buffer.from('data'), 0), 4);
			const bytes = new Uint8Array(4);
			assert.equal(await file.read(bytes, 0), 4);
			assert.equal(Buffer.from(bytes).toString(), 'data');
			identity = (await file.stat()).identity;
		} finally {
			await file.close();
		}
		await dataset.removeFile('data.bin', identity);
		await assert.rejects(stat(join(ioPath, 'data.bin')), { code: 'ENOENT' });
		const outside = join(base, 'outside');
		await mkdir(outside);
		await writeFile(join(outside, 'keep.bin'), 'untouched');
		await symlink(outside, join(ioPath, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
		await assert.rejects(dataset.prepare({ files: [{ path: 'redirect/keep.bin' }] }, { reserve: true, writable: true }), { code: 'LISH_UNSAFE_PATH' });
		assert.equal(await readFile(join(outside, 'keep.bin'), 'utf8'), 'untouched');
	} finally {
		await dataset.close();
	}

	if (other) assert.notEqual((await stat(base)).dev, (await stat(other)).dev, 'The second fixture must be on another filesystem');
	for (const targetBase of other ? [base, other] : [base]) {
		const source = await mkdtemp(join(base, 'source-'));
		const target = join(targetBase, `target-${crypto.randomUUID()}`);
		await writeFile(join(source, 'data.bin'), 'data');
		const sourceRoot = { kind: 'explicit' as const, path: source };
		const targetRoot = { kind: 'explicit' as const, path: target };
		let committed = false;
		const commit = () => {
			committed = true;
		};
		const wrong = { ...manifest, files: [{ ...manifest.files![0]!, checksums: [hash('nope')] }] };
		await assert.rejects(
			moveDatasetData(wrong, sourceRoot, targetRoot, commit, () => {}),
			{ code: 'LISH_INVALID_MANIFEST' }
		);
		assert.equal(committed, false);
		assert.equal(await readFile(join(source, 'data.bin'), 'utf8'), 'data');
		const result = await moveDatasetData(manifest, sourceRoot, targetRoot, commit, () => {});
		assert.equal(committed, true);
		assert.deepEqual(result.cleanupWarnings, []);
		assert.equal(await readFile(join(target, 'data.bin'), 'utf8'), 'data');
		await assert.rejects(stat(join(source, 'data.bin')), { code: 'ENOENT' });
	}
	if (other) {
		const source = join(base, 'changing');
		const target = join(other, 'changed-target');
		await mkdir(source);
		await writeFile(join(source, 'data.bin'), 'data');
		const result = await moveDatasetData(
			manifest,
			{ kind: 'explicit', path: source },
			{ kind: 'explicit', path: target },
			() => appendFileSync(join(source, 'data.bin'), '-changed'),
			() => {}
		);
		assert.equal(result.cleanupWarnings[0]?.code, 'FS_FILE_CHANGED');
		assert.equal(await readFile(join(source, 'data.bin'), 'utf8'), 'data-changed');
		assert.equal(await readFile(join(target, 'data.bin'), 'utf8'), 'data');
	}
	console.log(JSON.stringify({ platform: process.platform, bun: Bun.version, fileIO: true, rejectsRedirect: true, move: true, failedMoveKeepsSource: true, crossFilesystem: !!other, changedCopySourceRetained: !!other }));
} finally {
	await rm(base, { recursive: true, force: true });
	if (other) await rm(other, { recursive: true, force: true });
}
