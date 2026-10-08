/**
 * A download keeps the publisher its item is stored with: every manifest fetch expects it, a
 * forged or stripped manifest from one peer only moves on to the next one, a local `.lish` file
 * never overrides it, and a downloader waiting to store a manifest never blocks its own destroy.
 */
import { describe, expect, it, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { encode as lpEncode } from 'it-length-prefixed';
import { CodedError, encodeSignature, ErrorCodes, signedManifestBytes, type ILISH, type IStoredLISH } from '@shared';
import { Downloader } from '../../../src/protocol/downloader.ts';
import { encode as codecEncode } from '../../../src/protocol/codec.ts';
import { lishOwnershipUsers, withLISHOwnership } from '../../../src/lish/lish-ownership.ts';
import { LISHClient } from '../../../src/protocol/lish-protocol.ts';
import { verifyManifestSignature } from '../../../src/lish/manifest-signature.ts';
import { DEFAULT_MAX_CHUNK_SIZE, DEFAULT_MAX_MESSAGE_SIZE, useNetworkSettings, type SettingsData } from '../../../src/settings.ts';
import { MockDataServer, MockLISHClient, priv } from './downloader-test-helpers.ts';
import { MockNetwork } from '../helpers/mock-network.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { createTestDB } from '../helpers/fixtures.ts';

useNetworkSettings(() => ({ maxDownloadSpeed: 0, maxUploadSpeed: 0, maxDownloadPeersPerLISH: 30, maxUploadPeersPerLISH: 30, maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE, maxChunkSize: DEFAULT_MAX_CHUNK_SIZE }) as SettingsData['network']);

const ID = 'a1000000-0000-4000-8000-000000000007';
const keyA = await generateKeyPairFromSeed(
	'Ed25519',
	Uint8Array.from({ length: 32 }, (_, i) => i + 1)
);
const keyQ = await generateKeyPairFromSeed(
	'Ed25519',
	Uint8Array.from({ length: 32 }, (_, i) => 100 + i)
);
const A = peerIdFromPrivateKey(keyA).toString();

function manifest(overrides: Record<string, unknown> = {}): ILISH {
	return { id: ID, name: 'Item', created: '2026-10-08T10:00:00.000Z', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'a.bin', size: 4, checksums: ['c'.repeat(64)] }], ...overrides } as ILISH;
}

async function sign(lish: ILISH, key: typeof keyA): Promise<ILISH> {
	const withPublisher = { ...lish, publisher: peerIdFromPrivateKey(key).toString() };
	return { ...withPublisher, signature: encodeSignature(await key.sign(signedManifestBytes(withPublisher))) };
}

/** Records the expectation every manifest request carried. */
class RecordingClient extends MockLISHClient {
	expectations: unknown[] = [];
	override async requestManifest(lishID: string, _onProgress?: unknown, expectedPublisher?: unknown): Promise<IStoredLISH | null> {
		this.expectations.push(expectedPublisher);
		return super.requestManifest(lishID as never);
	}
}

/** A downloader for a stored item whose manifest has not arrived yet (the add-from-search state). */
function awaitingManifest(ds: MockDataServer, stored: IStoredLISH | null, network: unknown = new MockNetwork()): Downloader {
	const dl = new Downloader('/tmp/dl-publisher', network as never, ds as never, 'net-001');
	const p = priv(dl);
	p['state'] = 'awaiting-manifest';
	p['needsManifest'] = true;
	p['lish'] = stored;
	p['lishID'] = ID;
	return dl;
}

function peers(dl: Downloader): Map<string, MockLISHClient> {
	return (priv(dl)['peerManager'] as { peers: Map<string, MockLISHClient> }).peers;
}

