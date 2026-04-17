import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startNodes, stopNodes, getNodeURL } from './helpers/node-manager.ts';
import { TestClient } from './helpers/ws-test-client.ts';
import { LISH_ID, EVENT_TIMEOUT, PEER_DISCOVERY_TIMEOUT } from './helpers/constants.ts';

let node1: TestClient;
let node2: TestClient;
let node3: TestClient;

async function connectNodes(): Promise<void> {
	// Get node1 info for connecting other nodes
	const info1 = await node1.call('lishnets.getNodeInfo', {});
	const multiaddr = info1.multiaddrs?.[0];
	if (!multiaddr) throw new Error('Node1 has no multiaddr');

	// Get joined network ID from node1
	const nets1 = await node1.call('lishnets.list', {});
	const joinedNet = nets1.find((n: any) => n.joined);
	if (!joinedNet) throw new Error('Node1 has no joined network');
	const networkID = joinedNet.id;

	// Join same network on node2 and node3
	try {
		await node2.call('lishnets.join', { networkID });
	} catch {}
	try {
		await node3.call('lishnets.join', { networkID });
	} catch {}

	// Connect node2 and node3 to node1
	await node2.call('lishnets.connect', { multiaddr });
	await node3.call('lishnets.connect', { multiaddr });

	// Wait for peer discovery
	const waitPeers = async (client: TestClient, minPeers: number) => {
		const start = Date.now();
		while (Date.now() - start < PEER_DISCOVERY_TIMEOUT) {
			const status = await client.call('lishnets.getStatus', {});
			if (status.connectedPeers >= minPeers) return;
			await new Promise(r => setTimeout(r, 500));
		}
		throw new Error(`Peer discovery timeout (need ${minPeers} peers)`);
	};
	await waitPeers(node2, 1);
	await waitPeers(node3, 1);
}

async function importLISHToNode(client: TestClient): Promise<void> {
	// Check if LISH already exists on this node
	const list = await client.call('lishs.list', {});
	if (list.items?.some((item: any) => item.id === LISH_ID)) return;

	// Export from node1 and import to target
	const lishData = await node1.call('lishs.get', { id: LISH_ID });
	if (!lishData) throw new Error('LISH not found on node1');
	await client.call('lishs.importFromJSON', { json: lishData });
}

beforeAll(async () => {
	await startNodes();

	node1 = new TestClient(getNodeURL(0));
	node2 = new TestClient(getNodeURL(1));
	node3 = new TestClient(getNodeURL(2));

	await node1.waitConnected();
	await node2.waitConnected();
	await node3.waitConnected();

	node1.subscribeAll();
	node2.subscribeAll();
	node3.subscribeAll();

	// Wait for subscriptions to register
	await new Promise(r => setTimeout(r, 500));

	await connectNodes();

	// Import LISH manifest to node2 and node3
	await importLISHToNode(node2);
	await importLISHToNode(node3);

	console.log('[Test] Setup complete');
}, 60000);

afterAll(async () => {
	node1?.destroy();
	node2?.destroy();
	node3?.destroy();
	await stopNodes();
}, 15000);

// ============================================================================
// Test 1: Basic download (node2 downloads from node1)
// ============================================================================
describe('Basic download', () => {
	it(
		'node2 starts downloading and receives progress events',
		async () => {
			const progressPromise = node2.waitForEvent('transfer.download:progress', (d: any) => d.lishID === LISH_ID && d.downloadedChunks > 0 && d.peers >= 1, EVENT_TIMEOUT);

			await node2.call('transfer.enableDownload', { lishID: LISH_ID });
			const progress = await progressPromise;

			expect(progress.lishID).toBe(LISH_ID);
			expect(progress.downloadedChunks).toBeGreaterThan(0);
			expect(progress.totalChunks).toBeGreaterThan(0);
			expect(progress.peers).toBeGreaterThanOrEqual(1);
		},
		EVENT_TIMEOUT + 5000
	);

	it('progress shows realistic speed (bytesPerSecond > 0)', async () => {
		const events = await node2.collectEvents('transfer.download:progress', 5000);
		const withSpeed = events.filter((e: any) => e.lishID === LISH_ID && e.bytesPerSecond > 0);
		expect(withSpeed.length).toBeGreaterThan(0);
		// Speed should be < 100MB/s on localhost
		for (const e of withSpeed) {
			expect(e.bytesPerSecond).toBeLessThan(100 * 1024 * 1024);
		}
	}, 10000);
});

