import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { encode as lpEncode } from 'it-length-prefixed';
import { encodeSignature, ErrorCodes, signedManifestBytes, type ILISH, type LISHid } from '@shared';
import { encode as codecEncode } from '../../../src/protocol/codec.ts';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers, type ManifestSigner } from '../../../src/api/lishs.ts';
import { initLISHnetsHandlers } from '../../../src/api/lishnets.ts';
import { setActiveDownloadersRef } from '../../../src/api/transfer.ts';
import { verifyManifestSignature } from '../../../src/lish/manifest-signature.ts';
import { lishOwnershipUsers, withLISHOwnership } from '../../../src/lish/lish-ownership.ts';

/**
 * The signature through the real import, create and add-from-peer pipelines over a real store:
 * it survives storage, a stored publisher is never replaced, and a conflict is refused before
 * any running work for the item is stopped.
 */

const ID = 'd0000000-0000-4000-8000-000000000004' as LISHid;
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
	return { id: ID, name: 'Signed', created: '2026-10-08T10:00:00.000Z', chunkSize: 1024, checksumAlgo: 'sha256', files: [{ path: 'a.bin', size: 1024, checksums: ['b'.repeat(64)] }], ...overrides } as ILISH;
}

async function sign(lish: ILISH, key: typeof keyA): Promise<ILISH> {
	const withPublisher = { ...lish, publisher: peerIdFromPrivateKey(key).toString() };
	return { ...withPublisher, signature: encodeSignature(await key.sign(signedManifestBytes(withPublisher))) };
}

const signerA: ManifestSigner = lish => sign(lish, keyA);

let dirs: string[] = [];
let created: Array<ReturnType<typeof initLISHsHandlers>> = [];
let db: ReturnType<typeof openDatabase>;
let dataServer: DataServer;
let settings: Settings;
let downloadDir: string;

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

beforeEach(async () => {
	dirs = [];
	created = [];
	const dataDir = await tempDir('lish-sig-data-');
	downloadDir = await tempDir('lish-sig-dl-');
	db = openDatabase(dataDir);
	dataServer = new DataServer(db);
	settings = await Settings.create(dataDir);
	await settings.set('storage.downloadPath', downloadDir);
	await settings.set('storage.tempPath', await tempDir('lish-sig-tmp-'));
	await settings.set('network.autoStartSharing', false);
	await settings.set('network.autoStartDownloading', false);
});

