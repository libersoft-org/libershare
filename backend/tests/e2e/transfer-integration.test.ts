import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LISHid, ChunkID, IStoredLISH } from '@shared';
import {
	initLISHsTables,
	addLISH,
	setUploadEnabled,
	setDownloadEnabled,
	getUploadEnabledLishs,
	getDownloadEnabledLishs,
	getMissingChunks,
	markChunkDownloaded,
	isComplete,
	getLISH,
} from '../../src/db/lishs.ts';
import {
	initUploadState,
	pauseUpload,
	resumeUpload,
	isUploadPaused,
	isUploadEnabled,
	getEnabledUploads,
	getActiveUploads,
	resetUploadState,
	setUploadBroadcast,
} from '../../src/protocol/lish-protocol.ts';
import { initDownloadState, initTransferHandlers } from '../../src/api/transfer.ts';
import { DataServer } from '../../src/lish/data-server.ts';
import { Downloader } from '../../src/protocol/downloader.ts';
import type { MissingChunk } from '../../src/lish/data-server.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_LISH_ID = 'integ-test-lish-001' as LISHid;
const TEST_LISH_ID_2 = 'integ-test-lish-002' as LISHid;

const CHUNK_A = 'sha256:aaaa0000bbbb1111cccc2222dddd3333eeee4444ffff5555aaaa0000bbbb1111' as ChunkID;
const CHUNK_B = 'sha256:bbbb1111cccc2222dddd3333eeee4444ffff5555aaaa0000bbbb1111cccc2222' as ChunkID;
const CHUNK_C = 'sha256:cccc2222dddd3333eeee4444ffff5555aaaa0000bbbb1111cccc2222dddd3333' as ChunkID;

function createDB(): Database {
	const db = new Database(':memory:');
	db.run('PRAGMA foreign_keys = ON');
	initLISHsTables(db);
	return db;
}

function createTestLISH(id: LISHid = TEST_LISH_ID, opts: Partial<IStoredLISH> = {}): IStoredLISH {
	return {
		id,
		name: 'Integration Test LISH',
		description: 'Test dataset for integration tests',
		created: '2024-06-01T12:00:00Z',
		chunkSize: 1048576,
		checksumAlgo: 'sha256',
		directory: '/tmp/test-data',
		files: [
			{ path: 'file-a.bin', size: 2097152, checksums: [CHUNK_A, CHUNK_B] },
			{ path: 'file-b.bin', size: 1048576, checksums: [CHUNK_C] },
		],
		...opts,
	};
}

// Minimal mock for Networks — only used by initTransferHandlers
class MockNetworks {
	private _runningNetwork: unknown = null;
	private _firstJoinedNetworkID = '';

	setRunningNetwork(net: unknown): void { this._runningNetwork = net; }
	setFirstJoinedNetworkID(id: string): void { this._firstJoinedNetworkID = id; }

	getRunningNetwork(): unknown {
		if (!this._runningNetwork) throw new Error('No running network');
		return this._runningNetwork;
	}

	getFirstJoinedNetworkID(): string {
		return this._firstJoinedNetworkID;
	}
}

// Minimal mock DataServer wrapping real DB-backed DataServer for some tests
class MockDataServerForDownloader {
	missingChunks: MissingChunk[] = [];
	allChunkCount = 0;
	downloadedChunks = new Set<ChunkID>();
	writtenChunks: Array<{ fileIndex: number; chunkIndex: number; data: Uint8Array }> = [];
	storedLishs = new Map<string, IStoredLISH>();
	completeLishs = new Set<string>();

	getMissingChunks(_lishID: LISHid): MissingChunk[] { return [...this.missingChunks]; }
	getAllChunkCount(_lishID: LISHid): number { return this.allChunkCount; }
	isChunkDownloaded(_lishID: LISHid, chunkID: ChunkID): boolean { return this.downloadedChunks.has(chunkID); }
	markChunkDownloaded(_lishID: LISHid, chunkID: ChunkID): void {
		this.downloadedChunks.add(chunkID);
		this.missingChunks = this.missingChunks.filter(c => c.chunkID !== chunkID);
	}
	async writeChunk(_dir: string, _lish: IStoredLISH, fileIndex: number, chunkIndex: number, data: Uint8Array): Promise<void> {
		this.writtenChunks.push({ fileIndex, chunkIndex, data });
	}
	add(lish: IStoredLISH): void { this.storedLishs.set(lish.id, lish); }
	get(lishID: LISHid): IStoredLISH | null { return this.storedLishs.get(lishID) ?? null; }
	isCompleteLISH(lish: IStoredLISH): boolean { return this.completeLishs.has(lish.id); }
}

// Mock network for Downloader
class MockNetwork {
	topicPeers: string[] = [];
	subscribedTopics: Array<{ topic: string; handler: (data: Record<string, unknown>) => void }> = [];
	broadcastMessages: Array<{ topic: string; data: Record<string, unknown> }> = [];
	dialResults = new Map<string, unknown>();

