import { expect, mock, test } from 'bun:test';
import { get } from 'svelte/store';

type EventHandler = (data: any) => void;

const handlers = new Map<string, EventHandler>();
const detail = {
	id: 'download-bytes-test',
	name: 'download-bytes-test',
	created: '2026-01-01T00:00:00Z',
	directory: '/downloads/test',
	chunkSize: 16 * 1024 * 1024,
	checksumAlgo: 'sha256',
	totalSize: 48 * 1024 * 1024,
	totalChunks: 3,
	verifiedChunks: 2,
	totalUploadedBytes: 0,
	totalDownloadedBytes: 32 * 1024 * 1024,
	files: [
		{
			path: 'payload.bin',
			size: 48 * 1024 * 1024,
			totalChunks: 3,
			verifiedChunks: 2,
		},
	],
	directories: [],
	links: [],
};

const fakeApi = {
	lishs: {
		list: async () => ({ items: [{ id: detail.id }], verifying: null, pendingVerification: [], moving: [], uploadEnabled: [], downloadEnabled: [detail.id] }),
		get: async () => detail,
		delete: async () => true,
	},
	call: async () => [],
	on: (event: string, handler: EventHandler) => handlers.set(event, handler),
	subscribe: () => undefined,
};

mock.module('../../src/scripts/api.ts', () => ({ api: fakeApi }));

const { downloads, initDownloads } = await import('../../src/scripts/downloads.ts');

test('progress uses the backend cumulative byte count after a fresh database snapshot', async () => {
	await initDownloads();
	const progress = handlers.get('transfer.download:progress');
	expect(progress).toBeDefined();

	progress!({ lishID: detail.id, downloadedChunks: 0, totalChunks: 3, peers: 0, bytesPerSecond: 0, totalDownloadedBytes: 32 * 1024 * 1024 });
	progress!({ lishID: detail.id, downloadedChunks: 3, totalChunks: 3, peers: 0, bytesPerSecond: 0, totalDownloadedBytes: 48 * 1024 * 1024 });

	expect(get(downloads).find(download => download.id === detail.id)?.totalDownloadedBytes).toBe(48 * 1024 * 1024);

	const complete = handlers.get('transfer.download:complete');
	expect(complete).toBeDefined();
	complete!({ lishID: detail.id, downloadDir: detail.directory, totalDownloadedBytes: 64 * 1024 * 1024 });
	expect(get(downloads).find(download => download.id === detail.id)?.totalDownloadedBytes).toBe(64 * 1024 * 1024);
});
