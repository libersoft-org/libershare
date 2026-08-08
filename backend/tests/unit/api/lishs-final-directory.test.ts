/**
 * `finalDirectory` is node-local state this machine owns — an absolute path carrying the OS
 * user name, and the flag that decides what happens to the folder: deleteLISHData() wipes a
 * LISH with a set finalDirectory recursively, finalizeDownload() renames the directory to it.
 *
 * So it must not travel in either direction through the `lishs` API:
 *  - out: the exported .lish must not carry this machine's paths to whoever opens the file
 *  - in:  an imported finalDirectory must not survive, because `validateImportedLISH` is a
 *         pass-through cast and a share-only import points at the user's own folder
 *
 * All import routes (file, JSON, URL, peer manifest) funnel through the same importCommon,
 * so exercising importFromJSON pins the strip for all of them. The file-writer underneath
 * export is covered separately in tests/unit/lish/export-strips-local-paths.test.ts; here we
 * go through the API handlers a user actually reaches.
 */
import { describe, it, expect, afterAll, beforeAll } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import type { IStoredLISH } from '@shared';

const IMPORT_ID = 'import-strip-test';
const EXPORT_ID = 'export-strip-test';
const LOCAL_MARKER = 'somebody';

let dataDir: string;
let downloadDir: string;
let outDir: string;
let db: ReturnType<typeof openDatabase>;
let dataServer: DataServer;
let handlers: ReturnType<typeof initLISHsHandlers>;

beforeAll(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'lish-api-data-'));
	downloadDir = await mkdtemp(join(tmpdir(), 'lish-api-dl-'));
	outDir = await mkdtemp(join(tmpdir(), 'lish-api-out-'));
	db = openDatabase(dataDir);
	dataServer = new DataServer(db);
	const settings = await Settings.create(dataDir);
	handlers = initLISHsHandlers(
		dataServer,
		() => {},
		() => {},
		settings
	);
});

afterAll(async () => {
	db.close();
	for (const d of [dataDir, downloadDir, outDir]) await rm(d, { recursive: true, force: true });
});

/** A manifest as a hostile peer/author would craft it: a move target we never asked for. */
function hostileManifestJSON(): string {
	return JSON.stringify({
		id: IMPORT_ID,
		created: '2026-01-01T00:00:00.000Z',
		chunkSize: 1024,
		checksumAlgo: 'sha256',
		name: 'Import strip test',
		files: [{ path: 'a.bin', size: 1024, checksums: ['deadbeef'] }],
		directory: '/attacker/directory',
		finalDirectory: '/attacker/final',
	});
}

/** A LISH mid-download: living in temp, with a move target on this machine. */
function downloadingLISH(): IStoredLISH {
	return {
		id: EXPORT_ID,
		created: '2026-01-01T00:00:00.000Z',
		chunkSize: 1024,
		checksumAlgo: 'sha256',
		name: 'Export strip test',
		files: [{ path: 'a.bin', size: 1024, checksums: ['deadbeef'] }],
		directory: `C:\\Users\\${LOCAL_MARKER}\\temp\\Export strip test`,
		finalDirectory: `C:\\Users\\${LOCAL_MARKER}\\finished\\Export strip test`,
		chunks: ['deadbeef'],
	};
}

describe('lishs.importFromJSON', () => {
	it('drops an imported finalDirectory on a share-only import', async () => {
		await handlers.importFromJSON({ json: hostileManifestJSON(), downloadPath: downloadDir, enableSharing: true });
		const stored = dataServer.get(IMPORT_ID);
		expect(stored).not.toBeNull();
		expect(stored!.finalDirectory).toBeUndefined();
		// The directory we allocated ourselves must win over the imported one.
		expect(stored!.directory).toBe(join(downloadDir, 'Import strip test'));
	});
});

describe('lishs export handlers', () => {
	it('writes no local path into a single-LISH export', async () => {
		dataServer.add(downloadingLISH());
		const out = join(outDir, 'one.lish');
		await handlers.exportToFile({ lishID: EXPORT_ID, filePath: out });
		// Assert on the raw text too: a nested copy would still leak the user name.
		const raw = await readFile(out, 'utf8');
		expect(raw).not.toContain(LOCAL_MARKER);
		const parsed = JSON.parse(raw);
		expect(parsed.directory).toBeUndefined();
		expect(parsed.finalDirectory).toBeUndefined();
		expect(parsed.chunks).toBeUndefined();
		expect(parsed.id).toBe(EXPORT_ID);
	});

	it('writes no local path into an export-all', async () => {
		dataServer.add(downloadingLISH());
		const out = join(outDir, 'all.lish');
		await handlers.exportAllToFile({ filePath: out });
		const raw = await readFile(out, 'utf8');
		expect(raw).not.toContain(LOCAL_MARKER);
		const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
		const entry = parsed.find(l => l['id'] === EXPORT_ID);
		expect(entry).toBeDefined();
		expect(entry!['directory']).toBeUndefined();
		expect(entry!['finalDirectory']).toBeUndefined();
		expect(entry!['chunks']).toBeUndefined();
	});
});
