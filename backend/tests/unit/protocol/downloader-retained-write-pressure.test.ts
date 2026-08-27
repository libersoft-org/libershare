import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ChunkID } from '@shared';
import { ChunkDownloader, type ChunkDownloaderDeps } from '../../../src/protocol/chunk-downloader.ts';
import { Downloader } from '../../../src/protocol/downloader.ts';
import { PauseController } from '../../../src/protocol/pause-controller.ts';
import { PeerManager } from '../../../src/protocol/peer-manager.ts';
import { ProgressReporter } from '../../../src/protocol/progress-reporter.ts';
import { MockDataServer, MockLISHClient, makeLISH, makeMissingChunk } from './downloader-test-helpers.ts';

function sha256Hex(data: Uint8Array): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(data);
	return hasher.digest('hex');
}

describe('ChunkDownloader — retained-write memory pressure', () => {
	let originalWriteRetryDelay: number;
	let originalFileReallocDelay: number;
	let originalRetainedWriteLimit: number;

	beforeEach(() => {
		originalWriteRetryDelay = (ChunkDownloader as unknown as { WRITE_RETRY_DELAY: number }).WRITE_RETRY_DELAY;
		originalFileReallocDelay = (ChunkDownloader as unknown as { FILE_REALLOC_DELAY: number }).FILE_REALLOC_DELAY;
		originalRetainedWriteLimit = (ChunkDownloader as unknown as { MAX_RETAINED_WRITE_BYTES: number }).MAX_RETAINED_WRITE_BYTES;
		(ChunkDownloader as unknown as { WRITE_RETRY_DELAY: number }).WRITE_RETRY_DELAY = 15;
		(ChunkDownloader as unknown as { FILE_REALLOC_DELAY: number }).FILE_REALLOC_DELAY = 15;
		(ChunkDownloader as unknown as { MAX_RETAINED_WRITE_BYTES: number }).MAX_RETAINED_WRITE_BYTES = 2048;
		Downloader.setMaxDownloadSpeed(0);
	});

	afterEach(() => {
		(ChunkDownloader as unknown as { WRITE_RETRY_DELAY: number }).WRITE_RETRY_DELAY = originalWriteRetryDelay;
		(ChunkDownloader as unknown as { FILE_REALLOC_DELAY: number }).FILE_REALLOC_DELAY = originalFileReallocDelay;
		(ChunkDownloader as unknown as { MAX_RETAINED_WRITE_BYTES: number }).MAX_RETAINED_WRITE_BYTES = originalRetainedWriteLimit;
	});

	it('does not re-download a memory-pressure chunk while a retained write drains after ENOENT recovery', async () => {
		const payloads = [3, 7, 11, 13].map(seed => {
			const bytes = new Uint8Array(1024);
			for (let index = 0; index < bytes.length; index++) bytes[index] = (index * seed + 19) & 0xff;
			return bytes;
		});
		const chunkIDs = payloads.map(data => sha256Hex(data) as ChunkID);
		const dataServer = new MockDataServer();
		const lish = makeLISH({
			chunkSize: 1024,
			files: [{ path: 'f.bin', size: 4096, checksums: chunkIDs }],
		});
		dataServer.add(lish);
		dataServer.allChunkCount = 4;
		dataServer.missingChunks = chunkIDs.map((chunkID, chunkIndex) => makeMissingChunk(chunkID, 0, chunkIndex));
		(dataServer as unknown as { getFilesForVerification: () => null }).getFilesForVerification = () => null;

		let allInitialWritesEntered!: () => void;
		const allInitialWritesStarted = new Promise<void>(resolve => {
			allInitialWritesEntered = resolve;
		});
		let releaseMissingFileWrite!: () => void;
		const missingFileWriteBlocked = new Promise<void>(resolve => {
			releaseMissingFileWrite = resolve;
		});
		let releaseDiskFullWrites!: () => void;
		const diskFullWritesBlocked = new Promise<void>(resolve => {
			releaseDiskFullWrites = resolve;
		});
		let allDiskFullWritesFailed!: () => void;
		const diskFullWritesFailed = new Promise<void>(resolve => {
			allDiskFullWritesFailed = resolve;
		});
		let releaseSlowRetainedWrite!: () => void;
		const slowRetainedWriteBlocked = new Promise<void>(resolve => {
			releaseSlowRetainedWrite = resolve;
		});
		let slowRetainedWriteEntered!: () => void;
		const slowRetainedWriteStarted = new Promise<void>(resolve => {
			slowRetainedWriteEntered = resolve;
		});

		const initialWrites = new Set<number>();
		let diskFullFailures = 0;
		let slowWriteActive = false;
		let slowWriteReleased = false;
		dataServer.writeChunk = async (_dir, _lish, fileIndex, chunkIndex, data) => {
			if (!initialWrites.has(chunkIndex)) {
				initialWrites.add(chunkIndex);
				if (initialWrites.size === 4) allInitialWritesEntered();
				if (chunkIndex === 0) {
					await missingFileWriteBlocked;
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				}
				await diskFullWritesBlocked;
				diskFullFailures++;
				if (diskFullFailures === 3) allDiskFullWritesFailed();
				throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
			}

			if (chunkIndex === 0) {
				dataServer.writtenChunks.push({ fileIndex, chunkIndex, data });
				return;
			}
			if (!slowWriteActive) {
				slowWriteActive = true;
				slowRetainedWriteEntered();
				await slowRetainedWriteBlocked;
				slowWriteReleased = true;
				dataServer.writtenChunks.push({ fileIndex, chunkIndex, data });
				return;
			}
			if (!slowWriteReleased) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
			dataServer.writtenChunks.push({ fileIndex, chunkIndex, data });
		};

		const requestCounts = new Map<ChunkID, number>();
		let diskChunkRequestedAgain!: () => void;
		const diskChunkRedownloaded = new Promise<void>(resolve => {
			diskChunkRequestedAgain = resolve;
		});
		const peerManager = new PeerManager();
		peerManager.setLishID(lish.id);
		for (let index = 0; index < 4; index++) {
			const client = new MockLISHClient();
			client.requestChunk = async (_lishID, chunkID) => {
				client.requestChunkCalls++;
				const count = (requestCounts.get(chunkID) ?? 0) + 1;
				requestCounts.set(chunkID, count);
				if (chunkID !== chunkIDs[0] && count > 1) diskChunkRequestedAgain();
				return payloads[chunkIDs.indexOf(chunkID)] ?? null;
			};
			peerManager.tryAdd(`peer-${index}`, client as never, 'DIRECT');
		}

		let recoveryEntered!: () => void;
		const recoveryStarted = new Promise<void>(resolve => {
			recoveryEntered = resolve;
		});
		let releaseRecovery!: () => void;
		const recoveryBlocked = new Promise<void>(resolve => {
			releaseRecovery = resolve;
		});
		const fileAllocator = {
			findMissingFiles: async () => {
				recoveryEntered();
				await recoveryBlocked;
				return [];
			},
			allocateFiles: async () => {},
		};
		const state = { disabled: false, destroyed: false };
		const errors: Array<{ code: string; detail: string | undefined }> = [];
		const deps: ChunkDownloaderDeps = {
			lishID: lish.id,
			downloadDir: '/tmp/test-dl',
			abortSignal: new AbortController().signal,
			dataServer: dataServer as never,
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
			onRetry: () => {},
			emitAllocProgress: () => {},
		};

		const running = new ChunkDownloader(deps).run();
		await allInitialWritesStarted;
		releaseMissingFileWrite();
		await recoveryStarted;
		releaseDiskFullWrites();
		await diskFullWritesFailed;
		await new Promise(resolve => setTimeout(resolve, 0));
		releaseRecovery();
		await slowRetainedWriteStarted;
		const redownloadedWhileSlow = await Promise.race([diskChunkRedownloaded.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 40))]);
		releaseSlowRetainedWrite();
		await running;

		expect(redownloadedWhileSlow).toBe(false);
		expect(
			chunkIDs
				.slice(1)
				.map(chunkID => requestCounts.get(chunkID) ?? 0)
				.sort((left, right) => left - right)
		).toEqual([1, 1, 2]);
		expect(dataServer.downloadedChunks.size).toBe(4);
		expect(errors).toHaveLength(0);
	});

	it('rechecks the drain after a late in-flight write creates a new reservation', async () => {
		(ChunkDownloader as unknown as { MAX_RETAINED_WRITE_BYTES: number }).MAX_RETAINED_WRITE_BYTES = 1024;
		const payloads = [5, 9, 17].map(seed => {
			const bytes = new Uint8Array(1024);
			for (let index = 0; index < bytes.length; index++) bytes[index] = (index * seed + 23) & 0xff;
			return bytes;
		});
		const chunkIDs = payloads.map(data => sha256Hex(data) as ChunkID);
		const dataServer = new MockDataServer();
		const lish = makeLISH({
			chunkSize: 1024,
			files: [{ path: 'f.bin', size: 3072, checksums: chunkIDs }],
		});
		dataServer.add(lish);
		dataServer.allChunkCount = 3;
		dataServer.missingChunks = chunkIDs.map((chunkID, chunkIndex) => makeMissingChunk(chunkID, 0, chunkIndex));

		let allInitialWritesEntered!: () => void;
		const allInitialWritesStarted = new Promise<void>(resolve => {
			allInitialWritesEntered = resolve;
		});
		let releaseFirstFailure!: () => void;
		const firstFailureBlocked = new Promise<void>(resolve => {
			releaseFirstFailure = resolve;
		});
		let releaseOverflowFailure!: () => void;
		const overflowFailureBlocked = new Promise<void>(resolve => {
			releaseOverflowFailure = resolve;
		});
		let releaseLateFailure!: () => void;
		const lateFailureBlocked = new Promise<void>(resolve => {
			releaseLateFailure = resolve;
		});
		let lateRetainedWriteEntered!: () => void;
		const lateRetainedWriteStarted = new Promise<void>(resolve => {
			lateRetainedWriteEntered = resolve;
		});
		let releaseLateRetainedWrite!: () => void;
		const lateRetainedWriteBlocked = new Promise<void>(resolve => {
			releaseLateRetainedWrite = resolve;
		});

		const initialWrites = new Set<number>();
		dataServer.writeChunk = async (_dir, _lish, fileIndex, chunkIndex, data) => {
			if (!initialWrites.has(chunkIndex)) {
				initialWrites.add(chunkIndex);
				if (initialWrites.size === 3) allInitialWritesEntered();
				if (chunkIndex === 0) await firstFailureBlocked;
				else if (chunkIndex === 1) await overflowFailureBlocked;
				else await lateFailureBlocked;
				throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
			}

			if (chunkIndex === 0) {
				dataServer.writtenChunks.push({ fileIndex, chunkIndex, data });
				return;
			}
			if (chunkIndex === 2) {
				lateRetainedWriteEntered();
				await lateRetainedWriteBlocked;
			}
			dataServer.writtenChunks.push({ fileIndex, chunkIndex, data });
		};

		const requestCounts = new Map<ChunkID, number>();
		const peerManager = new PeerManager();
		peerManager.setLishID(lish.id);
		for (let index = 0; index < 3; index++) {
			const client = new MockLISHClient();
			client.requestChunk = async (_lishID, chunkID) => {
				client.requestChunkCalls++;
				requestCounts.set(chunkID, (requestCounts.get(chunkID) ?? 0) + 1);
				return payloads[chunkIDs.indexOf(chunkID)] ?? null;
			};
			peerManager.tryAdd(`peer-${index}`, client as never, 'DIRECT');
		}

		const state = { disabled: false, destroyed: false };
		const errors: Array<{ code: string; detail: string | undefined }> = [];
		let firstRetryEntered!: () => void;
		const firstRetryStarted = new Promise<void>(resolve => {
			firstRetryEntered = resolve;
		});
		let retryStarts = 0;
		let firstRetryResolved = false;
		const deps: ChunkDownloaderDeps = {
			lishID: lish.id,
			downloadDir: '/tmp/test-dl',
			abortSignal: new AbortController().signal,
			dataServer: dataServer as never,
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
			onSetError: (code, detail) => {
				errors.push({ code, detail });
				state.disabled = true;
			},
			onRetry: info => {
				if (info.resolved) {
					if (!firstRetryResolved) {
						firstRetryResolved = true;
						releaseLateFailure();
					}
					return;
				}
				retryStarts++;
				if (retryStarts === 1) firstRetryEntered();
			},
			emitAllocProgress: () => {},
		};

		const running = new ChunkDownloader(deps).run();
		await allInitialWritesStarted;
		releaseFirstFailure();
		await firstRetryStarted;
		releaseOverflowFailure();
		await new Promise(resolve => setTimeout(resolve, 0));
		await lateRetainedWriteStarted;
		const requestsBeforeLateRelease = requestCounts.get(chunkIDs[1]!) ?? 0;
		releaseLateRetainedWrite();
		await running;

		expect(requestsBeforeLateRelease).toBe(1);
		expect(requestCounts.get(chunkIDs[1]!)).toBe(2);
		expect(dataServer.downloadedChunks.size).toBe(3);
		expect(errors).toHaveLength(0);
	});
});
