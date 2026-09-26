import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodedError, ErrorCodes, type IStoredLISH } from '@shared';
import { FileAllocator } from '../../../src/protocol/file-allocator.ts';

/**
 * The declared sizes of a manifest are compared with the free space before any file is
 * zero-filled, so a dataset that cannot fit is refused up front instead of running the disk
 * full half way through.
 */
describe('FileAllocator free space', () => {
	const dir = mkdtempSync(join(tmpdir(), 'lish-alloc-space-'));
	afterAll(() => rm(dir, { recursive: true, force: true }));
	const lish = (files: { path: string; size: number }[]): IStoredLISH => ({ id: 'x', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', files: files.map(f => ({ ...f, checksums: [] })) }) as IStoredLISH;

	it('refuses a manifest larger than the free space before writing anything', async () => {
		const abort = new AbortController();
		// Only guards the unfixed code, which would start zero-filling a petabyte.
		const guard = setTimeout(() => abort.abort(), 300);
		let error: unknown;
		try {
			await new FileAllocator(dir).allocateStructure(
				lish([
					{ path: 'small.bin', size: 1 },
					{ path: 'huge.bin', size: 2 ** 50 },
				]),
				undefined,
				abort.signal
			);
		} catch (e) {
			error = e;
		} finally {
			clearTimeout(guard);
		}
		expect(error).toBeInstanceOf(CodedError);
		expect((error as CodedError).code).toBe(ErrorCodes.DISK_FULL);
		expect(existsSync(join(dir, 'small.bin'))).toBe(false);
		expect(existsSync(join(dir, 'huge.bin'))).toBe(false);
	});

	it('allocates what fits, counting existing files only by what they still need', async () => {
		writeFileSync(join(dir, 'done.bin'), new Uint8Array(8));
		const result = await new FileAllocator(dir).allocateStructure(
			lish([
				{ path: 'done.bin', size: 8 },
				{ path: 'new.bin', size: 16 },
			])
		);
		expect(result).toEqual({ created: 1, skipped: 1 });
	});
});

describe('FileAllocator free space for a directory that does not exist yet', () => {
	const base = mkdtempSync(join(tmpdir(), 'lish-alloc-new-'));
	afterAll(() => rm(base, { recursive: true, force: true }));

	it('measures the nearest existing parent instead of skipping the check', async () => {
		const target = join(base, 'not', 'yet', 'there');
		const abort = new AbortController();
		const guard = setTimeout(() => abort.abort(), 300);
		let error: unknown;
		try {
			await new FileAllocator(target).allocateStructure({ id: 'x', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'huge.bin', size: 2 ** 50, checksums: [] }] } as IStoredLISH, undefined, abort.signal);
		} catch (e) {
			error = e;
		} finally {
			clearTimeout(guard);
		}
		expect((error as CodedError)?.code).toBe(ErrorCodes.DISK_FULL);
		expect(existsSync(join(target, 'huge.bin'))).toBe(false);
	});
});

describe('Downloader with a dataset larger than the free space', () => {
	it('rejects download() with DISK_FULL instead of waiting forever', async () => {
		const { Downloader } = await import('../../../src/protocol/downloader.ts');
		const { MockNetwork } = await import('../helpers/mock-network.ts');
		const { MockDataServer, makeLISH, makeMissingChunk } = await import('./downloader-test-helpers.ts');
		const base = mkdtempSync(join(tmpdir(), 'lish-dl-full-'));
		try {
			const ds = new MockDataServer();
			ds.missingChunks = [makeMissingChunk('c0' as never)];
			ds.allChunkCount = 1;
			const dl = new Downloader(join(base, 'target'), new MockNetwork() as never, ds as never, 'net-001');
			await dl.initFromManifest(makeLISH({ chunkSize: 2 ** 40, files: [{ path: 'huge.bin', size: 2 ** 50, checksums: Array.from({ length: 1024 }, (_, i) => `c${i}`) }] }));
			const outcome = await Promise.race([
				dl.download().then(
					() => 'resolved',
					(e: unknown) => (e as CodedError).code
				),
				Bun.sleep(3000).then(() => 'hung'),
			]);
			expect(outcome).toBe(ErrorCodes.DISK_FULL);
			await dl.destroy();
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});