describe('the connected-peer loop', () => {
	it('expects the stored publisher, null for a stored unsigned item, nothing for an unknown one', async () => {
		for (const [stored, expected] of [
			[{ ...manifest({ files: [] }), publisher: A } as IStoredLISH, A],
			[manifest({ files: [] }) as IStoredLISH, null],
			[null, undefined],
		] as const) {
			const dl = awaitingManifest(new MockDataServer(), stored);
			const client = new RecordingClient();
			client.requestManifestError = new CodedError(ErrorCodes.PEER_UNREACHABLE, 'x');
			peers(dl).set('peer-recording-01', client);
			await dl.doWork();
			expect(client.expectations).toEqual([expected]);
			await dl.destroy();
		}
	});

	it('a refused write leaves the download waiting instead of storing or failing it', async () => {
		const ds = new MockDataServer();
		ds.add = () => {
			throw new CodedError(ErrorCodes.LISH_PUBLISHER_MISMATCH, 'stored A, received Q');
		};
		const stored = { ...manifest({ files: [] }), publisher: A } as IStoredLISH;
		const dl = awaitingManifest(ds, stored);
		let imported = false;
		priv(dl)['onManifestImported'] = () => (imported = true);
		const client = new MockLISHClient();
		client.requestManifestResult = (await sign(manifest(), keyA)) as IStoredLISH;
		peers(dl).set('peer-refused-0001', client);
		await dl.doWork();
		expect(imported).toBe(false);
		expect(priv(dl)['lish']).toBe(stored);
		expect(priv(dl)['state']).not.toBe('error');
		await dl.destroy();
	});

	it('a downloader waiting to store a manifest is released by destroy while the owner still holds the ID', async () => {
		const ds = new MockDataServer();
		const dl = awaitingManifest(ds, null);
		const client = new MockLISHClient();
		client.requestManifestResult = manifest() as IStoredLISH;
		peers(dl).set('peer-waiting-0001', client);
		let release!: () => void;
		let destroyed = false;
		// The owner (an import) waits for this destroy before it lets the ID go.
		const owner = withLISHOwnership(ID, async () => {
			const work = (priv(dl) as Record<string, any>)['trackLifecycle'](dl.doWork());
			await new Promise(resolve => setTimeout(resolve, 20));
			await Promise.race([dl.destroy().then(() => (destroyed = true)), new Promise(resolve => setTimeout(resolve, 2000))]);
			await new Promise<void>(resolve => (release = resolve));
			await work.catch(() => {});
		});
		while (!release) await new Promise(resolve => setTimeout(resolve, 5));
		expect(destroyed).toBe(true);
		release();
		await owner;
		expect(ds.addedLishs).toHaveLength(0);
	});
});

describe('the topic-peer probe', () => {
	function servingNetwork(served: ILISH) {
		const frame = lpEncode.single(codecEncode({ manifest: served })).subarray();
		return {
			subscribe() {},
			unsubscribeHandler() {},
			async broadcast() {},
			getTopicPeers: () => ['peer-probe-0001'],
			isRunning: () => true,
			async dialProtocolByPeerId() {
				return {
					stream: {
						status: 'open',
						send() {},
						close: async () => {},
						abort() {},
						async *[Symbol.asyncIterator]() {
							yield frame;
						},
					},
					connectionType: 'direct',
				};
			},
		};
	}

	it('refuses a manifest of another publisher and stores the expected one', async () => {
		const stored = { ...manifest({ files: [] }), publisher: A } as IStoredLISH;
		const forged = new MockDataServer();
		await (priv(awaitingManifest(forged, stored, servingNetwork(await sign(manifest(), keyQ)))) as Record<string, any>)['probeTopicPeers']();
		expect(forged.addedLishs).toHaveLength(0);
		const genuine = new MockDataServer();
		await (priv(awaitingManifest(genuine, stored, servingNetwork(await sign(manifest(), keyA)))) as Record<string, any>)['probeTopicPeers']();
		expect(genuine.addedLishs.map(lish => lish.publisher)).toEqual([A]);
	});
});

describe('a local .lish file', () => {
	const dirs: string[] = [];
	afterEach(async () => {
		for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
	});

	async function initFrom(file: ILISH, stored: IStoredLISH | null): Promise<Downloader> {
		const dir = await mkdtemp(join(tmpdir(), 'lish-local-'));
		dirs.push(dir);
		const path = join(dir, 'item.lish');
		await writeFile(path, JSON.stringify(file));
		const ds = new MockDataServer();
		if (stored) ds.storedLishs.set(ID, stored);
		const dl = new Downloader(dir, new MockNetwork() as never, ds as never, 'net-001');
		try {
			await dl.init(path);
		} finally {
			await dl.destroy();
		}
		return dl;
	}

	it('never overrides the stored publisher', async () => {
		const stored = (await sign(manifest(), keyA)) as IStoredLISH;
		await expect(initFrom(await sign(manifest(), keyQ), stored)).rejects.toMatchObject({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH });
		await expect(initFrom(manifest(), stored)).rejects.toMatchObject({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH });
		await initFrom(await sign(manifest(), keyA), stored);
	});

	it('refuses a file whose signature does not match its body', async () => {
		await expect(initFrom({ ...(await sign(manifest(), keyA)), name: 'Changed' }, null)).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_SIGNATURE });
	});
});

/** A stream answering one manifest request, as a peer would. */
function answeringStream(manifest: () => ILISH) {
	return {
		status: 'open',
		send() {},
		close: async () => {},
		abort() {},
		async *[Symbol.asyncIterator]() {
			yield lpEncode.single(codecEncode({ manifest: manifest() })).subarray();
		},
	};
}

