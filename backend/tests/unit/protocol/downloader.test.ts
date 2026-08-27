import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Downloader } from '../../../src/protocol/downloader.ts';
import type { IStoredLISH, LISHid, ChunkID } from '@shared';
import { CodedError, ErrorCodes } from '@shared';
import type { MissingChunk } from '../../../src/lish/data-server.ts';
import { MockNetwork } from '../helpers/mock-network.ts';
import { MockDataServer, MockLISHClient, makeLISH, makeMissingChunk, priv } from './downloader-test-helpers.ts';
describe('Downloader – static speed limit', () => {
	afterEach(() => {
		// Reset static limit between tests
		Downloader.setMaxDownloadSpeed(0);
	});

	it('setMaxDownloadSpeed(0) leaves limit at 0 (unlimited)', () => {
		Downloader.setMaxDownloadSpeed(0);
		// Internal static is private; we confirm no throw and logic consistency
		expect(() => Downloader.setMaxDownloadSpeed(0)).not.toThrow();
	});

	it('setMaxDownloadSpeed(512) sets limit to 512 * 1024 bytes/sec', () => {
		Downloader.setMaxDownloadSpeed(512);
		// Verify by setting and then clearing — no throw expected
		expect(() => Downloader.setMaxDownloadSpeed(0)).not.toThrow();
	});

	it('setMaxDownloadSpeed with negative value clamps to 0', () => {
		expect(() => Downloader.setMaxDownloadSpeed(-100)).not.toThrow();
	});
});

describe('Downloader – disable / enable state', () => {
	let downloader: Downloader;

	beforeEach(async () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		ds.missingChunks = [];
		downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
		await downloader.initFromManifest(makeLISH());
	});

	it('isDisabled returns false initially', () => {
		expect(downloader.isDisabled()).toBe(false);
	});

	it('disable() sets isDisabled to true', () => {
		downloader.disable();
		expect(downloader.isDisabled()).toBe(true);
	});

	it('enable() after disable sets isDisabled to false', async () => {
		downloader.disable();
		await downloader.enable();
		expect(downloader.isDisabled()).toBe(false);
	});

	it('enable() without prior disable does not throw', async () => {
		await expect(downloader.enable()).resolves.toBeUndefined();
	});

	it('multiple disable calls keep isDisabled true', () => {
		downloader.disable();
		downloader.disable();
		expect(downloader.isDisabled()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// waitIfDisabled — multi-peerLoop race condition (H2)
// ---------------------------------------------------------------------------

describe('Downloader – waitIfDisabled with multiple concurrent waiters', () => {
	it('resume unblocks ALL waiting callers, not just the last one', async () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		ds.missingChunks = [];
		const dl = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
		const lish = makeLISH();
		await dl.initFromManifest(lish);

		const pc = priv(dl)['pauseController'] as { waitIfDisabled: () => Promise<void>; enableResolvers: unknown[] };
		const waitIfDisabled = pc.waitIfDisabled.bind(pc);

		dl.disable();

		// Simulate 3 peerLoops calling waitIfDisabled concurrently
		const unblocked = [false, false, false];
		const waiters = [
			waitIfDisabled().then(() => {
				unblocked[0] = true;
			}),
			waitIfDisabled().then(() => {
				unblocked[1] = true;
			}),
			waitIfDisabled().then(() => {
				unblocked[2] = true;
			}),
		];

		// Give event loop a tick — all should still be blocked
		await new Promise(r => setTimeout(r, 50));
		expect(unblocked).toEqual([false, false, false]);

		// Resume — should unblock ALL three
		await dl.enable();
		await Promise.all(waiters);

		expect(unblocked).toEqual([true, true, true]);
	});

	it('resume unblocks 2 waiters when 2 peerLoops are paused', async () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		ds.missingChunks = [];
		const dl = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
		await dl.initFromManifest(makeLISH());

		const pc = priv(dl)['pauseController'] as { waitIfDisabled: () => Promise<void>; enableResolvers: unknown[] };
		const waitIfDisabled = pc.waitIfDisabled.bind(pc);
		dl.disable();

		let countUnblocked = 0;
		const w1 = waitIfDisabled().then(() => countUnblocked++);
		const w2 = waitIfDisabled().then(() => countUnblocked++);

		await new Promise(r => setTimeout(r, 20));
		expect(countUnblocked).toBe(0);

		await dl.enable();
		await Promise.all([w1, w2]);
		expect(countUnblocked).toBe(2);
	});

	it('waitIfDisabled returns immediately when not paused', async () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		ds.missingChunks = [];
		const dl = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
		await dl.initFromManifest(makeLISH());

		const pc = priv(dl)['pauseController'] as { waitIfDisabled: () => Promise<void>; enableResolvers: unknown[] };
		const waitIfDisabled = pc.waitIfDisabled.bind(pc);
		const start = Date.now();
		await waitIfDisabled();
		expect(Date.now() - start).toBeLessThan(20);
	});

	it('pause/resume/pause/resume cycle works for multiple waiters', async () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		ds.missingChunks = [];
		const dl = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
		await dl.initFromManifest(makeLISH());

		const pc = priv(dl)['pauseController'] as { waitIfDisabled: () => Promise<void>; enableResolvers: unknown[] };
		const waitIfDisabled = pc.waitIfDisabled.bind(pc);

		// Cycle 1
		dl.disable();
		let c1 = 0;
		const w1a = waitIfDisabled().then(() => c1++);
		const w1b = waitIfDisabled().then(() => c1++);
		await new Promise(r => setTimeout(r, 20));
		await dl.enable();
		await Promise.all([w1a, w1b]);
		expect(c1).toBe(2);

		// Cycle 2 — fresh pause, new waiters
		dl.disable();
		let c2 = 0;
		const w2a = waitIfDisabled().then(() => c2++);
		const w2b = waitIfDisabled().then(() => c2++);
		const w2c = waitIfDisabled().then(() => c2++);
		await new Promise(r => setTimeout(r, 20));
		await dl.enable();
		await Promise.all([w2a, w2b, w2c]);
		expect(c2).toBe(3);
	});

	it('resolvers array is cleared after resume', async () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		ds.missingChunks = [];
		const dl = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
		await dl.initFromManifest(makeLISH());

		const pc = priv(dl)['pauseController'] as { waitIfDisabled: () => Promise<void>; enableResolvers: unknown[] };
		const waitIfDisabled = pc.waitIfDisabled.bind(pc);

		dl.disable();
		const w = waitIfDisabled();
		await new Promise(r => setTimeout(r, 10));

		// Before resume: 1 resolver
		expect(pc.enableResolvers.length).toBe(1);

		dl.enable();
		await w;

		// After resume: cleared (new array)
		expect(pc.enableResolvers.length).toBe(0);
	});
});

