import { describe, expect, it } from 'bun:test';
import { type Database } from 'bun:sqlite';
import { type FileHandle } from 'fs/promises';
import { DataServer } from '../../../src/lish/data-server.ts';
import { type ILISH } from '@shared';

const lish: ILISH = {
	id: 'write-test',
	name: 'write-test',
	created: '2026-01-01T00:00:00Z',
	chunkSize: 8,
	checksumAlgo: 'sha256',
	files: [{ path: 'file.bin', size: 8, checksums: ['chunk-0'] }],
};

describe('DataServer.writeChunk', () => {
	it('continues after a partial write until the entire chunk is stored', async () => {
		const calls: Array<{ offset: number; length: number; position: number }> = [];
		let closed = false;
		const handle = {
			write: async (_data: Uint8Array, offset: number, length: number, position: number) => {
				calls.push({ offset, length, position });
				return { bytesWritten: calls.length === 1 ? 3 : length, buffer: _data };
			},
			close: async () => {
				closed = true;
			},
		} as unknown as FileHandle;
		const dataServer = new DataServer({} as Database, async () => handle);

		await dataServer.writeChunk('/download', lish, 0, 0, new Uint8Array(8));

		expect(calls).toEqual([
			{ offset: 0, length: 8, position: 0 },
			{ offset: 3, length: 5, position: 3 },
		]);
		expect(closed).toBe(true);
	});

	it('propagates ENOSPC after a partial write and closes the file', async () => {
		let calls = 0;
		let closed = false;
		const noSpace = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
		const handle = {
			write: async (_data: Uint8Array, _offset: number, length: number) => {
				calls++;
				if (calls === 1) return { bytesWritten: Math.min(3, length), buffer: _data };
				throw noSpace;
			},
			close: async () => {
				closed = true;
			},
		} as unknown as FileHandle;
		const dataServer = new DataServer({} as Database, async () => handle);

		await expect(dataServer.writeChunk('/download', lish, 0, 0, new Uint8Array(8))).rejects.toMatchObject({ code: 'ENOSPC' });
		expect(calls).toBe(2);
		expect(closed).toBe(true);
	});
});
