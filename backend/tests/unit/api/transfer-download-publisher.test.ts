import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { encodeSignature, ErrorCodes, signedManifestBytes, type ILISH, type IStoredLISH } from '@shared';
import { initDownloadState, initTransferHandlers } from '../../../src/api/transfer.ts';
import { initUploadState } from '../../../src/protocol/lish-protocol.ts';
import { Downloader } from '../../../src/protocol/downloader.ts';
import { withLISHOwnership } from '../../../src/lish/lish-ownership.ts';
import { DEFAULT_MAX_CHUNK_SIZE, DEFAULT_MAX_MESSAGE_SIZE, useNetworkSettings, type SettingsData, type Settings } from '../../../src/settings.ts';
import { MockNetwork } from '../helpers/mock-network.ts';
import type { Networks } from '../../../src/lishnet/lishnets.ts';
import type { DataServer } from '../../../src/lish/data-server.ts';

/**
 * A local `.lish` download must not take the active slot while an import of the same ID owns it.
 * The import below stores publisher A while the file of publisher Q waits; the download then reads
 * A and is refused before it ever activates. The comparison alone would pass a read made before the
 * import stored A; only taking part in the ownership lock makes the download see it.
 */

const ID = 'a2000000-0000-4000-8000-000000000008';
const keyA = await generateKeyPairFromSeed(
	'Ed25519',
	Uint8Array.from({ length: 32 }, (_, i) => i + 1)
);
const keyQ = await generateKeyPairFromSeed(
	'Ed25519',
	Uint8Array.from({ length: 32 }, (_, i) => 100 + i)
);

useNetworkSettings(() => ({ maxDownloadSpeed: 0, maxUploadSpeed: 0, maxDownloadPeersPerLISH: 30, maxUploadPeersPerLISH: 30, maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE, maxChunkSize: DEFAULT_MAX_CHUNK_SIZE }) as SettingsData['network']);

async function sign(lish: ILISH, key: typeof keyA): Promise<ILISH> {
	const withPublisher = { ...lish, publisher: peerIdFromPrivateKey(key).toString() };
	return { ...withPublisher, signature: encodeSignature(await key.sign(signedManifestBytes(withPublisher))) };
}

const manifest = { id: ID, name: 'Item', created: '2026-10-08T10:00:00.000Z', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'a.bin', size: 4, checksums: ['d'.repeat(64)] }] } as ILISH;
const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test('a local download waits for an import owning the ID and is refused by the publisher it stored', async () => {
	initDownloadState(new Set(), () => {});
	initUploadState(new Set(), () => {});
	const dir = await mkdtemp(join(tmpdir(), 'lish-local-dl-'));
	dirs.push(dir);
	const lishPath = join(dir, 'item.lish');
	await writeFile(lishPath, JSON.stringify(await sign(manifest, keyQ)));
	let stored: IStoredLISH | null = null;
	const data = { get: () => stored, getMissingChunks: () => [], getAllChunkCount: () => 1 } as unknown as DataServer;
	const networks = { getRunningNetwork: () => new MockNetwork(), set onNetworkLeft(_c: unknown) {}, set onNetworkJoined(_c: unknown) {} } as unknown as Networks;
	const start = spyOn(Downloader.prototype, 'download').mockImplementation(() => new Promise(() => {}));
	const handlers = initTransferHandlers(
		networks,
		data,
		dir,
		() => {},
		() => {},
		{ get: () => false } as unknown as Settings
	);
	try {
		let downloading!: Promise<unknown>;
		await withLISHOwnership(ID, async () => {
			downloading = handlers.download({ networkID: 'net-a', lishPath }, undefined);
			await new Promise(resolve => setTimeout(resolve, 50));
			// The import still owns the ID: the file was read, but nothing may be active yet.
			expect(handlers.getActiveTransfers()).toEqual([]);
			stored = (await sign(manifest, keyA)) as IStoredLISH;
		});
		await expect(downloading).rejects.toMatchObject({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH });
		expect(start).not.toHaveBeenCalled();
		expect(handlers.getActiveTransfers()).toEqual([]);
	} finally {
		start.mockRestore();
	}
});