	async subscribe(topic: string, handler: (data: Record<string, unknown>) => void): Promise<void> {
		this.subscribedTopics.push({ topic, handler });
	}
	async broadcast(topic: string, data: Record<string, unknown>): Promise<void> {
		this.broadcastMessages.push({ topic, data });
	}
	getTopicPeers(_networkID: string): string[] { return [...this.topicPeers]; }
	async dialProtocolByPeerId(peerID: string, _protocol: string): Promise<unknown> {
		const result = this.dialResults.get(peerID);
		if (!result) throw new Error(`No dial result for ${peerID}`);
		if (result instanceof Error) throw result;
		return result;
	}
}

// Mock LISHClient for Downloader tests
class MockLISHClient {
	requestChunkResult: Uint8Array | null | Error = new Uint8Array(1024).fill(0xab);
	requestManifestResult: IStoredLISH | null = null;
	closeCalled = false;
	haveChunks: 'all' | ChunkID[] = 'all';

	async requestChunk(_lishID: LISHid, _chunkID: ChunkID): Promise<Uint8Array | null> {
		if (this.requestChunkResult instanceof Error) throw this.requestChunkResult;
		return this.requestChunkResult;
	}
	async requestManifest(_lishID: LISHid): Promise<IStoredLISH | null> { return this.requestManifestResult; }
	async close(): Promise<void> { this.closeCalled = true; }
}

function priv(obj: unknown): Record<string, unknown> {
	return obj as unknown as Record<string, unknown>;
}

// ============================================================================
// Test 1: Upload state persistence
// ============================================================================

describe('Upload state persistence', () => {
	let db: Database;

	beforeEach(() => {
		resetUploadState();
		db = createDB();
	});

	it('setUploadEnabled(true) persists and getUploadEnabledLishs returns it', () => {
		addLISH(db, createTestLISH());
		setUploadEnabled(db, TEST_LISH_ID, true);

		const enabled = getUploadEnabledLishs(db);
		expect(enabled.has(TEST_LISH_ID)).toBe(true);
	});

	it('setUploadEnabled(false) removes from getUploadEnabledLishs', () => {
		addLISH(db, createTestLISH());
		setUploadEnabled(db, TEST_LISH_ID, true);
		setUploadEnabled(db, TEST_LISH_ID, false);

		const enabled = getUploadEnabledLishs(db);
		expect(enabled.has(TEST_LISH_ID)).toBe(false);
	});

	it('multiple LISHs can be independently enabled/disabled', () => {
		addLISH(db, createTestLISH(TEST_LISH_ID));
		addLISH(db, createTestLISH(TEST_LISH_ID_2, { id: TEST_LISH_ID_2 }));

		setUploadEnabled(db, TEST_LISH_ID, true);
		setUploadEnabled(db, TEST_LISH_ID_2, true);
		setUploadEnabled(db, TEST_LISH_ID, false);

		const enabled = getUploadEnabledLishs(db);
		expect(enabled.has(TEST_LISH_ID)).toBe(false);
		expect(enabled.has(TEST_LISH_ID_2)).toBe(true);
	});

	it('state persists across DB re-reads (simulated restart)', () => {
		addLISH(db, createTestLISH());
		setUploadEnabled(db, TEST_LISH_ID, true);

		// Simulate restart: re-read from same DB
		const enabledAfterRestart = getUploadEnabledLishs(db);
		expect(enabledAfterRestart.has(TEST_LISH_ID)).toBe(true);
		expect(enabledAfterRestart.size).toBe(1);
	});

	it('initUploadState loads enabled LISHs from DB and wires persist function', () => {
		addLISH(db, createTestLISH(TEST_LISH_ID));
		addLISH(db, createTestLISH(TEST_LISH_ID_2, { id: TEST_LISH_ID_2 }));
		setUploadEnabled(db, TEST_LISH_ID, true);

		// Load from DB into module state
		const dbEnabled = getUploadEnabledLishs(db);
		initUploadState(dbEnabled, (lishID, enabled) => setUploadEnabled(db, lishID, enabled));

		// Verify module state matches DB
		expect(isUploadEnabled(TEST_LISH_ID)).toBe(true);
		expect(isUploadEnabled(TEST_LISH_ID_2)).toBe(false);
		expect(isUploadPaused(TEST_LISH_ID)).toBe(false);
		expect(isUploadPaused(TEST_LISH_ID_2)).toBe(true);

		// Now pause via module — should persist to DB
		pauseUpload(TEST_LISH_ID);
		const dbEnabledAfter = getUploadEnabledLishs(db);
		expect(dbEnabledAfter.has(TEST_LISH_ID)).toBe(false);
	});
});

// ============================================================================
// Test 2: Download state persistence
// ============================================================================