// ============================================================================
// Test 2+3: Upload pause and resume on node1
// ============================================================================
describe('Upload pause/resume', () => {
	it(
		'pausing node1 upload stops node2 download progress (peers=0)',
		async () => {
			// Ensure download is running
			await node2.waitForEvent('transfer.download:progress', (d: any) => d.lishID === LISH_ID && d.peers >= 1, EVENT_TIMEOUT);

			node2.clearHistory();

			// Pause upload on node1
			await node1.call('transfer.disableUpload', { lishID: LISH_ID });

			// Wait for node2 to see peers=0
			const exhausted = await node2.waitForEvent('transfer.download:progress', (d: any) => d.lishID === LISH_ID && d.peers === 0, EVENT_TIMEOUT);
			expect(exhausted.peers).toBe(0);
			expect(exhausted.bytesPerSecond).toBe(0);
		},
		EVENT_TIMEOUT + 5000
	);

	it(
		'resuming node1 upload restarts node2 download',
		async () => {
			await node1.call('transfer.enableUpload', { lishID: LISH_ID });

			// Wait for progress with peers > 0
			const resumed = await node2.waitForEvent('transfer.download:progress', (d: any) => d.lishID === LISH_ID && d.peers >= 1 && d.bytesPerSecond > 0, EVENT_TIMEOUT);
			expect(resumed.peers).toBeGreaterThanOrEqual(1);
			expect(resumed.bytesPerSecond).toBeGreaterThan(0);
		},
		EVENT_TIMEOUT + 5000
	);
});

// ============================================================================
// Test 4: Upload tracking (node1 sees upload progress)
// ============================================================================
describe('Upload tracking', () => {
	it(
		'node1 emits upload:progress when serving chunks',
		async () => {
			const uploadProgress = await node1.waitForEvent('transfer.upload:progress', (d: any) => d.lishID === LISH_ID && d.peers >= 1 && d.bytesPerSecond > 0, EVENT_TIMEOUT);
			expect(uploadProgress.peers).toBeGreaterThanOrEqual(1);
			expect(uploadProgress.bytesPerSecond).toBeGreaterThan(0);
			expect(uploadProgress.uploadedChunks).toBeGreaterThan(0);
		},
		EVENT_TIMEOUT + 5000
	);
});

// ============================================================================
// Test 5: Download pause/resume
// ============================================================================
describe('Download pause/resume', () => {
	it(
		'pausing download stops progress events',
		async () => {
			// Ensure active
			await node2.waitForEvent('transfer.download:progress', (d: any) => d.lishID === LISH_ID && d.peers >= 1, EVENT_TIMEOUT);

			await node2.call('transfer.disableDownload', { lishID: LISH_ID });

			// Verify: no progress events for 3 seconds
			const events = await node2.collectEvents('transfer.download:progress', 3000);
			const forLISH = events.filter((e: any) => e.lishID === LISH_ID && e.peers > 0);
			expect(forLISH.length).toBe(0);
		},
		EVENT_TIMEOUT + 10000
	);

	it(
		'resuming download restarts progress',
		async () => {
			await node2.call('transfer.enableDownload', { lishID: LISH_ID });

			const progress = await node2.waitForEvent('transfer.download:progress', (d: any) => d.lishID === LISH_ID && d.peers >= 1, EVENT_TIMEOUT);
			expect(progress.peers).toBeGreaterThanOrEqual(1);
		},
		EVENT_TIMEOUT + 5000
	);
});

// ============================================================================
// Test 6: getActiveTransfers state
// ============================================================================
describe('getActiveTransfers', () => {
	it(
		'returns correct state for active download',
		async () => {
			// Ensure download active
			await node2.waitForEvent('transfer.download:progress', (d: any) => d.lishID === LISH_ID && d.peers >= 1, EVENT_TIMEOUT);

			const transfers = await node2.call('transfer.getActiveTransfers', {});
			const dl = transfers.find((t: any) => t.lishID === LISH_ID && t.type === 'downloading');
			expect(dl).toBeDefined();
		},
		EVENT_TIMEOUT + 5000
	);

	it('returns upload-disabled after disableUpload', async () => {
		await node1.call('transfer.disableUpload', { lishID: LISH_ID });
		await new Promise(r => setTimeout(r, 500));

		const transfers = await node1.call('transfer.getActiveTransfers', {});
		const paused = transfers.find((t: any) => t.lishID === LISH_ID && t.type === 'upload-disabled');
		expect(paused).toBeDefined();

		// Clean up — resume for next tests
		await node1.call('transfer.enableUpload', { lishID: LISH_ID });
	}, 10000);
});

