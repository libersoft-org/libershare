import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import { getLISHScope, initLISHScopes, initUploadState, resetUploadState } from '../../../src/protocol/lish-protocol.ts';

let dataDir: string;
let downloadDir: string;
let db: ReturnType<typeof openDatabase>;
let handlers: ReturnType<typeof initLISHsHandlers>;
let settings: Settings;

beforeAll(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'lish-import-scope-'));
	downloadDir = await mkdtemp(join(tmpdir(), 'lish-import-scope-dl-'));
	db = openDatabase(dataDir);
	const dataServer = new DataServer(db);
	initLISHScopes(new Map(), (id, ids) => dataServer.setLISHScope(id as any, ids));
	settings = await Settings.create(dataDir);
	handlers = initLISHsHandlers(dataServer, () => {}, () => {}, settings, id => id === 'net-p');
});

afterAll(async () => {
	await handlers.stopVerifyAll();
	initUploadState(new Set(), () => {});
	resetUploadState();
	initLISHScopes(new Map(), () => {});
	db.close();
	for (const d of [dataDir, downloadDir]) await rm(d, { recursive: true, force: true });
});

const manifest = (id: string): string => JSON.stringify({ id, created: '2026-01-01T00:00:00.000Z', chunkSize: 1024, checksumAlgo: 'sha256', name: id, files: [{ path: 'a.bin', size: 1024, checksums: ['deadbeef'] }] });

/** A LISH imported from a file, JSON or URL was always public: no import took a protected lishnet. */
test('an imported LISH can be shared in a protected lishnet, and only in one this node knows', async () => {
	await handlers.importFromJSON({ json: manifest('import-scoped'), downloadPath: downloadDir, enableSharing: true, scope: ['net-p'] });
	expect(getLISHScope('import-scoped')).toEqual(['net-p']);
	await handlers.importFromJSON({ json: manifest('import-public'), downloadPath: downloadDir, enableSharing: true });
	expect(getLISHScope('import-public')).toEqual([]);
	await expect(handlers.importFromJSON({ json: manifest('import-unknown'), downloadPath: downloadDir, enableSharing: true, scope: ['net-x'] })).rejects.toThrow('protected lishnets only');
});

/** With no protected lishnet to pick (or the list still loading) the screens sent no scope, and the LISH was stored public. */
test('with protected lishnets only, no LISH is created, imported or switched public', async () => {
	await settings.set('network.privateOnly', true);
	try {
		await expect(handlers.create({ dataPath: downloadDir, addToSharing: true }, null)).rejects.toMatchObject({ code: 'OVERLAY_PRIVATE_ONLY' });
		await expect(handlers.importFromJSON({ json: manifest('private-only-public'), downloadPath: downloadDir, enableSharing: true })).rejects.toMatchObject({ code: 'OVERLAY_PRIVATE_ONLY' });
		await expect(handlers.importFromJSON({ json: manifest('private-only-explicit'), downloadPath: downloadDir, scope: [] })).rejects.toMatchObject({ code: 'OVERLAY_PRIVATE_ONLY' });
		await handlers.importFromJSON({ json: manifest('private-only-scoped'), downloadPath: downloadDir, enableSharing: true, scope: ['net-p'] });
		// Added again without a scope it keeps its protected one.
		await handlers.importFromJSON({ json: manifest('private-only-scoped'), downloadPath: downloadDir, overwrite: true });
		expect(getLISHScope('private-only-scoped')).toEqual(['net-p']);
		expect(() => handlers.setScope({ lishID: 'private-only-scoped', networkIDs: [] })).toThrow('protected lishnet');
	} finally {
		await settings.set('network.privateOnly', false);
	}
});