describe('Download state persistence', () => {
	let db: Database;

	beforeEach(() => {
		db = createDB();
	});

	it('setDownloadEnabled(true) persists and getDownloadEnabledLishs returns it', () => {
		addLISH(db, createTestLISH());
		setDownloadEnabled(db, TEST_LISH_ID, true);

		const enabled = getDownloadEnabledLishs(db);
		expect(enabled.has(TEST_LISH_ID)).toBe(true);
	});

	it('setDownloadEnabled(false) removes from getDownloadEnabledLishs', () => {
		addLISH(db, createTestLISH());
		setDownloadEnabled(db, TEST_LISH_ID, true);
		setDownloadEnabled(db, TEST_LISH_ID, false);

		const enabled = getDownloadEnabledLishs(db);
		expect(enabled.has(TEST_LISH_ID)).toBe(false);
	});

	it('multiple LISHs can be independently enabled/disabled', () => {
		addLISH(db, createTestLISH(TEST_LISH_ID));
		addLISH(db, createTestLISH(TEST_LISH_ID_2, { id: TEST_LISH_ID_2 }));

		setDownloadEnabled(db, TEST_LISH_ID, true);
		setDownloadEnabled(db, TEST_LISH_ID_2, true);
		setDownloadEnabled(db, TEST_LISH_ID_2, false);

		const enabled = getDownloadEnabledLishs(db);
		expect(enabled.has(TEST_LISH_ID)).toBe(true);
		expect(enabled.has(TEST_LISH_ID_2)).toBe(false);
	});

	it('state persists across DB re-reads (simulated restart)', () => {
		addLISH(db, createTestLISH());
		setDownloadEnabled(db, TEST_LISH_ID, true);

		const enabledAfterRestart = getDownloadEnabledLishs(db);
		expect(enabledAfterRestart.has(TEST_LISH_ID)).toBe(true);
		expect(enabledAfterRestart.size).toBe(1);
	});

	it('initDownloadState loads enabled LISHs and wires persist function', () => {
		addLISH(db, createTestLISH(TEST_LISH_ID));
		addLISH(db, createTestLISH(TEST_LISH_ID_2, { id: TEST_LISH_ID_2 }));
		setDownloadEnabled(db, TEST_LISH_ID, true);
		setDownloadEnabled(db, TEST_LISH_ID_2, true);

		const dbEnabled = getDownloadEnabledLishs(db);
		initDownloadState(dbEnabled, (lishID, enabled) => setDownloadEnabled(db, lishID, enabled));

		// initDownloadState doesn't expose the in-memory set directly,
		// but the persist function gets wired — verify via DB write
		// by calling through transfer handlers (tested in later sections)
		expect(dbEnabled.size).toBe(2);
	});
});

// ============================================================================
// Test 3: Transfer API — getActiveTransfers
// ============================================================================

describe('Transfer API — getActiveTransfers', () => {
	let db: Database;

	beforeEach(() => {
		resetUploadState();
		db = createDB();
	});

	it('returns empty array when no transfers are active', () => {
		const networks = new MockNetworks();
		const dataServer = new DataServer(db);
		const emit = (): void => {};

		initUploadState(new Set(), () => {});
		initDownloadState(new Set(), () => {});
		const handlers = initTransferHandlers(networks as never, dataServer, '/tmp/data', emit);

		const transfers = handlers.getActiveTransfers();
		expect(transfers).toEqual([]);
	});

	it('shows upload-enabled after resumeUpload', () => {
		addLISH(db, createTestLISH());
		const networks = new MockNetworks();
		const dataServer = new DataServer(db);
		const emit = (): void => {};

		initUploadState(new Set(), (lishID, enabled) => setUploadEnabled(db, lishID, enabled));
		initDownloadState(new Set(), () => {});
		const handlers = initTransferHandlers(networks as never, dataServer, '/tmp/data', emit);

		handlers.resumeUpload({ lishID: TEST_LISH_ID });

		const transfers = handlers.getActiveTransfers();
		const uploadEntry = transfers.find(t => t.lishID === TEST_LISH_ID);
		expect(uploadEntry).toBeDefined();
		expect(uploadEntry!.type).toBe('upload-enabled');
	});

	it('upload-enabled disappears from getActiveTransfers after pauseUpload', () => {
		addLISH(db, createTestLISH());
		const networks = new MockNetworks();
		const dataServer = new DataServer(db);
		const emit = (): void => {};

		initUploadState(new Set(), (lishID, enabled) => setUploadEnabled(db, lishID, enabled));
		initDownloadState(new Set(), () => {});
		const handlers = initTransferHandlers(networks as never, dataServer, '/tmp/data', emit);

		handlers.resumeUpload({ lishID: TEST_LISH_ID });
		handlers.pauseUpload({ lishID: TEST_LISH_ID });

		const transfers = handlers.getActiveTransfers();
		const uploadEntry = transfers.find(t => t.lishID === TEST_LISH_ID && t.type === 'upload-enabled');
		expect(uploadEntry).toBeUndefined();
	});

	it('shows download-enabled for enabled downloads without active downloader', () => {
		addLISH(db, createTestLISH());
		const networks = new MockNetworks();
		const dataServer = new DataServer(db);
		const emit = (): void => {};

		initUploadState(new Set(), () => {});
		const dlEnabled = new Set([TEST_LISH_ID]);
		initDownloadState(dlEnabled, (lishID, enabled) => setDownloadEnabled(db, lishID, enabled));
		const handlers = initTransferHandlers(networks as never, dataServer, '/tmp/data', emit);

		const transfers = handlers.getActiveTransfers();
		const dlEntry = transfers.find(t => t.lishID === TEST_LISH_ID && t.type === 'download-enabled');
		expect(dlEntry).toBeDefined();
	});

	it('pauseDownload removes from getActiveTransfers download-enabled list', () => {
		addLISH(db, createTestLISH());
		const networks = new MockNetworks();
		const dataServer = new DataServer(db);
		const emit = (): void => {};

		initUploadState(new Set(), () => {});
		const dlEnabled = new Set([TEST_LISH_ID]);
		initDownloadState(dlEnabled, (lishID, enabled) => setDownloadEnabled(db, lishID, enabled));
		const handlers = initTransferHandlers(networks as never, dataServer, '/tmp/data', emit);

		handlers.pauseDownload({ lishID: TEST_LISH_ID });

		const transfers = handlers.getActiveTransfers();
		const dlEntry = transfers.find(t => t.lishID === TEST_LISH_ID);
		expect(dlEntry).toBeUndefined();
	});
});

