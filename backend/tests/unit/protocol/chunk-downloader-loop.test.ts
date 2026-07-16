import { describe, it, expect } from 'bun:test';
import { ChunkDownloader, type ChunkDownloaderDeps } from '../../../src/protocol/chunk-downloader.ts';
import { PeerManager } from '../../../src/protocol/peer-manager.ts';
import { PauseController } from '../../../src/protocol/pause-controller.ts';
import { ProgressReporter } from '../../../src/protocol/progress-reporter.ts';
import { CodedError, ErrorCodes, type ChunkID, type LISHid, type IStoredLISH } from '@shared';
import type { MissingChunk } from '../../../src/lish/data-server.ts';

/**
 * Behavioral tests for the peerLoop inside ChunkDownloader.run() — the queue
 * sharing, partial-seeder handling and peer drop decisions that unit tests on
 * downloadChunk() alone can't reach. Uses the real PeerManager / PauseController /
 * ProgressReporter and a fake DataServer + LISHClient.
 */

const CHUNK_SIZE = 1024;
const LISH_ID = 'lish-peerloop-test' as LISHid;

function sha256hex(data: Uint8Array): string {
	const h = new Bun.CryptoHasher('sha256');
	h.update(data);
	return h.digest('hex');
}

function makeChunks(count: number): { missing: MissingChunk[]; data: Map<ChunkID, Uint8Array> } {
	const missing: MissingChunk[] = [];
	const data = new Map<ChunkID, Uint8Array>();
	for (let i = 0; i < count; i++) {
		const payload = new Uint8Array(CHUNK_SIZE).fill(i + 1);
		const id = sha256hex(payload) as ChunkID;
		missing.push({ fileIndex: 0, chunkIndex: i, chunkID: id });
		data.set(id, payload);
	}
	return { missing, data };
}

class FakeDataServer {
	downloadedChunks = new Set<ChunkID>();
	private missing: MissingChunk[];
	constructor(missing: MissingChunk[]) {
		this.missing = missing;
	}
	getMissingChunks(_l: LISHid): MissingChunk[] {
		return this.missing.filter(c => !this.downloadedChunks.has(c.chunkID));
	}
	getAllChunkCount(_l: LISHid): number {
		return this.missing.length;
	}
	getAllChunkSlots(_l: LISHid): Array<{ checksum: string; fileIndex: number; chunkIndex: number }> {
		return [];
	}
	isChunkDownloaded(_l: LISHid, c: ChunkID): boolean {
		return this.downloadedChunks.has(c);
	}
	markChunkDownloaded(_l: LISHid, c: ChunkID): void {
		this.downloadedChunks.add(c);
	}
	async writeChunk(_dir: string, _lish: IStoredLISH, _fi: number, _ci: number, _data: Uint8Array): Promise<void> {}
	incrementDownloadedBytes(_l: LISHid, _n: number): void {}
	getFileVerificationProgress(_l: LISHid): Array<{ filePath: string; verifiedChunks: number }> {
		return [];
	}
}

/** Scripted responses: payload → success, 'nf' → PEER_CHUNK_NOT_FOUND, 'busy' → PEER_BUSY. */
type Reply = Uint8Array | 'nf' | 'busy';

class ScriptedClient {
	requests: ChunkID[] = [];
	private replies: Map<ChunkID, Reply>;
	private delayMs: number;
	constructor(replies: Map<ChunkID, Reply>, delayMs = 0) {
		this.replies = replies;
		this.delayMs = delayMs;
	}
	async requestChunk(_l: LISHid, c: ChunkID): Promise<Uint8Array> {
		this.requests.push(c);
		if (this.delayMs > 0) await new Promise(r => setTimeout(r, this.delayMs));
		const reply = this.replies.get(c) ?? 'nf';
		if (reply === 'nf') throw new CodedError(ErrorCodes.PEER_CHUNK_NOT_FOUND, 'not found');
		if (reply === 'busy') throw new CodedError(ErrorCodes.PEER_BUSY, 'busy');
		return reply;
	}
	async close(): Promise<void> {}
}

