import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { startNodes, stopNodes, getNodeURL, getNodeDataDir } from './helpers/node-manager.ts';
import { TestClient } from './helpers/ws-test-client.ts';

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

function downloadedHash(nodeIndex: number): string {
	const path = findFile(join(getNodeDataDir(nodeIndex), 'storage', 'finished'), 'payload.bin');
	if (!path) throw new Error(`payload.bin not found on node${nodeIndex}`);
	return sha256(readFileSync(path));
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

	// One private network, bootstrapped from node0's LAN address. Loopback would be simpler, but
	// the dial filter deliberately refuses 127.0.0.0/8 (a remote peer can never reach it).
	const network = (bootstrapPeers: string[]) => ({ network: { networkID: NETWORK_ID, name: 'e2e', description: '', bootstrapPeers, created: new Date().toISOString(), enabled: true } });
	await nodes[0]!.call('lishnets.add', network([]));
	const isLan = (a: string): boolean => a.startsWith('/ip4/') && !a.startsWith('/ip4/127.') && !a.includes('/p2p-circuit');
	const info = await waitFor(
		'node0 addresses',
		() => nodes[0]!.call('lishnets.getNodeInfo'),
		(i: any) => i?.addresses?.some(isLan)
	);
	seederPeerID = info.peerID;
	const dialable = async (i: number): Promise<string> => {
		const nodeInfo = await waitFor(
			`node${i} addresses`,
			() => nodes[i]!.call('lishnets.getNodeInfo'),
			(n: any) => n?.addresses?.some(isLan)
		);
		const address: string = nodeInfo.addresses.find(isLan);
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
			// node0 stops serving: whatever node2 receives must come from node1.
			await nodes[0]!.call('transfer.disableUpload', { lishID });
			// Slow node1 down so the pause lands in the middle of the transfer.
			await nodes[1]!.call('settings.set', { path: 'network.maxUploadSpeed', value: 128 });

			const started = nodes[2]!.waitForEvent('transfer.download:progress', (d: any) => d.lishID === lishID && d.downloadedChunks > 0, EVENT_TIMEOUT);
			await nodes[2]!.call('transfer.enableDownload', { lishID });
			await started;

			const disabled = nodes[2]!.waitForEvent('transfer.download:disabled', (d: any) => d.lishID === lishID, EVENT_TIMEOUT);
			await nodes[2]!.call('transfer.disableDownload', { lishID });
			await disabled;
			nodes[2]!.clearHistory();
			const whilePaused = await nodes[2]!.collectEvents('transfer.download:progress', 3000);
			expect(whilePaused.filter((e: any) => e.lishID === lishID && e.peers > 0)).toEqual([]);

			await nodes[1]!.call('settings.set', { path: 'network.maxUploadSpeed', value: 0 });
			const complete = nodes[2]!.waitForEvent('transfer.download:complete', (d: any) => d.lishID === lishID, EVENT_TIMEOUT * 2);
			await nodes[2]!.call('transfer.enableDownload', { lishID });
			await complete;
			expect(downloadedHash(2)).toBe(payloadHash);
			await nodes[0]!.call('transfer.enableUpload', { lishID });
		},
		EVENT_TIMEOUT * 4
	);
});

describe('active transfers', () => {
	it('never reports a disabled upload as uploading', async () => {
		await nodes[0]!.call('transfer.disableUpload', { lishID });
		const transfers: Array<{ lishID: string; type: string }> = await nodes[0]!.call('transfer.getActiveTransfers');
		expect(transfers.filter(t => t.lishID === lishID && t.type === 'uploading')).toEqual([]);
		await nodes[0]!.call('transfer.enableUpload', { lishID });
	});
});