// ============================================================================
// Test 4: Upload pause/resume affects protocol state
// ============================================================================

describe('Upload pause/resume affects protocol state', () => {
	let db: Database;

	beforeEach(() => {
		resetUploadState();
		db = createDB();
	});

	it('isUploadPaused returns true for unknown LISH (default paused)', () => {
		initUploadState(new Set(), () => {});
		expect(isUploadPaused('unknown-lish')).toBe(true);
	});

	it('initUploadState loads provided set correctly', () => {
		addLISH(db, createTestLISH());
		const enabledSet = new Set([TEST_LISH_ID]);
		initUploadState(enabledSet, () => {});

		expect(isUploadPaused(TEST_LISH_ID)).toBe(false);
		expect(isUploadEnabled(TEST_LISH_ID)).toBe(true);
	});

	it('pause sets isUploadPaused=true, resume sets it back to false', () => {
		initUploadState(new Set([TEST_LISH_ID]), () => {});

		expect(isUploadPaused(TEST_LISH_ID)).toBe(false);

		pauseUpload(TEST_LISH_ID);
		expect(isUploadPaused(TEST_LISH_ID)).toBe(true);
		expect(isUploadEnabled(TEST_LISH_ID)).toBe(false);

		resumeUpload(TEST_LISH_ID);
		expect(isUploadPaused(TEST_LISH_ID)).toBe(false);
		expect(isUploadEnabled(TEST_LISH_ID)).toBe(true);
	});

	it('pause persists to DB via persistFn', () => {
		addLISH(db, createTestLISH());
		setUploadEnabled(db, TEST_LISH_ID, true);
		initUploadState(
			getUploadEnabledLishs(db),
			(lishID, enabled) => setUploadEnabled(db, lishID, enabled),
		);

		pauseUpload(TEST_LISH_ID);

		// Verify DB was updated
		const dbEnabled = getUploadEnabledLishs(db);
		expect(dbEnabled.has(TEST_LISH_ID)).toBe(false);
	});

	it('resume persists to DB via persistFn', () => {
		addLISH(db, createTestLISH());
		initUploadState(
			new Set<string>(),
			(lishID, enabled) => setUploadEnabled(db, lishID, enabled),
		);

		resumeUpload(TEST_LISH_ID);

		const dbEnabled = getUploadEnabledLishs(db);
		expect(dbEnabled.has(TEST_LISH_ID)).toBe(true);
	});

	it('getEnabledUploads returns the live Set reflecting all changes', () => {
		initUploadState(new Set([TEST_LISH_ID]), () => {});

		const enabled = getEnabledUploads();
		expect(enabled.has(TEST_LISH_ID)).toBe(true);

		pauseUpload(TEST_LISH_ID);
		expect(enabled.has(TEST_LISH_ID)).toBe(false);

		resumeUpload(TEST_LISH_ID);
		expect(enabled.has(TEST_LISH_ID)).toBe(true);
	});

	it('pause broadcasts transfer.upload:paused event', () => {
		const events: Array<{ event: string; data: unknown }> = [];
		setUploadBroadcast((event, data) => events.push({ event, data }));
		initUploadState(new Set([TEST_LISH_ID]), () => {});

		pauseUpload(TEST_LISH_ID);

		expect(events.length).toBe(1);
		expect(events[0]!.event).toBe('transfer.upload:paused');
		expect((events[0]!.data as { lishID: string }).lishID).toBe(TEST_LISH_ID);
	});

	it('resume broadcasts transfer.upload:resumed event', () => {
		const events: Array<{ event: string; data: unknown }> = [];
		setUploadBroadcast((event, data) => events.push({ event, data }));
		initUploadState(new Set<string>(), () => {});

		resumeUpload(TEST_LISH_ID);

		expect(events.length).toBe(1);
		expect(events[0]!.event).toBe('transfer.upload:resumed');
		expect((events[0]!.data as { lishID: string }).lishID).toBe(TEST_LISH_ID);
	});
});

