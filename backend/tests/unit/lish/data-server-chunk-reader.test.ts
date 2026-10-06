import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
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
	let dataServer: DataServer;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'lish-reader-'));
		writeFileSync(join(dir, 'data.bin'), 'AAAABBBBCC');
		db = openDatabase(dir);
		const lish: IStoredLISH = { id: LISH_ID, name: 'reader', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', directory: dir, files: [{ path: 'data.bin', size: 10, checksums: CHUNKS }], chunks: [...CHUNKS] };
		addLISH(db, lish);
		opened = 0;
		closed = 0;
		const counting: typeof openDataset = async (...args) => {
			opened++;
			const dataset = await openDataset(...args);
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
		expect(opened).toBe(1);
		expect(closed).toBe(0);
		await reader.close();
		expect(closed).toBe(1);
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
});
