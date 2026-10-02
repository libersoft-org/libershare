import { expect, spyOn, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { CodedError, ErrorCodes } from '@shared';
import { initDownloadState, initTransferHandlers, removeDownloadState } from '../../../src/api/transfer.ts';
import { initUploadState } from '../../../src/protocol/lish-protocol.ts';
import { Downloader } from '../../../src/protocol/downloader.ts';
import type { Networks } from '../../../src/lishnet/lishnets.ts';
import type { DataServer } from '../../../src/lish/data-server.ts';
import type { Settings } from '../../../src/settings.ts';

for (const batch of [false, true])
	for (const interruption of ['none', 'leave', 'delete'] as const)
		test(`${batch ? 'batch restore' : 'manual start'} handles ${interruption} after preparation and before registration`, async () => {
			const id = 'handoff-download';
			const enabled = new Set<string>();
			initDownloadState(enabled, () => {});
			initUploadState(new Set(), () => {});
			let joined = true,
				initialized = false,
				queued = false;
			let left: (networkID: string) => unknown = () => {};
			let interrupted: Promise<unknown> | undefined;
			const networks = {
				getRunningNetwork: () => ({ onPeerDisconnect: () => () => {} }),
				getEnabled: () => [{ networkID: 'net-a' }],
				isJoined: () => {
					if (initialized && !queued && interruption !== 'none') {
						queued = true;
						queueMicrotask(() => {
							if (interruption === 'delete') interrupted = removeDownloadState(id);
							else {
								joined = false;
								interrupted = Promise.resolve(left('net-a'));
							}
						});
					}
					return joined;
				},
				set onNetworkLeft(callback: typeof left) {
					left = callback;
				},
				set onNetworkJoined(_callback: unknown) {},
			} as unknown as Networks;
			const data = {
				get: () => ({ id, name: 'download', directory: null, files: [] }),
				getAllChunkCount: () => 4,
				getMissingChunks: () => ['chunk-0'],
				isCompleteLISH: () => false,
				getTransferStats: () => ({ downloadedBytes: 0, uploadedBytes: 0 }),
				clearError: () => {},
				setError: () => {},
			} as unknown as DataServer;
			const originalInit = Downloader.prototype.initFromManifest;
			const init = spyOn(Downloader.prototype, 'initFromManifest').mockImplementation(async function (this: Downloader, lish) {
				await originalInit.call(this, lish);
				initialized = true;
			});
			let cancel!: (error: Error) => void;
			const running = new Promise<void>((_, reject) => {
				cancel = reject;
			});
			void running.catch(() => {});
			const start = spyOn(Downloader.prototype, 'download').mockImplementation(() => running);
			const destroy = spyOn(Downloader.prototype, 'destroy');
			const events: string[] = [];
			const handlers = initTransferHandlers(
				networks,
				data,
				tmpdir(),
				() => {},
				event => events.push(event),
				{ get: () => false } as unknown as Settings
			);
			try {
				if (batch) await handlers.restoreAll(new Set([id]));
				else expect(await handlers.enableDownload({ lishID: id })).toEqual({ success: interruption === 'none' });
				await interrupted;
				if (interruption === 'none') {
					expect(start).toHaveBeenCalledTimes(1);
					expect(enabled.has(id)).toBe(true);
				} else {
					expect(queued).toBe(true);
					expect(start).not.toHaveBeenCalled();
					expect(destroy).toHaveBeenCalledTimes(1);
					expect(handlers.getActiveTransfers()).toEqual([]);
					expect(enabled.has(id)).toBe(false);
					expect(events).not.toContain('transfer.download:enabled');
				}
			} finally {
				cancel(new CodedError(ErrorCodes.DOWNLOAD_CANCELLED));
				await removeDownloadState(id);
				init.mockRestore();
				start.mockRestore();
				destroy.mockRestore();
			}
		});
