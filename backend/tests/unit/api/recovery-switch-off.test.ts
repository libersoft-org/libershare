import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode as lpEncode } from 'it-length-prefixed';
import { initDownloadState, initTransferHandlers } from '../../../src/api/transfer.ts';
import { encode } from '../../../src/protocol/codec.ts';
import { enableUpload, getEnabledUploads, handleLISHProtocol, resetUploadState } from '../../../src/protocol/lish-protocol.ts';
import { type DataServer } from '../../../src/lish/data-server.ts';
import { MockNetwork } from '../helpers/mock-network.ts';
import { MockDataServer, makeMissingChunk } from '../protocol/downloader-test-helpers.ts';
import { type Networks } from '../../../src/lishnet/lishnets.ts';
import { Settings, useNetworkSettings } from '../../../src/settings.ts';

/**
 * Error recovery restarts the download first and only then turns sharing back on. A switch-off
 * the user makes in between is the last word: the recovery must not undo it.
 *
 * The recovery here is the real one, started the way production starts it — an upload request
 * that finds its backing file gone — and it restarts the download through the "already
 * complete" path, which announces the download before the recovery turns to sharing.
 */
describe('error recovery and a switch-off during the attempt', () => {
	const LISH = 'lish-recovery-switch-off';
	const dir = mkdtempSync(join(tmpdir(), 'lish-recovery-'));
	let activeHandlers: ReturnType<typeof initTransferHandlers> | undefined;
	afterEach(async () => {
		await activeHandlers?.clearAll();
		activeHandlers = undefined;
		resetUploadState();
		initDownloadState(new Set(), () => {});
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, 'a.bin'), new Uint8Array(4));
	const dataServer = {
		get: (): any => ({ id: LISH, directory: dir, chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'a.bin', size: 4, checksums: ['c0'] }] }),
		getMissingChunks: (): string[] => [],
		getAllChunkCount: (): number => 1,
		getChunk: async (): Promise<string> => 'file_missing',
		clearError: (): void => {},
		isVerifyPending: () => false,
		setError: (): void => {},
		resetVerification: (): void => {},
		getDatasetRoot: (): null => null,
	} as unknown as DataServer;
	/** A LISH still missing its chunk: its download runs through a real downloader. */
	const unfinishedServer = Object.assign(new MockDataServer(), {
		get: (): any => ({ id: LISH, directory: dir, chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'a.bin', size: 4, checksums: ['c0'] }] }),
		getChunk: async (): Promise<string> => 'file_missing',
		getTransferStats: () => ({ uploadedBytes: 0, downloadedBytes: 0 }),
		clearError: (): void => {},
		isVerifyPending: () => false,
		setError: (): void => {},
		resetVerification: (): void => {},
		getDatasetRoot: (): null => null,
	});
	unfinishedServer.missingChunks = [makeMissingChunk('c0' as never)];
	unfinishedServer.allChunkCount = 1;
	const networks = {
		getNetwork: () => ({ pauseLISHProtocolHandlersAndDrain: async () => {} }),
		getRunningNetwork: (): any => new MockNetwork(),
		getEnabled: (): any[] => [{ networkID: 'net-a' }],
		isJoined: (): boolean => true,
		set onNetworkLeft(_cb: unknown) {},
		set onNetworkJoined(_cb: unknown) {},
	} as unknown as Networks;
	const settings = { get: (): undefined => undefined } as unknown as Settings;

	/** One getChunk request whose backing file has vanished — that starts recovery. */
	async function missingFileRequest(server: DataServer = dataServer): Promise<void> {
		const frame = lpEncode.single(encode({ type: 'getChunk', lishID: LISH, chunkID: 'c0' })).subarray();
		const stream = {
			status: 'open',
			send() {},
			close: async () => {},
			abort() {},
			async *[Symbol.asyncIterator]() {
				yield frame;
			},
		};
		await handleLISHProtocol(stream as any, server, 'peer-a');
	}

	async function run(switchOff: boolean): Promise<string[]> {
		resetUploadState();
		initDownloadState(new Set([LISH]), () => {});
		const events: string[] = [];
		let attempting = false;
		const handlers = initTransferHandlers(
			networks,
			dataServer,
			tmpdir(),
			() => {},
			(event: string) => {
				events.push(event);
				if (event === 'transfer.recovery:attempting') attempting = true;
				// The user switches sharing off while the recovery is restarting the download.
				if (event === 'transfer.download:enabled' && attempting && switchOff) handlers.disableUpload({ lishID: LISH });
			},
			settings
		);
		activeHandlers = handlers;
		enableUpload(LISH);
		await missingFileRequest();
		const deadline = Date.now() + 12_000;
		while (Date.now() < deadline && !(attempting && events.includes('transfer.download:enabled'))) await Bun.sleep(50);
		await Bun.sleep(100);
		return events;
	}

	it('keeps sharing off when the user switched it off during the attempt', async () => {
		const events = await run(true);
		expect(events).toContain('transfer.recovery:attempting');
		expect(getEnabledUploads().has(LISH)).toBe(false);
		expect(events).not.toContain('transfer.recovery:recovered');
	}, 20_000);

	it('still brings sharing back when nobody intervened', async () => {
		const events = await run(false);
		expect(events).toContain('transfer.recovery:recovered');
		expect(getEnabledUploads().has(LISH)).toBe(true);
	}, 20_000);

	it('does not supersede itself when it restarts an unfinished download', async () => {
		resetUploadState();
		initDownloadState(new Set([LISH]), () => {});
		const events: string[] = [];
		activeHandlers = initTransferHandlers(
			networks,
			unfinishedServer as unknown as DataServer,
			tmpdir(),
			() => {},
			(event: string) => void events.push(event),
			settings
		);
		enableUpload(LISH);
		// The startup resume brings the download up first; only then does the upload fail.
		for (let i = 0; i < 100 && !events.includes('transfer.download:enabled'); i++) await Bun.sleep(50);
		expect(events).toContain('transfer.download:enabled');
		await missingFileRequest(unfinishedServer as unknown as DataServer);
		const deadline = Date.now() + 12_000;
		while (Date.now() < deadline && !events.includes('transfer.recovery:recovered') && !events.includes('transfer.recovery:exhausted')) await Bun.sleep(50);
		expect(events).toContain('transfer.recovery:attempting');
		expect(events).toContain('transfer.recovery:recovered');
		expect(getEnabledUploads().has(LISH)).toBe(true);
	}, 20_000);

	it('does not restart again a download the attempt saw refused for the in-flight budget', async () => {
		// The disk is back, but the limit was lowered under the missing chunk meanwhile. That is not
		// a recovery that failed: retrying would repeat the refusal every few seconds, and the next
		// start is the user's to make once the limit is raised.
		resetUploadState();
		initDownloadState(new Set([LISH]), () => {});
		const defaults = (await Settings.create(dir)).getDefaults().network;
		const events: string[] = [];
		// What the store is told about the LISH's error, in order.
		const stored: string[] = [];
		const { setError, clearError } = unfinishedServer;
		unfinishedServer.setError = (_lishID?: string, code?: string): void => void stored.push(`set ${code}`);
		unfinishedServer.clearError = (): void => void stored.push('clear');
		activeHandlers = initTransferHandlers(
			networks,
			unfinishedServer as unknown as DataServer,
			tmpdir(),
			() => {},
			(event: string) => void events.push(event),
			settings
		);
		enableUpload(LISH);
		for (let i = 0; i < 100 && !events.includes('transfer.download:enabled'); i++) await Bun.sleep(50);
		expect(events).toContain('transfer.download:enabled');
		await missingFileRequest(unfinishedServer as unknown as DataServer);
		// Below the 4-byte chunk the download still misses.
		useNetworkSettings(() => ({ ...defaults, chunkInflightBudgetBytes: 2 }));
		try {
			const deadline = Date.now() + 12_000;
			while (Date.now() < deadline && !events.includes('transfer.download:error')) await Bun.sleep(50);
			await Bun.sleep(300);
			const sinceAttempt = events.slice(events.indexOf('transfer.recovery:attempting'));
			expect(sinceAttempt.filter(e => e === 'transfer.download:error')).toHaveLength(1);
			expect(sinceAttempt).not.toContain('transfer.recovery:scheduled');
			// The refusal stays stored: it is what the user has to see and act on. Bringing sharing
			// back as a recovery does would clear the LISH's one error.
			expect(stored[stored.length - 1]).toBe('set DOWNLOAD_CHUNK_EXCEEDS_BUDGET');
		} finally {
			useNetworkSettings(() => defaults);
			Object.assign(unfinishedServer, { setError, clearError });
		}
	}, 20_000);
});
