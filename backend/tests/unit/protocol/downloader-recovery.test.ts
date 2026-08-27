import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Downloader } from '../../../src/protocol/downloader.ts';
import { ChunkDownloader, type ChunkDownloaderDeps, type RetryInfo } from '../../../src/protocol/chunk-downloader.ts';
import { PeerManager } from '../../../src/protocol/peer-manager.ts';
import { PauseController } from '../../../src/protocol/pause-controller.ts';
import { ProgressReporter } from '../../../src/protocol/progress-reporter.ts';
import type { ChunkID } from '@shared';
import { CodedError, ErrorCodes } from '@shared';
import { MockNetwork } from '../helpers/mock-network.ts';
import { MockDataServer, MockLISHClient, makeLISH, makeMissingChunk, priv } from './downloader-test-helpers.ts';
// ---------------------------------------------------------------------------
// Inline retry tests
// ---------------------------------------------------------------------------

describe('Downloader — inline ENOENT recovery', () => {
	let dataServer: MockDataServer;
	let network: MockNetwork;
	let downloader: Downloader;

	beforeEach(() => {
		dataServer = new MockDataServer();
		network = new MockNetwork();
		downloader = new Downloader('/tmp/test', network as any, dataServer as any, ['net1']);
	});

	afterEach(() => {
		downloader.destroy().catch(() => {});
	});

	it('retryCallback is set and callable', () => {
		const calls: any[] = [];
		downloader.setRetryCallback(info => calls.push(info));
		expect(calls.length).toBe(0);
	});

	it('has fileReallocAttempts and writeRetryCount fields', async () => {
		// chunkDownloader is created in initFromManifest; retry state lives there now
		await downloader.initFromManifest(makeLISH());
		const cd = priv(downloader)['chunkDownloader'] as { fileReallocAttempts: Map<number, number>; writeRetryCount: number };
		expect(cd.fileReallocAttempts).toBeInstanceOf(Map);
		expect(cd.writeRetryCount).toBe(0);
	});

	it('MAX_FILE_REALLOC is 3', () => {
		expect((ChunkDownloader as any).MAX_FILE_REALLOC).toBe(3);
	});

	it('MAX_WRITE_RETRIES is 5', () => {
		expect((ChunkDownloader as any).MAX_WRITE_RETRIES).toBe(5);
	});

	it('enable() resets fileReallocAttempts and writeRetryCount', async () => {
		const lish = makeLISH();
		dataServer.add(lish);
		dataServer.allChunkCount = 1;
		dataServer.missingChunks = [makeMissingChunk('abc123' as ChunkID)];
		await downloader.initFromManifest(lish);
		const cd = priv(downloader)['chunkDownloader'] as { fileReallocAttempts: Map<number, number>; writeRetryCount: number };
		cd.fileReallocAttempts.set(0, 2);
		cd.writeRetryCount = 3;
		await downloader.enable();
		expect(cd.fileReallocAttempts.size).toBe(0);
		expect(cd.writeRetryCount).toBe(0);
	});

	it('writeChunkError in mock triggers error for testing', async () => {
		dataServer.writeChunkError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		dataServer.writeChunkErrorCount = 1;
		await expect(dataServer.writeChunk('/tmp', makeLISH(), 0, 0, new Uint8Array(10))).rejects.toThrow('ENOENT');
		// Second call succeeds
		await expect(dataServer.writeChunk('/tmp', makeLISH(), 0, 0, new Uint8Array(10))).resolves.toBeUndefined();
	});

	it('resetFileChunks mock correctly resets downloaded chunks for a file', () => {
		const lish = makeLISH({
			files: [
				{ path: 'a.bin', size: 1024, checksums: ['chunk-a1' as string, 'chunk-a2' as string] },
				{ path: 'b.bin', size: 1024, checksums: ['chunk-b1' as string] },
			],
		});
		dataServer.add(lish);
		dataServer.downloadedChunks.add('chunk-a1' as ChunkID);
		dataServer.downloadedChunks.add('chunk-a2' as ChunkID);
		dataServer.downloadedChunks.add('chunk-b1' as ChunkID);
		const resetCount = dataServer.resetFileChunks(lish.id, 0);
		expect(resetCount).toBe(2);
		expect(dataServer.downloadedChunks.has('chunk-a1' as ChunkID)).toBe(false);
		expect(dataServer.downloadedChunks.has('chunk-a2' as ChunkID)).toBe(false);
		expect(dataServer.downloadedChunks.has('chunk-b1' as ChunkID)).toBe(true);
	});

	it('resetFileChunks returns 0 for file with no downloaded chunks', () => {
		const lish = makeLISH();
		dataServer.add(lish);
		const resetCount = dataServer.resetFileChunks(lish.id, 0);
		expect(resetCount).toBe(0);
	});
});

