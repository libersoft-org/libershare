import { describe, it, expect, beforeEach } from 'bun:test';
import { tmpdir } from 'os';
import { initTransferHandlers, initDownloadState, removeDownloadState } from '../../../src/api/transfer.ts';
import { type Networks } from '../../../src/lishnet/lishnets.ts';
import { type DataServer } from '../../../src/lish/data-server.ts';
import { type Settings } from '../../../src/settings.ts';

/**
 * A download start is not atomic: it builds and initialises a downloader across
 * several awaits before registering it. Deleting the LISH (or a factory reset) in
 * that window finds nothing to tear down — both walk the active-downloader map — so
 * the start must notice on its own that the download was withdrawn, instead of
 * registering a downloader for a LISH that no longer exists.
 */

const LISH_ID = 'lish-withdrawn';

function makeNetworks(): Networks {
	return {
		getRunningNetwork: (): any => ({ onPeerDisconnect: (): (() => void) => () => {} }),
		getEnabled: (): any[] => [{ networkID: 'net-a' }],
		isJoined: (): boolean => true,
		set onNetworkLeft(_cb: unknown) {},
		set onNetworkJoined(_cb: unknown) {},
	} as unknown as Networks;
}

/** Recovery off, so a non-success outcome schedules no retry timer inside the test. */
const settings = { get: (): boolean => false } as unknown as Settings;

describe('enableDownload — withdrawn while starting', () => {
	beforeEach(() => {
		initDownloadState(new Set<string>(), () => {});
	});

	it('discards the downloader when the LISH is deleted mid-start', async () => {
		let withdrawn = false;
		const dataServer: any = {
			clearError: (): void => {},
			setError: (): void => {},
			// `directory: null` keeps the start on the no-pre-flight path, so the only
			// thing between entry and registration is the downloader init below.
			get: (): any => ({ id: LISH_ID, name: 'x', directory: null, files: [] }),
			getAllChunkCount: (): number => 4,
			isCompleteLISH: (): boolean => false,
			getMissingChunks: (): string[] => {
				// The downloader's own init reads this; the deletion lands here, exactly
				// as it would from a concurrent lishs.delete call.
				if (!withdrawn) {
					withdrawn = true;
					void removeDownloadState(LISH_ID);
				}
				return ['chunk-0'];
			},
		};
		const handlers = initTransferHandlers(makeNetworks(), dataServer as DataServer, tmpdir(), () => {}, undefined, settings);

		const result = await handlers.enableDownload({ lishID: LISH_ID });

		expect(result).toEqual({ success: false });
		expect(handlers.getActiveTransfers()).toEqual([]);
	});

	it('registers the downloader when nothing withdrew the download', async () => {
		const dataServer: any = {
			clearError: (): void => {},
			setError: (): void => {},
			get: (): any => ({ id: LISH_ID, name: 'x', directory: null, files: [] }),
			getAllChunkCount: (): number => 4,
			isCompleteLISH: (): boolean => false,
			getMissingChunks: (): string[] => ['chunk-0'],
		};
		const handlers = initTransferHandlers(makeNetworks(), dataServer as DataServer, tmpdir(), () => {}, undefined, settings);

		const result = await handlers.enableDownload({ lishID: LISH_ID });

		expect(result).toEqual({ success: true });
		expect(handlers.getActiveTransfers().map(t => t.lishID)).toEqual([LISH_ID]);
	});
});