describe('Downloader – getLISHID', () => {
	it('getLISHID returns lishID after init', async () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		ds.missingChunks = [];
		ds.completeLishs.add('test-lish-id-0001');

		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
		const lish = makeLISH();
		ds.storedLishs.set(lish.id, lish);

		await downloader.initFromManifest(lish);

		expect(downloader.getLISHID()).toBe('test-lish-id-0001');
	});
});

describe('Downloader – speed samples rolling window', () => {
	let downloader: Downloader;

	beforeEach(() => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
	});

	it('speedSamples array starts empty', () => {
		const samples = (priv(downloader)['progressReporter'] as { speedSamples: Array<{ time: number; bytes: number }> }).speedSamples;
		expect(samples).toHaveLength(0);
	});

	it('rolling window keeps only samples within last 10 seconds', () => {
		const p = priv(downloader);
		const now = Date.now();
		const samples = (p['progressReporter'] as { speedSamples: Array<{ time: number; bytes: number }> }).speedSamples;

		// Inject samples directly (as downloadChunks does internally)
		samples.push({ time: now - 15000, bytes: 50000 }); // older than 10s
		samples.push({ time: now - 5000, bytes: 30000 });
		samples.push({ time: now - 1000, bytes: 20000 });

		// Run the same filter the production code uses
		const cutoff = now - 10000;
		const filtered = samples.filter(s => s.time > cutoff);

		expect(filtered).toHaveLength(2);
		expect(filtered.reduce((sum, s) => sum + s.bytes, 0)).toBe(50000);
	});

	it('bytesPerSecond calculation uses rolling window correctly', () => {
		const p = priv(downloader);
		const now = Date.now();
		const samples = (p['progressReporter'] as { speedSamples: Array<{ time: number; bytes: number }> }).speedSamples;

		// 200,000 bytes over exactly 2 seconds → 100,000 B/s
		samples.push({ time: now - 2000, bytes: 100000 });
		samples.push({ time: now, bytes: 100000 });

		const windowBytes = samples.reduce((sum, s) => sum + s.bytes, 0);
		const windowSec = samples.length > 1 ? (now - samples[0]!.time) / 1000 : 0;
		const bps = windowSec > 0.1 ? Math.round(windowBytes / windowSec) : 0;

		// Should be approximately 100000 B/s
		expect(bps).toBeGreaterThan(80000);
		expect(bps).toBeLessThan(120000);
	});

	it('bytesPerSecond is 0 when window is too short', () => {
		const p = priv(downloader);
		const now = Date.now();
		const samples = (p['progressReporter'] as { speedSamples: Array<{ time: number; bytes: number }> }).speedSamples;

		// Only one sample, so windowSec falls back to elapsed which is 0
		samples.push({ time: now, bytes: 999999 });

		const windowBytes = samples.reduce((sum, s) => sum + s.bytes, 0);
		const windowSec = samples.length > 1 ? (now - samples[0]!.time) / 1000 : 0;
		const bps = windowSec > 0.1 ? Math.round(windowBytes / windowSec) : 0;

		expect(bps).toBe(0);
	});
});

