import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { encodeSignature, ErrorCodes, signedManifestBytes, type ILISH } from '@shared';
import { initDownloadState, initTransferHandlers, setActiveDownloadersRef } from '../../../src/api/transfer.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import { initUploadState } from '../../../src/protocol/lish-protocol.ts';
import { Downloader } from '../../../src/protocol/downloader.ts';
import { lishOwnershipUsers } from '../../../src/lish/lish-ownership.ts';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import * as files from '../../../src/lish/safe-dataset-files.ts';
import { MockNetwork } from '../helpers/mock-network.ts';
import type { Networks } from '../../../src/lishnet/lishnets.ts';

/**
 * A local `.lish` download must not take the active slot while an import of the same ID owns it.
 * The file of publisher Q has been read and passed its first comparison (nothing stored yet); a
 * real import of A then writes A and still holds the ID. The download waits, reads A on its second
 * comparison and is refused without ever activating.
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

async function sign(lish: ILISH, key: typeof keyA): Promise<ILISH> {
	const withPublisher = { ...lish, publisher: peerIdFromPrivateKey(key).toString() };
	return { ...withPublisher, signature: encodeSignature(await key.sign(signedManifestBytes(withPublisher))) };
}

const manifest = { id: ID, name: 'Item', created: '2026-10-08T10:00:00.000Z', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'a.bin', size: 4, checksums: ['d'.repeat(64)] }] } as ILISH;
const dirs: string[] = [];

afterEach(async () => {
	setActiveDownloadersRef(new Map());
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

test('a local download waits for a real import owning the ID and is refused by the publisher it stored', async () => {
	initDownloadState(new Set(), () => {});
	initUploadState(new Set(), () => {});
	const dataDir = await tempDir('lish-local-data-');
	const db = openDatabase(dataDir);
	const dataServer = new DataServer(db);
	const settings = await Settings.create(dataDir);
	await settings.set('storage.tempPath', await tempDir('lish-local-tmp-'));
	await settings.set('network.autoStartSharing', false);
	await settings.set('network.autoStartDownloading', false);
	const lishs = initLISHsHandlers(
		dataServer,
		() => {},
		() => {},
		settings
	);
	const lishPath = join(await tempDir('lish-local-file-'), 'item.lish');
	await writeFile(lishPath, JSON.stringify(await sign(manifest, keyQ)));
	const networks = { getRunningNetwork: () => new MockNetwork(), set onNetworkLeft(_c: unknown) {}, set onNetworkJoined(_c: unknown) {} } as unknown as Networks;
	const handlers = initTransferHandlers(
		networks,
		dataServer,
		dataDir,
		() => {},
		() => {},
		settings
	);
	const start = spyOn(Downloader.prototype, 'download').mockImplementation(() => new Promise(() => {}));
	// Known point: the file was read and passed its first comparison, with nothing stored yet.
	const realInit = Downloader.prototype.init;
	let releaseInit!: () => void;
	const initHeld = new Promise<void>(resolve => (releaseInit = resolve));
	let initDone = false;
	const init = spyOn(Downloader.prototype, 'init').mockImplementation(async function (this: Downloader, path: string) {
		await realInit.call(this, path);
		initDone = true;
		await initHeld;
	});
	try {
		const downloading = handlers.download({ networkID: 'net-a', lishPath }, undefined);
		downloading.catch(() => {});
		while (!initDone) await Bun.sleep(2);
		// The real import of A writes A, then holds the ID while it stops old work for it.
		let releaseA!: () => void;
		const heldA = new Promise<void>(resolve => (releaseA = resolve));
		let stopping = false;
		setActiveDownloadersRef(new Map([[ID, { destroy: () => ((stopping = true), heldA) }]]));
		const importingA = lishs.importManifest(await sign(manifest, keyA), await tempDir('lish-local-dl-'));
		while (!stopping) await Bun.sleep(2);
		releaseInit();
		// The download now waits for the ID behind the import.
		while (lishOwnershipUsers(ID) < 2) await Bun.sleep(2);
		expect(handlers.getActiveTransfers()).toEqual([]);
		releaseA();
		await importingA;
		await expect(downloading).rejects.toMatchObject({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH });
		expect(start).not.toHaveBeenCalled();
		expect(handlers.getActiveTransfers()).toEqual([]);
		expect(dataServer.get(ID as never)?.publisher).toBe(peerIdFromPrivateKey(keyA).toString());
	} finally {
		start.mockRestore();
		init.mockRestore();
		await lishs.stopVerifyAll();
		db.close();
	}
});

test('a local download cannot activate while a real import holds the ID before writing anything', async () => {
	initDownloadState(new Set(), () => {});
	initUploadState(new Set(), () => {});
	const dataDir = await tempDir('lish-local-data-');
	const db = openDatabase(dataDir);
	const dataServer = new DataServer(db);
	const settings = await Settings.create(dataDir);
	await settings.set('storage.tempPath', await tempDir('lish-local-tmp-'));
	await settings.set('network.autoStartSharing', false);
	await settings.set('network.autoStartDownloading', false);
	const lishs = initLISHsHandlers(
		dataServer,
		() => {},
		() => {},
		settings
	);
	const lishPath = join(await tempDir('lish-local-file-'), 'item.lish');
	await writeFile(lishPath, JSON.stringify(await sign(manifest, keyQ)));
	const networks = { getRunningNetwork: () => new MockNetwork(), set onNetworkLeft(_c: unknown) {}, set onNetworkJoined(_c: unknown) {} } as unknown as Networks;
	const handlers = initTransferHandlers(
		networks,
		dataServer,
		dataDir,
		() => {},
		() => {},
		settings
	);
	const start = spyOn(Downloader.prototype, 'download').mockImplementation(() => new Promise(() => {}));
	// Known point: the file was read and passed its first comparison, with nothing stored yet.
	const realInit = Downloader.prototype.init;
	let releaseInit!: () => void;
	const initHeld = new Promise<void>(resolve => (releaseInit = resolve));
	let initDone = false;
	const init = spyOn(Downloader.prototype, 'init').mockImplementation(async function (this: Downloader, path: string) {
		await realInit.call(this, path);
		initDone = true;
		await initHeld;
	});
	let open: { mockRestore(): void } | undefined;
	try {
		const downloading = handlers.download({ networkID: 'net-a', lishPath }, undefined);
		downloading.catch(() => {});
		while (!initDone) await Bun.sleep(2);
		// The real import of A takes the ID and is held at its first preparation step: A is not stored.
		let releaseA!: () => void;
		const heldA = new Promise<void>(resolve => (releaseA = resolve));
		let preparing = false;
		const realOpen = files.openDataset;
		open = spyOn(files, 'openDataset').mockImplementation((async (...args: Parameters<typeof realOpen>) => {
			if (!preparing) {
				preparing = true;
				await heldA;
			}
			return realOpen(...args);
		}) as typeof realOpen);
		const importingA = lishs.importManifest(await sign(manifest, keyA), await tempDir('lish-local-dl-'));
		while (!preparing) await Bun.sleep(2);
		releaseInit();
		// The download now waits behind the import; neither A nor an active download exists yet.
		while (lishOwnershipUsers(ID) < 2) await Bun.sleep(2);
		expect(dataServer.get(ID as never)).toBeFalsy();
		expect(handlers.getActiveTransfers()).toEqual([]);
		releaseA();
		await importingA;
		await expect(downloading).rejects.toMatchObject({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH });
		expect(start).not.toHaveBeenCalled();
		expect(handlers.getActiveTransfers()).toEqual([]);
		expect(dataServer.get(ID as never)?.publisher).toBe(peerIdFromPrivateKey(keyA).toString());
	} finally {
		start.mockRestore();
		init.mockRestore();
		open?.mockRestore();
		await lishs.stopVerifyAll();
		db.close();
	}
});