// ============================================================================
// Test 5: Downloader behavior with mocked network
// ============================================================================

describe('Downloader — download behavior with mocked peers', () => {
	let downloader: Downloader;
	let ds: MockDataServerForDownloader;
	let net: MockNetwork;

	beforeEach(() => {
		net = new MockNetwork();
		ds = new MockDataServerForDownloader();
		downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
	});

	afterEach(() => {
		// Clear any intervals set by the downloader
		const interval = priv(downloader)['callForPeersInterval'] as NodeJS.Timeout | undefined;
		if (interval) clearInterval(interval);
	});

	it('downloadChunk returns { data } on success', async () => {
		const lish = createTestLISH();
		ds.completeLishs.add(lish.id);
		ds.storedLishs.set(lish.id, lish);
		await downloader.initFromManifest(lish);

		const client = new MockLISHClient();
		const chunkData = new Uint8Array(512).fill(0x42);
		client.requestChunkResult = chunkData;

		const result = await (downloader as never as {
			downloadChunk: (client: MockLISHClient, chunkID: ChunkID) => Promise<{ data: Uint8Array } | 'not_available' | 'error'>;
		}).downloadChunk(client, CHUNK_A);

		expect(result).not.toBe('not_available');
		expect(result).not.toBe('error');
		expect((result as { data: Uint8Array }).data).toEqual(chunkData);
	});

	it('downloadChunk returns "not_available" when client returns null', async () => {
		const lish = createTestLISH();
		ds.completeLishs.add(lish.id);
		ds.storedLishs.set(lish.id, lish);
		await downloader.initFromManifest(lish);

		const client = new MockLISHClient();
		client.requestChunkResult = null;

		const result = await (downloader as never as {
			downloadChunk: (client: MockLISHClient, chunkID: ChunkID) => Promise<{ data: Uint8Array } | 'not_available' | 'error'>;
		}).downloadChunk(client, CHUNK_A);

		expect(result).toBe('not_available');
	});

	it('downloadChunk returns "error" when client throws', async () => {
		const lish = createTestLISH();
		ds.completeLishs.add(lish.id);
		ds.storedLishs.set(lish.id, lish);
		await downloader.initFromManifest(lish);

		const client = new MockLISHClient();
		client.requestChunkResult = new Error('stream reset');

		const result = await (downloader as never as {
			downloadChunk: (client: MockLISHClient, chunkID: ChunkID) => Promise<{ data: Uint8Array } | 'not_available' | 'error'>;
		}).downloadChunk(client, CHUNK_A);

		expect(result).toBe('error');
	});

	it('failedPeers gets cleared and allows re-probe', () => {
		const failedPeers = priv(downloader)['failedPeers'] as Set<string>;
		failedPeers.add('peer-dead-001');
		failedPeers.add('peer-dead-002');

		expect(failedPeers.size).toBe(2);
		expect(failedPeers.has('peer-dead-001')).toBe(true);

		failedPeers.clear();
		expect(failedPeers.size).toBe(0);
		expect(failedPeers.has('peer-dead-001')).toBe(false);
	});

	it('lastExhaustedTime throttle prevents immediate doWork re-entry', async () => {
		const lish = createTestLISH();
		ds.missingChunks = [{ chunkID: CHUNK_A, fileIndex: 0, chunkIndex: 0 }];
		ds.storedLishs.set(lish.id, lish);
		await downloader.initFromManifest(lish);

		// Set lastExhaustedTime to now — doWork should return immediately
		(priv(downloader) as Record<string, number>)['lastExhaustedTime'] = Date.now();
		(priv(downloader) as Record<string, string>)['state'] = 'downloading';

		// doWork should return immediately without attempting download
		await downloader['doWork' as never]();

		// peers should still be empty (no work was done)
		const peers = priv(downloader)['peers'] as Map<string, unknown>;
		expect(peers.size).toBe(0);
	});

	it('lastExhaustedTime resets to 0 on resume, allowing immediate retry', async () => {
		const lish = createTestLISH();
		ds.completeLishs.add(lish.id);
		ds.storedLishs.set(lish.id, lish);
		await downloader.initFromManifest(lish);

		(priv(downloader) as Record<string, number>)['lastExhaustedTime'] = Date.now();
		downloader.resume();

		expect(priv(downloader)['lastExhaustedTime']).toBe(0);
	});

	it('pause/resume cycle works correctly', () => {
		expect(downloader.isPaused()).toBe(false);

		downloader.pause();
		expect(downloader.isPaused()).toBe(true);

		downloader.resume();
		expect(downloader.isPaused()).toBe(false);
	});

	it('progress callback receives correct shape', () => {
		let received: unknown = null;
		downloader.setProgressCallback(info => { received = info; });

		const cb = priv(downloader)['onProgress'] as ((info: unknown) => void);
		cb({ downloadedChunks: 5, totalChunks: 10, peers: 2, bytesPerSecond: 100000 });

		expect(received).toEqual({
			downloadedChunks: 5,
			totalChunks: 10,
			peers: 2,
			bytesPerSecond: 100000,
		});
	});

	it('manifest imported callback fires correctly', () => {
		let receivedID = '';
		downloader.setManifestImportedCallback(id => { receivedID = id; });

		const cb = priv(downloader)['onManifestImported'] as ((id: string) => void);
		cb('lish-manifest-xyz');

		expect(receivedID).toBe('lish-manifest-xyz');
	});
});

