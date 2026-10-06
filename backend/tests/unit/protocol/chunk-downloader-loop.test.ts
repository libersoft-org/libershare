import { describe, it, expect } from 'bun:test';
import { ChunkDownloader, type ChunkDownloaderDeps } from '../../../src/protocol/chunk-downloader.ts';
import { PeerManager } from '../../../src/protocol/peer-manager.ts';
import { PauseController } from '../../../src/protocol/pause-controller.ts';
import { ByteBudget } from '../../../src/protocol/inflight-budget.ts';
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
		const payload = new Uint8Array(CHUNK_SIZE).fill((i + 1) & 0xff);
		new DataView(payload.buffer).setUint32(0, i + 1, true);
		const id = sha256hex(payload) as ChunkID;
		missing.push({ fileIndex: 0, chunkIndex: i, chunkID: id });
		data.set(id, payload);
	}
	return { missing, data };
}

class FakeDataServer {
	downloadedChunks = new Set<ChunkID>();
	isChunkDownloadedCalls = 0;
	writeChunkHook: (() => Promise<void>) | undefined;
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
		this.isChunkDownloadedCalls++;
		return this.downloadedChunks.has(c);
	}
	markChunkDownloaded(_l: LISHid, c: ChunkID): void {
		this.downloadedChunks.add(c);
	}
	/** Every payload that reached the disk boundary, so a test can assert what was written. */
	written: Array<{ chunkIndex: number; data: Uint8Array }> = [];
	async writeChunk(_dir: string, _lish: IStoredLISH, _fi: number, ci: number, data: Uint8Array): Promise<void> {
		this.written.push({ chunkIndex: ci, data: data.slice() });
		await this.writeChunkHook?.();
	}
	incrementDownloadedBytes(_l: LISHid, _n: number): void {}
	getFileVerificationProgress(_l: LISHid): Array<{ filePath: string; verifiedChunks: number }> {
		return [];
	}
}

/** Scripted responses: payload → success, 'nf' → PEER_CHUNK_NOT_FOUND, 'busy' → PEER_BUSY, 'gone' → PEER_UNREACHABLE. */
type Reply = Uint8Array | 'nf' | 'busy' | 'gone';

class ScriptedClient {
	requests: ChunkID[] = [];
	private replies: Map<ChunkID, Reply>;
	private delayMs: number;
	private delaySuccessOnly: boolean;
	constructor(replies: Map<ChunkID, Reply>, delayMs = 0, delaySuccessOnly = false) {
		this.replies = replies;
		this.delayMs = delayMs;
		this.delaySuccessOnly = delaySuccessOnly;
	}
	setReply(chunkID: ChunkID, reply: Reply): void {
		this.replies.set(chunkID, reply);
	}
	/** Requests on the wire right now, and the most there ever were at once. */
	active = 0;
	maxActive = 0;
	/** Shared with other clients to count requests in flight across peers and downloads. */
	sharedActive: { now: number; max: number } | undefined;
	async requestChunk(_l: LISHid, c: ChunkID): Promise<Uint8Array> {
		this.requests.push(c);
		this.maxActive = Math.max(this.maxActive, ++this.active);
		if (this.sharedActive) this.sharedActive.max = Math.max(this.sharedActive.max, ++this.sharedActive.now);
		try {
			return await this.reply(c);
		} finally {
			this.active--;
			if (this.sharedActive) this.sharedActive.now--;
		}
	}
	/** Per-chunk delay that overrides `delayMs`. */
	delayByChunk = new Map<ChunkID, number>();
	private async reply(c: ChunkID): Promise<Uint8Array> {
		const reply = this.replies.get(c) ?? 'nf';
		const delay = this.delayByChunk.get(c) ?? (!this.delaySuccessOnly || reply instanceof Uint8Array ? this.delayMs : 0);
		if (delay > 0) await new Promise(r => setTimeout(r, delay));
		if (reply === 'nf') throw new CodedError(ErrorCodes.PEER_CHUNK_NOT_FOUND, 'not found');
		if (reply === 'busy') throw new CodedError(ErrorCodes.PEER_BUSY, 'busy');
		if (reply === 'gone') throw new CodedError(ErrorCodes.PEER_UNREACHABLE, 'gone');
		return reply;
	}
	abortCalls = 0;
	/** Holds close() open until it settles; `onClose` runs when close() is entered. */
	closeGate: Promise<void> | undefined;
	onClose: (() => void) | undefined;
	async close(): Promise<void> {
		this.onClose?.();
		await this.closeGate;
	}
	abort(): void {
		this.abortCalls++;
	}
}

