import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import { getLISHScope, initLISHScopes, initUploadState, isUploadEnabled, removeLISHScope, resetUploadState } from '../../../src/protocol/lish-protocol.ts';

let dataDir: string;
let dataServer: DataServer;
let downloadDir: string;
let db: ReturnType<typeof openDatabase>;
let handlers: ReturnType<typeof initLISHsHandlers>;
let settings: Settings;

beforeAll(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'lish-import-scope-'));
	downloadDir = await mkdtemp(join(tmpdir(), 'lish-import-scope-dl-'));
	db = openDatabase(dataDir);
	dataServer = new DataServer(db);
	initLISHScopes(new Map(), (id, ids) => dataServer.setLISHScope(id as any, ids));
	settings = await Settings.create(dataDir);
	handlers = initLISHsHandlers(
		dataServer,
		() => {},
		() => {},
		settings,
		id => id === 'net-p'
	);
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

/** A .lish file made and not added was refused too, though it is shared nowhere. */
test('with protected lishnets only, a .lish file is still made when it is not added', async () => {
	const source = await mkdtemp(join(tmpdir(), 'lish-private-file-'));
	await settings.set('network.privateOnly', true);
	try {
		await writeFile(join(source, 'a.txt'), 'data');
		const made = await handlers.create({ dataPath: join(source, 'a.txt'), lishFile: join(source, 'out.lish') }, null);
		expect(made.lishFile).toBe(join(source, 'out.lish'));
		expect(dataServer.get(made.lishID)).toBeNull();
	} finally {
		await settings.set('network.privateOnly', false);
		await rm(source, { recursive: true, force: true });
	}
});

/** Added again keeping its scope while it was deleted: the scope it was let in with was looked up again, found gone, and the LISH came back public. */
test('a LISH added again keeps the scope it had when the addition began', async () => {
	await handlers.importFromJSON({ json: manifest('race-scoped'), downloadPath: downloadDir, enableSharing: true, scope: ['net-p'] });
	const realGet = dataServer.get.bind(dataServer);
	let deleted = false;
	const get = spyOn(dataServer, 'get').mockImplementation(id => {
		const found = realGet(id);
		if (id === 'race-scoped' && !deleted) {
			deleted = true;
			dataServer.delete(id);
			removeLISHScope(id);
		}
		return found;
	});
	try {
		await handlers.importFromJSON({ json: manifest('race-scoped'), downloadPath: downloadDir, enableSharing: true, overwrite: true });
		expect(deleted).toBe(true);
		expect(getLISHScope('race-scoped')).toEqual(['net-p']);
	} finally {
		get.mockRestore();
	}
});

/** Moved to a protected lishnet while it was added again: the scope it had at the start of the addition was written back, and it was public again. */
test('a LISH added again keeps a scope set while it was being added', async () => {
	await handlers.importFromJSON({ json: manifest('race-moved'), downloadPath: downloadDir, enableSharing: true });
	const realGet = dataServer.get.bind(dataServer);
	let moved = false;
	const get = spyOn(dataServer, 'get').mockImplementation(id => {
		if (id === 'race-moved' && !moved) {
			moved = true;
			handlers.setScope({ lishID: id, networkIDs: ['net-p'] });
		}
		return realGet(id);
	});
	try {
		await handlers.importFromJSON({ json: manifest('race-moved'), downloadPath: downloadDir, enableSharing: true, overwrite: true });
		expect(moved).toBe(true);
		expect(getLISHScope('race-moved')).toEqual(['net-p']);
	} finally {
		get.mockRestore();
	}
});

/** Switched on while a long import ran: the check at its start had passed, and the LISH was stored public and shared. */
test('a LISH is not stored public when protected lishnets only is switched on during its import', async () => {
	let sealed = false;
	const realSetting = settings.get.bind(settings);
	const setting = spyOn(settings, 'get').mockImplementation(((path?: string) => (path === 'network.privateOnly' ? sealed : realSetting(path as any))) as any);
	const realGet = dataServer.get.bind(dataServer);
	const get = spyOn(dataServer, 'get').mockImplementation(id => {
		if (id === 'late-seal') sealed = true;
		return realGet(id);
	});
	try {
		await expect(handlers.importFromJSON({ json: manifest('late-seal'), downloadPath: downloadDir, enableSharing: true })).rejects.toMatchObject({ code: 'OVERLAY_PRIVATE_ONLY' });
		expect(isUploadEnabled('late-seal')).toBe(false);
	} finally {
		get.mockRestore();
		setting.mockRestore();
	}
});
