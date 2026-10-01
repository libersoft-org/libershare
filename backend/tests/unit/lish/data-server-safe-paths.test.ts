import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { runVerification, type VerifyFileProgress } from '../../../src/lish/lish.ts';
import type { IStoredLISH } from '@shared';

async function fixture(run: (data: DataServer, manifest: IStoredLISH, directory: string, outside: string) => Promise<void>): Promise<void> {
	const base = await mkdtemp(join(tmpdir(), 'lish-safe-io-'));
	const directory = join(base, 'dataset');
	const outside = join(base, 'outside');
	await mkdir(directory);
	await mkdir(outside);
	await writeFile(join(outside, 'file.bin'), 'KEEP');
	const db = openDatabase(base);
	const data = new DataServer(db);
	const checksum = new Bun.CryptoHasher('sha256').update('DATA').digest('hex');
	const manifest: IStoredLISH = { id: crypto.randomUUID(), created: '2026-01-01T00:00:00Z', directory, chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'file.bin', size: 4, checksums: [checksum] }], chunks: [checksum] };
	data.add(manifest);
	try {
		await run(data, manifest, directory, outside);
	} finally {
		db.close();
		await rm(base, { recursive: true, force: true });
	}
}

describe('dataset data paths', () => {
	test('writes, serves and verifies content with unchanged checksum semantics', async () => {
		await fixture(async (data, manifest, directory) => {
			await writeFile(join(directory, 'file.bin'), 'ZERO');
			await data.writeChunk(directory, manifest, 0, 0, Buffer.from('DATA'));
			expect(await readFile(join(directory, 'file.bin'), 'utf8')).toBe('DATA');
			expect(await data.getChunk(manifest.id, manifest.files![0]!.checksums[0]!)).toEqual(new Uint8Array(Buffer.from('DATA')));
			const progress: VerifyFileProgress[] = [];
			data.resetVerification(manifest.id);
			await runVerification(data, manifest.id, event => progress.push(event));
			expect(data.isVerified(manifest.id)).toBe(true);
			expect(progress[progress.length - 1]?.done).toBe(true);
			await writeFile(join(directory, 'file.bin'), 'BAD');
			data.resetVerification(manifest.id);
			await runVerification(data, manifest.id, () => {});
			expect(data.isVerified(manifest.id)).toBe(false);
			expect(data.getMissingChunks(manifest.id)).toHaveLength(1);
		});
	});

	for (const linkKind of ['file', 'parent'] as const) {
		test(`refuses ${linkKind} links for upload, chunk write and verification`, async () => {
			await fixture(async (data, manifest, directory, outside) => {
				if (linkKind === 'file') {
					await symlink(join(outside, 'file.bin'), join(directory, 'file.bin'), 'file');
				} else {
					manifest.files![0]!.path = 'linked/file.bin';
					data.delete(manifest.id);
					data.add(manifest);
					await symlink(outside, join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
				}
				await expect(data.getChunk(manifest.id, manifest.files![0]!.checksums[0]!)).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
				await expect(data.writeChunk(directory, manifest, 0, 0, Buffer.from('EVIL'))).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
				const progress: VerifyFileProgress[] = [];
				await expect(runVerification(data, manifest.id, event => progress.push(event))).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
				expect(progress).toHaveLength(0);
				expect(data.getMissingChunks(manifest.id)).toHaveLength(0);
				expect(await readFile(join(outside, 'file.bin'), 'utf8')).toBe('KEEP');
			});
		});
	}

	test('checks all manifest targets before writing even an unrelated safe file', async () => {
		await fixture(async (data, manifest, directory, outside) => {
			await writeFile(join(directory, 'file.bin'), 'ZERO');
			manifest.files!.push({ path: 'other.bin', size: 4, checksums: ['other'] });
			await symlink(join(outside, 'file.bin'), join(directory, 'other.bin'), 'file');
			await expect(data.writeChunk(directory, manifest, 0, 0, Buffer.from('DATA'))).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
			expect(await readFile(join(directory, 'file.bin'), 'utf8')).toBe('ZERO');
			expect(await readFile(join(outside, 'file.bin'), 'utf8')).toBe('KEEP');
		});
	});

	test('rejects invalid chunk bounds without touching the target', async () => {
		await fixture(async (data, manifest, directory) => {
			await writeFile(join(directory, 'file.bin'), 'ZERO');
			for (const [fileIndex, chunkIndex, length] of [[-1, 0, 4], [0, -1, 4], [0, 0.5, 4], [0, 1, 4], [0, 0, 3], [0, 0, 5]] as const) {
				await expect(data.writeChunk(directory, manifest, fileIndex, chunkIndex, new Uint8Array(length))).rejects.toBeDefined();
			}
			expect(await readFile(join(directory, 'file.bin'), 'utf8')).toBe('ZERO');
		});
	});

	test('records missing chunks when the entire dataset directory disappeared', async () => {
		await fixture(async (data, manifest, directory) => {
			await rm(directory, { recursive: true });
			const progress: VerifyFileProgress[] = [];
			await runVerification(data, manifest.id, event => progress.push(event));
			expect(data.getMissingChunks(manifest.id)).toHaveLength(1);
			expect(progress[progress.length - 1]?.done).toBe(true);
		});
	});

	test('cancellation between chunks closes the file without completing verification', async () => {
		await fixture(async (data, manifest, directory) => {
			manifest.files![0]!.size = 8;
			manifest.files![0]!.checksums.push(manifest.files![0]!.checksums[0]!);
			data.delete(manifest.id);
			data.add(manifest);
			await writeFile(join(directory, 'file.bin'), 'DATADATA');
			const controller = new AbortController();
			const progress: VerifyFileProgress[] = [];
			data.resetVerification(manifest.id);
			await runVerification(data, manifest.id, event => { progress.push(event); controller.abort(); }, controller.signal);
			expect(progress).toHaveLength(1);
			expect(progress[0]?.done).toBeUndefined();
			expect(data.isVerified(manifest.id)).toBe(false);
			await rm(join(directory, 'file.bin'));
		});
	});
});
