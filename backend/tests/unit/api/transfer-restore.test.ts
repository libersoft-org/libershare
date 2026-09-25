import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { tmpdir } from 'os';
import { initDownloadState, initTransferHandlers } from '../../../src/api/transfer.ts';
import { restoreTransferBatch, TransferRestoreRollbackError, type PreparedRestore, type RestorePlan } from '../../../src/api/transfer-restore.ts';
import { Downloader } from '../../../src/protocol/downloader.ts';
import type { Networks } from '../../../src/lishnet/lishnets.ts';
import type { DataServer } from '../../../src/lish/data-server.ts';
import type { Settings } from '../../../src/settings.ts';

/**
 * Restoring downloads after a network restart is all or nothing: when one download of the
 * batch cannot come back, none of them runs, and the stored "download enabled" intent of every
 * one of them stays exactly as it was.
 */

const A = 'lish-a';
const B = 'lish-b';
const NET = 'net-a';

describe('restoreTransferBatch', () => {
	const resume: RestorePlan = { kind: 'resume', networkIDs: [NET], originalNetworkIDs: [NET] };

	function batch(failOn: string, destroyFails = false) {
		const destroyed: string[] = [];
		const accepted: string[] = [];
		const deps = {
			activeCount: () => 0,
			plan: async () => resume,
			prepare: async (lishID: string): Promise<PreparedRestore> => {
				if (lishID === failOn) throw new Error(`cannot prepare ${lishID}`);
				return {
					destroy: async () => {
						destroyed.push(lishID);
						if (destroyFails) throw new Error(`cannot destroy ${lishID}`);
					},
				};
			},
			accept: async (lishID: string) => void accepted.push(lishID),
			suspend: () => {},
			complete: () => {},
		};
		return { deps, destroyed, accepted };
	}

	it('accepts nothing and destroys every prepared download when one fails', async () => {
		const { deps, destroyed, accepted } = batch(B);
		const error = await restoreTransferBatch([A, B], deps).catch(e => e);
		expect(error).toBeInstanceOf(AggregateError);
		expect(String(error.errors[0])).toContain(`cannot prepare ${B}`);
		expect(destroyed).toEqual([A]);
		expect(accepted).toEqual([]);
	});

	it('reports a rollback that failed as an unsafe runtime', async () => {
		const { deps } = batch(B, true);
		const error = await restoreTransferBatch([A, B], deps).catch(e => e);
		expect(error).toBeInstanceOf(TransferRestoreRollbackError);
		expect(error.errors.map(String)).toEqual([`Error: cannot prepare ${B}`, `Error: cannot destroy ${A}`]);
	});

	it('refuses to start over downloads that are already running', async () => {
		const { deps, accepted } = batch('none');
		await expect(restoreTransferBatch([A], { ...deps, activeCount: () => 1 })).rejects.toThrow('already running');
		expect(accepted).toEqual([]);
	});

	it('accepts the whole batch when every download is prepared', async () => {
		const { deps, accepted, destroyed } = batch('none');
		await restoreTransferBatch([A, B], deps);
		expect(accepted).toEqual([A, B]);
		expect(destroyed).toEqual([]);
	});
});

describe('restoreAll through the real transfer handlers', () => {
	let persisted: Array<{ lishID: string; enabled: boolean }> = [];
	const destroy = spyOn(Downloader.prototype, 'destroy');

	beforeEach(() => {
		persisted = [];
		destroy.mockClear();
		initDownloadState(new Set<string>(), (lishID, enabled) => persisted.push({ lishID, enabled }));
	});
	afterEach(() => destroy.mockClear());

	it('starts none of the batch and writes no intent when one download cannot come back', async () => {
		const networks = {
			getRunningNetwork: (): any => ({ onPeerDisconnect: () => () => {}, broadcast: async () => {}, getTopicPeers: () => [], isRunning: () => true }),
			getEnabled: (): any[] => [{ networkID: NET }],
			isJoined: (id: string): boolean => id === NET,
			set onNetworkLeft(_cb: unknown) {},
			set onNetworkJoined(_cb: unknown) {},
		} as unknown as Networks;
		// A is an ordinary unfinished download; B's LISH is gone.
		const dataServer = {
			clearError: () => {},
			setError: () => {},
			getTransferStats: () => ({ downloadedBytes: 0, uploadedBytes: 0 }),
			get: (lishID: string): any => (lishID === A ? { id: A, name: 'a', directory: null, files: [] } : null),
			getAllChunkCount: () => 4,
			isCompleteLISH: () => false,
			getMissingChunks: () => ['chunk-0'],
			resetVerification: () => {},
		} as unknown as DataServer;
		const events: string[] = [];
		const handlers = initTransferHandlers(
			networks,
			dataServer,
			tmpdir(),
			() => {},
			(event: string, data: any) => events.push(`${event}:${data.lishID}`),
			{ get: () => false } as unknown as Settings
		);

		await expect(handlers.restoreAll(new Set([A, B]))).rejects.toBeInstanceOf(AggregateError);

		expect(events.filter(event => event.startsWith('transfer.download:enabled'))).toEqual([]);
		expect(persisted).toEqual([]);
		expect(handlers.getActiveTransfers()).toEqual([]);
		// A was prepared, then torn down with the batch.
		expect(destroy).toHaveBeenCalledTimes(1);
	});
});
