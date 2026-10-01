import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { startNodes, stopNodes, getNodeURL, getNodeDataDir, getNodeListenAddresses, nodeTransferProbe } from './helpers/node-manager.ts';
import { TestClient } from './helpers/ws-test-client.ts';
import type { ILISHDetail, ILISHListResult } from '@shared';

/**
 * Real transfers between three isolated backend processes over the public API: node0 creates
 * and shares a LISH, node1 and node2 learn its manifest over P2P and download it. Every
 * scenario ends by comparing the downloaded bytes with the original.
 */

const EVENT_TIMEOUT = 60_000;
const PAYLOAD_SIZE = 2 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;
const NETWORK_ID = crypto.randomUUID();

let nodes: TestClient[] = [];
let lishID = '';
let seederPeerID = '';
let payloadHash = '';

function sha256(data: Uint8Array): string {
	return createHash('sha256').update(data).digest('hex');
}

/** The first file named `name` under `dir`, searched depth-first. */
function findFile(dir: string, name: string): string | null {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			const found = findFile(path, name);
			if (found) return found;
		} else if (entry === name) return path;
	}
	return null;
}

function downloadedHash(nodeIndex: number, name = 'payload.bin'): string {
	const path = findFile(join(getNodeDataDir(nodeIndex), 'storage', 'finished'), name);
	if (!path) throw new Error(`${name} not found on node${nodeIndex}`);
	return sha256(readFileSync(path));
}

async function downloadState(node: TestClient, id: string): Promise<ILISHDetail> {
	const detail = await node.call<ILISHDetail | null>('lishs.get', { lishID: id });
	if (!detail) throw new Error(`Missing LISH ${id}`);
	return detail;
}

async function expectStoppedDownload(nodeIndex: number, id: string): Promise<ILISHDetail> {
	await nodeTransferProbe(nodeIndex, 'drain-downloads');
	const node = nodes[nodeIndex]!;
	const paused = await downloadState(node, id);
	expect(paused.verifiedChunks).toBeGreaterThan(0);
	expect(paused.verifiedChunks).toBeLessThan(paused.totalChunks);
	const deadline = Date.now() + 3000;
	do {
		await Bun.sleep(100);
		const current = await downloadState(node, id);
		expect(current.verifiedChunks).toBe(paused.verifiedChunks);
		expect(current.totalDownloadedBytes).toBe(paused.totalDownloadedBytes);
		expect(node.getEventHistory('transfer.download:complete').filter(e => e.data.lishID === id)).toEqual([]);
	} while (Date.now() < deadline);
	return paused;
}

async function waitFor<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeout = 30_000): Promise<T> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await read();
		if (ok(value)) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
		await Bun.sleep(300);
	}
}