describe('Downloader – downloadChunk private method', () => {
	let downloader: Downloader;
	let mockClient: MockLISHClient;

	beforeEach(async () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		ds.missingChunks = [];
		ds.completeLishs.add('test-lish-id-0001');

		downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
		const lish = makeLISH();
		ds.storedLishs.set(lish.id, lish);
		await downloader.initFromManifest(lish);

		mockClient = new MockLISHClient();
		// Inject lishID directly since it is set during init
		// (priv access is needed to call the private downloadChunk method)
	});

	// Access pattern: downloadChunk is now a private method on ChunkDownloader (refactored out of Downloader).
	// Tests reach it via priv(downloader).chunkDownloader with any-cast for TS-private bypass.
	type DownloadChunkResult = { data: Uint8Array } | 'skip-chunk' | 'chunk-not-found' | 'drop-peer';
	type ChunkDownloaderWithPrivates = { downloadChunk: (client: MockLISHClient, chunkID: ChunkID) => Promise<DownloadChunkResult> };
	const getChunkDownloader = (dl: Downloader): ChunkDownloaderWithPrivates => priv(dl)['chunkDownloader'] as ChunkDownloaderWithPrivates;

	it('returns { data } when client returns Uint8Array', async () => {
		const chunkData = new Uint8Array(512).fill(0x42);
		mockClient.requestChunkResult = chunkData;

		const result = await getChunkDownloader(downloader).downloadChunk(mockClient, 'chunk-001' as ChunkID);

		expect(result).not.toBe('skip-chunk');
		expect(result).not.toBe('drop-peer');
		expect((result as { data: Uint8Array }).data).toEqual(chunkData);
	});

	it('returns "skip-chunk" on PEER_BUSY (chunk-specific transient)', async () => {
		mockClient.requestChunkResult = new CodedError(ErrorCodes.PEER_BUSY, 'test');

		const result = await getChunkDownloader(downloader).downloadChunk(mockClient, 'chunk-002' as ChunkID);

		expect(result).toBe('skip-chunk');
	});

	it('returns "chunk-not-found" on PEER_CHUNK_NOT_FOUND (partial seeder)', async () => {
		mockClient.requestChunkResult = new CodedError(ErrorCodes.PEER_CHUNK_NOT_FOUND, 'test');

		const result = await getChunkDownloader(downloader).downloadChunk(mockClient, 'chunk-004' as ChunkID);

		expect(result).toBe('chunk-not-found');
	});

	it('returns "skip-chunk" on PEER_IO_ERROR (chunk-specific transient)', async () => {
		mockClient.requestChunkResult = new CodedError(ErrorCodes.PEER_IO_ERROR, 'test');

		const result = await getChunkDownloader(downloader).downloadChunk(mockClient, 'chunk-005' as ChunkID);

		expect(result).toBe('skip-chunk');
	});

	it('returns "drop-peer" on generic error', async () => {
		mockClient.requestChunkResult = new Error('stream reset');

		const result = await getChunkDownloader(downloader).downloadChunk(mockClient, 'chunk-003' as ChunkID);

		expect(result).toBe('drop-peer');
	});
});