describe('Downloader — destroy drain', () => {
	it('waits for active work and cancels download before its completion waiter is installed', async () => {
		const dataServer = new MockDataServer();
		const lish = makeLISH();
		dataServer.completeLishs.add(lish.id);
		const downloader = new Downloader('/tmp/test', new MockNetwork() as never, dataServer as never, ['net1']);
		await downloader.initFromManifest(lish);

		let workStarted!: () => void;
		let releaseWork!: () => void;
		const workEntered = new Promise<void>(resolve => {
			workStarted = resolve;
		});
		const workBlocked = new Promise<void>(resolve => {
			releaseWork = resolve;
		});
		(priv(downloader) as any).doWorkInternal = async () => {
			workStarted();
			await workBlocked;
		};

		const download = downloader.download();
		const outcome = download.then(
			() => null,
			error => error
		);
		await workEntered;
		let destroyed = false;
		const destroying = downloader.destroy().then(() => {
			destroyed = true;
		});
		await Promise.resolve();
		expect(destroyed).toBe(false);

		releaseWork();
		await destroying;
		const error = await outcome;

		expect(error).toBeInstanceOf(CodedError);
		expect((error as CodedError).code).toBe(ErrorCodes.DOWNLOAD_CANCELLED);
		expect(priv(downloader)['downloadReject']).toBeUndefined();
	}, 5000);

	it('drains peer discovery and never publishes the next WANT after destroy', async () => {
		const dataServer = new MockDataServer();
		const lish = makeLISH();
		dataServer.completeLishs.add(lish.id);
		const network = new MockNetwork();
		const topics: string[] = [];
		let firstBroadcastStarted!: () => void;
		let releaseFirstBroadcast!: () => void;
		const firstBroadcastEntered = new Promise<void>(resolve => {
			firstBroadcastStarted = resolve;
		});
		const firstBroadcastBlocked = new Promise<void>(resolve => {
			releaseFirstBroadcast = resolve;
		});
		network.broadcast = async topic => {
			topics.push(topic);
			if (topics.length === 1) {
				firstBroadcastStarted();
				await firstBroadcastBlocked;
				throw new Error('old network stopped');
			}
		};
		const downloader = new Downloader('/tmp/test', network as never, dataServer as never, ['net-a', 'net-b']);
		await downloader.initFromManifest(lish);

		const discovery = (priv(downloader)['callForPeers'] as () => Promise<void>).call(downloader);
		await firstBroadcastEntered;
		let destroyed = false;
		const destroying = downloader.destroy().then(() => {
			destroyed = true;
		});
		await Promise.resolve();
		expect(destroyed).toBe(false);

		releaseFirstBroadcast();
		await Promise.all([discovery, destroying]);

		expect(topics).toEqual(['lish/net-a']);
	}, 5000);
});