beforeAll(async () => {
	await startNodes(3);
	nodes = [0, 1, 2].map(i => new TestClient(getNodeURL(i)));
	for (const node of nodes) {
		await node.waitConnected();
		await node.subscribeAll();
	}

	// node0: a random payload, shared as a LISH.
	const source = join(getNodeDataDir(0), 'source');
	mkdirSync(source, { recursive: true });
	const payload = randomBytes(PAYLOAD_SIZE);
	payloadHash = sha256(payload);
	writeFileSync(join(source, 'payload.bin'), payload);
	({ lishID } = await nodes[0]!.call('lishs.create', { dataPath: source, name: 'e2e payload', addToSharing: true, chunkSize: CHUNK_SIZE }, 120_000));

	// One private network, bootstrapped from node0's bound address. Loopback would be simpler, but
	// the dial filter deliberately refuses 127.0.0.0/8 (a remote peer can never reach it).
	const network = (bootstrapPeers: string[]) => ({ network: { networkID: NETWORK_ID, name: 'e2e', description: '', bootstrapPeers, created: new Date().toISOString(), enabled: true } });
	await nodes[0]!.call('lishnets.add', network([]));
	const isDialable = (a: string): boolean => a.startsWith('/ip4/') && !a.startsWith('/ip4/127.') && !a.startsWith('/ip4/0.0.0.0/') && !a.includes('/p2p-circuit') && /\/tcp\/[1-9]\d*(\/|$)/.test(a);
	const info = await nodes[0]!.call('lishnets.getNodeInfo');
	seederPeerID = info.peerID;
	const dialable = async (i: number): Promise<string> => {
		const addresses = await waitFor(
			`node${i} addresses`,
			async () => getNodeListenAddresses(i),
			addresses => addresses.some(isDialable)
		);
		const nodeInfo = await nodes[i]!.call('lishnets.getNodeInfo');
		const address = addresses.find(isDialable)!;
		return address.includes('/p2p/') ? address : `${address}/p2p/${nodeInfo.peerID}`;
	};
	// node1 bootstraps from node0; node2 from both, as a network with two bootstrap peers
	// would — the second-seeder scenario needs node2 to reach node1 without node0's help.
	const bootstraps = [[await dialable(0)], [] as string[]];
	for (const [index, node] of [nodes[1]!, nodes[2]!].entries()) {
		if (index === 1) bootstraps[1] = [bootstraps[0]![0]!, await dialable(1)];
		await node.call('lishnets.add', network(bootstraps[index]!));
		await waitFor(
			'network membership',
			() => node.call('lishnets.getStatus', { networkID: NETWORK_ID }),
			(s: any) => s.connected >= 1,
			EVENT_TIMEOUT
		);
		// The manifest travels over P2P from the seeder; autoStartDownloading is off, so the
		// tests decide when each download starts.
		await node.call('lishnets.addPeerLish', { lishID, peerID: seederPeerID, networkID: NETWORK_ID }, 60_000);
	}
}, 240_000);

afterAll(async () => {
	for (const node of nodes) node.destroy();
	await stopNodes();
}, 60_000);

describe('download from one seeder', () => {
	it(
		'node1 downloads the whole LISH from node0 with progress, and the bytes match',
		async () => {
			// A fast local transfer may report its only non-zero progress with the peer already gone.
			const progress = nodes[1]!.waitForEvent('transfer.download:progress', (d: any) => d.lishID === lishID && d.downloadedChunks > 0, EVENT_TIMEOUT);
			const complete = nodes[1]!.waitForEvent('transfer.download:complete', (d: any) => d.lishID === lishID, EVENT_TIMEOUT * 2);
			await nodes[1]!.call('transfer.enableDownload', { lishID });
			const first = await progress;
			expect(first.totalChunks).toBe(PAYLOAD_SIZE / CHUNK_SIZE);
			await complete;
			expect(downloadedHash(1)).toBe(payloadHash);
		},
		EVENT_TIMEOUT * 3
	);
});

describe('download from a second seeder, paused and resumed', () => {
	it(
		'with node0 not uploading, node2 gets every chunk from node1 across a pause',
		async () => {
			const seederReady = nodes[1]!.waitForEvent('transfer.download:complete', (d: any) => d.lishID === lishID, EVENT_TIMEOUT * 2);
			await nodes[1]!.call('transfer.enableDownload', { lishID });
			await seederReady;
			expect(downloadedHash(1)).toBe(payloadHash);
			// node0 stops serving: whatever node2 receives must come from node1.
			await nodes[0]!.call('transfer.disableUpload', { lishID });
			// Slow node1 down so the pause lands in the middle of the transfer.
			await nodes[1]!.call('settings.set', { path: 'network.maxUploadSpeed', value: 128 });

			nodes[2]!.clearHistory();
			await nodeTransferProbe(2, 'hold-second-write', lishID);
			await nodes[2]!.call('transfer.enableDownload', { lishID });
			const started = await waitFor(
				'partial download',
				() => downloadState(nodes[2]!, lishID),
				state => state.verifiedChunks > 0,
				EVENT_TIMEOUT
			);
			expect(started.verifiedChunks).toBeLessThan(started.totalChunks);
			await nodeTransferProbe(2, 'wait-write-held', lishID);

			const disabled = nodes[2]!.waitForEvent('transfer.download:disabled', (d: any) => d.lishID === lishID, EVENT_TIMEOUT);
			await nodes[2]!.call('transfer.disableDownload', { lishID });
			await disabled;
			const pauseCheck = expectStoppedDownload(2, lishID);
			// Keep the second real write pending beyond the former one-second grace period.
			await Bun.sleep(1500);
			await nodeTransferProbe(2, 'release-write', lishID);
			const paused = await pauseCheck;

			// No completion was accepted during the pause; only the resumed transfer may finish.
			nodes[2]!.clearHistory();
			const complete = nodes[2]!.waitForEvent('transfer.download:complete', (d: any) => d.lishID === lishID, EVENT_TIMEOUT * 2);
			await nodes[2]!.call('transfer.enableDownload', { lishID });
			await nodes[1]!.call('settings.set', { path: 'network.maxUploadSpeed', value: 0 });
			await complete;
			const finished = await downloadState(nodes[2]!, lishID);
			expect(finished.verifiedChunks).toBe(finished.totalChunks);
			expect(finished.verifiedChunks).toBeGreaterThan(paused.verifiedChunks);
			expect(downloadedHash(2)).toBe(payloadHash);
			await nodes[0]!.call('transfer.enableUpload', { lishID });
		},
		EVENT_TIMEOUT * 4
	);
});