function servingNetworkOf(peers: Array<{ peer: string; manifest: () => ILISH }>) {
	return {
		subscribe() {},
		unsubscribeHandler() {},
		async broadcast() {},
		getTopicPeers: () => peers.map(p => p.peer),
		isRunning: () => true,
		async dialProtocolByPeerId(peerID: string) {
			return { stream: answeringStream(peers.find(p => p.peer === peerID)!.manifest), connectionType: 'direct' };
		},
	};
}

/**
 * Both loops fetch through the real client, so the answer is verified before anything else.
 * The barrier is the ID lock: the test owns it, and only once the downloader is confirmed waiting
 * for it (owner + one waiter) does the test change state, i.e. strictly after verification.
 */
describe('late manifest answers against the real store', () => {
	function run(dl: Downloader, loop: 'connected' | 'probe', answer: () => ILISH): Promise<unknown> {
		if (loop === 'connected') {
			peers(dl).set('peer-late-00001', new LISHClient(answeringStream(answer) as never) as never);
			return (priv(dl) as Record<string, any>)['trackLifecycle'](dl.doWork());
		}
		return (priv(dl) as Record<string, any>)['probeTopicPeers']();
	}

	async function waitingForID(): Promise<void> {
		while (lishOwnershipUsers(ID) < 2) await Bun.sleep(2);
	}

	for (const loop of ['connected', 'probe'] as const) {
		it(`${loop}: a publisher stored after the answer was verified wins over it`, async () => {
			const ds = new DataServer(createTestDB());
			const forged = await sign(manifest(), keyQ);
			const dl = awaitingManifest(ds as never, null, loop === 'probe' ? servingNetworkOf([{ peer: 'peer-late-00001', manifest: () => forged }]) : new MockNetwork());
			let imported = false;
			priv(dl)['onManifestImported'] = () => (imported = true);
			let running!: Promise<unknown>;
			await withLISHOwnership(ID, async () => {
				running = run(dl, loop, () => forged);
				await waitingForID();
				// Another operation stores the genuine publisher under this ID.
				ds.add((await sign(manifest(), keyA)) as IStoredLISH);
			});
			await running;
			expect(imported).toBe(false);
			expect(ds.get(ID as never)?.publisher).toBe(A);
			await dl.destroy();
		});

		it(`${loop}: a verified answer is never stored once destroy ran, and destroy does not wait for the owner`, async () => {
			const ds = new DataServer(createTestDB());
			const genuine = await sign(manifest(), keyA);
			const dl = awaitingManifest(ds as never, null, loop === 'probe' ? servingNetworkOf([{ peer: 'peer-late-00001', manifest: () => genuine }]) : new MockNetwork());
			let running!: Promise<unknown>;
			let destroyed = false;
			await withLISHOwnership(ID, async () => {
				running = run(dl, loop, () => genuine);
				await waitingForID();
				await Promise.race([dl.destroy().then(() => (destroyed = true)), Bun.sleep(2000)]);
				// Still inside the owner: destroy finished without the lock being released.
				expect(destroyed).toBe(true);
			});
			await running.catch(() => {});
			expect(ds.get(ID as never)).toBeFalsy();
			expect(lishOwnershipUsers(ID)).toBe(0);
		});
	}

	it('connected: a newer signed body of the same publisher replaces old directories and links', async () => {
		const ds = new DataServer(createTestDB());
		ds.add((await sign(manifest({ directories: [{ path: 'old' }], links: [{ path: 'l', target: 'a.bin' }] }), keyA)) as IStoredLISH);
		const stored = ds.get(ID as never)!;
		const dl = awaitingManifest(ds as never, stored);
		const newer = await sign(manifest(), keyA);
		peers(dl).set('peer-newer-00001', new LISHClient(answeringStream(() => newer) as never) as never);
		// Only the manifest write matters here; the chunk transfer that follows has no engine in this harness.
		await dl.doWork().catch(() => {});
		const reloaded = ds.get(ID as never)!;
		expect(reloaded.directories ?? []).toEqual([]);
		expect(reloaded.links ?? []).toEqual([]);
		expect(await verifyManifestSignature(reloaded)).toEqual({ signed: true, publisher: A });
		await dl.destroy();
	});

	it('probe: one pass refuses the forged peer and stores the genuine one', async () => {
		const ds = new DataServer(createTestDB());
		const stored = { ...manifest({ files: [] }), publisher: A } as IStoredLISH;
		const forged = await sign(manifest({ name: 'Forged' }), keyQ);
		const genuine = await sign(manifest(), keyA);
		const network = servingNetworkOf([
			{ peer: 'peer-forged-0001', manifest: () => forged },
			{ peer: 'peer-genuine-001', manifest: () => genuine },
		]);
		const dl = awaitingManifest(ds as never, stored, network);
		await (priv(dl) as Record<string, any>)['probeTopicPeers']();
		expect(ds.get(ID as never)).toMatchObject({ name: 'Item', publisher: A });
		await dl.destroy();
	});
});