function makeDownloader(ds: FakeDataServer, pm: PeerManager, chunkCount: number): ChunkDownloader {
	const lish = { id: LISH_ID, name: 'test', chunkSize: CHUNK_SIZE, checksumAlgo: 'sha256', files: [{ path: 'f.bin', size: chunkCount * CHUNK_SIZE, checksums: [] }] } as unknown as IStoredLISH;
	const pc = new PauseController(
		() => false,
		() => false
	);
	const deps = {
		lishID: LISH_ID,
		downloadDir: '/tmp/peerloop-test',
		abortSignal: new AbortController().signal,
		dataServer: ds as never,
		peerManager: pm,
		pauseController: pc,
		progressReporter: new ProgressReporter(),
		fileAllocator: {} as never,
		getLish: () => lish,
		isDestroyed: () => false,
		isDisabled: () => false,
		onSetError: () => {},
		emitAllocProgress: () => {},
	} as unknown as ChunkDownloaderDeps;
	return new ChunkDownloader(deps);
}

describe('ChunkDownloader peerLoop — partial seeder behavior', () => {
	it('downloads the available chunk even when 12 not-found chunks sit ahead of it', async () => {
		const { missing, data } = makeChunks(13);
		const availableID = missing[12]!.chunkID;
		const replies = new Map<ChunkID, Reply>([[availableID, data.get(availableID)!]]);
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const cd = makeDownloader(ds, pm, 13);
		pm.tryAdd('peer-partial-000', new ScriptedClient(replies) as never, 'DIRECT');

		await cd.run();

		expect(ds.downloadedChunks.has(availableID)).toBe(true);
	}, 15000);

	it('terminates against an empty peer, probing each chunk at most once', async () => {
		const { missing } = makeChunks(13);
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const client = new ScriptedClient(new Map());
		const cd = makeDownloader(ds, pm, 13);
		pm.tryAdd('peer-empty-00000', client as never, 'DIRECT');

		await cd.run();

		expect(ds.downloadedChunks.size).toBe(0);
		expect(new Set(client.requests).size).toBe(client.requests.length);
		expect(client.requests.length).toBeLessThanOrEqual(13);
	}, 15000);

	it('does not count a definitive not-found into the transient-skip streak', async () => {
		// 9 busy chunks, then a not-found, then another busy, then the servable one.
		// Without the streak reset the not-found keeps the streak at 9 and the next
		// busy hits 10 — the peer is dropped before the servable chunk is reached.
		const { missing, data } = makeChunks(12);
		const replies = new Map<ChunkID, Reply>();
		for (let i = 0; i < 9; i++) replies.set(missing[i]!.chunkID, 'busy');
		replies.set(missing[9]!.chunkID, 'nf');
		replies.set(missing[10]!.chunkID, 'busy');
		replies.set(missing[11]!.chunkID, data.get(missing[11]!.chunkID)!);
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const cd = makeDownloader(ds, pm, 12);
		pm.tryAdd('peer-flaky-00000', new ScriptedClient(replies) as never, 'DIRECT');

		await cd.run();

		expect(ds.downloadedChunks.has(missing[11]!.chunkID)).toBe(true);
	}, 15000);

	it('a peer waits for in-flight chunks instead of exiting while another peer holds the last one', async () => {
		// Peer A (spawned first, slow) claims the only chunk and answers not-found after
		// 300ms. Peer B — the only peer that HAS the chunk — sees an empty queue while
		// A holds it. Without in-flight tracking B exits, the requeued chunk is orphaned
		// and the run ends incomplete; with it B re-scans and downloads the chunk.
		const { missing, data } = makeChunks(1);
		const onlyID = missing[0]!.chunkID;
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const slowEmpty = new ScriptedClient(new Map(), 300);
		const hasIt = new ScriptedClient(new Map<ChunkID, Reply>([[onlyID, data.get(onlyID)!]]));
		const cd = makeDownloader(ds, pm, 1);
		pm.tryAdd('peer-slow-empty0', slowEmpty as never, 'DIRECT');
		pm.tryAdd('peer-has-chunk00', hasIt as never, 'DIRECT');

		await cd.run();

		expect(ds.downloadedChunks.has(onlyID)).toBe(true);
	}, 15000);
});