describe('active transfers', () => {
	it(
		'changes a running upload to inactive and stops sending chunks',
		async () => {
			const source = join(getNodeDataDir(0), 'upload-source');
			mkdirSync(source);
			const payload = randomBytes(PAYLOAD_SIZE);
			writeFileSync(join(source, 'upload.bin'), payload);
			const { lishID: uploadID } = await nodes[0]!.call('lishs.create', { dataPath: source, name: 'upload pause', addToSharing: true, chunkSize: CHUNK_SIZE });
			await waitFor(
				'seeder verification',
				() => nodes[0]!.call<ILISHListResult>('lishs.list'),
				list => list.verifying !== uploadID && !list.pendingVerification.includes(uploadID) && list.uploadEnabled.includes(uploadID)
			);
			await nodes[0]!.call('settings.set', { path: 'network.maxUploadSpeed', value: 128 });
			await nodes[2]!.call('lishnets.addPeerLish', { lishID: uploadID, peerID: seederPeerID, networkID: NETWORK_ID });
			nodes[2]!.clearHistory();
			await nodes[2]!.call('transfer.enableDownload', { lishID: uploadID });
			const activeUploads = () => nodes[0]!.call<Array<{ lishID: string; type: string; peers: number }>>('transfer.getActiveTransfers');
			await waitFor('active upload', activeUploads, transfers => transfers.some(t => t.lishID === uploadID && t.type === 'uploading' && t.peers > 0));
			const started = await waitFor(
				'partial download',
				() => downloadState(nodes[2]!, uploadID),
				state => state.verifiedChunks > 0,
				EVENT_TIMEOUT
			);
			expect(started.verifiedChunks).toBeLessThan(started.totalChunks);

			await nodes[0]!.call('transfer.disableUpload', { lishID: uploadID });
			expect((await activeUploads()).filter(t => t.lishID === uploadID && t.type === 'uploading')).toEqual([]);
			const list = await nodes[0]!.call<ILISHListResult>('lishs.list');
			expect(list.uploadEnabled).not.toContain(uploadID);
			await expectStoppedDownload(2, uploadID);

			nodes[2]!.clearHistory();
			const complete = nodes[2]!.waitForEvent('transfer.download:complete', (d: any) => d.lishID === uploadID, EVENT_TIMEOUT * 2);
			await nodes[0]!.call('transfer.enableUpload', { lishID: uploadID });
			await nodes[0]!.call('settings.set', { path: 'network.maxUploadSpeed', value: 0 });
			await nodes[2]!.call('transfer.findPeers', { lishID: uploadID });
			await complete;
			expect(downloadedHash(2, 'upload.bin')).toBe(sha256(payload));
		},
		EVENT_TIMEOUT * 3
	);
});
