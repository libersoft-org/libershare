import { describe, expect, it } from 'bun:test';
import { type Database } from 'bun:sqlite';
import type { DatasetFileHandle } from '../../../src/lish/safe-dataset-types.ts';
import type { SafeDataset } from '../../../src/lish/safe-dataset-files.ts';
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
		const calls: Array<{ length: number; position: number }> = [];
		let closed = false;
		const handle = {
			stat: async () => ({ kind: 'file', size: 8, links: 1, identity: 'test-file' }),
			write: async (data: Uint8Array, position: number) => {
				calls.push({ length: data.length, position });
				return calls.length === 1 ? 3 : data.length;
			},
			close: async () => {
				closed = true;
			},
		} as unknown as DatasetFileHandle;
		const dataServer = new DataServer({} as Database, async () => ({ statDirectory: async () => ({ identity: 'root' }), prepare: async () => {}, openFile: async () => handle, close: async () => {} }) as unknown as SafeDataset);

		await dataServer.writeChunk('/download', lish, 0, 0, new Uint8Array(8));

		expect(calls).toEqual([
			{ length: 8, position: 0 },
			{ length: 5, position: 3 },
		]);
		expect(closed).toBe(true);
	});

	it('propagates ENOSPC after a partial write and closes the file', async () => {
		let calls = 0;
		let closed = false;
		const noSpace = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
		const handle = {
			stat: async () => ({ kind: 'file', size: 8, links: 1, identity: 'test-file' }),
			write: async (data: Uint8Array) => {
				calls++;
				if (calls === 1) return Math.min(3, data.length);
				throw noSpace;
			},
			close: async () => {
				closed = true;
			},
		} as unknown as DatasetFileHandle;
		const dataServer = new DataServer({} as Database, async () => ({ statDirectory: async () => ({ identity: 'root' }), prepare: async () => {}, openFile: async () => handle, close: async () => {} }) as unknown as SafeDataset);

		await expect(dataServer.writeChunk('/download', lish, 0, 0, new Uint8Array(8))).rejects.toMatchObject({ code: 'ENOSPC' });
		expect(calls).toBe(2);
		expect(closed).toBe(true);
	});
});