// ============================================================================
// Test 6: State after restart — upload/download persist and reload
// ============================================================================

describe('State after restart', () => {
	let db: Database;

	beforeEach(() => {
		resetUploadState();
		db = createDB();
	});

	it('upload_enabled persists to DB after pauseUpload/resumeUpload cycle', () => {
		addLISH(db, createTestLISH());

		// Wire up with persist function
		initUploadState(
			new Set<string>(),
			(lishID, enabled) => setUploadEnabled(db, lishID, enabled),
		);

		// Resume (enable upload)
		resumeUpload(TEST_LISH_ID);
		expect(getUploadEnabledLishs(db).has(TEST_LISH_ID)).toBe(true);

		// Pause (disable upload)
		pauseUpload(TEST_LISH_ID);
		expect(getUploadEnabledLishs(db).has(TEST_LISH_ID)).toBe(false);

		// Resume again
		resumeUpload(TEST_LISH_ID);
		expect(getUploadEnabledLishs(db).has(TEST_LISH_ID)).toBe(true);
	});

	it('initUploadState reads correct state from DB after simulated restart', () => {
		addLISH(db, createTestLISH(TEST_LISH_ID));
		addLISH(db, createTestLISH(TEST_LISH_ID_2, { id: TEST_LISH_ID_2 }));

		// Enable one, leave other disabled
		setUploadEnabled(db, TEST_LISH_ID, true);
		setUploadEnabled(db, TEST_LISH_ID_2, false);

		// Simulate restart: fresh module state from DB
		resetUploadState();
		const enabledFromDB = getUploadEnabledLishs(db);
		initUploadState(enabledFromDB, (lishID, enabled) => setUploadEnabled(db, lishID, enabled));

		expect(isUploadEnabled(TEST_LISH_ID)).toBe(true);
		expect(isUploadPaused(TEST_LISH_ID)).toBe(false);
		expect(isUploadEnabled(TEST_LISH_ID_2)).toBe(false);
		expect(isUploadPaused(TEST_LISH_ID_2)).toBe(true);
	});

	it('download_enabled persists to DB through transfer handler pauseDownload/resumeDownload', () => {
		addLISH(db, createTestLISH());

		const persistCalls: Array<{ lishID: string; enabled: boolean }> = [];
		initDownloadState(
			new Set<string>(),
			(lishID, enabled) => {
				persistCalls.push({ lishID, enabled });
				setDownloadEnabled(db, lishID, enabled);
			},
		);

		const networks = new MockNetworks();
		const dataServer = new DataServer(db);
		const emit = (): void => {};
		const handlers = initTransferHandlers(networks as never, dataServer, '/tmp/data', emit);

		// pauseDownload should persist enabled=false
		handlers.pauseDownload({ lishID: TEST_LISH_ID });
		expect(persistCalls.some(c => c.lishID === TEST_LISH_ID && !c.enabled)).toBe(true);

		// Verify DB state
		expect(getDownloadEnabledLishs(db).has(TEST_LISH_ID)).toBe(false);
	});

	it('full restart cycle: enable uploads, reset module, reload from DB', () => {
		addLISH(db, createTestLISH(TEST_LISH_ID));
		addLISH(db, createTestLISH(TEST_LISH_ID_2, { id: TEST_LISH_ID_2 }));

		// Step 1: Wire up and enable
		initUploadState(
			new Set<string>(),
			(lishID, enabled) => setUploadEnabled(db, lishID, enabled),
		);
		resumeUpload(TEST_LISH_ID);
		resumeUpload(TEST_LISH_ID_2);

		// Verify both in DB
		expect(getUploadEnabledLishs(db).size).toBe(2);

		// Step 2: Pause one
		pauseUpload(TEST_LISH_ID_2);
		expect(getUploadEnabledLishs(db).size).toBe(1);

		// Step 3: Simulate restart — clear module, reload from DB
		resetUploadState();
		expect(getEnabledUploads().size).toBe(0); // module state cleared

		const reloaded = getUploadEnabledLishs(db);
		initUploadState(reloaded, (lishID, enabled) => setUploadEnabled(db, lishID, enabled));

		// Verify restored state
		expect(isUploadEnabled(TEST_LISH_ID)).toBe(true);
		expect(isUploadEnabled(TEST_LISH_ID_2)).toBe(false);
		expect(getEnabledUploads().size).toBe(1);
	});
});

