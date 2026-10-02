import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IStoredLISH } from '@shared';
import { FileAllocator } from '../../../src/protocol/file-allocator.ts';
import { Downloader } from '../../../src/protocol/downloader.ts';
import { MockNetwork } from '../helpers/mock-network.ts';
import { MockDataServer, makeMissingChunk } from '../protocol/downloader-test-helpers.ts';
import { checkDatasetSpace } from '../../../src/lish/dataset-space.ts';
import { moveDatasetData } from '../../../src/lish/dataset-transfer.ts';

const roots: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	for (const path of roots.splice(0)) await fs.rm(path, { recursive: true, force: true });
});

async function fixture() {
	const base = await fs.mkdtemp(join(tmpdir(), 'dataset-space-'));
	roots.push(base);
	const source = join(base, 'source');
	const target = join(base, 'destination');
	await fs.mkdir(source);
	const lish: IStoredLISH = { id: 'space', name: 'space', created: '2026-01-01', chunkSize: 50, checksumAlgo: 'sha256', directory: source, finalDirectory: target, files: [{ path: 'data.bin', size: 50, checksums: ['00'] }] };
	return { base, source, target, lish };
}

function capacity(free: bigint): void {
	spies.push(spyOn(fs, 'statfs').mockResolvedValue({ bavail: free, bsize: 1n } as any));
}

test('refuses a download that fits alone but cannot coexist with its completion copy', async () => {
	const f = await fixture();
	capacity(60n);
	await expect(new FileAllocator(f.source).allocateStructure(f.lish)).rejects.toMatchObject({ code: 'DISK_FULL' });
	await expect(fs.stat(join(f.source, 'data.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
	await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('allocates when both copies fit on the same filesystem', async () => {
	const f = await fixture();
	capacity(100n);
	expect(await new FileAllocator(f.source).allocateStructure(f.lish)).toEqual({ created: 1, skipped: 0 });
	expect((await fs.stat(join(f.source, 'data.bin'))).size).toBe(50);
});

test('checks the completion reserve again when resuming fully allocated files', async () => {
	const f = await fixture();
	await fs.writeFile(join(f.source, 'data.bin'), Buffer.alloc(50));
	capacity(10n);
	await expect(new FileAllocator(f.source).findMissingFiles(f.lish)).rejects.toMatchObject({ code: 'DISK_FULL' });
	expect((await fs.stat(join(f.source, 'data.bin'))).size).toBe(50);
});

test('counts the additional files materialized from links', async () => {
	const f = await fixture();
	f.lish.links = [{ path: 'copy.bin', target: 'data.bin' }];
	capacity(120n);
	await expect(new FileAllocator(f.source).allocateStructure(f.lish)).rejects.toMatchObject({ code: 'DISK_FULL' });
	await expect(fs.stat(join(f.source, 'data.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('checks separate filesystems independently and still refuses a full destination', async () => {
	const f = await fixture();
	spies.push(spyOn(fs, 'stat').mockImplementation((async (path: unknown) => ({ dev: String(path).includes('destination') ? 2n : 1n })) as any));
	const available = spyOn(fs, 'statfs').mockResolvedValue({ bavail: 60n, bsize: 1n } as any);
	spies.push(available);
	await checkDatasetSpace(f.source, 50n, { path: f.target, bytes: 50n });
	available.mockImplementation((async (path: unknown) => ({ bavail: String(path).includes('destination') ? 40n : 60n, bsize: 1n })) as any);
	await expect(checkDatasetSpace(f.source, 50n, { path: f.target, bytes: 50n })).rejects.toMatchObject({ code: 'DISK_FULL' });
});

test('rechecks copy space before creating a destination and keeps the complete source', async () => {
	const f = await fixture();
	const bytes = Buffer.alloc(50, 7);
	await fs.writeFile(join(f.source, 'data.bin'), bytes);
	f.lish.files![0]!.checksums = [new Bun.CryptoHasher('sha256').update(bytes).digest('hex')];
	capacity(10n);
	let committed = false;
	await expect(
		moveDatasetData(
			f.lish,
			{ kind: 'explicit', path: f.source },
			{ kind: 'derived', base: f.base, component: 'destination' },
			() => {
				committed = true;
			},
			() => {}
		)
	).rejects.toMatchObject({ code: 'DISK_FULL' });
	expect(committed).toBe(false);
	expect(await fs.readFile(join(f.source, 'data.bin'))).toEqual(bytes);
	await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('reports unavailable capacity as a terminal download error without allocating files', async () => {
	const f = await fixture();
	const data = Object.assign(new MockDataServer(), { getDatasetLinkBindings: () => [] });
	data.allChunkCount = 1;
	data.missingChunks = [makeMissingChunk('chunk' as never)];
	spies.push(spyOn(fs, 'statfs').mockRejectedValue(Object.assign(new Error('Capacity read failed'), { code: 'EIO' })));
	const downloader = new Downloader(f.source, new MockNetwork() as never, data as never, 'test-network');
	try {
		await downloader.initFromManifest(f.lish);
		await expect(downloader.download()).rejects.toMatchObject({ code: 'DISK_SPACE_UNAVAILABLE' });
		expect(downloader.getError()?.code).toBe('DISK_SPACE_UNAVAILABLE');
		await expect(fs.stat(join(f.source, 'data.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
	} finally {
		await downloader.destroy();
	}
});
