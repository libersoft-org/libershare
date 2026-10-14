import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { encodeSignature, ErrorCodes, signedManifestBytes, validateLISHStructure, type ILISH } from '@shared';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { DEFAULT_MAX_CHUNK_SIZE, Settings } from '../../../src/settings.ts';
import { initLISHsHandlers, type ManifestSigner } from '../../../src/api/lishs.ts';
import { verifyManifestSignature } from '../../../src/lish/manifest-signature.ts';

/** Every shape of source a user can pick for a new LISH, signed and unsigned, through the real create. */

const key = await generateKeyPairFromSeed(
	'Ed25519',
	Uint8Array.from({ length: 32 }, (_, i) => i + 7)
);
const publisher = peerIdFromPrivateKey(key).toString();
const signer: ManifestSigner = async lish => {
	const withPublisher = { ...lish, publisher };
	return { ...withPublisher, signature: encodeSignature(await key.sign(signedManifestBytes(withPublisher as ILISH))) };
};

let dirs: string[] = [];
let handlers: ReturnType<typeof initLISHsHandlers>[] = [];
let db: ReturnType<typeof openDatabase>;
let dataServer: DataServer;
let settings: Settings;

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

beforeEach(async () => {
	dirs = [];
	handlers = [];
	const dataDir = await tempDir('lish-shapes-data-');
	db = openDatabase(dataDir);
	dataServer = new DataServer(db);
	settings = await Settings.create(dataDir);
});

afterEach(async () => {
	for (const handler of handlers) await handler.stopVerifyAll();
	db.close();
	for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function create(dataPath: string, sign: boolean) {
	const handler = initLISHsHandlers(
		dataServer,
		() => {},
		() => {},
		settings,
		signer
	);
	handlers.push(handler);
	return handler.create({ dataPath, addToSharing: true, chunkSize: 1024, sign } as never, undefined as never);
}

for (const sign of [false, true]) {
	describe(`create ${sign ? 'signed' : 'unsigned'}`, () => {
		/** The stored manifest, checked the way every receiver checks it. */
		async function stored(lishID: string): Promise<ILISH> {
			const lish = dataServer.get(lishID)!;
			validateLISHStructure(lish, DEFAULT_MAX_CHUNK_SIZE);
			expect(await verifyManifestSignature(lish)).toEqual(sign ? { signed: true, publisher } : { signed: false });
			return lish;
		}

		it('a single file', async () => {
			const dir = await tempDir('lish-shapes-src-');
			await writeFile(join(dir, 'data.bin'), Buffer.alloc(3000, 1));
			const lish = await stored((await create(join(dir, 'data.bin'), sign)).lishID);
			expect(lish.files!.map(f => [f.path, f.size, f.checksums.length])).toEqual([['data.bin', 3000, 3]]);
		});

		it('nested folders with content next to empty folders', async () => {
			const dir = await tempDir('lish-shapes-src-');
			await mkdir(join(dir, 'a', 'b'), { recursive: true });
			await mkdir(join(dir, 'a', 'empty-inner'));
			await mkdir(join(dir, 'empty-top'));
			await writeFile(join(dir, 'a', 'b', 'deep.bin'), Buffer.alloc(2048, 2));
			await writeFile(join(dir, 'a', 'note.txt'), 'note');
			await writeFile(join(dir, 'root.txt'), 'root');
			const lish = await stored((await create(dir, sign)).lishID);
			expect(lish.files!.map(f => f.path).sort()).toEqual(['a/b/deep.bin', 'a/note.txt', 'root.txt']);
			expect(lish.directories!.map(d => d.path).sort()).toEqual(['a', 'a/b', 'a/empty-inner', 'empty-top']);
		});

		it('a folder whose only file is empty', async () => {
			const dir = await tempDir('lish-shapes-src-');
			await writeFile(join(dir, 'zero.bin'), '');
			const lish = await stored((await create(dir, sign)).lishID);
			expect(lish.files!.map(f => [f.path, f.size, f.checksums.length])).toEqual([['zero.bin', 0, 0]]);
		});

		it('an empty file on its own', async () => {
			const dir = await tempDir('lish-shapes-src-');
			await writeFile(join(dir, 'zero.bin'), '');
			const lish = await stored((await create(join(dir, 'zero.bin'), sign)).lishID);
			expect(lish.files!.map(f => [f.path, f.size])).toEqual([['zero.bin', 0]]);
		});

		it('refuses an empty folder and a folder holding only empty folders, storing nothing', async () => {
			const empty = await tempDir('lish-shapes-src-');
			await expect(create(empty, sign)).rejects.toMatchObject({ code: ErrorCodes.DIRECTORY_EMPTY });
			const onlyFolders = await tempDir('lish-shapes-src-');
			await mkdir(join(onlyFolders, 'x', 'y'), { recursive: true });
			await expect(create(onlyFolders, sign)).rejects.toMatchObject({ code: ErrorCodes.DIRECTORY_EMPTY });
			expect(dataServer.list()).toHaveLength(0);
		});
	});
}