describe('Downloader — inline ENOSPC retry', () => {
	let dataServer: MockDataServer;
	let network: MockNetwork;
	let downloader: Downloader;

	beforeEach(() => {
		dataServer = new MockDataServer();
		network = new MockNetwork();
		downloader = new Downloader('/tmp/test', network as any, dataServer as any, ['net1']);
	});

	afterEach(() => {
		downloader.destroy().catch(() => {});
	});

	it('WRITE_RETRY_DELAY is 60000ms', () => {
		expect((ChunkDownloader as any).WRITE_RETRY_DELAY).toBe(60000);
	});

	it('writePaused starts as false', () => {
		const pc = priv(downloader)['pauseController'] as { writePaused: boolean };
		expect(pc.writePaused).toBe(false);
	});

	it('waitIfWritePaused resolves immediately when not paused', async () => {
		const pc = priv(downloader)['pauseController'] as { waitIfWritePaused: () => Promise<void> };
		await expect(pc.waitIfWritePaused()).resolves.toBeUndefined();
	});

	it('resumeWrites resolves all pending waiters', async () => {
		const pc = priv(downloader)['pauseController'] as {
			pauseWrites: () => void;
			resumeWrites: () => void;
			waitIfWritePaused: () => Promise<void>;
			writeResolvers: unknown[];
			writePaused: boolean;
		};
		pc.pauseWrites();
		const promises = [pc.waitIfWritePaused(), pc.waitIfWritePaused()];
		// Yield a microtask so the awaited Promises register their resolvers before we assert.
		await new Promise(r => setTimeout(r, 0));
		expect(pc.writeResolvers.length).toBe(2);
		pc.resumeWrites();
		await Promise.all(promises);
		expect(pc.writePaused).toBe(false);
		expect(pc.writeResolvers.length).toBe(0);
	});

	it('stays paused until every holder releases', async () => {
		const pc = priv(downloader)['pauseController'] as {
			pauseWrites: () => void;
			resumeWrites: () => void;
			waitIfWritePaused: () => Promise<void>;
			writeResolvers: unknown[];
			writePaused: boolean;
		};
		// Two independent paths pause writes: the retained-write retry cycle and
		// missing-file recovery. Whichever finishes first must not open the gate for
		// the other, or a peer would claim a retry cycle someone else already owns.
		pc.pauseWrites();
		pc.pauseWrites();
		const waiter = pc.waitIfWritePaused();
		await new Promise(r => setTimeout(r, 0));
		expect(pc.writeResolvers.length).toBe(1);

		pc.resumeWrites();
		await new Promise(r => setTimeout(r, 0));
		expect(pc.writePaused).toBe(true); // one holder left
		expect(pc.writeResolvers.length).toBe(1); // waiter still blocked

		pc.resumeWrites();
		await waiter;
		expect(pc.writePaused).toBe(false);
		expect(pc.writeResolvers.length).toBe(0);
	});

	it('ignores an unbalanced release instead of going negative', () => {
		const pc = priv(downloader)['pauseController'] as { pauseWrites: () => void; resumeWrites: () => void; writePaused: boolean };
		pc.resumeWrites(); // nobody was holding
		expect(pc.writePaused).toBe(false);
		pc.pauseWrites();
		expect(pc.writePaused).toBe(true); // a stray release must not leave a negative debt
		pc.resumeWrites();
		expect(pc.writePaused).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Write-retry keeps the verified chunk in memory instead of re-downloading it
// ---------------------------------------------------------------------------

describe('ChunkDownloader — write-retry retains chunk in memory (no re-download)', () => {
	function sha256Hex(data: Uint8Array): string {
		const h = new Bun.CryptoHasher('sha256');
		h.update(data);
		return h.digest('hex');
	}

	let origDelay: number;
	let origFileReallocDelay: number;

	beforeEach(() => {
		// Shrink the 60s retry pause so the loop runs in milliseconds under test.
		origDelay = (ChunkDownloader as unknown as { WRITE_RETRY_DELAY: number }).WRITE_RETRY_DELAY;
		origFileReallocDelay = (ChunkDownloader as unknown as { FILE_REALLOC_DELAY: number }).FILE_REALLOC_DELAY;
		(ChunkDownloader as unknown as { WRITE_RETRY_DELAY: number }).WRITE_RETRY_DELAY = 15;
		(ChunkDownloader as unknown as { FILE_REALLOC_DELAY: number }).FILE_REALLOC_DELAY = 15;
		Downloader.setMaxDownloadSpeed(0); // guard against a leftover throttle from other suites
	});

	afterEach(() => {
		(ChunkDownloader as unknown as { WRITE_RETRY_DELAY: number }).WRITE_RETRY_DELAY = origDelay;
		(ChunkDownloader as unknown as { FILE_REALLOC_DELAY: number }).FILE_REALLOC_DELAY = origFileReallocDelay;
	});

	/**
	 * Build a ChunkDownloader over real PeerManager/PauseController/ProgressReporter with a
	 * single missing chunk. `failCount` write attempts throw ENOSPC before the write succeeds
	 * (`Infinity` = never succeeds). The peer client counts how many times the chunk is fetched.
	 */
	function harness(failCount: number) {
		const data = new Uint8Array(2048);
		for (let i = 0; i < data.length; i++) data[i] = (i * 5 + 1) & 0xff;
		const chunkID = sha256Hex(data) as ChunkID;

		const ds = new MockDataServer();
		const lish = makeLISH({ files: [{ path: 'file.bin', size: data.length, checksums: [chunkID] }] });
		ds.add(lish);
		ds.allChunkCount = 1;
		ds.missingChunks = [makeMissingChunk(chunkID, 0, 0)];
		ds.writeChunkError = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
		ds.writeChunkErrorCount = failCount;

		const client = new MockLISHClient();
		client.requestChunkResult = data;

		const peerManager = new PeerManager();
		peerManager.setLishID(lish.id);
		peerManager.tryAdd('peer-1', client as never, 'DIRECT');

		const state = { disabled: false, destroyed: false };
		const pauseController = new PauseController(
			() => state.disabled,
			() => state.destroyed
		);
		const progressReporter = new ProgressReporter();

		const retries: RetryInfo[] = [];
		const errors: Array<{ code: string; detail: string | undefined }> = [];

		const deps: ChunkDownloaderDeps = {
			lishID: lish.id,
			downloadDir: '/tmp/test-dl',
			abortSignal: new AbortController().signal,
			dataServer: ds as never,
			peerManager,
			pauseController,
			progressReporter,
			fileAllocator: {} as never,
			getLish: () => lish,
			isDestroyed: () => state.destroyed,
			isDisabled: () => state.disabled,
			onSetError: (code, detail) => {
				errors.push({ code, detail });
				state.disabled = true; // mirror Downloader.setError so peer loops exit
			},
			onRetry: info => retries.push({ ...info }),
			emitAllocProgress: () => {},
		};

		return { cd: new ChunkDownloader(deps), client, ds, retries, errors, chunkID, data, pauseController, deps };
	}

	it('write fails once → retries from the SAME buffer, no second network request', async () => {
		const h = harness(1);
		await h.cd.run();

		expect(h.client.requestChunkCalls).toBe(1); // fetched from the network exactly once
		expect(h.ds.writtenChunks).toHaveLength(1);
		expect(h.ds.writtenChunks[0]!.data).toEqual(h.data); // identical bytes landed on disk
		expect(h.ds.downloadedChunks.has(h.chunkID)).toBe(true);
		expect(h.ds.missingChunks).toHaveLength(0); // download completed
		expect(h.retries.some(r => !r.resolved)).toBe(true); // FE got a retry notification
		expect(h.retries.some(r => r.resolved)).toBe(true); // …and a resolved one
		expect(h.errors).toHaveLength(0);
	});

	it('onRetry throws while taking the recovery pause → hold is released, not leaked', async () => {
		const h = harness(0);
		// The write pause is a holder count, so a hold leaked by a throwing callback would
		// never self-heal — every later peer loop would block on it for this Downloader's life.
		h.ds.writeChunkOutcomes = [Object.assign(new Error('ENOENT'), { code: 'ENOENT' })];
		h.deps.onRetry = () => {
			throw new Error('callback blew up');
		};
		await h.cd.run();

		expect((h.pauseController as unknown as { writePauseHolders: number })['writePauseHolders']).toBe(0);
		expect(h.pauseController.writePaused).toBe(false);
		expect(h.pauseController.progressPaused).toBe(false);
	});

	it('write fails several times → buffer held across all retries, still one fetch', async () => {
		const h = harness(3);
		await h.cd.run();

		expect(h.client.requestChunkCalls).toBe(1);
		expect(h.ds.writtenChunks).toHaveLength(1);
		expect(h.ds.writtenChunks[0]!.data).toEqual(h.data);
		expect(h.ds.downloadedChunks.has(h.chunkID)).toBe(true);
	});

	it('throwing retry callback cannot discard the retained chunk', async () => {
		const h = harness(1);
		h.deps.onRetry = () => {
			throw new Error('callback blew up');
		};

		await h.cd.run();

		expect(h.client.requestChunkCalls).toBe(1);
		expect(h.ds.writtenChunks).toHaveLength(1);
		expect(h.ds.downloadedChunks.has(h.chunkID)).toBe(true);
		expect(h.pauseController.writePaused).toBe(false);
		expect(h.errors).toHaveLength(0);
	});

	it('write never succeeds → onSetError after MAX_WRITE_RETRIES, no re-download', async () => {
		const h = harness(Number.POSITIVE_INFINITY);
		await h.cd.run();

		expect(h.client.requestChunkCalls).toBe(1); // buffer dropped only after giving up — never re-fetched
		expect(h.errors).toHaveLength(1);
		expect(h.errors[0]!.code).toBe(ErrorCodes.DISK_FULL);
		expect(h.ds.downloadedChunks.has(h.chunkID)).toBe(false);
	});

	it('error changes to ENOENT mid-retry → re-queues (re-downloads), never mis-reports DISK_FULL', async () => {
		const h = harness(0);
		h.ds.writeChunkOutcomes = [
			Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }), // initial write: disk full
			Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), // retry: file vanished during pause
			null, // re-queued chunk re-downloaded, write now lands
		];
		await h.cd.run();

		expect(h.client.requestChunkCalls).toBe(2); // re-queued → one extra fetch (blind retry would stay at 1)
		expect(h.ds.downloadedChunks.has(h.chunkID)).toBe(true);
		expect(h.errors).toHaveLength(0); // never burned through 5 retries reporting DISK_FULL
		expect(h.retries.some(r => r.resolved)).toBe(true); // disk retry state must not stay stuck in the FE
	});

	it('error changes to an unknown code mid-retry → fails with real cause, not DISK_FULL', async () => {
		const h = harness(0);
		h.ds.writeChunkOutcomes = [
			Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }), // initial write: disk full
			new Error('disk controller exploded'), // retry: unexpected error, no code
		];
		await h.cd.run();

		expect(h.client.requestChunkCalls).toBe(1); // aborted immediately, no re-download
		expect(h.errors).toHaveLength(1);
		expect(h.errors[0]!.code).toBe(ErrorCodes.DOWNLOAD_ERROR); // real cause surfaced, not DISK_FULL
		expect(h.ds.downloadedChunks.has(h.chunkID)).toBe(false);
	});

	it('two concurrent peers both hit ENOSPC → both write from memory, no extra fetches', async () => {
		const mk = (seed: number) => {
			const d = new Uint8Array(1024);
			for (let i = 0; i < d.length; i++) d[i] = (i * seed + 7) & 0xff;
			return d;
		};
		const dataA = mk(3);
		const dataB = mk(11);
		const idA = sha256Hex(dataA) as ChunkID;
		const idB = sha256Hex(dataB) as ChunkID;

		const ds = new MockDataServer();
		// chunkSize must match the 1024-byte payloads — the downloader rejects chunk data
		// whose length doesn't match the manifest, which would fail the write retry under test.
		const lish = makeLISH({ chunkSize: 1024, files: [{ path: 'f.bin', size: dataA.length + dataB.length, checksums: [idA, idB] }] });
		ds.add(lish);
		ds.allChunkCount = 2;
		ds.missingChunks = [makeMissingChunk(idA, 0, 0), makeMissingChunk(idB, 0, 1)];
		// Disk full for the first 3 write attempts (2 initial + 1 owner retry), then it frees.
		ds.writeChunkError = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
		ds.writeChunkErrorCount = 3;

		const chunkData = new Map<ChunkID, Uint8Array>([
			[idA, dataA],
			[idB, dataB],
		]);
		const c1 = new MockLISHClient();
		c1.chunkData = chunkData;
		const c2 = new MockLISHClient();
		c2.chunkData = chunkData;

		const peerManager = new PeerManager();
		peerManager.setLishID(lish.id);
		peerManager.tryAdd('peer-1', c1 as never, 'DIRECT');
		peerManager.tryAdd('peer-2', c2 as never, 'DIRECT');

		const state = { disabled: false, destroyed: false };
		const pauseController = new PauseController(
			() => state.disabled,
			() => state.destroyed
		);
		const errors: Array<{ code: string; detail: string | undefined }> = [];
		const deps: ChunkDownloaderDeps = {
			lishID: lish.id,
			downloadDir: '/tmp/test-dl',
			abortSignal: new AbortController().signal,
			dataServer: ds as never,
			peerManager,
			pauseController,
			progressReporter: new ProgressReporter(),
			fileAllocator: {} as never,
			getLish: () => lish,
			isDestroyed: () => state.destroyed,
			isDisabled: () => state.disabled,
			onSetError: (code, detail) => {
				errors.push({ code, detail });
				state.disabled = true;
			},
			onRetry: () => {},
			emitAllocProgress: () => {},
		};

		await new ChunkDownloader(deps).run();

		// Both chunks fetched exactly once total — the waiting peer wrote from its retained buffer.
		expect(c1.requestChunkCalls + c2.requestChunkCalls).toBe(2);
		expect(ds.downloadedChunks.has(idA)).toBe(true);
		expect(ds.downloadedChunks.has(idB)).toBe(true);
		expect(ds.writtenChunks).toHaveLength(2);
		expect(errors).toHaveLength(0);
	});

	it('an in-flight successful write cannot reset the active retry budget', async () => {
		const mk = (seed: number) => {
			const d = new Uint8Array(1024);
			for (let i = 0; i < d.length; i++) d[i] = (i * seed + 9) & 0xff;
			return d;
		};
		const dataA = mk(3);
		const dataB = mk(7);
		const idA = sha256Hex(dataA) as ChunkID;
		const idB = sha256Hex(dataB) as ChunkID;
		const ds = new MockDataServer();
		const lish = makeLISH({ chunkSize: 1024, files: [{ path: 'f.bin', size: 2048, checksums: [idA, idB] }] });
		ds.add(lish);
		ds.allChunkCount = 2;
		ds.missingChunks = [makeMissingChunk(idA, 0, 0), makeMissingChunk(idB, 0, 1)];

		let releaseSlowWrite!: () => void;
		const slowWrite = new Promise<void>(resolve => {
			releaseSlowWrite = resolve;
		});
		let writeCalls = 0;
		ds.writeChunk = async (_dir, _lish, fileIndex, chunkIndex, data) => {
			writeCalls++;
			if (writeCalls === 1 || writeCalls === 3) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
			if (writeCalls === 2) await slowWrite;
			ds.writtenChunks.push({ fileIndex, chunkIndex, data });
		};

		const chunkData = new Map<ChunkID, Uint8Array>([
			[idA, dataA],
			[idB, dataB],
		]);
		const c1 = new MockLISHClient();
		c1.chunkData = chunkData;
		const c2 = new MockLISHClient();
		c2.chunkData = chunkData;
		const peerManager = new PeerManager();
		peerManager.setLishID(lish.id);
		peerManager.tryAdd('peer-1', c1 as never, 'DIRECT');
		peerManager.tryAdd('peer-2', c2 as never, 'DIRECT');
		const state = { disabled: false, destroyed: false };
		const retryCounts: number[] = [];
		const deps: ChunkDownloaderDeps = {
			lishID: lish.id,
			downloadDir: '/tmp/test-dl',
			abortSignal: new AbortController().signal,
			dataServer: ds as never,
			peerManager,
			pauseController: new PauseController(
				() => state.disabled,
				() => state.destroyed
			),
			progressReporter: new ProgressReporter(),
			fileAllocator: {} as never,
			getLish: () => lish,
			isDestroyed: () => state.destroyed,
			isDisabled: () => state.disabled,
			onSetError: () => {
				state.disabled = true;
			},
			onRetry: info => {
				if (!info.resolved) retryCounts.push(info.retryCount);
				if (retryCounts.length === 1) releaseSlowWrite();
			},
			emitAllocProgress: () => {},
		};

		await new ChunkDownloader(deps).run();

		expect(retryCounts.slice(0, 2)).toEqual([1, 2]);
		expect(ds.downloadedChunks.has(idA)).toBe(true);
		expect(ds.downloadedChunks.has(idB)).toBe(true);
	});

	it('retained write waits until concurrent ENOENT recovery finishes', async () => {
		const mk = (seed: number) => {
			const bytes = new Uint8Array(1024);
			for (let i = 0; i < bytes.length; i++) bytes[i] = (i * seed + 13) & 0xff;
			return bytes;
		};
		const dataA = mk(3);
		const dataB = mk(7);
		const idA = sha256Hex(dataA) as ChunkID;
		const idB = sha256Hex(dataB) as ChunkID;
		const ds = new MockDataServer();
		const lish = makeLISH({ chunkSize: 1024, files: [{ path: 'f.bin', size: 2048, checksums: [idA, idB] }] });
		ds.add(lish);
		ds.allChunkCount = 2;
		ds.missingChunks = [makeMissingChunk(idA, 0, 0), makeMissingChunk(idB, 0, 1)];
		(ds as unknown as { getFilesForVerification: () => null }).getFilesForVerification = () => null;

		let firstWriteEntered!: () => void;
		let secondWriteEntered!: () => void;
		let releaseFirstWrite!: () => void;
		let releaseSecondWrite!: () => void;
		const firstWriteStarted = new Promise<void>(resolve => {
			firstWriteEntered = resolve;
		});
		const secondWriteStarted = new Promise<void>(resolve => {
			secondWriteEntered = resolve;
		});
		const firstWriteBlocked = new Promise<void>(resolve => {
			releaseFirstWrite = resolve;
		});
		const secondWriteBlocked = new Promise<void>(resolve => {
			releaseSecondWrite = resolve;
		});
		let writeCalls = 0;
		let retainedChunkIndex = -1;
		let recoveryActive = false;
		let writeDuringRecovery = false;
		ds.writeChunk = async (_dir, _lish, fileIndex, chunkIndex, data) => {
			writeCalls++;
			if (writeCalls === 1) {
				retainedChunkIndex = chunkIndex;
				firstWriteEntered();
				await firstWriteBlocked;
				throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
			}
			if (writeCalls === 2) {
				secondWriteEntered();
				await secondWriteBlocked;
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			}
			if (recoveryActive) writeDuringRecovery = true;
			ds.writtenChunks.push({ fileIndex, chunkIndex, data });
		};

		const requestCounts = new Map<ChunkID, number>();
		const client = () => {
			const c = new MockLISHClient();
			c.requestChunk = async (_lishID, chunkID) => {
				c.requestChunkCalls++;
				requestCounts.set(chunkID, (requestCounts.get(chunkID) ?? 0) + 1);
				return chunkID === idA ? dataA : dataB;
			};
			return c;
		};
		const c1 = client();
		const c2 = client();
		const peerManager = new PeerManager();
		peerManager.setLishID(lish.id);
		peerManager.tryAdd('peer-1', c1 as never, 'DIRECT');
		peerManager.tryAdd('peer-2', c2 as never, 'DIRECT');

		let recoveryEntered!: () => void;
		let releaseRecovery!: () => void;
		const recoveryStarted = new Promise<void>(resolve => {
			recoveryEntered = resolve;
		});
		const recoveryBlocked = new Promise<void>(resolve => {
			releaseRecovery = resolve;
		});
		const fileAllocator = {
			findMissingFiles: async () => {
				recoveryActive = true;
				recoveryEntered();
				await recoveryBlocked;
				recoveryActive = false;
				return [];
			},
			allocateFiles: async () => {},
		};
		const state = { disabled: false, destroyed: false };
		const errors: Array<{ code: string; detail: string | undefined }> = [];
		let retryStarted!: () => void;
		const retryCycleStarted = new Promise<void>(resolve => {
			retryStarted = resolve;
		});
		const deps: ChunkDownloaderDeps = {
			lishID: lish.id,
			downloadDir: '/tmp/test-dl',
			abortSignal: new AbortController().signal,
			dataServer: ds as never,
			peerManager,
			pauseController: new PauseController(
				() => state.disabled,
				() => state.destroyed
			),
			progressReporter: new ProgressReporter(),
			fileAllocator: fileAllocator as never,
			getLish: () => lish,
			isDestroyed: () => state.destroyed,
			isDisabled: () => state.disabled,
			onSetError: (code, detail) => {
				errors.push({ code, detail });
				state.disabled = true;
			},
			onRetry: info => {
				if (info.errorCode === ErrorCodes.DISK_FULL && !info.resolved) retryStarted();
			},
			emitAllocProgress: () => {},
		};

		const running = new ChunkDownloader(deps).run();
		await Promise.all([firstWriteStarted, secondWriteStarted]);
		releaseFirstWrite();
		await retryCycleStarted;
		releaseSecondWrite();
		await recoveryStarted;
		await new Promise(resolve => setTimeout(resolve, 40));
		const markedDuringRecovery = ds.downloadedChunks.size > 0;
		releaseRecovery();
		await running;

		const retainedID = retainedChunkIndex === 0 ? idA : idB;
		expect(writeDuringRecovery).toBe(false);
		expect(markedDuringRecovery).toBe(false);
		expect(requestCounts.get(retainedID)).toBe(1);
		expect(ds.downloadedChunks.has(idA)).toBe(true);
		expect(ds.downloadedChunks.has(idB)).toBe(true);
		expect(errors).toHaveLength(0);
	});
});