afterEach(async () => {
	setActiveDownloadersRef(new Map());
	// Imports queue a verification pass; it must end before the database closes under it.
	for (const handler of created) await handler.stopVerifyAll();
	db.close();
	for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function handlers(signer?: ManifestSigner): ReturnType<typeof initLISHsHandlers> {
	const handler = initLISHsHandlers(
		dataServer,
		() => {},
		() => {},
		settings,
		signer
	);
	created.push(handler);
	return handler;
}

describe('import keeps the signature', () => {
	it('stores publisher and signature so the stored body still verifies and the API reports the publisher', async () => {
		const lishs = handlers();
		await lishs.importManifest(await sign(manifest(), keyA), downloadDir);
		const stored = dataServer.get(ID)!;
		expect(await verifyManifestSignature(stored)).toEqual({ signed: true, publisher: A });
		expect((await lishs.get({ lishID: ID }))?.publisher).toBe(A);
	});

	it('refuses an overwrite by another publisher before stopping the running work of the stored one', async () => {
		const lishs = handlers();
		await lishs.importManifest(await sign(manifest(), keyA), downloadDir);
		let destroyed = false;
		setActiveDownloadersRef(new Map([[ID, { destroy: async () => void (destroyed = true) }]]));
		for (const other of [await sign(manifest({ name: 'Q' }), keyQ), manifest({ name: 'unsigned' })]) {
			await expect(lishs.importManifest(other, downloadDir, { overwrite: true })).rejects.toMatchObject({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH });
		}
		expect(destroyed).toBe(false);
		expect(dataServer.get(ID)).toMatchObject({ name: 'Signed', publisher: A });
	});

	for (const variant of ['another key', 'unsigned'] as const) {
		it(`an import (${variant}) queued behind a real import of A reads A under the lock and never reaches its own write`, async () => {
			const lishs = handlers();
			// A's import holds the ID: it has written A and is stopping old work, which the test holds.
			let releaseA!: () => void;
			const heldA = new Promise<void>(resolve => (releaseA = resolve));
			setActiveDownloadersRef(new Map([[ID, { destroy: () => heldA }]]));
			const writes: string[] = [];
			const realAdd = dataServer.addDataset.bind(dataServer);
			dataServer.addDataset = (lish, root, finalRoot, options) => {
				writes.push(lish.publisher ?? 'unsigned');
				return realAdd(lish, root, finalRoot, options);
			};
			const signedA = await sign(manifest(), keyA);
			const importingA = lishs.importManifest(signedA, downloadDir);
			while (writes.length === 0) await Bun.sleep(2);
			const rootA = dataServer.getDatasetRoot(ID);
			// Q passed its own checks and now waits for the ID (owner + one waiter).
			const other = variant === 'unsigned' ? manifest({ name: 'Q' }) : await sign(manifest({ name: 'Q' }), keyQ);
			const importingQ = lishs.importManifest(other, downloadDir, { overwrite: true });
			importingQ.catch(() => {});
			while (lishOwnershipUsers(ID) < 2) await Bun.sleep(2);
			// From here on A has running work that only a passing Q would stop.
			let destroyedByQ = false;
			releaseA();
			await importingA;
			setActiveDownloadersRef(new Map([[ID, { destroy: async () => void (destroyedByQ = true) }]]));
			await expect(importingQ).rejects.toMatchObject({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH });
			expect(writes).toEqual([A]);
			expect(destroyedByQ).toBe(false);
			expect(dataServer.getDatasetRoot(ID)).toEqual(rootA);
			expect(dataServer.get(ID)).toMatchObject({ name: 'Signed', publisher: A, signature: signedA.signature });
		});
	}

	for (const variant of ['another key', 'unsigned'] as const) {
		it(`an import (${variant}) verified before A existed re-reads the ID under the lock`, async () => {
			const lishs = handlers();
			const writes: string[] = [];
			const realAdd = dataServer.addDataset.bind(dataServer);
			dataServer.addDataset = (lish, root, finalRoot, options) => {
				writes.push(lish.publisher ?? 'unsigned');
				return realAdd(lish, root, finalRoot, options);
			};
			const signedA = await sign(manifest(), keyA);
			const rootA = { kind: 'explicit' as const, path: await tempDir('lish-sig-roota-') };
			let destroyedByQ = false;
			let importingQ!: Promise<unknown>;
			await withLISHOwnership(ID, async () => {
				const other = variant === 'unsigned' ? manifest({ name: 'Q' }) : await sign(manifest({ name: 'Q' }), keyQ);
				importingQ = lishs.importManifest(other, downloadDir, { overwrite: true });
				importingQ.catch(() => {});
				// Q has passed every check made without the lock and now waits; nothing is stored yet.
				while (lishOwnershipUsers(ID) < 2) await Bun.sleep(2);
				expect(dataServer.get(ID)).toBeFalsy();
				// Only now does the owner store A and start work for it.
				dataServer.addDataset(signedA as never, rootA);
				setActiveDownloadersRef(new Map([[ID, { destroy: async () => void (destroyedByQ = true) }]]));
			});
			await expect(importingQ).rejects.toMatchObject({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH });
			expect(writes).toEqual([A]);
			expect(destroyedByQ).toBe(false);
			expect(dataServer.getDatasetRoot(ID)).toEqual(rootA);
			expect(dataServer.get(ID)).toMatchObject({ name: 'Signed', publisher: A, signature: signedA.signature });
		});
	}

	it('refuses a signature that does not match the body', async () => {
		const lishs = handlers();
		await expect(lishs.importManifest({ ...(await sign(manifest(), keyA)), name: 'Changed' }, downloadDir)).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_SIGNATURE });
		expect(dataServer.get(ID)).toBeFalsy();
	});

	it('a preview refuses a bad signature and passes a good one through unchanged', async () => {
		const lishs = handlers();
		const signed = await sign(manifest(), keyA);
		expect(await lishs.parseFromJSON({ json: JSON.stringify(signed) })).toEqual([signed]);
		await expect(lishs.parseFromJSON({ json: JSON.stringify({ ...signed, name: 'Changed' }) })).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_SIGNATURE });
	});

	it('a preview refuses a signed manifest carrying non-text fields the signature does not cover', async () => {
		const lishs = handlers();
		const { name: _name, ...nameless } = manifest();
		const signed = await sign(nameless as ILISH, keyA);
		for (const extra of [{ name: false }, { description: 0 }]) {
			await expect(lishs.parseFromJSON({ json: JSON.stringify({ ...signed, ...extra }) })).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_MANIFEST });
		}
		// Validly signed, structurally broken (wrong checksum count): only the full structure check sees it.
		const broken = await sign(manifest({ files: [{ path: 'a.bin', size: 1024, checksums: ['b'.repeat(64), 'c'.repeat(64)] }] }), keyA);
		await expect(lishs.parseFromJSON({ json: JSON.stringify(broken) })).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_MANIFEST });
	});
});

