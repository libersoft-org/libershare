import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { ErrorCodes } from '@shared';
import { windowsDatasetError } from '../../../src/lish/windows-dataset-error.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { openDataset } from '../../../src/lish/safe-dataset-files.ts';
import type { DatasetWriteScope } from '../../../src/lish/dataset-write-scope.ts';
import { ChunkDownloader, type RetryInfo } from '../../../src/protocol/chunk-downloader.ts';
import { PeerManager } from '../../../src/protocol/peer-manager.ts';
import { PauseController } from '../../../src/protocol/pause-controller.ts';
import { ProgressReporter } from '../../../src/protocol/progress-reporter.ts';
import { MockDataServer, MockLISHClient, makeLISH, makeMissingChunk } from '../protocol/downloader-test-helpers.ts';

test.each([39, 112])('Windows error %i retains and retries the chunk after disk space becomes available', async nativeError => {
	const directory = await mkdtemp(join(tmpdir(), 'lish-disk-full-'));
	const bytes = Buffer.from('verified chunk');
	const checksum = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
	await writeFile(join(directory, 'file.bin'), Buffer.alloc(bytes.length));
	const manifest = makeLISH({ chunkSize: bytes.length, files: [{ path: 'file.bin', size: bytes.length, checksums: [checksum] }] });
	let spaceAvailable = false;
	let writeAttempts = 0;
	const writer = new DataServer({} as Database, async root => {
		const dataset = await openDataset(root);
		const openFile = dataset.openFile.bind(dataset);
		dataset.openFile = async (path, mode) => {
			const file = await openFile(path, mode);
			const write = file.write.bind(file);
			file.write = async (buffer, position) => {
				writeAttempts++;
				if (!spaceAvailable) throw windowsDatasetError('Write file', nativeError);
				return write(buffer, position);
			};
			return file;
		};
		return dataset;
	});
	const data = new MockDataServer();
	data.add(manifest);
	data.allChunkCount = 1;
	data.missingChunks = [makeMissingChunk(checksum, 0, 0)];
	data.writeChunk = async (_root, lish, fileIndex, chunkIndex, buffer, scope?: DatasetWriteScope) => writer.writeChunk({ kind: 'explicit', path: directory }, lish, fileIndex, chunkIndex, buffer, scope);
	const client = new MockLISHClient();
	client.requestChunkResult = bytes;
	const peers = new PeerManager();
	peers.setLishID(manifest.id);
	peers.tryAdd('test-peer', client as never, 'DIRECT');
	const pause = new PauseController(() => disabled, () => false);
	const progress = new ProgressReporter();
	const retries: RetryInfo[] = [];
	const errors: string[] = [];
	let disabled = false;
	const downloader = new ChunkDownloader({
		lishID: manifest.id,
		downloadDir: directory,
		datasetRoot: { kind: 'explicit', path: directory },
		abortSignal: new AbortController().signal,
		dataServer: data as never,
		peerManager: peers,
		pauseController: pause,
		progressReporter: progress,
		fileAllocator: {} as never,
		getLish: () => manifest,
		isDestroyed: () => false,
		isDisabled: () => disabled,
		onSetError: code => { errors.push(code); disabled = true; },
		onRetry: info => { retries.push(info); if (!info.resolved) spaceAvailable = true; },
		emitAllocProgress: () => {},
	});
	const timing = ChunkDownloader as unknown as { WRITE_RETRY_DELAY: number };
	const delay = timing.WRITE_RETRY_DELAY;
	timing.WRITE_RETRY_DELAY = 1;
	try {
		await downloader.run();
		expect(errors).toEqual([]);
		expect(writeAttempts).toBe(2);
		expect(client.requestChunkCalls).toBe(1);
		expect(data.downloadedChunks.has(checksum)).toBe(true);
		expect(retries.some(info => info.errorCode === ErrorCodes.DISK_FULL && !info.resolved)).toBe(true);
		expect(retries.some(info => info.resolved)).toBe(true);
		expect(await readFile(join(directory, 'file.bin'))).toEqual(bytes);
	} finally {
		timing.WRITE_RETRY_DELAY = delay;
		await peers.closeAllAwait('test cleanup');
		await rm(directory, { recursive: true, force: true });
	}
});