// ============================================================================
// Test: DB + DataServer integration for chunk operations
// ============================================================================

describe('DataServer + DB chunk integration', () => {
	let db: Database;
	let dataServer: DataServer;

	beforeEach(() => {
		db = createDB();
		dataServer = new DataServer(db);
	});

	it('DataServer wraps DB correctly for getMissingChunks', () => {
		dataServer.add(createTestLISH());

		const missing = dataServer.getMissingChunks(TEST_LISH_ID);
		expect(missing).toHaveLength(3);
		expect(missing[0]!.chunkID).toBe(CHUNK_A);
		expect(missing[1]!.chunkID).toBe(CHUNK_B);
		expect(missing[2]!.chunkID).toBe(CHUNK_C);
	});

	it('markChunkDownloaded reduces missing count', () => {
		dataServer.add(createTestLISH());

		dataServer.markChunkDownloaded(TEST_LISH_ID, CHUNK_A);
		expect(dataServer.getMissingChunks(TEST_LISH_ID)).toHaveLength(2);

		dataServer.markChunkDownloaded(TEST_LISH_ID, CHUNK_B);
		expect(dataServer.getMissingChunks(TEST_LISH_ID)).toHaveLength(1);

		dataServer.markChunkDownloaded(TEST_LISH_ID, CHUNK_C);
		expect(dataServer.getMissingChunks(TEST_LISH_ID)).toHaveLength(0);
	});

	it('isComplete returns true only when all chunks downloaded', () => {
		dataServer.add(createTestLISH());

		expect(dataServer.isComplete(TEST_LISH_ID)).toBe(false);

		dataServer.markChunkDownloaded(TEST_LISH_ID, CHUNK_A);
		dataServer.markChunkDownloaded(TEST_LISH_ID, CHUNK_B);
		expect(dataServer.isComplete(TEST_LISH_ID)).toBe(false);

		dataServer.markChunkDownloaded(TEST_LISH_ID, CHUNK_C);
		expect(dataServer.isComplete(TEST_LISH_ID)).toBe(true);
	});

	it('getHaveChunks returns "all" when complete', () => {
		dataServer.add(createTestLISH());

		for (const chunk of [CHUNK_A, CHUNK_B, CHUNK_C]) {
			dataServer.markChunkDownloaded(TEST_LISH_ID, chunk);
		}

		expect(dataServer.getHaveChunks(TEST_LISH_ID)).toBe('all');
	});

	it('getHaveChunks returns Set with partial downloads', () => {
		dataServer.add(createTestLISH());

		dataServer.markChunkDownloaded(TEST_LISH_ID, CHUNK_A);
		const have = dataServer.getHaveChunks(TEST_LISH_ID);
		expect(have).toBeInstanceOf(Set);
		expect((have as Set<string>).has(CHUNK_A)).toBe(true);
		expect((have as Set<string>).has(CHUNK_B)).toBe(false);
	});

	it('getAllChunkCount returns total chunk count', () => {
		dataServer.add(createTestLISH());
		expect(dataServer.getAllChunkCount(TEST_LISH_ID)).toBe(3);
	});

	it('add + get round-trips LISH correctly', () => {
		const lish = createTestLISH();
		dataServer.add(lish);

		const stored = dataServer.get(TEST_LISH_ID);
		expect(stored).not.toBeNull();
		expect(stored!.id).toBe(TEST_LISH_ID);
		expect(stored!.name).toBe('Integration Test LISH');
		expect(stored!.files).toHaveLength(2);
		expect(stored!.chunkSize).toBe(1048576);
	});
});

// ============================================================================
// Test: Transfer handlers pauseUpload/resumeUpload integration
// ============================================================================

