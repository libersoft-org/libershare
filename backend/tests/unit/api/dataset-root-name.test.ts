import { afterAll, beforeAll, expect, it } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import { initUploadState, resetUploadState } from '../../../src/protocol/lish-protocol.ts';

let root: string;
let target: string;
let database: ReturnType<typeof openDatabase>;
let data: DataServer;
let handlers: ReturnType<typeof initLISHsHandlers>;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'lish-root-name-'));
	target = join(root, 'selected');
	await mkdir(target);
	await writeFile(join(root, 'control.bin'), 'KEEP');
	database = openDatabase(root);
	data = new DataServer(database);
	handlers = initLISHsHandlers(
		data,
		() => {},
		() => {},
		await Settings.create(root)
	);
});
afterAll(async () => {
	await handlers.stopVerifyAll();
	initUploadState(new Set(), () => {});
	resetUploadState();
	database.close();
	await rm(root, { recursive: true, force: true });
});

for (const name of ['.', '..', '', '///', 'name.', 'NUL', 'aux.txt', 'COM¹', 'LPT².txt', 'CON .txt']) {
	it(`rejects the unsafe derived directory name ${JSON.stringify(name)} before storing an import`, async () => {
		const id = name === '///' ? '../outside' : crypto.randomUUID();
		const manifest = { id, name, created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', files: [] };
		await expect(handlers.importFromJSON({ json: JSON.stringify(manifest), downloadPath: target, enableSharing: false, enableDownloading: false })).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
		expect(data.get(id)).toBeNull();
		expect(await readFile(join(root, 'control.bin'), 'utf8')).toBe('KEEP');
	});
}

it('keeps the manifest name unchanged while using its safe sanitized directory', async () => {
	const id = crypto.randomUUID();
	await handlers.importFromJSON({ json: JSON.stringify({ id, name: 'Dataset/A', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', files: [] }), downloadPath: target });
	expect(data.get(id)?.directory).toBe(join(target, 'DatasetA'));
	expect(data.get(id)?.name).toBe('Dataset/A');
});

it('rejects an unsafe name during relocation before changing the stored directory', async () => {
	const id = crypto.randomUUID();
	data.add({ id, name: '..', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', directory: target, files: [] });
	await expect(handlers.move({ lishID: id, newDirectory: target, createSubdirectory: true, moveData: false })).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
	expect(data.get(id)?.directory).toBe(target);
});

it('preserves the previous record when an unsafe import requests overwrite', async () => {
	const id = crypto.randomUUID();
	data.add({ id, name: 'Original', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', directory: target, files: [] });
	await expect(handlers.importFromJSON({ json: JSON.stringify({ id, name: '..', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', files: [] }), downloadPath: target, overwrite: true })).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
	expect(data.get(id)?.name).toBe('Original');
	expect(data.get(id)?.directory).toBe(target);
});

it('allows an explicit relocation directory independently of the manifest name', async () => {
	const id = crypto.randomUUID();
	data.add({ id, name: '..', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', directory: target, files: [] });
	const destination = join(root, 'explicit');
	await handlers.move({ lishID: id, newDirectory: destination, createSubdirectory: false, moveData: false });
	expect(data.get(id)?.directory).toBe(destination);
});

it('uses the ID only when the manifest has no name', async () => {
	const id = crypto.randomUUID();
	await handlers.importFromJSON({ json: JSON.stringify({ id, created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', files: [] }), downloadPath: target });
	expect(data.get(id)?.directory).toBe(join(target, id));
	await expect(handlers.importFromJSON({ json: JSON.stringify({ id: '..', created: '2026-01-01T00:00:00Z', chunkSize: 4, checksumAlgo: 'sha256', files: [] }), downloadPath: target })).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
});