function makeDownloader(ds: FakeDataServer, pm: PeerManager, chunkCount: number, lifecycle?: { controller?: AbortController; isDestroyed?: () => boolean; isDisabled?: () => boolean; pauseController?: PauseController; inflightBudget?: ByteBudget }): ChunkDownloader {
	const lish = { id: LISH_ID, name: 'test', chunkSize: CHUNK_SIZE, checksumAlgo: 'sha256', files: [{ path: 'f.bin', size: chunkCount * CHUNK_SIZE, checksums: [] }] } as unknown as IStoredLISH;
	const controller = lifecycle?.controller ?? new AbortController();
	const pc =
		lifecycle?.pauseController ??
		new PauseController(
			() => false,
			() => false
		);
	const deps = {
		lishID: LISH_ID,
		downloadDir: '/tmp/peerloop-test',
		abortSignal: controller.signal,
		dataServer: ds as never,
		peerManager: pm,
		pauseController: pc,
		progressReporter: new ProgressReporter(),
		fileAllocator: {} as never,
		getLish: () => lish,
		isDestroyed: lifecycle?.isDestroyed ?? (() => false),
		isDisabled: lifecycle?.isDisabled ?? (() => false),
		inflightBudget: lifecycle?.inflightBudget ?? new ByteBudget(() => 64 * 1024 * 1024),
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

	it('does not repeatedly rotate an unchanged not-found queue while another chunk is in flight', async () => {
		// The empty peer quickly learns that it cannot serve every chunk except the
		// one held by the slow peer. Once it reaches only known-not-found entries it
		// must wait for that request to settle without rescanning the whole queue on
		// every 150ms poll.
		const chunkCount = 1500;
		const { missing, data } = makeChunks(chunkCount);
		const slowChunkID = missing[1]!.chunkID;
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const empty = new ScriptedClient(new Map());
		const slowHasOne = new ScriptedClient(new Map<ChunkID, Reply>([[slowChunkID, data.get(slowChunkID)!]]), 3000, true);
		const cd = makeDownloader(ds, pm, chunkCount);
		pm.tryAdd('peer-empty-fast0', empty as never, 'DIRECT');
		pm.tryAdd('peer-slow-has01', slowHasOne as never, 'DIRECT');

		const runPromise = cd.run();
		const readyDeadline = Date.now() + 2000;
		while ((!slowHasOne.requests.includes(slowChunkID) || empty.requests.length < chunkCount - 1) && Date.now() < readyDeadline) {
			await new Promise(r => setTimeout(r, 10));
		}
		expect(slowHasOne.requests.includes(slowChunkID)).toBe(true);
		expect(empty.requests.length).toBeGreaterThanOrEqual(chunkCount - 1);

		const checksBeforeSteadyWait = ds.isChunkDownloadedCalls;
		await new Promise(r => setTimeout(r, 600));
		const checksDuringSteadyWait = ds.isChunkDownloadedCalls - checksBeforeSteadyWait;
		// Counter polling performs no queue scan. The old loop added roughly one
		// complete-manifest scan every 150ms during this stable interval.
		expect(checksDuringSteadyWait).toBeLessThan(100);

		await runPromise;

		expect(ds.downloadedChunks.has(slowChunkID)).toBe(true);
	}, 15000);

	it('rejects a wrong-length chunk before hashing and completes from a healthy peer', async () => {
		// The bad peer serves a truncated payload for the only chunk. The length check
		// (not the hash) must reject it, the chunk is requeued and the healthy peer
		// finishes the download.
		const { missing, data } = makeChunks(1);
		const onlyID = missing[0]!.chunkID;
		const truncated = data.get(onlyID)!.subarray(0, CHUNK_SIZE / 2);
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const bad = new ScriptedClient(new Map<ChunkID, Reply>([[onlyID, truncated]]));
		const good = new ScriptedClient(new Map<ChunkID, Reply>([[onlyID, data.get(onlyID)!]]), 100);
		const cd = makeDownloader(ds, pm, 1);
		pm.tryAdd('peer-bad-length0', bad as never, 'DIRECT');
		pm.tryAdd('peer-good-00000', good as never, 'DIRECT');

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => logs.push(args.join(' '));
		try {
			await cd.run();
		} finally {
			console.log = origLog;
		}

		expect(ds.downloadedChunks.has(onlyID)).toBe(true);
		expect(logs.some(l => l.includes('Rejected chunk') && l.includes('wrong length'))).toBe(true);
	}, 15000);

	it('rejects a chunk of the right length with one flipped bit — only the hash can catch it', async () => {
		// Same length as the original, so the length check passes: rejecting it proves the
		// hash comparison runs. The corrupt bytes must never reach the disk, and the healthy
		// peer must still supply the original.
		const { missing, data } = makeChunks(1);
		const onlyID = missing[0]!.chunkID;
		const original = data.get(onlyID)!;
		const flipped = original.slice();
		flipped[100]! ^= 0x01;
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const bad = new ScriptedClient(new Map<ChunkID, Reply>([[onlyID, flipped]]));
		const good = new ScriptedClient(new Map<ChunkID, Reply>([[onlyID, original]]), 100);
		const cd = makeDownloader(ds, pm, 1);
		pm.tryAdd('peer-bad-hash000', bad as never, 'DIRECT');
		pm.tryAdd('peer-good-00001', good as never, 'DIRECT');

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => logs.push(args.join(' '));
		try {
			await cd.run();
		} finally {
			console.log = origLog;
		}

		expect(ds.downloadedChunks.has(onlyID)).toBe(true);
		expect(logs.some(l => l.includes('Rejected chunk') && l.includes('bad hash'))).toBe(true);
		expect(ds.written.length).toBe(1);
		expect(Buffer.from(ds.written[0]!.data).equals(Buffer.from(original))).toBe(true);
	}, 15000);

	it('bans a peer that keeps serving same-length corrupt chunks', async () => {
		const { missing, data } = makeChunks(4);
		const replies = new Map<ChunkID, Reply>();
		for (const c of missing) {
			const corrupt = data.get(c.chunkID)!.slice();
			corrupt[0]! ^= 0xff;
			replies.set(c.chunkID, corrupt);
		}
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const bad = new ScriptedClient(replies);
		const cd = makeDownloader(ds, pm, 4);
		pm.tryAdd('peer-corrupt000', bad as never, 'DIRECT');

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => logs.push(args.join(' '));
		try {
			await cd.run();
		} finally {
			console.log = origLog;
		}

		expect(ds.downloadedChunks.size).toBe(0);
		expect(ds.written.length).toBe(0);
		expect(logs.some(l => l.includes('banned') && l.includes('bad chunks'))).toBe(true);
		// Pipelined requests can all be on the wire before the third bad reply arrives; none is repeated.
		expect(new Set(bad.requests).size).toBe(bad.requests.length);
	}, 15000);

	it('bans a peer that keeps serving wrong-length chunks', async () => {
		// Every reply from the bad peer is oversized. After MAX_CORRUPT_CHUNKS
		// rejections the peer must be banned instead of being asked forever.
		const { missing, data } = makeChunks(4);
		const replies = new Map<ChunkID, Reply>();
		for (const c of missing) {
			const oversized = new Uint8Array(CHUNK_SIZE + 1);
			oversized.set(data.get(c.chunkID)!);
			replies.set(c.chunkID, oversized);
		}
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const bad = new ScriptedClient(replies);
		const cd = makeDownloader(ds, pm, 4);
		pm.tryAdd('peer-oversize00', bad as never, 'DIRECT');

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => logs.push(args.join(' '));
		try {
			await cd.run();
		} finally {
			console.log = origLog;
		}

		expect(ds.downloadedChunks.size).toBe(0);
		expect(logs.some(l => l.includes('banned') && l.includes('bad chunks'))).toBe(true);
		// Banned after 3 rejected chunks; pipelined requests already on the wire are not repeated.
		expect(new Set(bad.requests).size).toBe(bad.requests.length);
	}, 15000);

	it('retries a cached miss when a connected peer announces the chunk in a new HAVE', async () => {
		const { missing, data } = makeChunks(2);
		const newlyAvailableID = missing[0]!.chunkID;
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const dynamic = new ScriptedClient(new Map());
		const slowEmpty = new ScriptedClient(new Map(), 600);
		const cd = makeDownloader(ds, pm, 2);
		pm.tryAdd('peer-dynamic-00', dynamic as never, 'DIRECT');
		pm.tryAdd('peer-slow-empty1', slowEmpty as never, 'DIRECT');

		const runPromise = cd.run();
		const waitingDeadline = Date.now() + 2000;
		while ((!dynamic.requests.includes(newlyAvailableID) || slowEmpty.requests.length === 0) && Date.now() < waitingDeadline) await new Promise(r => setTimeout(r, 10));
		expect(dynamic.requests.includes(newlyAvailableID)).toBe(true);
		expect(slowEmpty.requests.length).toBeGreaterThan(0);

		dynamic.setReply(newlyAvailableID, data.get(newlyAvailableID)!);
		cd.notifyPeerHave('peer-dynamic-00', [newlyAvailableID]);

		await runPromise;
		expect(ds.downloadedChunks.has(newlyAvailableID)).toBe(true);
		expect(dynamic.requests.filter(id => id === newlyAvailableID).length).toBe(2);
	}, 15000);

	it('does not commit a chunk after its downloader is destroyed during the file write', async () => {
		const { missing, data } = makeChunks(1);
		const chunkID = missing[0]!.chunkID;
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const controller = new AbortController();
		let destroyed = false;
		let writeStarted!: () => void;
		let releaseWrite!: () => void;
		const writeEntered = new Promise<void>(resolve => {
			writeStarted = resolve;
		});
		const writeBlocked = new Promise<void>(resolve => {
			releaseWrite = resolve;
		});
		ds.writeChunkHook = async () => {
			writeStarted();
			await writeBlocked;
		};
		const cd = makeDownloader(ds, pm, 1, { controller, isDestroyed: () => destroyed });
		pm.tryAdd('peer-write-wait0', new ScriptedClient(new Map([[chunkID, data.get(chunkID)!]])) as never, 'DIRECT');

		const running = cd.run();
		await writeEntered;
		destroyed = true;
		controller.abort();
		let settled = false;
		void running.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		releaseWrite();
		await running;

		expect(ds.downloadedChunks.has(chunkID)).toBe(false);
	}, 15000);
});

