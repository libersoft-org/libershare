import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDatabase } from '../../../src/db/database.ts';
import { addLISH } from '../../../src/db/lishs.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { openDataset } from '../../../src/lish/safe-dataset-files.ts';
import { type ChunkID, type IStoredLISH, type LISHid } from '@shared';

const LISH_ID = 'lish-chunk-reader-test' as LISHid;
const CHUNKS = ['chunk-r-0', 'chunk-r-1', 'chunk-r-2'] as ChunkID[];

/**
 * A chunk reader keeps the files it read open for the next chunk of the same stream, and closes
 * them when the stream ends or goes idle.
 */
describe('DataServer.createChunkReader', () => {
	let dir: string;
	let db: ReturnType<typeof openDatabase>;
	let opened = 0;
	let closed = 0;
	let fileOpens = 0;
	let maxOpen = 0;
	let openDelayMs = 0;
	let dataServer: DataServer;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'lish-reader-'));
		writeFileSync(join(dir, 'data.bin'), 'AAAABBBBCC');
		db = openDatabase(dir);
		const lish: IStoredLISH = { id: LISH_ID, name: 'reader', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', directory: dir, files: [{ path: 'data.bin', size: 10, checksums: CHUNKS }], chunks: [...CHUNKS] };
		addLISH(db, lish);
		opened = 0;
		closed = 0;
		fileOpens = 0;
		maxOpen = 0;
		openDelayMs = 0;
		const counting: typeof openDataset = async (...args) => {
			opened++;
			maxOpen = Math.max(maxOpen, opened - closed);
			if (openDelayMs > 0) await Bun.sleep(openDelayMs);
			const dataset = await openDataset(...args);
			const openFile = dataset.openFile.bind(dataset);
			dataset.openFile = (...fileArgs) => {
				fileOpens++;
				return openFile(...fileArgs);
			};
			const close = dataset.close.bind(dataset);
			dataset.close = async () => {
				closed++;
				await close();
			};
			return dataset;
		};
		dataServer = new DataServer(db, counting);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const text = (data: unknown): string => new TextDecoder().decode(data as Uint8Array);

	it('opens a file once for consecutive chunks of one stream and closes it with the reader', async () => {
		const reader = dataServer.createChunkReader();
		expect(text(await reader.getChunk(LISH_ID, CHUNKS[0]!))).toBe('AAAA');
		expect(text(await reader.getChunk(LISH_ID, CHUNKS[1]!))).toBe('BBBB');
		expect(text(await reader.getChunk(LISH_ID, CHUNKS[2]!))).toBe('CC');
		// Off Windows each reuse also resolves the path through a fresh root, which it closes again.
		expect(fileOpens).toBe(1);
		expect(opened - closed).toBe(1);
		await reader.close();
		expect(closed).toBe(opened);
	});

	it('closes kept files after the idle time and reopens them for the next chunk', async () => {
		const reader = dataServer.createChunkReader(30);
		await reader.getChunk(LISH_ID, CHUNKS[0]!);
		await Bun.sleep(80);
		expect(closed).toBe(1);
		expect(text(await reader.getChunk(LISH_ID, CHUNKS[1]!))).toBe('BBBB');
		expect(opened).toBe(2);
		await reader.close();
	});

	it('still opens and closes per chunk outside a reader', async () => {
		await dataServer.getChunk(LISH_ID, CHUNKS[0]!);
		await dataServer.getChunk(LISH_ID, CHUNKS[1]!);
		expect(opened).toBe(2);
		expect(closed).toBe(2);
	});

	it('keeps no more than its file limit open while a stream reads many files without a pause', async () => {
		const id = 'lish-chunk-reader-many' as LISHid;
		const ids = Array.from({ length: 12 }, (_, i) => `chunk-many-${i}` as ChunkID);
		ids.forEach((_, i) => writeFileSync(join(dir, `f${i}.bin`), `F${String(i).padStart(3, '0')}`));
		addLISH(db, { id, name: 'many', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', directory: dir, files: ids.map((c, i) => ({ path: `f${i}.bin`, size: 4, checksums: [c] })), chunks: [...ids] });
		const reader = dataServer.createChunkReader(2000, 4);
		for (let i = 0; i < ids.length; i++) expect(text(await reader.getChunk(id, ids[i]!))).toBe(`F${String(i).padStart(3, '0')}`);
		expect(maxOpen).toBeLessThanOrEqual(5);
		expect(opened - closed).toBeLessThanOrEqual(4);
		await reader.close();
		expect(closed).toBe(opened);
	});

	it('does not close a file that is still opening when the idle time passes', async () => {
		const reader = dataServer.createChunkReader(30);
		openDelayMs = 80;
		expect(text(await reader.getChunk(LISH_ID, CHUNKS[0]!))).toBe('AAAA');
		await reader.close();
		expect(closed).toBe(opened);
	});

	it('reads past the old end of a kept file that grew since it was opened', async () => {
		writeFileSync(join(dir, 'data.bin'), 'AAAA');
		const reader = dataServer.createChunkReader();
		expect(text(await reader.getChunk(LISH_ID, CHUNKS[0]!))).toBe('AAAA');
		appendFileSync(join(dir, 'data.bin'), 'BBBBCC');
		expect(text(await reader.getChunk(LISH_ID, CHUNKS[1]!))).toBe('BBBB');
		await reader.close();
	});

	// Windows refuses to delete or replace a file that is open, so these cases cannot happen there.
	it.skipIf(process.platform === 'win32')('does not serve a kept file that was deleted from disk', async () => {
		const reader = dataServer.createChunkReader();
		await reader.getChunk(LISH_ID, CHUNKS[0]!);
		rmSync(join(dir, 'data.bin'));
		expect(await reader.getChunk(LISH_ID, CHUNKS[1]!)).toBe('file_missing');
		await reader.close();
	});

	it.skipIf(process.platform === 'win32')('serves the new file when the kept one was replaced on disk', async () => {
		const reader = dataServer.createChunkReader();
		await reader.getChunk(LISH_ID, CHUNKS[0]!);
		writeFileSync(join(dir, 'next.bin'), 'XXXXYYYYZZ');
		renameSync(join(dir, 'next.bin'), join(dir, 'data.bin'));
		expect(text(await reader.getChunk(LISH_ID, CHUNKS[1]!))).toBe('YYYY');
		await reader.close();
	});

	it.skipIf(process.platform === 'win32')('does not serve a kept file that was renamed away', async () => {
		const reader = dataServer.createChunkReader();
		await reader.getChunk(LISH_ID, CHUNKS[0]!);
		renameSync(join(dir, 'data.bin'), join(dir, 'backup.bin'));
		expect(await reader.getChunk(LISH_ID, CHUNKS[1]!)).toBe('file_missing');
		await reader.close();
	});

	it.skipIf(process.platform === 'win32')('serves the new file when the kept one was renamed away and another took its name', async () => {
		const reader = dataServer.createChunkReader();
		await reader.getChunk(LISH_ID, CHUNKS[0]!);
		renameSync(join(dir, 'data.bin'), join(dir, 'backup.bin'));
		writeFileSync(join(dir, 'data.bin'), 'XXXXYYYYZZ');
		expect(text(await reader.getChunk(LISH_ID, CHUNKS[1]!))).toBe('YYYY');
		await reader.close();
	});

	// The reader skips its path check on Windows because a file it holds open cannot be moved away.
	it.skipIf(process.platform !== 'win32')('keeps a file it holds open from being renamed or deleted on Windows', async () => {
		const reader = dataServer.createChunkReader();
		await reader.getChunk(LISH_ID, CHUNKS[0]!);
		expect(() => renameSync(join(dir, 'data.bin'), join(dir, 'backup.bin'))).toThrow();
		expect(() => rmSync(join(dir, 'data.bin'))).toThrow();
		expect(() => renameSync(dir, `${dir}-moved`)).toThrow();
		await reader.close();
	});

	it('closes an idle file after its own idle time while the stream keeps reading another one', async () => {
		const other = 'lish-chunk-reader-other' as LISHid;
		writeFileSync(join(dir, 'other.bin'), 'OOOO');
		addLISH(db, { id: other, name: 'other', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', directory: dir, files: [{ path: 'other.bin', size: 4, checksums: ['chunk-o-0' as ChunkID] }], chunks: ['chunk-o-0' as ChunkID] });
		const reader = dataServer.createChunkReader(40);
		await reader.getChunk(LISH_ID, CHUNKS[0]!);
		for (let i = 0; i < 10; i++) {
			expect(text(await reader.getChunk(other, 'chunk-o-0' as ChunkID))).toBe('OOOO');
			await Bun.sleep(15);
		}
		// The first file was last read well past its idle time ago; only the other one stays open.
		expect(opened - closed).toBe(1);
		await reader.close();
		expect(closed).toBe(opened);
	});

	it('closes the files of a held LISH and reads it uncached until the hold is released', async () => {
		const reader = dataServer.createChunkReader(60_000);
		await reader.getChunk(LISH_ID, CHUNKS[0]!);
		expect(opened - closed).toBe(1);
		const release = await dataServer.holdChunkFiles(LISH_ID);
		expect(closed).toBe(opened);
		expect(text(await reader.getChunk(LISH_ID, CHUNKS[1]!))).toBe('BBBB');
		expect(closed).toBe(opened);
		release();
		await reader.getChunk(LISH_ID, CHUNKS[2]!);
		expect(opened - closed).toBe(1);
		await reader.close();
		expect(closed).toBe(opened);
	});

	it('waits for a read still using a kept file before the hold returns', async () => {
		const reader = dataServer.createChunkReader(60_000);
		openDelayMs = 60;
		const reading = reader.getChunk(LISH_ID, CHUNKS[0]!);
		await Bun.sleep(10);
		const release = await dataServer.holdChunkFiles(LISH_ID);
		expect(text(await reading)).toBe('AAAA');
		expect(closed).toBe(opened);
		release();
		await reader.close();
	});

	it.skipIf(process.platform !== 'win32')('lets a held LISH be deleted on Windows', async () => {
		const reader = dataServer.createChunkReader(60_000);
		await reader.getChunk(LISH_ID, CHUNKS[0]!);
		const release = await dataServer.holdChunkFiles(LISH_ID);
		expect(() => rmSync(join(dir, 'data.bin'))).not.toThrow();
		release();
		await reader.close();
	});

	describe('when the shared folder itself moves', () => {
		const NESTED = 'lish-chunk-reader-nested' as LISHid;
		const NESTED_CHUNKS = ['chunk-n-0', 'chunk-n-1', 'chunk-n-2'] as ChunkID[];
		let parent: string;
		let share: string;
		beforeEach(() => {
			parent = join(dir, 'parent');
			share = join(parent, 'share');
			mkdirSync(share, { recursive: true });
			writeFileSync(join(share, 'data.bin'), 'AAAABBBBCC');
			addLISH(db, { id: NESTED, name: 'nested', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', directory: share, files: [{ path: 'data.bin', size: 10, checksums: NESTED_CHUNKS }], chunks: [...NESTED_CHUNKS] });
		});
		const settle = (read: Promise<unknown>): Promise<string> =>
			read.then(
				value => (typeof value === 'string' ? value : text(value)),
				(error: { code?: string; message?: string }) => `threw ${error.code ?? error.message}`
			);

		it.skipIf(process.platform === 'win32')('does not serve the old data after the shared folder was renamed away', async () => {
			const reader = dataServer.createChunkReader();
			await reader.getChunk(NESTED, NESTED_CHUNKS[0]!);
			renameSync(share, join(parent, 'share-moved'));
			expect(await settle(reader.getChunk(NESTED, NESTED_CHUNKS[1]!))).not.toBe('BBBB');
			await reader.close().catch(() => {});
		});

		it.skipIf(process.platform === 'win32')('serves the folder that took the place of the shared one', async () => {
			const reader = dataServer.createChunkReader();
			await reader.getChunk(NESTED, NESTED_CHUNKS[0]!);
			renameSync(share, join(parent, 'share-moved'));
			mkdirSync(share);
			writeFileSync(join(share, 'data.bin'), 'XXXXYYYYZZ');
			expect(await settle(reader.getChunk(NESTED, NESTED_CHUNKS[1]!))).toBe('YYYY');
			await reader.close().catch(() => {});
		});

		it.skipIf(process.platform === 'win32')('does not serve the old data after a folder above the shared one was renamed away', async () => {
			const reader = dataServer.createChunkReader();
			await reader.getChunk(NESTED, NESTED_CHUNKS[0]!);
			renameSync(parent, join(dir, 'parent-moved'));
			expect(await settle(reader.getChunk(NESTED, NESTED_CHUNKS[1]!))).not.toBe('BBBB');
			await reader.close().catch(() => {});
		});
	});
});