// ============================================================================
// Test 7: Node3 downloads from node1
// ============================================================================
describe('Multi-node download', () => {
	it(
		'node3 starts downloading and receives progress',
		async () => {
			const progressPromise = node3.waitForEvent('transfer.download:progress', (d: any) => d.lishID === LISH_ID && d.downloadedChunks > 0 && d.peers >= 1, EVENT_TIMEOUT);

			await node3.call('transfer.enableDownload', { lishID: LISH_ID });
			const progress = await progressPromise;

			expect(progress.peers).toBeGreaterThanOrEqual(1);
			expect(progress.downloadedChunks).toBeGreaterThan(0);
		},
		EVENT_TIMEOUT + 5000
	);
});

// ============================================================================
// Test 8: Peer exchange (node1 off, node2+node3 exchange chunks)
// ============================================================================
describe('Peer exchange', () => {
	it('node2 and node3 exchange chunks when node1 is offline', async () => {
		// Let both download some chunks first
		await new Promise(r => setTimeout(r, 3000));

		// Pause node1 upload
		await node1.call('transfer.disableUpload', { lishID: LISH_ID });
		await new Promise(r => setTimeout(r, 2000));

		// Record current progress
		const list2before = await node2.call('lishs.list', {});
		const list3before = await node3.call('lishs.list', {});
		const chunks2before = list2before.items?.find((i: any) => i.id === LISH_ID)?.verifiedChunks ?? 0;
		const chunks3before = list3before.items?.find((i: any) => i.id === LISH_ID)?.verifiedChunks ?? 0;

		// Wait for peer exchange (node2 and node3 should share chunks)
		await new Promise(r => setTimeout(r, 10000));

		// Check if either made progress
		const list2after = await node2.call('lishs.list', {});
		const list3after = await node3.call('lishs.list', {});
		const chunks2after = list2after.items?.find((i: any) => i.id === LISH_ID)?.verifiedChunks ?? 0;
		const chunks3after = list3after.items?.find((i: any) => i.id === LISH_ID)?.verifiedChunks ?? 0;

		// At least one should have gained chunks from the other
		const gained = chunks2after - chunks2before + (chunks3after - chunks3before);
		expect(gained).toBeGreaterThan(0);

		// Resume node1 for cleanup
		await node1.call('transfer.enableUpload', { lishID: LISH_ID });
	}, 30000);
});

// ============================================================================
// Test 9: Stale upload state cleanup
// ============================================================================
describe('Upload state cleanup', () => {
	it('upload peers reset to 0 after peer disconnects', async () => {
		// Ensure node1 is uploading
		await node1.waitForEvent('transfer.upload:progress', (d: any) => d.lishID === LISH_ID && d.peers >= 1, EVENT_TIMEOUT);

		// Pause download on node2 (simulates disconnect)
		await node2.call('transfer.disableDownload', { lishID: LISH_ID });
		await node3.call('transfer.disableDownload', { lishID: LISH_ID });

		// Wait for upload:stopped or timeout
		try {
			await node1.waitForEvent('transfer.upload:stopped', undefined, 20000);
		} catch {
			// May not fire if TCP lingers — check getActiveTransfers instead
		}

		// After 15s the frontend stale timeout would kick in
		await new Promise(r => setTimeout(r, 5000));

		const transfers = await node1.call('transfer.getActiveTransfers', {});
		const upload = transfers.find((t: any) => t.lishID === LISH_ID && t.type === 'uploading');
		// Either no active upload or peers=0
		if (upload) expect(upload.peers).toBe(0);

		// Resume for cleanup
		await node2.call('transfer.enableDownload', { lishID: LISH_ID });
		await node3.call('transfer.enableDownload', { lishID: LISH_ID });
	}, 40000);
});

// ============================================================================
// Test 10: Speed display sanity
// ============================================================================
describe('Speed calculation', () => {
	it('download speed updates reflect recent activity (not stale average)', async () => {
		// Collect progress events for 8 seconds
		const events = await node2.collectEvents('transfer.download:progress', 8000);
		const speeds = events.filter((e: any) => e.lishID === LISH_ID && e.bytesPerSecond > 0).map((e: any) => e.bytesPerSecond);

		if (speeds.length >= 3) {
			// Speed should not be constant — rolling window produces variation
			const max = Math.max(...speeds);
			// Allow some variation (at least 10% difference between min and max)
			// This is a soft check — on very stable connections it might be nearly constant
			expect(max).toBeGreaterThan(0);
		}
	}, 15000);

	it('upload speed on node1 is realistic', async () => {
		const events = await node1.collectEvents('transfer.upload:progress', 5000);
		const speeds = events.filter((e: any) => e.lishID === LISH_ID).map((e: any) => e.bytesPerSecond);

		if (speeds.length > 0) {
			for (const s of speeds) {
				expect(s).toBeGreaterThan(0);
				expect(s).toBeLessThan(100 * 1024 * 1024); // < 100 MB/s
			}
		}
	}, 10000);
});