describe('ChunkDownloader peerLoop — stopping a peer', () => {
	it('aborts the stream of a banned peer instead of only half-closing it', async () => {
		const { missing, data } = makeChunks(4);
		const replies = new Map<ChunkID, Reply>();
		for (const c of missing) {
			const corrupt = data.get(c.chunkID)!.slice();
			corrupt[0]! ^= 0xff;
			replies.set(c.chunkID, corrupt);
		}
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const bad = new ScriptedClient(replies);
		const cd = makeDownloader(ds, pm, 4);
		pm.tryAdd('peer-banned-abort', bad as never, 'DIRECT');

		await cd.run();

		expect(pm.isBanned('peer-banned-abort')).toBe(true);
		expect(bad.abortCalls).toBe(1);
	}, 15000);

	it('leaves a new run of the same peer active when the stopped run winds down after it started', async () => {
		const { missing, data } = makeChunks(3);
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const cd = makeDownloader(ds, pm, 3);
		const peerID = 'peer-rejoined-000';
		// The first connection has none of the chunks, so the run drops the peer — and stays inside
		// removeAwait while its close is held open.
		const first = new ScriptedClient(new Map());
		let releaseClose!: () => void;
		first.closeGate = new Promise(resolve => (releaseClose = resolve));
		const closing = new Promise<void>(resolve => (first.onClose = resolve));
		pm.tryAdd(peerID, first as never, 'DIRECT');
		const run = cd.run();
		await closing;

		// The peer comes back (a fresh HAVE) before the old run finished; the new connection is slow.
		const replies = new Map<ChunkID, Reply>(missing.map(c => [c.chunkID, data.get(c.chunkID)!]));
		const second = new ScriptedClient(replies, 300);
		expect(pm.tryAdd(peerID, second as never, 'DIRECT')).toBe(true);
		releaseClose();
		await Bun.sleep(50);

		expect(pm.isActive(peerID)).toBe(true);
		await run;
		expect(ds.downloadedChunks.size).toBe(3);
	}, 15000);
});

