import { describe, expect, it } from 'bun:test';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { encode as lpEncode } from 'it-length-prefixed';
import { encodeSignature, ErrorCodes, signedManifestBytes, type ILISH, type LISHid } from '@shared';
import { LISHClient } from '../../../src/protocol/lish-protocol.ts';
import { encode as codecEncode } from '../../../src/protocol/codec.ts';
import { DEFAULT_MAX_CHUNK_SIZE, DEFAULT_MAX_MESSAGE_SIZE, useNetworkSettings, type SettingsData } from '../../../src/settings.ts';

useNetworkSettings(() => ({ maxDownloadSpeed: 0, maxUploadSpeed: 0, maxDownloadPeersPerLISH: 30, maxUploadPeersPerLISH: 30, maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE, maxChunkSize: DEFAULT_MAX_CHUNK_SIZE }) as SettingsData['network']);

const ID = 'b0000000-0000-4000-8000-000000000002' as LISHid;
const CHECKSUM = 'a'.repeat(64);

function manifest(overrides: Record<string, unknown> = {}): ILISH {
	return { id: ID, name: 'Demo', created: '2026-10-08T10:00:00.000Z', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'a.txt', size: 4, checksums: [CHECKSUM] }], directories: [], links: [], ...overrides } as ILISH;
}

async function sign(lish: ILISH, key: typeof keyA): Promise<ILISH> {
	const withPublisher = { ...lish, publisher: peerIdFromPrivateKey(key).toString() };
	return { ...withPublisher, signature: encodeSignature(await key.sign(signedManifestBytes(withPublisher))) };
}

const keyA = await generateKeyPairFromSeed(
	'Ed25519',
	Uint8Array.from({ length: 32 }, (_, i) => i + 1)
);
const keyQ = await generateKeyPairFromSeed(
	'Ed25519',
	Uint8Array.from({ length: 32 }, (_, i) => 100 + i)
);
const A = peerIdFromPrivateKey(keyA).toString();

describe('requestManifest checks signature and expected publisher', () => {
	function client(response: unknown): LISHClient {
		const frame = lpEncode.single(codecEncode({ manifest: response })).subarray();
		return new LISHClient({
			status: 'open',
			send() {},
			close: async () => {},
			async *[Symbol.asyncIterator]() {
				yield frame;
			},
		} as any);
	}
	const peerFault = { code: ErrorCodes.PEER_INVALID_REQUEST };

	it('accepts a valid signature and returns the publisher', async () => {
		const signed = await sign(manifest(), keyA);
		expect((await client(signed).requestManifest(ID, undefined, A)).publisher).toBe(A);
		expect((await client(signed).requestManifest(ID)).publisher).toBe(A);
	});

	it('blames the peer for a changed signed body', async () => {
		const signed = await sign(manifest(), keyA);
		await expect(client({ ...signed, name: 'Changed' }).requestManifest(ID)).rejects.toMatchObject(peerFault);
	});

	it('blames the peer for a stripped signature, another publisher, or a signature where none is expected', async () => {
		const signed = await sign(manifest(), keyA);
		const { publisher: _p, signature: _s, ...stripped } = signed;
		await expect(client(stripped).requestManifest(ID, undefined, A)).rejects.toMatchObject(peerFault);
		await expect(client(await sign(manifest(), keyQ)).requestManifest(ID, undefined, A)).rejects.toMatchObject(peerFault);
		await expect(client(signed).requestManifest(ID, undefined, null)).rejects.toMatchObject(peerFault);
		expect((await client(stripped).requestManifest(ID, undefined, null)).publisher).toBeUndefined();
	});
});
