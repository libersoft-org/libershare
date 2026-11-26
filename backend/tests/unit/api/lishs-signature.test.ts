import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { encode as lpEncode } from 'it-length-prefixed';
import { CodedError, ErrorCodes, signedManifestBytes, unverifiedLISHFromError, type ILISH } from '@shared';
import { encode as codecEncode } from '../../../src/protocol/codec.ts';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { DEFAULT_MAX_CHUNK_SIZE, Settings } from '../../../src/settings.ts';
import { initLISHsHandlers, type ManifestSigner } from '../../../src/api/lishs.ts';
import { initLISHnetsHandlers } from '../../../src/api/lishnets.ts';
import { setActiveDownloadersRef } from '../../../src/api/transfer.ts';
import { ManifestAdmission } from '../../../src/lish/manifest-admission.ts';
import { lishOwnershipUsers, withLISHOwnership } from '../../../src/lish/lish-ownership.ts';
import { UNSIGNED, VERIFIED, fixedIDOf, signFixed as sign, signKeepingID } from '../helpers/signing.ts';

/**
 * The signature through the real import, create and add-from-peer pipelines over a real store:
 * it survives storage, a stored publisher is never replaced, and a conflict is refused before
 * any running work for the item is stopped.
 */

const keyA = await generateKeyPairFromSeed(
	'Ed25519',
	Uint8Array.from({ length: 32 }, (_, i) => i + 1)
);
const keyQ = await generateKeyPairFromSeed(
	'Ed25519',
	Uint8Array.from({ length: 32 }, (_, i) => 100 + i)
);
const A = peerIdFromPrivateKey(keyA).toString();
const ID = fixedIDOf(keyA);

