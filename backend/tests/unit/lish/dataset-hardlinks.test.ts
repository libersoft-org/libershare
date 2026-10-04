import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataServer } from '../../../src/lish/data-server.ts';
import { FileAllocator } from '../../../src/protocol/file-allocator.ts';
import { Downloader } from '../../../src/protocol/downloader.ts';
import { MockNetwork } from '../helpers/mock-network.ts';
import { MockDataServer, makeMissingChunk } from '../protocol/downloader-test-helpers.ts';
import type { IStoredLISH } from '@shared';

async function withLinkedTarget(size: number, test: (directory: string, manifest: IStoredLISH, control: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'lish-hardlink-'));
	const directory = join(root, 'dataset');
	const control = join(root, 'control.bin');
	await mkdir(directory);
	await writeFile(control, 'KEEP');
	await link(control, join(directory, 'file.bin'));
	const left = await stat(control, { bigint: true });
	const right = await stat(join(directory, 'file.bin'), { bigint: true });
	expect(left.ino).toBe(right.ino);
	expect(left.nlink).toBeGreaterThan(1n);
	const manifest: IStoredLISH = { id: crypto.randomUUID(), created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', directory, files: [{ path: 'file.bin', size, checksums: ['chunk'] }] };
	try {
		await test(directory, manifest, control);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe('dataset hardlink boundaries', () => {
	it('ends preparation with a permanent local error and keeps it after a later worker error', async () => {
		await withLinkedTarget(4, async (directory, manifest, control) => {
			const data = new MockDataServer();
			data.allChunkCount = 1;
			data.missingChunks = [makeMissingChunk('chunk' as never)];
			const downloader = new Downloader(directory, new MockNetwork() as never, data as never, 'test-network');
			try {
				await downloader.initFromManifest(manifest);
				await expect(downloader.download()).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
				const first = downloader.getError();
				(downloader as unknown as { setError(code: string): void }).setError('DOWNLOAD_ERROR');
				expect(downloader.getError()).toEqual(first);
				expect(data.downloadedChunks.size).toBe(0);
				expect(await readFile(control, 'utf8')).toBe('KEEP');
			} finally {
				await downloader.destroy();
			}
		});
	});

	it('rejects a chunk write through a real hardlink without changing the other name', async () => {
		await withLinkedTarget(4, async (directory, manifest, control) => {
			const db = new Database(':memory:');
			try {
				await expect(new DataServer(db).writeChunk(directory, manifest, 0, 0, Buffer.from('TEST'))).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
				expect(await readFile(control, 'utf8')).toBe('KEEP');
			} finally {
				db.close();
			}
		});
	});

	for (const size of [4, 8]) {
		for (const operation of ['findMissingFiles', 'allocateStructure', 'allocateFile', 'allocateFiles'] as const) {
			it(`rejects ${operation} for a linked target with declared size ${size}`, async () => {
				await withLinkedTarget(size, async (directory, manifest, control) => {
					const allocator = new FileAllocator(directory);
					const attempt = operation === 'allocateFile' ? allocator.allocateFile(manifest, 0) : operation === 'allocateFiles' ? allocator.allocateFiles(manifest, [0]) : allocator[operation](manifest);
					await expect(attempt).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
					expect(await readFile(control, 'utf8')).toBe('KEEP');
				});
			});
		}
	}
});
