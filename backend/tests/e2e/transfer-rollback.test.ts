import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCodes, type LISHid, type ChunkID } from '@shared';
import { createDB } from './helpers/transfer-state.ts';
import { addLISH, getDownloadEnabledLishs, setDownloadEnabled } from '../../src/db/lishs.ts';
import { DataServer } from '../../src/lish/data-server.ts';
import { initDownloadState, initTransferHandlers, getDownloadEnabledLishs as runtimeDownloads } from '../../src/api/transfer.ts';
import { initUploadState } from '../../src/protocol/lish-protocol.ts';

describe('download startup persistence', () => {
	const id = 'rollback-dataset' as LISHid;
	let db: ReturnType<typeof createDB>;
	let dataServer: DataServer;
	let dir: string;
	let writes: boolean[];
	let events: Array<{ event: string; data: any }>;
	let networkReads: number;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'lish-transfer-rollback-'));
		db = createDB();
		dataServer = new DataServer(db);
		writes = [];
		events = [];
		networkReads = 0;
		initUploadState(new Set(), () => {});
		initDownloadState(new Set(), (lishID, enabled) => {
			writes.push(enabled);
			setDownloadEnabled(db, lishID, enabled);
		});
		addLISH(db, { id, name: 'Dataset', description: '', created: '2024-06-01T12:00:00Z', chunkSize: 65536, checksumAlgo: 'sha256', directory: join(dir, 'download'), files: [{ path: 'payload.bin', size: 1, checksums: [`sha256:${'a'.repeat(64)}` as ChunkID] }] });
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	function handlers(joined: boolean): ReturnType<typeof initTransferHandlers> {
		const networks = {
			getEnabled: () => (joined ? [{ id: 'test-network' }] : []),
			isJoined: () => joined,
			getRunningNetwork: () => {
				networkReads++;
				throw new Error('No running network');
			},
		};
		return initTransferHandlers(
			networks as never,
			dataServer,
			dir,
			() => {},
			(event, data) => events.push({ event, data })
		);
	}

	it('rolls back the runtime flag for a missing LISH', async () => {
		const result = await handlers(true).enableDownload({ lishID: 'missing-dataset' });
		expect(result.success).toBe(false);
		expect(runtimeDownloads().has('missing-dataset')).toBe(false);
		expect(writes).toEqual([true, false]);
		expect(networkReads).toBe(0);
	});

	it('rolls back a persisted enable when the joined network disappears before startup', async () => {
		const result = await handlers(true).enableDownload({ lishID: id });
		expect(result.success).toBe(false);
		expect(networkReads).toBe(1);
		expect(writes).toEqual([true, false]);
		expect(runtimeDownloads().has(id)).toBe(false);
		expect(getDownloadEnabledLishs(db).has(id)).toBe(false);
		expect(dataServer.listSummaries().find(item => item.id === id)?.errorCode).toBe(ErrorCodes.DOWNLOAD_ERROR);
		expect(events.find(item => item.event === 'transfer.download:error')).toMatchObject({ data: { lishID: id, error: ErrorCodes.DOWNLOAD_ERROR, errorDetail: 'No running network' } });
	});

	it('keeps the saved download intent when no network has joined yet', async () => {
		const result = await handlers(false).enableDownload({ lishID: id });
		expect(result.success).toBe(false);
		expect(writes).toEqual([true]);
		expect(runtimeDownloads().has(id)).toBe(false);
		expect(getDownloadEnabledLishs(db).has(id)).toBe(true);
		expect(networkReads).toBe(0);
		expect(events.some(item => item.event === 'transfer.download:error')).toBe(false);
	});
});