function manifest(overrides: Record<string, unknown> = {}): ILISH {
	return { id: ID, name: 'Signed', created: '2026-10-08T10:00:00.000Z', chunkSize: 1024, checksumAlgo: 'sha256', files: [{ path: 'a.bin', size: 1024, checksums: ['b'.repeat(64)] }], ...overrides } as ILISH;
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
		expect(await ManifestAdmission.check(stored)).toEqual(VERIFIED);
		expect((await lishs.get({ lishID: ID }))?.publisher).toBe(A);
	});

	it('an import from a URL verifies the signature like any other import', async () => {
		const signed = await sign(manifest(), keyA);
		const bodies = [JSON.stringify({ ...signed, name: 'Forged' }), JSON.stringify(signed)];
		const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(bodies.shift()) });
		try {
			const url = `http://127.0.0.1:${server.port}/item.lish`;
			await expect(handlers().importFromURL({ url, downloadPath: downloadDir })).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_SIGNATURE });
			expect(dataServer.get(ID)).toBeFalsy();
			await handlers().importFromURL({ url, downloadPath: downloadDir });
			expect(dataServer.get(ID)?.publisher).toBe(A);
		} finally {
			server.stop(true);
		}
	});

	it('refuses an overwrite by another publisher before stopping the running work of the stored one', async () => {
		const lishs = handlers();
		await lishs.importManifest(await sign(manifest(), keyA), downloadDir);
		let destroyed = false;
		setActiveDownloadersRef(new Map([[ID, { destroy: async () => void (destroyed = true) }]]));
		// Neither can replace A's item, so neither is put to the user: a manifest that is not
		// verified would be kept without a publisher, and the stored one has A.
		for (const other of [await signKeepingID(manifest({ name: 'Q' }), keyQ), { ...(await sign(manifest(), keyA)), name: 'Changed' }, manifest({ name: 'unsigned' })]) {
			for (const acceptUnverified of [false, true]) {
				await expect(lishs.importManifest(other, downloadDir, { overwrite: true, acceptUnverified })).rejects.toMatchObject({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH });
			}
		}
		expect(destroyed).toBe(false);
		expect(dataServer.get(ID)).toMatchObject({ name: 'Signed', publisher: A });
	});

	it('an unsigned import arriving while a real import of A holds the ID is refused by what A stored', async () => {
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
		// Q reads A before it would wait for the ID, so it never queues behind A at all.
		const importingQ = lishs.importManifest(manifest({ name: 'Q' }), downloadDir, { overwrite: true, acceptUnverified: true });
		importingQ.catch(() => {});
		// From here on A has running work that only a passing Q would stop.
		let destroyedByQ = false;
		await expect(importingQ).rejects.toMatchObject({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH });
		expect(lishOwnershipUsers(ID)).toBe(1);
		releaseA();
		await importingA;
		setActiveDownloadersRef(new Map([[ID, { destroy: async () => void (destroyedByQ = true) }]]));
		expect(writes).toEqual([A]);
		expect(destroyedByQ).toBe(false);
		expect(dataServer.getDatasetRoot(ID)).toEqual(rootA);
		expect(dataServer.get(ID)).toMatchObject({ name: 'Signed', publisher: A, signature: signedA.signature });
	});

	it('an unsigned import verified before A existed re-reads the ID under the lock', async () => {
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
			importingQ = lishs.importManifest(manifest({ name: 'Q' }), downloadDir, { overwrite: true, acceptUnverified: true });
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

	it('a preview passes a manifest through unchanged, whatever its signature', async () => {
		const lishs = handlers();
		const signed = await sign(manifest(), keyA);
		// The preview only hands the manifest to the screen that imports it; the import decides.
		for (const lish of [signed, { ...signed, name: 'Changed' }]) expect(await lishs.parseFromJSON({ json: JSON.stringify(lish) })).toEqual([lish]);
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

	it('a file preview shows the checks of each item and reports a loosely shaped signed manifest', async () => {
		const lishs = handlers();
		const signed = await sign(manifest(), keyA);
		const unsigned = manifest({ id: 'd0000000-0000-4000-8000-000000000005', version: 1 });
		const filePath = join(await tempDir('lish-sig-inspect-'), 'mixed.lishs');
		await writeFile(filePath, JSON.stringify([signed, { ...signed, name: 'Changed' }, await signKeepingID(manifest(), keyQ), { ...signed, extra: 1 }, unsigned]));
		const [ok, tampered, taken, loose, plain] = (await lishs.inspectFile({ filePath })).items;
		expect(ok!.error).toBeUndefined();
		expect(ok!.detail).toMatchObject({ publisher: A, checks: VERIFIED });
		// A manifest that fails a check is shown with what failed; its publisher is only what it names.
		expect(tampered!.error).toBeUndefined();
		expect(tampered!.detail).toMatchObject({ namedPublisher: A, checks: { signed: true, signatureValid: false, idMatchesPublisher: true } });
		expect(tampered!.detail!.publisher).toBeUndefined();
		expect(taken!.detail).toMatchObject({ namedPublisher: peerIdFromPrivateKey(keyQ).toString(), checks: { signed: true, signatureValid: true, idMatchesPublisher: false } });
		expect(loose).toMatchObject({ error: ErrorCodes.LISH_INVALID_MANIFEST });
		expect(plain!.error).toBeUndefined();
		expect(plain!.detail).toMatchObject({ checks: UNSIGNED });
		expect(plain!.detail!.publisher).toBeUndefined();
	});
});

describe('adding a manifest that is not verified', () => {
	const failedSignature = { signed: true, signatureValid: false, idMatchesPublisher: true };

	/** The question an import leaves open: the refusal, read as the client reads it. */
	async function asked(importing: Promise<unknown>) {
		return unverifiedLISHFromError(await importing.catch(error => error))!;
	}

	it('asks first, and adds exactly the held manifest once the user agrees', async () => {
		const lishs = handlers();
		const question = await asked(lishs.importManifest(manifest(), downloadDir));
		expect(question).toMatchObject({ code: 'LISH_UNSIGNED', checks: UNSIGNED });
		expect(dataServer.get(ID)).toBeFalsy();
		expect(await lishs.answerUnverified({ token: question.token!, accept: true })).toMatchObject({ lishID: ID });
		expect(dataServer.get(ID)).toMatchObject({ name: 'Signed' });
		expect((await lishs.get({ lishID: ID }))!.checks).toEqual(UNSIGNED);
		// One answer per question.
		await expect(lishs.answerUnverified({ token: question.token!, accept: true })).rejects.toMatchObject({ code: ErrorCodes.LISH_CONFIRMATION_EXPIRED });
	});

	it('adds nothing when the user refuses', async () => {
		const lishs = handlers();
		const question = await asked(lishs.importManifest(manifest(), downloadDir));
		expect(await lishs.answerUnverified({ token: question.token!, accept: false })).toBeNull();
		expect(dataServer.get(ID)).toBeFalsy();
		await expect(lishs.answerUnverified({ token: question.token!, accept: true })).rejects.toMatchObject({ code: ErrorCodes.LISH_CONFIRMATION_EXPIRED });
	});

	it('names the first failed check and keeps a manifest that failed one as an unsigned body', async () => {
		const lishs = handlers();
		const forged = { ...(await sign(manifest(), keyA)), name: 'Changed' };
		const question = await asked(lishs.importManifest(forged, downloadDir));
		expect(question).toMatchObject({ code: 'LISH_INVALID_SIGNATURE', checks: failedSignature, publisher: A });
		await lishs.answerUnverified({ token: question.token!, accept: true });
		// Nothing downstream may take the claimed publisher for a fact: it is not stored at all.
		const stored = dataServer.get(ID)!;
		expect(stored).toMatchObject({ name: 'Changed' });
		expect(stored.publisher).toBeUndefined();
		expect(stored.signature).toBeUndefined();
		expect(stored.nonce).toBeUndefined();
		expect(dataServer.getPublisher(ID)).toBeNull();
		// The detail still says what failed.
		const detail = (await lishs.get({ lishID: ID }))!;
		expect(detail.checks).toEqual(failedSignature);
		expect(detail.publisher).toBeUndefined();
	});

	it("keeps which check failed for an ID that is not the signer's", async () => {
		const lishs = handlers();
		const taken = await signKeepingID(manifest(), keyQ);
		const question = await asked(lishs.importManifest(taken, downloadDir));
		expect(question.code).toBe('LISH_ID_MISMATCH');
		await lishs.answerUnverified({ token: question.token!, accept: true });
		expect((await lishs.get({ lishID: ID }))!.checks).toEqual({ signed: true, signatureValid: true, idMatchesPublisher: false });
	});

	it('adds without asking when the caller says the user already agreed', async () => {
		const lishs = handlers();
		await lishs.importFromJSON({ json: JSON.stringify(manifest()), downloadPath: downloadDir, acceptUnverified: true });
		expect(dataServer.get(ID)).toMatchObject({ name: 'Signed' });
	});

	const plainID = '6f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b';

	it('holds a request of several manifests as it was read, and a yes adds exactly those', async () => {
		const lishs = handlers();
		const signed = await sign(manifest(), keyA);
		// What the address holds once the question is open: the same IDs, other content.
		const bodies = [JSON.stringify([signed, manifest({ id: plainID, name: 'Plain' })]), JSON.stringify([signed, manifest({ id: plainID, name: 'Swapped' })])];
		const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(bodies.shift()) });
		try {
			const question = await asked(lishs.importFromURL({ url: `http://127.0.0.1:${server.port}/items.lish`, downloadPath: downloadDir }));
			expect(question).toMatchObject({ code: 'LISH_UNSIGNED', checks: UNSIGNED });
			// Nothing of the request is added before the answer, the verified manifest included.
			expect(dataServer.get(ID)).toBeFalsy();
			await lishs.answerUnverified({ token: question.token!, accept: true });
			expect(dataServer.getPublisher(ID)).toBe(A);
			expect(dataServer.get(plainID)).toMatchObject({ name: 'Plain' });
			// The address was read once.
			expect(bodies).toHaveLength(1);
		} finally {
			server.stop(true);
		}
	});

	it('a waiting request of several manifests does not keep the text it was read from', async () => {
		const lishs = handlers();
		// Asked from a function of its own, so nothing of the request stays on this one's stack.
		const ask = async () => {
			const params = { json: JSON.stringify([manifest(), manifest({ id: plainID, name: 'Plain' })]), downloadPath: downloadDir };
			return { token: (await asked(lishs.importFromJSON(params))).token!, params: new WeakRef(params) };
		};
		const { token, params } = await ask();
		// Collection takes a moment; a request the open question holds on to would never go.
		for (let tries = 0; tries < 50 && params.deref(); tries++) {
			await Bun.sleep(10);
			Bun.gc(true);
		}
		expect(params.deref()).toBeUndefined();
		expect(await lishs.answerUnverified({ token, accept: false })).toBeNull();
	});

	it('names the manifest that failed a check among several unverified ones, and a no adds none', async () => {
		const lishs = handlers();
		const forged = { ...(await sign(manifest(), keyA)), name: 'Changed' };
		const json = JSON.stringify([manifest({ id: plainID, name: 'Plain' }), forged]);
		const question = await asked(lishs.importFromJSON({ json, downloadPath: downloadDir }));
		expect(question).toMatchObject({ code: 'LISH_INVALID_SIGNATURE', checks: failedSignature, publisher: A });
		expect(await lishs.answerUnverified({ token: question.token!, accept: false })).toBeNull();
		expect(dataServer.get(plainID)).toBeFalsy();
		expect(dataServer.get(ID)).toBeFalsy();
		// A caller whose user agreed beforehand is not asked.
		await lishs.importFromJSON({ json, downloadPath: downloadDir, acceptUnverified: true });
		expect(dataServer.get(plainID)).toMatchObject({ name: 'Plain' });
		expect(dataServer.get(ID)).toMatchObject({ name: 'Changed' });
	});

	it('lets go of a question an import raised while maintenance was pausing', async () => {
		const lishs = handlers();
		// The import is past the gate when the pause begins, and raises its question only after that.
		const importing = asked(lishs.importManifest(manifest(), downloadDir));
		await lishs.pauseMutations();
		const question = await importing;
		lishs.resumeMutations();
		await expect(lishs.answerUnverified({ token: question.token!, accept: true })).rejects.toMatchObject({ code: ErrorCodes.LISH_CONFIRMATION_EXPIRED });
		expect(dataServer.get(ID)).toBeFalsy();
	});

	it('never lets the agreement cover a broken shape', async () => {
		const lishs = handlers();
		const signed = await sign(manifest(), keyA);
		await expect(lishs.importManifest({ ...signed, extra: 1 } as never, downloadDir, { acceptUnverified: true })).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_MANIFEST });
		expect(dataServer.get(ID)).toBeFalsy();
	});

	it('does not ask about an ID that is already stored', async () => {
		const lishs = handlers();
		await lishs.importManifest(manifest(), downloadDir, { acceptUnverified: true });
		await expect(lishs.importManifest(manifest({ name: 'Again' }), downloadDir)).rejects.toMatchObject({ code: ErrorCodes.LISH_ALREADY_EXISTS });
	});

	it('keeps the failed checks of a stored item when a later write gives none', async () => {
		const lishs = handlers();
		const forged = { ...(await sign(manifest(), keyA)), name: 'Changed' };
		await lishs.importManifest(forged, downloadDir, { acceptUnverified: true });
		// The downloader storing a manifest it fetched on its own: an unsigned body, no checks.
		dataServer.add({ ...manifest({ name: 'Changed' }), directory: dataServer.get(ID)!.directory } as never);
		expect((await lishs.get({ lishID: ID }))!.checks).toEqual(failedSignature);
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
				expect(await ManifestAdmission.check(stored)).toEqual(VERIFIED);
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
		expect(await ManifestAdmission.check(stored)).toEqual(VERIFIED);
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
		expect(await ManifestAdmission.check(written)).toEqual(VERIFIED);
	});

	it('rejects a non-boolean sign before creating a LISH', async () => {
		const source = join(await tempDir('lish-sig-src-'), 'data.bin');
		await writeFile(source, 'payload');
		await expect(handlers(signerA).create({ dataPath: source, addToSharing: true, sign: 'false' } as never, undefined)).rejects.toMatchObject({ code: ErrorCodes.INVALID_INPUT_TYPE });
		expect(dataServer.list()).toHaveLength(0);
	});

	it('refuses to sign without a running network and creates nothing', async () => {
		const source = join(await tempDir('lish-sig-src-'), 'data.bin');
		await writeFile(source, 'payload');
		await expect(handlers().create({ dataPath: source, addToSharing: true, sign: true } as never, undefined as never)).rejects.toMatchObject({ code: ErrorCodes.NETWORK_NOT_RUNNING });
		expect(dataServer.list()).toHaveLength(0);
	});

	it('refuses a key or a stopped network before hashing the dataset', async () => {
		const source = join(await tempDir('lish-sig-src-'), 'data.bin');
		await writeFile(source, 'payload');
		for (const code of [ErrorCodes.LISH_SIGNING_UNSUPPORTED_KEY, ErrorCodes.NETWORK_NOT_RUNNING]) {
			const events: string[] = [];
			let signed = 0;
			const signer: ManifestSigner = lish => {
				signed++;
				return signerA(lish);
			};
			const lishs = initLISHsHandlers(
				dataServer,
				(_client, event) => events.push(event),
				() => {},
				settings,
				signer,
				() => {
					throw new CodedError(code);
				}
			);
			created.push(lishs);
			await expect(lishs.create({ dataPath: source, addToSharing: true, sign: true } as never, undefined as never)).rejects.toMatchObject({ code });
			expect(events.filter(event => event === 'lishs.create:progress')).toEqual([]);
			expect(signed).toBe(0);
			expect(dataServer.list()).toHaveLength(0);
		}
	});
});