describe('ChunkDownloader peerLoop — writes around recovery', () => {
	it('holds a reply that arrives during a recovery write pause until the pause lifts', async () => {
		const { missing, data } = makeChunks(1);
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const pc = new PauseController(
			() => false,
			() => false
		);
		const cd = makeDownloader(ds, pm, 1, { pauseController: pc });
		const client = new ScriptedClient(new Map([[missing[0]!.chunkID, data.get(missing[0]!.chunkID)!]]), 100);
		pm.tryAdd('peer-recovery-hold', client as never, 'DIRECT');
		const run = cd.run();
		await Bun.sleep(30);
		// Another peer's recovery takes the pause while this request is on the wire.
		pc.pauseWrites();
		await Bun.sleep(150);
		expect(ds.written.length).toBe(0);
		pc.resumeWrites();
		await run;
		expect(ds.written.length).toBe(1);
	}, 15000);

	it('drops a reply for a chunk that recovery found intact while the reply waited', async () => {
		const { missing, data } = makeChunks(1);
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const pc = new PauseController(
			() => false,
			() => false
		);
		const cd = makeDownloader(ds, pm, 1, { pauseController: pc });
		const client = new ScriptedClient(new Map([[missing[0]!.chunkID, data.get(missing[0]!.chunkID)!]]), 100);
		pm.tryAdd('peer-recovery-done', client as never, 'DIRECT');
		const run = cd.run();
		await Bun.sleep(30);
		pc.pauseWrites();
		await Bun.sleep(150);
		// Recovery verified the file from disk and marked the chunk downloaded.
		ds.downloadedChunks.add(missing[0]!.chunkID);
		pc.resumeWrites();
		await run;
		expect(ds.written.length).toBe(0);
	}, 15000);
});

