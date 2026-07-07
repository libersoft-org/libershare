import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDatabase } from '../../../src/db/database.ts';
import { addLISH, getMissingChunks, findChunkLocation } from '../../../src/db/lishs.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { type LISHid, type ChunkID, type IStoredLISH } from '@shared';

const LISH_ID = 'lish-missing-file-test' as LISHid;
const CHUNK_SIZE = 4;

// Two 2-chunk files, all chunks marked as have (completed download / share).
const FILE_A_CHUNKS = ['chunk-a-0', 'chunk-a-1'] as ChunkID[];
const FILE_B_CHUNKS = ['chunk-b-0', 'chunk-b-1'] as ChunkID[];

describe('DataServer.getChunk — file missing on disk', () => {
	let dir: string;
	let dataServer: DataServer;
	let db: ReturnType<typeof openDatabase>;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'lish-missing-'));
		writeFileSync(join(dir, 'file-a.bin'), 'AAAABBBB');
		writeFileSync(join(dir, 'file-b.bin'), 'CCCCDDDD');
		db = openDatabase(dir);
		const lish: IStoredLISH = {
			id: LISH_ID,
			name: 'missing-file-test',
			created: '2026-01-01T00:00:00Z',
			chunkSize: CHUNK_SIZE,
			checksumAlgo: 'sha256',
			directory: dir,
			files: [
				{ path: 'file-a.bin', size: 8, checksums: FILE_A_CHUNKS },
				{ path: 'file-b.bin', size: 8, checksums: FILE_B_CHUNKS },
			],
			chunks: [...FILE_A_CHUNKS, ...FILE_B_CHUNKS],
		};
		addLISH(db, lish);
		dataServer = new DataServer(db);
	});

	afterAll(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it('serves chunks while the file exists', async () => {
		const data = await dataServer.getChunk(LISH_ID, FILE_A_CHUNKS[0]!);
		expect(data).toBeInstanceOf(Uint8Array);
		expect(new TextDecoder().decode(data as Uint8Array)).toBe('AAAA');
	});

	it('resets all chunks of a file that vanished from disk and reports io_error once', async () => {
		unlinkSync(join(dir, 'file-a.bin'));
		const result = await dataServer.getChunk(LISH_ID, FILE_A_CHUNKS[0]!);
		expect(result).toBe('io_error');
		// Both chunks of file-a are reset in DB — listed as missing again.
		const missing = getMissingChunks(db, LISH_ID).map(m => m.chunkID);
		expect(missing).toEqual(FILE_A_CHUNKS);
		// findChunkLocation no longer claims the vanished file's chunks.
		expect(findChunkLocation(db, LISH_ID, FILE_A_CHUNKS[1]!)).toBeNull();
	});

	it('answers chunk_not_found for the vanished file afterwards (honest partial seeder)', async () => {
		const result = await dataServer.getChunk(LISH_ID, FILE_A_CHUNKS[1]!);
		expect(result).toBe('chunk_not_found');
	});

	it('keeps serving chunks of intact files in the same LISH', async () => {
		const data = await dataServer.getChunk(LISH_ID, FILE_B_CHUNKS[1]!);
		expect(data).toBeInstanceOf(Uint8Array);
		expect(new TextDecoder().decode(data as Uint8Array)).toBe('DDDD');
	});
});