describe('add from a peer checks the expected publisher', () => {
	/** A peer answering each manifest request with the next of `served`, the last one from then on. */
	function lishnetsOver(...served: ILISH[]) {
		let dials = 0;
		const network = {
			getRunningNetwork: () => ({
				dialProtocolByPeerId: async () => {
					const manifest = served[Math.min(dials++, served.length - 1)];
					return {
						stream: {
							status: 'open',
							send() {},
							close: async () => {},
							async *[Symbol.asyncIterator]() {
								yield lpEncode.single(codecEncode({ manifest })).subarray();
							},
						},
					};
				},
			}),
		} as never;
		const lishs = handlers();
		const lishnets = initLISHnetsHandlers(network, dataServer, () => {}, settings, lishs.importManifestAdmitted, lishs.runMutation, new AbortController().signal);
		return Object.assign(lishnets, { lishs, dials: () => dials });
	}

	// The user sees why this node refused the manifest, not a generic "peer rejected the request".
	it('refuses an unsigned manifest for a row that names a publisher', async () => {
		const lishnets = lishnetsOver(manifest({ name: 'stripped' }));
		await expect(lishnets.addPeerLish({ lishID: ID, peerID: 'p', networkID: 'n', expectedPublisher: A })).rejects.toMatchObject({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH });
		expect(dataServer.get(ID)).toBeFalsy();
	});

	it('refuses a manifest signed by a key the ID was not made for', async () => {
		const lishnets = lishnetsOver(await signKeepingID(manifest(), keyQ));
		await expect(lishnets.addPeerLish({ lishID: ID, peerID: 'p', networkID: 'n' })).rejects.toMatchObject({ code: ErrorCodes.LISH_ID_MISMATCH });
		expect(dataServer.get(ID)).toBeFalsy();
	});

	it('refuses a signed manifest for an unsigned row', async () => {
		const lishnets = lishnetsOver(await sign(manifest(), keyA));
		await expect(lishnets.getPeerLish({ lishID: ID, peerID: 'p', networkID: 'n', expectedPublisher: null })).rejects.toMatchObject({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH });
	});

	it('shows a signed manifest changed on the way as not verified, and asks before adding it', async () => {
		const forged = { ...(await sign(manifest(), keyA)), name: 'Forged' };
		const failedSignature = { signed: true, signatureValid: false, idMatchesPublisher: true };
		const detail = await lishnetsOver(forged).getPeerLish({ lishID: ID, peerID: 'p', networkID: 'n', expectedPublisher: A });
		expect(detail).toMatchObject({ name: 'Forged', checks: failedSignature, namedPublisher: A });
		expect(detail.publisher).toBeUndefined();
		const question = unverifiedLISHFromError(
			await lishnetsOver(forged)
				.addPeerLish({ lishID: ID, peerID: 'p', networkID: 'n', expectedPublisher: A })
				.catch(error => error)
		)!;
		expect(question).toMatchObject({ code: 'LISH_INVALID_SIGNATURE', checks: failedSignature, publisher: A });
		expect(question.token).toBeString();
		expect(dataServer.get(ID)).toBeFalsy();
	});

	it('adds the manifest the user was asked about, not one fetched again', async () => {
		// The peer would answer a second request with something else under the same ID.
		const lishnets = lishnetsOver(manifest({ name: 'Asked about' }), manifest({ name: 'Swapped in' }));
		const question = unverifiedLISHFromError(await lishnets.addPeerLish({ lishID: ID, peerID: 'p', networkID: 'n', expectedPublisher: null }).catch(error => error))!;
		expect(question.code).toBe('LISH_UNSIGNED');
		await lishnets.lishs.answerUnverified({ token: question.token!, accept: true });
		expect(dataServer.get(ID)).toMatchObject({ name: 'Asked about' });
		expect(lishnets.dials()).toBe(1);
	});

	it('still blames the peer for a forged signed manifest with an over-limit chunk size', async () => {
		const huge = DEFAULT_MAX_CHUNK_SIZE * 2;
		const forged = { ...(await sign(manifest(), keyA)), chunkSize: huge, files: [{ path: 'a.bin', size: huge, checksums: ['b'.repeat(64)] }] };
		// Nothing to ask the user here: the limit would refuse it anyway, and the forgery is the peer's.
		await expect(lishnetsOver(forged).addPeerLish({ lishID: ID, peerID: 'p', networkID: 'n' })).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_SIGNATURE });
		expect(dataServer.get(ID)).toBeFalsy();
	});

	it('reports a manifest version the requester cannot read', async () => {
		const signed = await sign(manifest(), keyA);
		const lishnets = lishnetsOver({ ...signed, version: 2 });
		await expect(lishnets.getPeerLish({ lishID: ID, peerID: 'p', networkID: 'n' })).rejects.toMatchObject({ code: ErrorCodes.LISH_INVALID_MANIFEST, detail: 'unsupported manifest version 2' });
	});

	it('without a picked row, expects the publisher already stored under the ID', async () => {
		await handlers().importManifest(await sign(manifest(), keyA), downloadDir);
		const lishnets = lishnetsOver(manifest({ name: 'stripped' }));
		await expect(lishnets.getPeerLish({ lishID: ID, peerID: 'p', networkID: 'n' })).rejects.toMatchObject({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH });
	});

	it('expects the stored publisher even when the picked row is an unsigned one', async () => {
		await handlers().importManifest(await sign(manifest(), keyA), downloadDir);
		const lishnets = lishnetsOver(manifest({ name: 'stripped' }));
		await expect(lishnets.getPeerLish({ lishID: ID, peerID: 'p', networkID: 'n', expectedPublisher: null })).rejects.toMatchObject({ code: ErrorCodes.LISH_PUBLISHER_MISMATCH });
	});

	it('shows the verified publisher in the preview', async () => {
		const lishnets = lishnetsOver(await sign(manifest(), keyA));
		expect((await lishnets.getPeerLish({ lishID: ID, peerID: 'p', networkID: 'n', expectedPublisher: A })).publisher).toBe(A);
	});
});
