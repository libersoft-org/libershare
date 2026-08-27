import { expect, test } from 'bun:test';
import { buildDownloadCompleteEvent, buildDownloadProgressEvent } from '../../../src/api/transfer.ts';

const dataServer = {
	getTransferStats: () => ({ uploadedBytes: 7, downloadedBytes: 48 * 1024 * 1024 }),
};

test('download progress carries the authoritative cumulative byte count', () => {
	expect(buildDownloadProgressEvent(dataServer, 'lish-1', { downloadedChunks: 3, totalChunks: 3, peers: 2, bytesPerSecond: 1024 })).toEqual({
		lishID: 'lish-1',
		downloadedChunks: 3,
		totalChunks: 3,
		peers: 2,
		bytesPerSecond: 1024,
		totalDownloadedBytes: 48 * 1024 * 1024,
	});
});

test('download completion carries the same authoritative cumulative byte count', () => {
	expect(buildDownloadCompleteEvent(dataServer, '/downloads/lish-1', 'lish-1')).toEqual({
		downloadDir: '/downloads/lish-1',
		lishID: 'lish-1',
		totalDownloadedBytes: 48 * 1024 * 1024,
	});
});
