import { describe, expect, it } from 'bun:test';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { encodeSignature, signedManifestBytes, type ILISH, type IStoredLISH, type LISHid } from '@shared';
import { LISHListPages, receiveLISHList } from '../../../src/protocol/lish-list-pages.ts';
import { encode as codecEncode, decode as codecDecode } from '../../../src/protocol/codec.ts';
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
const A = peerIdFromPrivateKey(keyA).toString();

describe('listing entries carry the reported publisher', () => {
	it('sends the publisher of a signed item and nothing for an unsigned one', async () => {
		const signed = (await sign(manifest(), keyA)) as IStoredLISH;
		const unsigned = manifest({ id: 'c0000000-0000-4000-8000-000000000003' }) as IStoredLISH;
		const reply = codecDecode(
			new LISHListPages().respond(
				{ type: 'getLishs' },
				() => [signed, unsigned],
				() => true
			)
		) as { lishs: Array<{ id: string; publisher?: string }> };
		expect(reply.lishs.find(e => e.id === ID)?.publisher).toBe(A);
		expect('publisher' in reply.lishs.find(e => e.id === unsigned.id)!).toBe(false);
	});

	it('drops only the row whose reported publisher is malformed', async () => {
		const page = { type: 'getLishs-result', lishs: [{ id: 'good', publisher: A }, { id: 'bad', publisher: '0OIl not base58' }, { id: 'plain' }] };
		const entries = await receiveLISHList(undefined, async () => codecEncode(page), 1_000_000);
		expect(entries.map(e => e.id)).toEqual(['good', 'plain']);
	});

	it('a page whose only row is dropped still leads on to the next page', async () => {
		const snapshot = 'd0000000-0000-4000-8000-000000000009';
		const pages = [
			{ type: 'getLishs-result', lishs: [{ id: 'bad', publisher: 'not a Peer ID' }], page: true, offset: 0, nextCursor: `${snapshot}:1` },
			{ type: 'getLishs-result', lishs: [{ id: 'next', publisher: A }], page: true, offset: 1 },
		];
		let exchanges = 0;
		const entries = await receiveLISHList(undefined, async () => codecEncode(pages[exchanges++]), 1_000_000);
		expect(exchanges).toBe(2);
		expect(entries.map(e => e.id)).toEqual(['next']);
	});
});
