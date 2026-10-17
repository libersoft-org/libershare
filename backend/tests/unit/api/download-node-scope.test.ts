import { afterEach, expect, spyOn, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { CodedError, ErrorCodes } from '@shared';
import { initDownloadState, initTransferHandlers, removeDownloadState } from '../../../src/api/transfer.ts';
import { initLISHScopes, initUploadState } from '../../../src/protocol/lish-protocol.ts';
import { Downloader } from '../../../src/protocol/downloader.ts';
import type { Networks } from '../../../src/lishnet/lishnets.ts';
import type { DataServer } from '../../../src/lish/data-server.ts';
import type { Settings } from '../../../src/settings.ts';

afterEach(() => initLISHScopes(new Map(), () => {}));

/**
 * A member of two protected lishnets downloaded a LISH shared in the second one on the first one's node, whose
 * peers all answered "not shared", and the download never moved.
 */
for (const [scope, expected] of [
	[['net-b'], 'net-b'],
	[[], 'public'],
] as const)
	test(`a LISH shared in ${scope.length > 0 ? 'a protected lishnet' : 'public'} downloads on the ${expected} node`, async () => {
		const id = `scoped-download-${expected}`;
		initDownloadState(new Set(), () => {});
		initUploadState(new Set(), () => {});
		initLISHScopes(new Map(scope.length > 0 ? [[id, [...scope]]] : []), () => {});
		const nodes = new Map<string, object>(['public', 'net-a', 'net-b'].map(n => [n, { name: n, onPeerDisconnect: () => () => {} }]));
		const networks = {
			get: (n: string) => ({ networkID: n, overlay: n === 'public' ? undefined : {} }),
			networkFor: (n: string) => nodes.get(n),
			protectedNodes: () => [],
			getRunningNetwork: () => nodes.get('public'),
			getEnabled: () => [{ networkID: 'net-a' }, { networkID: 'net-b' }, { networkID: 'public' }],
			isJoined: () => true,
			set onNetworkLeft(_callback: unknown) {},
			set onNetworkJoined(_callback: unknown) {},
		} as unknown as Networks;
		const data = {
			get: () => ({ id, name: 'download', directory: null, files: [] }),
			getDatasetRoot: (): null => null,
			getAllChunkCount: () => 4,
			getMissingChunks: () => ['chunk-0'],
			isCompleteLISH: () => false,
			getTransferStats: () => ({ downloadedBytes: 0, uploadedBytes: 0 }),
			clearError: () => {},
			isVerifyPending: () => false,
			setError: () => {},
		} as unknown as DataServer;
		let cancel!: (error: Error) => void;
		const running = new Promise<void>((_, reject) => {
			cancel = reject;
		});
		void running.catch(() => {});
		let used: { node: unknown; networkIDs: string[] } | undefined;
		const start = spyOn(Downloader.prototype, 'download').mockImplementation(function (this: Downloader) {
			used = { node: (this as any).network, networkIDs: this.getNetworkIDs() };
			return running;
		});
		const handlers = initTransferHandlers(
			networks,
			data,
			tmpdir(),
			() => {},
			() => {},
			{ get: () => false } as unknown as Settings
		);
		try {
			expect(await handlers.enableDownload({ lishID: id })).toEqual({ success: true });
			expect(used?.node).toBe(nodes.get(expected));
			expect(used?.networkIDs).toEqual([expected]);
		} finally {
			cancel(new CodedError(ErrorCodes.DOWNLOAD_CANCELLED));
			await removeDownloadState(id);
			start.mockRestore();
		}
	});