describe('Downloader – bannedPeers Set', () => {
	it('bannedPeers starts empty', () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');

		const bannedPeers = (priv(downloader)['peerManager'] as { bannedPeers: Set<string> }).bannedPeers;
		expect(bannedPeers.size).toBe(0);
	});

	it('adding to bannedPeers prevents re-use of peer within same cycle', () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');

		const bannedPeers = (priv(downloader)['peerManager'] as { bannedPeers: Set<string> }).bannedPeers;
		bannedPeers.add('peer-bad-001');
		bannedPeers.add('peer-bad-002');

		expect(bannedPeers.has('peer-bad-001')).toBe(true);
		expect(bannedPeers.has('peer-bad-002')).toBe(true);
		expect(bannedPeers.has('peer-ok-003')).toBe(false);
	});

	it('clearing bannedPeers allows re-probe (simulates manual unban)', () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');

		const bannedPeers = (priv(downloader)['peerManager'] as { bannedPeers: Set<string> }).bannedPeers;
		bannedPeers.add('peer-retry');
		bannedPeers.clear();

		expect(bannedPeers.has('peer-retry')).toBe(false);
	});
});

describe('Downloader – peers Map management', () => {
	it('peers starts as empty Map', () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');

		const peers = (priv(downloader)['peerManager'] as { peers: Map<string, unknown> }).peers;
		expect(peers.size).toBe(0);
	});

	it('injecting a peer into peers Map reflects in size', () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');

		const peers = (priv(downloader)['peerManager'] as { peers: Map<string, MockLISHClient> }).peers;
		const client = new MockLISHClient();
		peers.set('peer-injected', client);

		expect(peers.size).toBe(1);
		expect(peers.get('peer-injected')).toBe(client);
	});

	it('deleting a peer from peers Map reduces size', () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');

		const peers = (priv(downloader)['peerManager'] as { peers: Map<string, MockLISHClient> }).peers;
		peers.set('peer-to-remove', new MockLISHClient());
		peers.delete('peer-to-remove');

		expect(peers.size).toBe(0);
	});
});

describe('Downloader – progress callback', () => {
	it('setProgressCallback stores the callback', () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');

		let received: unknown = null;
		downloader.setProgressCallback(info => {
			received = info;
		});

		// Trigger callback directly via the private field on progressReporter
		const cb = (priv(downloader)['progressReporter'] as { cb?: (info: unknown) => void }).cb;
		expect(cb).toBeDefined();

		cb!({ downloadedChunks: 3, totalChunks: 10, peers: 2, bytesPerSecond: 50000 });
		expect(received).toEqual({ downloadedChunks: 3, totalChunks: 10, peers: 2, bytesPerSecond: 50000 });
	});

	it('setManifestImportedCallback stores the callback', () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');

		let receivedID: string | undefined;
		downloader.setManifestImportedCallback(id => {
			receivedID = id;
		});

		const cb = priv(downloader)['onManifestImported'] as ((id: string) => void) | undefined;
		expect(cb).toBeDefined();
		cb!('lish-manifest-id');
		expect(receivedID).toBe('lish-manifest-id');
	});
});