describe('export and import keep the signed bytes', () => {
	it('single and bulk export, plain and compressed, import on another store with a valid signature', async () => {
		const original = await sign(manifest({ directories: [], links: [{ path: 'l', target: 'a.bin' }] }), keyA);
		await handlers().importManifest(original, downloadDir);
		const out = await tempDir('lish-sig-out-');
		const exports = handlers();
		const files = [join(out, 'one.lish'), join(out, 'one.lish.gz'), join(out, 'all.lish')];
		await exports.exportToFile({ lishID: ID, filePath: files[0]! });
		await exports.exportToFile({ lishID: ID, filePath: files[1]!, compress: true, compressionAlgorithm: 'gzip' });
		await exports.exportAllToFile({ filePath: files[2]! });
		const expected = signedManifestBytes(original);
		for (const file of files) {
			// A fresh node: its own database and settings.
			const otherDir = await tempDir('lish-sig-other-');
			const otherDB = openDatabase(otherDir);
			const otherStore = new DataServer(otherDB);
			const otherSettings = await Settings.create(otherDir);
			await otherSettings.set('storage.tempPath', await tempDir('lish-sig-othertmp-'));
			await otherSettings.set('network.autoStartSharing', false);
			await otherSettings.set('network.autoStartDownloading', false);
			const other = initLISHsHandlers(
				otherStore,
				() => {},
				() => {},
				otherSettings
			);
			try {
				const [parsed] = await other.parseFromFile({ filePath: file });
				expect(signedManifestBytes(parsed!)).toEqual(expected);
				await other.importFromFile({ filePath: file, downloadPath: await tempDir('lish-sig-otherdl-') });
				const stored = otherStore.get(ID)!;
				expect(signedManifestBytes(stored)).toEqual(expected);
				expect(await verifyManifestSignature(stored)).toEqual({ signed: true, publisher: A });
			} finally {
				await other.stopVerifyAll();
				otherDB.close();
			}
		}
	});
});

describe('create with sign', () => {
	it('signs the new manifest, stores it and reports the publisher', async () => {
		const source = join(await tempDir('lish-sig-src-'), 'data.bin');
		await writeFile(source, 'signed payload');
		const lishs = handlers(signerA);
		const result = await lishs.create({ dataPath: source, addToSharing: true, sign: true } as never, undefined as never);
		expect(result.publisher).toBe(A);
		const stored = dataServer.get(result.lishID)!;
		expect(await verifyManifestSignature(stored)).toEqual({ signed: true, publisher: A });
	});

	it('signs a manifest written only to a file, with sharing and downloading both off', async () => {
		const dir = await tempDir('lish-sig-src-');
		const source = join(dir, 'data.bin');
		await writeFile(source, 'file only payload');
		const lishFile = join(dir, 'item.lish');
		const result = await handlers(signerA).create({ dataPath: source, lishFile, addToSharing: false, addToDownloading: false, sign: true } as never, undefined as never);
		expect(result.publisher).toBe(A);
		expect(dataServer.list()).toHaveLength(0);
		const written = JSON.parse(await readFile(lishFile, 'utf8')) as ILISH;
		expect(await verifyManifestSignature(written)).toEqual({ signed: true, publisher: A });
	});

	it('refuses to sign without a running network and creates nothing', async () => {
		const source = join(await tempDir('lish-sig-src-'), 'data.bin');
		await writeFile(source, 'payload');
		await expect(handlers().create({ dataPath: source, addToSharing: true, sign: true } as never, undefined as never)).rejects.toMatchObject({ code: ErrorCodes.NETWORK_NOT_RUNNING });
		expect(dataServer.list()).toHaveLength(0);
	});
});

describe('add from a peer checks the expected publisher', () => {
	function peerServing(served: ILISH) {
		const stream = {
			status: 'open',
			send() {},
			close: async () => {},
			async *[Symbol.asyncIterator]() {
				yield lpEncode.single(codecEncode({ manifest: served })).subarray();
			},
		};
		return { getRunningNetwork: () => ({ dialProtocolByPeerId: async () => ({ stream }) }) } as never;
	}

	function lishnetsOver(served: ILISH) {
		const lishs = handlers();
		return initLISHnetsHandlers(peerServing(served), dataServer, () => {}, settings, lishs.importManifestAdmitted, lishs.runMutation, new AbortController().signal);
	}

	it('refuses another publisher than the row the user picked', async () => {
		const lishnets = lishnetsOver(await sign(manifest(), keyQ));
		await expect(lishnets.addPeerLish({ lishID: ID, peerID: 'p', networkID: 'n', expectedPublisher: A })).rejects.toMatchObject({ code: ErrorCodes.PEER_INVALID_REQUEST });
		expect(dataServer.get(ID)).toBeFalsy();
	});

	it('refuses a signed manifest for an unsigned row', async () => {
		const lishnets = lishnetsOver(await sign(manifest(), keyA));
		await expect(lishnets.getPeerLish({ lishID: ID, peerID: 'p', networkID: 'n', expectedPublisher: null })).rejects.toMatchObject({ code: ErrorCodes.PEER_INVALID_REQUEST });
	});

	it('without a picked row, expects the publisher already stored under the ID', async () => {
		await handlers().importManifest(await sign(manifest(), keyA), downloadDir);
		const lishnets = lishnetsOver(manifest({ name: 'stripped' }));
		await expect(lishnets.getPeerLish({ lishID: ID, peerID: 'p', networkID: 'n' })).rejects.toMatchObject({ code: ErrorCodes.PEER_INVALID_REQUEST });
	});

	it('shows the verified publisher in the preview', async () => {
		const lishnets = lishnetsOver(await sign(manifest(), keyA));
		expect((await lishnets.getPeerLish({ lishID: ID, peerID: 'p', networkID: 'n', expectedPublisher: A })).publisher).toBe(A);
	});
});