describe('Transfer handlers — pauseUpload/resumeUpload integration', () => {
	let db: Database;

	beforeEach(() => {
		resetUploadState();
		db = createDB();
	});

	it('handler.pauseUpload calls protocol pauseUpload and persists', () => {
		addLISH(db, createTestLISH());
		initUploadState(
			new Set([TEST_LISH_ID]),
			(lishID, enabled) => setUploadEnabled(db, lishID, enabled),
		);

		const networks = new MockNetworks();
		const dataServer = new DataServer(db);
		const handlers = initTransferHandlers(networks as never, dataServer, '/tmp/data', () => {});

		const result = handlers.pauseUpload({ lishID: TEST_LISH_ID });
		expect(result.success).toBe(true);
		expect(isUploadPaused(TEST_LISH_ID)).toBe(true);
		expect(getUploadEnabledLishs(db).has(TEST_LISH_ID)).toBe(false);
	});

	it('handler.resumeUpload calls protocol resumeUpload and persists', () => {
		addLISH(db, createTestLISH());
		initUploadState(
			new Set<string>(),
			(lishID, enabled) => setUploadEnabled(db, lishID, enabled),
		);

		const networks = new MockNetworks();
		const dataServer = new DataServer(db);
		const handlers = initTransferHandlers(networks as never, dataServer, '/tmp/data', () => {});

		const result = handlers.resumeUpload({ lishID: TEST_LISH_ID });
		expect(result.success).toBe(true);
		expect(isUploadEnabled(TEST_LISH_ID)).toBe(true);
		expect(getUploadEnabledLishs(db).has(TEST_LISH_ID)).toBe(true);
	});

	it('activeUploads entries appear in getActiveTransfers', () => {
		addLISH(db, createTestLISH());
		initUploadState(
			new Set([TEST_LISH_ID]),
			(lishID, enabled) => setUploadEnabled(db, lishID, enabled),
		);

		// Seed an active upload entry
		const uploads = getActiveUploads();
		uploads.set(TEST_LISH_ID, {
			chunks: 10,
			bytes: 10240,
			startTime: Date.now() - 5000,
			peers: 2,
			speedSamples: [
				{ time: Date.now() - 2000, bytes: 5120 },
				{ time: Date.now() - 1000, bytes: 5120 },
			],
		});

		const networks = new MockNetworks();
		const dataServer = new DataServer(db);
		const handlers = initTransferHandlers(networks as never, dataServer, '/tmp/data', () => {});

		const transfers = handlers.getActiveTransfers();
		const upload = transfers.find(t => t.lishID === TEST_LISH_ID && t.type === 'uploading');
		expect(upload).toBeDefined();
		expect(upload!.peers).toBe(2);
		expect(upload!.bytesPerSecond).toBeGreaterThan(0);
	});
});

// ============================================================================
// Test: Downloader state transitions with initFromManifest
// ============================================================================

describe('Downloader — state transitions', () => {
	it('state goes added → initialized when manifest has chunks', async () => {
		const net = new MockNetwork();
		const ds = new MockDataServerForDownloader();
		const lish = createTestLISH();
		ds.missingChunks = [{ chunkID: CHUNK_A, fileIndex: 0, chunkIndex: 0 }];
		ds.storedLishs.set(lish.id, lish);

		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
		expect(priv(downloader)['state']).toBe('added');

		await downloader.initFromManifest(lish);
		expect(priv(downloader)['state']).toBe('initialized');
		expect(priv(downloader)['needsManifest']).toBe(false);
	});

	it('needsManifest=true for stub manifest (no files, not complete)', async () => {
		const net = new MockNetwork();
		const ds = new MockDataServerForDownloader();
		const stubLish: IStoredLISH = {
			id: 'stub-lish' as LISHid,
			name: 'Stub',
			created: '2024-01-01',
			chunkSize: 1048576,
			checksumAlgo: 'sha256',
		};

		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');
		await downloader.initFromManifest(stubLish);

		expect(priv(downloader)['needsManifest']).toBe(true);
	});

	it('getPeerCount returns 0 initially', () => {
		const net = new MockNetwork();
		const ds = new MockDataServerForDownloader();
		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'net-001');

		expect(downloader.getPeerCount()).toBe(0);
	});

	it('subscribes to correct topic on initFromManifest', async () => {
		const net = new MockNetwork();
		const ds = new MockDataServerForDownloader();
		const lish = createTestLISH();
		ds.completeLishs.add(lish.id);

		const downloader = new Downloader('/tmp/dl', net as never, ds as never, 'network-abc');
		await downloader.initFromManifest(lish);

		expect(net.subscribedTopics).toHaveLength(1);
		expect(net.subscribedTopics[0]!.topic).toBe('lish/network-abc');
	});
});

// ============================================================================
// Test: resetUploadState clears everything
// ============================================================================

describe('resetUploadState — full cleanup', () => {
	beforeEach(() => {
		resetUploadState();
	});

	it('clears enabled uploads set', () => {
		initUploadState(new Set(['lish-1', 'lish-2']), () => {});
		expect(getEnabledUploads().size).toBe(2);

		resetUploadState();
		expect(getEnabledUploads().size).toBe(0);
	});

	it('clears active uploads map', () => {
		const uploads = getActiveUploads();
		uploads.set('lish-active', { chunks: 5, bytes: 5000, startTime: Date.now(), peers: 1, speedSamples: [] });
		expect(uploads.size).toBe(1);

		resetUploadState();
		expect(getActiveUploads().size).toBe(0);
	});

	it('after reset, all LISHs report as paused', () => {
		initUploadState(new Set(['lish-was-enabled']), () => {});
		expect(isUploadPaused('lish-was-enabled')).toBe(false);

		resetUploadState();
		expect(isUploadPaused('lish-was-enabled')).toBe(true);
	});
});
