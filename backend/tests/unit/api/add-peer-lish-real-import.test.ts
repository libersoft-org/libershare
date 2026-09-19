import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode as lpEncode } from 'it-length-prefixed';
import { encode as codecEncode } from '../../../src/protocol/codec.ts';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import { initLISHnetsHandlers } from '../../../src/api/lishnets.ts';

/**
 * Adding another peer's LISH, end to end, with the store that actually keeps it — and a
 * factory reset closing the mutation gate while the manifest is still on its way.
 *
 * The narrower test beside this one stubs the import step, so it shows the gate is not asked
 * twice but not that the accepted operation really lands. This one runs the real import
 * pipeline over a real store: with the gated entry point in its place, the reset below
 * refuses the operation's second half and nothing is stored.
 *
 * It builds that wiring itself, so it does NOT guard the wiring in APIServer — a mistake made
 * there alone would leave this test green.
 */

const LISH_ID = 'add-peer-real-import-test';

let dataDir: string;
let downloadDir: string;
let tempDir: string;
let db: ReturnType<typeof openDatabase>;
let dataServer: DataServer;
let lishs: ReturnType<typeof initLISHsHandlers>;
let lishnets: ReturnType<typeof initLISHnetsHandlers>;
/** Releases the manifest response the peer is holding back. */
let deliverManifest: () => void;

function manifest(): unknown {
	return {
		id: LISH_ID,
		created: '2026-01-01T00:00:00.000Z',
		chunkSize: 1024,
		checksumAlgo: 'sha256',
		name: 'Add peer real import',
		files: [{ path: 'a.bin', size: 1024, checksums: ['deadbeef'] }],
	};
}

/** A stream that answers the manifest request only once `deliverManifest` is called. */
function heldStream(): any {
	const held = new Promise<void>(resolve => {
		deliverManifest = resolve;
	});
	async function* source() {
		await held;
		yield lpEncode.single(codecEncode({ manifest: manifest() })).subarray();
	}
	return { status: 'open', send() {}, close: async () => {}, [Symbol.asyncIterator]: source };
}

beforeAll(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'lish-addpeer-data-'));
	downloadDir = await mkdtemp(join(tmpdir(), 'lish-addpeer-dl-'));
	tempDir = await mkdtemp(join(tmpdir(), 'lish-addpeer-tmp-'));
	db = openDatabase(dataDir);
	dataServer = new DataServer(db);
	const settings = await Settings.create(dataDir);
	await settings.set('storage.downloadPath', downloadDir);
	// Kept off the real storage path: the import allocates its staging directory from this.
	await settings.set('storage.tempPath', tempDir);
	// The import would otherwise register this LISH in the process-wide download and upload
	// state, which the transfer tests in this suite read. Storing the manifest is the point
	// here; enabling transfers for it is not.
	await settings.set('network.autoStartSharing', false);
	await settings.set('network.autoStartDownloading', false);
	lishs = initLISHsHandlers(
		dataServer,
		() => {},
		() => {},
		settings
	);
	const networks = {
		getRunningNetwork: () => ({ dialProtocolByPeerId: async () => ({ stream: heldStream() }) }),
	} as never;
	// The same wiring APIServer uses: the admitted import, and the gate the public entry takes.
	lishnets = initLISHnetsHandlers(networks, dataServer, () => {}, settings, lishs.importManifestAdmitted, lishs.runMutation);
});

afterAll(async () => {
	// The import queues a verification pass of its own, which the test does not wait for.
	// Closing the database under it makes that pass write into a closed handle after the test
	// has already reported success. The factory reset waits for the same thing, in this order.
	await lishs.stopVerifyAll();
	db.close();
	for (const dir of [dataDir, downloadDir, tempDir]) await rm(dir, { recursive: true, force: true });
});

describe('adding a peer LISH through the real import pipeline', () => {
	it('stores the share even though a reset closed the gate mid-download', async () => {
		const adding = lishnets.addPeerLish({ lishID: LISH_ID, peerID: 'peer-1', networkID: 'net-1' });
		await Promise.resolve();

		// The reset arrives while the manifest is still held: admission closes now, the drain
		// waits for this operation.
		let drained = false;
		const pausing = lishs.pauseMutations().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);

		deliverManifest();
		await expect(adding).resolves.toEqual({ lishID: LISH_ID });
		await pausing;

		const stored = dataServer.get(LISH_ID);
		expect(stored).not.toBeNull();
		expect(stored!.name).toBe('Add peer real import');
		expect(drained).toBe(true);

		lishs.resumeMutations();
	});
});