describe('ChunkDownloader peerLoop — chunks in flight', () => {
	it('does not fetch a chunk twice when the queue lists it again while it is in flight', async () => {
		const { missing, data } = makeChunks(2);
		const [x, y] = [missing[0]!, missing[1]!];
		// The queue holds X twice, as after a requeue or a rebuilt queue.
		const ds = new FakeDataServer([x, x, y]);
		const pm = new PeerManager();
		const cd = makeDownloader(ds, pm, 2);
		const replies = new Map<ChunkID, Reply>([
			[x.chunkID, data.get(x.chunkID)!],
			[y.chunkID, data.get(y.chunkID)!],
		]);
		const slow = new ScriptedClient(replies, 300);
		const fast = new ScriptedClient(replies);
		pm.tryAdd('peer-slow-0000000', slow as never, 'DIRECT');
		pm.tryAdd('peer-fast-0000000', fast as never, 'DIRECT');

		await cd.run();

		expect([...slow.requests, ...fast.requests].filter(c => c === x.chunkID).length).toBe(1);
		expect(ds.downloadedChunks.size).toBe(2);
	}, 15000);
});

describe('ChunkDownloader peerLoop — pipelining', () => {
	it('keeps several requests to one peer on the wire at once', async () => {
		const { missing, data } = makeChunks(40);
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const cd = makeDownloader(ds, pm, 40);
		const client = new ScriptedClient(new Map(missing.map(c => [c.chunkID, data.get(c.chunkID)! as Reply])), 50);
		pm.tryAdd('peer-pipelined-00', client as never, 'DIRECT');

		await cd.run();

		expect(ds.downloadedChunks.size).toBe(40);
		// 1 KiB chunks against the 16 MiB default window: the per-peer cap of 32 requests applies.
		expect(client.maxActive).toBe(32);
		expect(new Set(client.requests).size).toBe(40);
	}, 15000);

	it('never has more chunk bytes in flight than the shared budget across downloads', async () => {
		const budget = new ByteBudget(() => 2 * CHUNK_SIZE);
		const shared = { now: 0, max: 0 };
		const runs: Promise<void>[] = [];
		const stores: FakeDataServer[] = [];
		for (const name of ['a', 'b']) {
			const { missing, data } = makeChunks(6);
			const ds = new FakeDataServer(missing);
			stores.push(ds);
			const pm = new PeerManager();
			const cd = makeDownloader(ds, pm, 6, { inflightBudget: budget });
			const client = new ScriptedClient(new Map(missing.map(c => [c.chunkID, data.get(c.chunkID)! as Reply])), 30);
			client.sharedActive = shared;
			pm.tryAdd(`peer-budget-${name}-000`, client as never, 'DIRECT');
			runs.push(cd.run());
		}

		await Promise.all(runs);

		expect(stores.map(ds => ds.downloadedChunks.size)).toEqual([6, 6]);
		expect(shared.max).toBe(2);
		expect(budget.reservedBytes).toBe(0);
	}, 15000);

	it('ends a disabled download even while another download holds the whole budget', async () => {
		const budget = new ByteBudget(() => CHUNK_SIZE);
		// Download B takes the only slot and keeps it: its peer answers after 10 s.
		const slow = makeChunks(1);
		const holder = new AbortController();
		const dsB = new FakeDataServer(slow.missing);
		const pmB = new PeerManager();
		const cdB = makeDownloader(dsB, pmB, 1, { inflightBudget: budget, controller: holder });
		pmB.tryAdd('peer-holds-budget', new ScriptedClient(new Map([[slow.missing[0]!.chunkID, slow.data.get(slow.missing[0]!.chunkID)! as Reply]]), 10_000) as never, 'DIRECT');
		const runB = cdB.run();
		await Bun.sleep(20);
		expect(budget.reservedBytes).toBe(CHUNK_SIZE);

		// Download A waits for budget, then gets disabled.
		let disabled = false;
		const pcA = new PauseController(
			() => disabled,
			() => false
		);
		const fast = makeChunks(2);
		const dsA = new FakeDataServer(fast.missing);
		const pmA = new PeerManager();
		const cdA = makeDownloader(dsA, pmA, 2, { inflightBudget: budget, pauseController: pcA, isDisabled: () => disabled });
		pmA.tryAdd('peer-waits-budget', new ScriptedClient(new Map(fast.missing.map(c => [c.chunkID, fast.data.get(c.chunkID)! as Reply]))) as never, 'DIRECT');
		const runA = cdA.run();
		await Bun.sleep(20);
		disabled = true;
		pcA.notifyStateChange();
		const ended = await Promise.race([runA.then(() => true), Bun.sleep(1000).then(() => false)]);
		expect(ended).toBe(true);

		holder.abort();
		await pmB.closeAllAwait('test done', true);
		await Promise.race([runB, Bun.sleep(1000)]);
	}, 15000);

	it('refills the pipeline when work comes back after its workers went idle', async () => {
		const { missing, data } = makeChunks(40);
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const cd = makeDownloader(ds, pm, 40);
		// The first peer takes most chunks and loses its connection on every one of them after 200 ms.
		const flaky = new ScriptedClient(new Map(missing.map(c => [c.chunkID, 'gone' as Reply])), 200);
		const steady = new ScriptedClient(new Map(missing.map(c => [c.chunkID, data.get(c.chunkID)! as Reply])), 50);
		pm.tryAdd('peer-flaky-fails0', flaky as never, 'DIRECT');
		pm.tryAdd('peer-steady-00000', steady as never, 'DIRECT');
		const run = cd.run();
		// By now the steady peer finished what it got and its workers went idle.
		await Bun.sleep(150);
		steady.maxActive = steady.active;

		await run;

		expect(ds.downloadedChunks.size).toBe(40);
		expect(steady.maxActive).toBeGreaterThan(1);
	}, 15000);

	it('drops valid replies that arrive after a sibling banned the peer', async () => {
		const { missing, data } = makeChunks(6);
		const replies = new Map<ChunkID, Reply>();
		const bad = new ScriptedClient(replies);
		missing.forEach((c, i) => {
			if (i < 3) {
				const corrupt = data.get(c.chunkID)!.slice();
				corrupt[0]! ^= 0xff;
				replies.set(c.chunkID, corrupt);
				return;
			}
			// Intact data, but on the wire until well after the third corrupt reply banned the peer.
			replies.set(c.chunkID, data.get(c.chunkID)!);
			bad.delayByChunk.set(c.chunkID, 200);
		});
		const ds = new FakeDataServer(missing);
		const pm = new PeerManager();
		const cd = makeDownloader(ds, pm, 6);
		pm.tryAdd('peer-banned-late0', bad as never, 'DIRECT');

		await cd.run();

		expect(pm.isBanned('peer-banned-late0')).toBe(true);
		expect(ds.written.length).toBe(0);
	}, 15000);
});
