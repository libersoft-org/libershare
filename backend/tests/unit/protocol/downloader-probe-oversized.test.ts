/**
 * Peer discovery keeps probing while a download runs, and there `requestManifest` is only a
 * "do you have this LISH?" test — the answer is thrown away because the manifest is already
 * imported. A peer answering that probe with an over-limit manifest must therefore not be
 * able to fail a healthy transfer; the verdict belongs to the manifest-fetch path only.
 *
 * Uses the real LISHClient over a canned stream (same trick as lish-protocol.test.ts) rather
 * than mocking the module — a module mock leaks into every other test file in the run.
 */
import { test, expect, afterEach } from 'bun:test';
import { encode as lpEncode } from 'it-length-prefixed';
import { Downloader } from '../../../src/protocol/downloader.ts';
import { encode as codecEncode } from '../../../src/protocol/codec.ts';
import { DEFAULT_MAX_CHUNK_SIZE, DEFAULT_MAX_MESSAGE_SIZE, useNetworkSettings, type SettingsData } from '../../../src/settings.ts';
import { ErrorCodes, type IStoredLISH } from '@shared';

const CHUNK_LIMIT = 1024 * 1024;
/** The chunk limit is read live from settings, so a test sets it by moving this. */
let chunkLimit = DEFAULT_MAX_CHUNK_SIZE;
useNetworkSettings(
	() =>
		({
			maxDownloadSpeed: 0,
			maxUploadSpeed: 0,
			maxDownloadPeersPerLISH: 30,
			maxUploadPeersPerLISH: 30,
			maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE,
			maxChunkSize: chunkLimit,
		}) as SettingsData['network']
);
const priv = (o: unknown): Record<string, any> => o as unknown as Record<string, any>;

/** Manifest declaring a chunk size well past the limit set below. */
function oversizedManifest(): IStoredLISH {
	const chunkSize = 8 * CHUNK_LIMIT;
	return {
		id: 'test-probe-lish',
		created: new Date().toISOString(),
		chunkSize,
		checksumAlgo: 'sha256',
		files: [{ path: 'a.bin', size: chunkSize, checksums: ['h1'] }],
	} as IStoredLISH;
}

/** A manifest within the limit, as an honest peer serves it. */
function validManifest(): IStoredLISH {
	return { id: 'test-probe-lish', created: new Date().toISOString(), chunkSize: 1024, checksumAlgo: 'sha256', files: [{ path: 'a.bin', size: 1024, checksums: ['h1'] }] } as IStoredLISH;
}

/** Stream stub that answers any request with one length-prefixed manifest frame. */
function cannedStream(manifest: IStoredLISH): any {
	const frame = lpEncode.single(codecEncode({ manifest })).subarray();
	async function* source() {
		yield frame;
	}
	return { status: 'open', send() {}, close: async () => {}, abort() {}, [Symbol.asyncIterator]: source };
}

/** Network stub listing topic peers whose dial hands back a stream answering with that peer's manifest. */
class ProbeNetwork {
	private readonly manifests: Map<string, () => IStoredLISH>;
	constructor(manifests: Map<string, () => IStoredLISH>) {
		this.manifests = manifests;
	}
	subscribe(): void {}
	unsubscribeHandler(): void {}
	async broadcast(): Promise<void> {}
	getTopicPeers(): string[] {
		return [...this.manifests.keys()];
	}
	async dialProtocolByPeerId(peerID: string): Promise<{ stream: unknown; connectionType: string }> {
		return { stream: cannedStream(this.manifests.get(peerID)!()), connectionType: 'direct' };
	}
	isRunning(): boolean {
		return true;
	}
}

function makeDownloader(manifests = new Map([['peer-probe-0001', oversizedManifest]]), added: IStoredLISH[] = []): any {
	const ds = {
		getMissingChunks: () => [],
		getAllChunkCount: () => 2,
		add: (lish: IStoredLISH) => added.push(lish),
		isChunkDownloaded: () => false,
	};
	const dl = new Downloader('/tmp/dl-probe', new ProbeNetwork(manifests) as never, ds as never, 'net-001');
	priv(dl)['lishID'] = 'test-probe-lish';
	return dl;
}

afterEach(() => {
	chunkLimit = DEFAULT_MAX_CHUNK_SIZE;
});

test('a probe answered with an over-limit manifest does not fail a running download', async () => {
	chunkLimit = CHUNK_LIMIT;
	const dl = makeDownloader();
	// Manifest already fetched and validated — the probe only looks for more peers here.
	priv(dl)['state'] = 'downloading';
	priv(dl)['needsManifest'] = false;
	priv(dl)['lish'] = { id: 'test-probe-lish', chunkSize: 1024, files: [] };

	await priv(dl)['probeTopicPeers']();

	expect(priv(dl)['state']).toBe('downloading');
	expect(priv(dl)['errorCode']).toBeUndefined();
});

test('an over-limit answer from one topic peer does not stop the next peer serving the manifest', async () => {
	chunkLimit = CHUNK_LIMIT;
	const added: IStoredLISH[] = [];
	const dl = makeDownloader(
		new Map([
			['peer-probe-0001', oversizedManifest],
			['peer-probe-0002', validManifest],
		]),
		added
	);
	priv(dl)['state'] = 'awaiting-manifest';
	priv(dl)['needsManifest'] = true;
	priv(dl)['lish'] = null;

	await priv(dl)['probeTopicPeers']();

	expect(priv(dl)['errorCode']).toBeUndefined();
	expect(added.map(lish => lish.chunkSize)).toEqual([1024]);
});

test('the same answer is terminal while the manifest is still missing and no other peer is left', async () => {
	chunkLimit = CHUNK_LIMIT;
	const dl = makeDownloader();
	priv(dl)['state'] = 'awaiting-manifest';
	priv(dl)['needsManifest'] = true;
	priv(dl)['lish'] = null;

	await priv(dl)['probeTopicPeers']();

	expect(priv(dl)['state']).toBe('error');
	expect(priv(dl)['errorCode']).toBe(ErrorCodes.LISH_CHUNK_SIZE_TOO_LARGE);
});
