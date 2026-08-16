import { describe, it, expect, beforeEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { initTransferHandlers, initDownloadState } from '../../../src/api/transfer.ts';
import { type Networks } from '../../../src/lishnet/lishnets.ts';
import { type DataServer } from '../../../src/lish/data-server.ts';
import { type Settings } from '../../../src/settings.ts';

/**
 * Two enable attempts for the same LISH must resolve to the SAME outcome.
 *
 * The second caller used to get a synthetic `{ success: true }` while the first
 * attempt was still running. onNetworkJoined reads success as "the download was
 * resumed" and drops the suspension claim, so the real attempt could then fail with
 * nothing left to resume it on the next join.
 */

const LISH_ID = 'lish-concurrent';
/** A directory that cannot exist, so the pre-flight access() check fails deterministically. */
const MISSING_DIR = join(tmpdir(), 'libershare-test-missing', 'nope-does-not-exist');

function makeDataServer(): DataServer {
	return {
		clearError: (): void => {},
		setError: (): void => {},
		get: (): any => ({ directory: MISSING_DIR, files: [{ path: 'a.bin', size: 1 }] }),
		getMissingChunks: (): string[] => ['chunk-0'],
		getAllChunkCount: (): number => 4,
		resetVerification: (): void => {},
	} as unknown as DataServer;
}

function makeNetworks(): Networks {
	return {
		getRunningNetwork: (): any => ({}),
		getEnabled: (): any[] => [{ networkID: 'net-a' }],
		isJoined: (): boolean => true,
		set onNetworkLeft(_cb: unknown) {},
		set onNetworkJoined(_cb: unknown) {},
	} as unknown as Networks;
}

/** Recovery off, so a failing attempt schedules no retry timer inside the test. */
const settings = { get: (): boolean => false } as unknown as Settings;

describe('enableDownload — concurrent attempts', () => {
	beforeEach(() => {
		initDownloadState(new Set<string>(), () => {});
	});

	it('gives the second caller the first attempt real result', async () => {
		const handlers = initTransferHandlers(makeNetworks(), makeDataServer(), tmpdir(), () => {}, undefined, settings);

		const [first, second] = await Promise.all([handlers.enableDownload({ lishID: LISH_ID }), handlers.enableDownload({ lishID: LISH_ID })]);

		// The download directory does not exist, so the attempt fails — and both
		// callers must see that, not a placeholder success.
		expect(first).toEqual({ success: false });
		expect(second).toEqual({ success: false });
	});

	it('lets a later attempt run once the in-flight one has settled', async () => {
		const handlers = initTransferHandlers(makeNetworks(), makeDataServer(), tmpdir(), () => {}, undefined, settings);

		await handlers.enableDownload({ lishID: LISH_ID });
		const again = await handlers.enableDownload({ lishID: LISH_ID });

		expect(again).toEqual({ success: false });
	});
});