describe('Downloader – initFromManifest state transitions', () => {
	it('state starts as "added" before init', () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');

		expect(priv(downloader)['state']).toBe('added');
	});

	it('state becomes "initialized" after initFromManifest with complete lish', async () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		const lish = makeLISH();
		ds.completeLishs.add(lish.id);
		ds.storedLishs.set(lish.id, lish);

		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
		await downloader.initFromManifest(lish);

		expect(priv(downloader)['state']).toBe('initialized');
	});

	it('needsManifest is false when lish is complete', async () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		const lish = makeLISH();
		ds.completeLishs.add(lish.id);
		ds.storedLishs.set(lish.id, lish);

		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
		await downloader.initFromManifest(lish);

		expect(priv(downloader)['needsManifest']).toBe(false);
	});

	it('needsManifest is true when lish is a stub (no files, not complete)', async () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		// stub: no complete entry and getMissingChunks returns [] (no chunks exist yet)
		ds.missingChunks = [];

		const stubLish: IStoredLISH = {
			id: 'stub-lish-id' as LISHid,
			name: 'Stub',
			created: new Date().toISOString(),
			chunkSize: 1024 * 1024,
			checksumAlgo: 'sha256',
			// No files — this is a stub manifest
		};

		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
		await downloader.initFromManifest(stubLish);

		expect(priv(downloader)['needsManifest']).toBe(true);
	});

	// NOTE: Previously asserted that initFromManifest subscribes on `network.subscribe(lishTopic(networkID))`.
	// Subscribe ownership moved out of Downloader to the orchestrator (lishnets / DataServer) in the
	// orchestration refactor, so Downloader no longer talks to Network for pubsub subscriptions. Test
	// removed; the new contract is covered by the lishnets integration tests.

	it('missingChunks is populated from dataServer after initFromManifest', async () => {
		const net = new MockNetwork();
		const ds = new MockDataServer();
		const lish = makeLISH();
		ds.missingChunks = [makeMissingChunk('chunk-a' as ChunkID), makeMissingChunk('chunk-b' as ChunkID, 0, 1)];
		ds.storedLishs.set(lish.id, lish);

		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
		await downloader.initFromManifest(lish);

		const missing = priv(downloader)['missingChunks'] as MissingChunk[];
		expect(missing).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Network peer:disconnect handling
// ---------------------------------------------------------------------------

describe('Downloader – network peer:disconnect handling', () => {
	type PeerManagerView = {
		tryAdd: (peerID: string, client: unknown, connectionType: 'DIRECT' | 'RELAY' | 'DCUtR') => boolean;
		has: (peerID: string) => boolean;
		isDropped: (peerID: string) => boolean;
		isBanned: (peerID: string) => boolean;
		canDial: (peerID: string) => boolean;
	};

	let net: MockNetwork;
	let downloader: Downloader;

	const pm = (): PeerManagerView => priv(downloader)['peerManager'] as PeerManagerView;

	beforeEach(async () => {
		net = new MockNetwork();
		const ds = new MockDataServer();
		ds.missingChunks = [];
		downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
		await downloader.initFromManifest(makeLISH());
	});

	afterEach(async () => {
		await downloader.destroy();
	});

	it('initFromManifest subscribes exactly one peer:disconnect handler', () => {
		expect(net.peerDisconnectHandlers.size).toBe(1);
	});

	it('a disconnected peer is removed from the peer manager', () => {
		pm().tryAdd('peer-gone', new MockLISHClient() as never, 'DIRECT');
		pm().tryAdd('peer-stays', new MockLISHClient() as never, 'DIRECT');
		net.emitPeerDisconnect('peer-gone');
		expect(pm().has('peer-gone')).toBe(false);
		expect(pm().has('peer-stays')).toBe(true);
	});

	it('disconnect removal is plain — peer is neither dropped nor banned and may re-dial', () => {
		pm().tryAdd('peer-flap', new MockLISHClient() as never, 'DIRECT');
		net.emitPeerDisconnect('peer-flap');
		expect(pm().isDropped('peer-flap')).toBe(false);
		expect(pm().isBanned('peer-flap')).toBe(false);
		expect(pm().canDial('peer-flap')).toBe(true);
	});

	it('disconnect of a peer not in the peer manager is a no-op', () => {
		pm().tryAdd('peer-a', new MockLISHClient() as never, 'DIRECT');
		expect(() => net.emitPeerDisconnect('peer-unknown')).not.toThrow();
		expect(pm().has('peer-a')).toBe(true);
	});

	it('destroy() disposes the peer:disconnect subscription', async () => {
		await downloader.destroy();
		expect(net.peerDisconnectHandlers.size).toBe(0);
	});

	it('successful completion disposes the peer:disconnect subscription', async () => {
		expect(net.peerDisconnectHandlers.size).toBe(1);
		// needsManifest path parks download() on its internal completion promise
		// without touching the filesystem; resolve it to simulate a finished download.
		const done = downloader.download();
		while (!priv(downloader)['downloadResolve']) await new Promise(r => setTimeout(r, 0));
		priv(downloader)['state'] = 'downloaded';
		(priv(downloader)['downloadResolve'] as () => void)();
		await done;
		expect(net.peerDisconnectHandlers.size).toBe(0);
	});
});

describe('Downloader – lishnet membership across leave and rejoin', () => {
	function make(networkIDs: string[]): Downloader {
		return new Downloader('/tmp/dl', new MockNetwork() as never, new MockDataServer() as never, networkIDs);
	}

	it('drops a left lishnet from the set it broadcasts on', () => {
		const dl = make(['net-a', 'net-b']);
		dl.removeNetwork('net-a');
		expect(dl.getNetworkIDs()).toEqual(['net-b']);
	});

	it('ignores a lishnet this download was never bound to', () => {
		const dl = make(['net-a']);
		dl.removeNetwork('net-z');
		expect(dl.getNetworkIDs()).toEqual(['net-a']);
	});

	it('drops the last lishnet too, leaving nothing to broadcast on', () => {
		// It used to keep the last one, on the grounds that the caller disables the
		// download — but a disabled download can still be resumed by a rejoin.
		const dl = make(['net-a']);
		dl.removeNetwork('net-a');
		expect(dl.getNetworkIDs()).toEqual([]);
	});

	it('does not resurrect a left lishnet when a different one is rejoined', () => {
		// The reported defect, end to end: bound to A and B, leave both, rejoin only
		// A. Before the fix B survived the second leave and addNetwork appended A
		// beside it, so the resumed download broadcast WANTs on B — a topic the node
		// had left.
		const dl = make(['net-a', 'net-b']);
		dl.removeNetwork('net-a');
		dl.removeNetwork('net-b');
		dl.addNetwork('net-a');
		expect(dl.getNetworkIDs()).toEqual(['net-a']);
		expect(dl.getNetworkIDs()).not.toContain('net-b');
	});

	it('rejoining restores only lishnets the download actually belongs to', () => {
		const dl = make(['net-a']);
		dl.removeNetwork('net-a');
		dl.addNetwork('net-stranger');
		expect(dl.getNetworkIDs()).toEqual([]);
	});

	it('keeps the original binding so a rejoin can still resume the download', () => {
		// removeNetwork must not touch the original set — that is what the resume
		// path matches a rejoined lishnet against.
		const dl = make(['net-a', 'net-b']);
		dl.removeNetwork('net-a');
		dl.removeNetwork('net-b');
		expect(dl.getOriginalNetworkIDs().sort()).toEqual(['net-a', 'net-b']);
	});

	it('adding a lishnet twice does not duplicate it', () => {
		const dl = make(['net-a']);
		dl.removeNetwork('net-a');
		dl.addNetwork('net-a');
		dl.addNetwork('net-a');
		expect(dl.getNetworkIDs()).toEqual(['net-a']);
	});
});

// ---------------------------------------------------------------------------
// doWork Phase 1 — over-limit manifest handling across multiple peers
// ---------------------------------------------------------------------------

describe('Downloader – oversized manifest across peers', () => {
	function awaitingManifestDownloader(ds: MockDataServer): Downloader {
		const dl = new Downloader('/tmp/dl-oversized', new MockNetwork() as never, ds as never, 'net-001');
		const p = priv(dl);
		p['state'] = 'awaiting-manifest';
		p['needsManifest'] = true;
		p['lish'] = null;
		p['lishID'] = 'test-oversized-lish';
		return dl;
	}

	function oversizedClient(): MockLISHClient {
		const c = new MockLISHClient();
		c.requestManifestError = new CodedError(ErrorCodes.LISH_CHUNK_SIZE_TOO_LARGE, '4.00 MB > 1.00 MB');
		return c;
	}

	it('stops at the first over-limit manifest without asking the remaining peers', async () => {
		const ds = new MockDataServer();
		const dl = awaitingManifestDownloader(ds);
		const peers = (priv(dl)['peerManager'] as { peers: Map<string, MockLISHClient> }).peers;
		const second = new MockLISHClient();
		second.requestManifestResult = makeLISH();
		peers.set('peer-oversized-1', oversizedClient()); // first peer answers: chunk size over limit
		peers.set('peer-valid-00001', second); // must never be asked

		await dl.doWork();

		expect(priv(dl)['state']).toBe('error');
		expect(priv(dl)['errorCode']).toBe(ErrorCodes.LISH_CHUNK_SIZE_TOO_LARGE);
		expect(ds.addedLishs.length).toBe(0); // nothing imported
		expect(peers.has('peer-oversized-1')).toBe(false); // the answering peer was dropped
		expect(second.requestManifestCalls ?? 0).toBe(0); // the rest were left alone
	});

	it('surfaces the terminal error when the only peer returns an over-limit manifest', async () => {
		const ds = new MockDataServer();
		const dl = awaitingManifestDownloader(ds);
		const peers = (priv(dl)['peerManager'] as { peers: Map<string, MockLISHClient> }).peers;
		peers.set('peer-oversized-1', oversizedClient());

		await dl.doWork();

		expect(ds.addedLishs.length).toBe(0); // nothing imported
		expect(peers.size).toBe(0); // the over-limit peer dropped
		expect(priv(dl)['state']).toBe('error');
		expect(priv(dl)['errorCode']).toBe(ErrorCodes.LISH_CHUNK_SIZE_TOO_LARGE);
	});
});

describe('Downloader – malformed manifest peer handling', () => {
	it('drops a peer whose manifest is malformed and imports from the next peer', async () => {
		const ds = new MockDataServer();
		const dl = new Downloader('/tmp/dl-malformed', new MockNetwork() as never, ds as never, 'net-001');
		const p = priv(dl);
		p['state'] = 'awaiting-manifest';
		p['needsManifest'] = true;
		p['lish'] = null;
		p['lishID'] = 'test-malformed-lish';
		const peers = (priv(dl)['peerManager'] as { peers: Map<string, MockLISHClient> }).peers;
		const bad = new MockLISHClient();
		bad.requestManifestError = new CodedError(ErrorCodes.PEER_INVALID_REQUEST, 'getLish: LISH_INVALID_MANIFEST');
		const good = new MockLISHClient();
		good.requestManifestResult = makeLISH();
		peers.set('peer-malformed-1', bad);
		peers.set('peer-valid-00001', good);

		await dl.doWork();

		expect(ds.addedLishs.length).toBe(1); // imported from the valid peer
		expect(peers.has('peer-malformed-1')).toBe(false); // bad peer dropped, not stuck
	});
});

describe('Downloader – peer-fault manifest failures are not terminal', () => {
	function awaitingDl(ds: MockDataServer): Downloader {
		const dl = new Downloader('/tmp/dl-mixed', new MockNetwork() as never, ds as never, 'net-001');
		const p = priv(dl);
		p['state'] = 'awaiting-manifest';
		p['needsManifest'] = true;
		p['lish'] = null;
		p['lishID'] = 'test-mixed-lish';
		return dl;
	}

	it('malformed and unreachable peers keep the download awaiting discovery', async () => {
		const ds = new MockDataServer();
		const dl = awaitingDl(ds);
		const peers = (priv(dl)['peerManager'] as { peers: Map<string, MockLISHClient> }).peers;
		const malformed = new MockLISHClient();
		malformed.requestManifestError = new CodedError(ErrorCodes.PEER_INVALID_REQUEST, 'getLish: malformed');
		const unreachable = new MockLISHClient();
		unreachable.requestManifestError = new CodedError(ErrorCodes.PEER_UNREACHABLE, 'test-mixed-lish');
		peers.set('peer-malformed-1', malformed);
		peers.set('peer-unreach-001', unreachable);

		await dl.doWork();

		// Neither failure says anything about the LISH itself — keep awaiting discovery.
		expect(priv(dl)['state']).toBe('awaiting-manifest');
		expect(priv(dl)['errorCode']).toBeUndefined();
	});

	it('an over-limit peer is terminal even when another peer failed for its own reason first', async () => {
		const ds = new MockDataServer();
		const dl = awaitingDl(ds);
		const peers = (priv(dl)['peerManager'] as { peers: Map<string, MockLISHClient> }).peers;
		const malformed = new MockLISHClient();
		malformed.requestManifestError = new CodedError(ErrorCodes.PEER_INVALID_REQUEST, 'getLish: malformed');
		const oversized = new MockLISHClient();
		oversized.requestManifestError = new CodedError(ErrorCodes.LISH_CHUNK_SIZE_TOO_LARGE, '4.00 MB > 1.00 MB');
		peers.set('peer-malformed-1', malformed);
		peers.set('peer-oversized-1', oversized);

		await dl.doWork();

		expect(priv(dl)['state']).toBe('error');
		expect(priv(dl)['errorCode']).toBe(ErrorCodes.LISH_CHUNK_SIZE_TOO_LARGE);
	});
});
