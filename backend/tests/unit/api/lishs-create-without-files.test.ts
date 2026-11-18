import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';

describe('lishs.create with folders only', () => {
	let dataDir: string;
	let sourceDir: string;
	let db: ReturnType<typeof openDatabase>;
	let dataServer: DataServer;
	let handlers: ReturnType<typeof initLISHsHandlers>;

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'lish-nofiles-data-'));
		sourceDir = await mkdtemp(join(tmpdir(), 'lish-nofiles-src-'));
		db = openDatabase(dataDir);
		dataServer = new DataServer(db);
		handlers = initLISHsHandlers(
			dataServer,
			() => {},
			() => {},
			await Settings.create(dataDir)
		);
	});

	afterAll(async () => {
		db.close();
		for (const dir of [dataDir, sourceDir]) await rm(dir, { recursive: true, force: true });
	});

	it('creates a LISH that lists the empty subfolders of a folder without files', async () => {
		await mkdir(join(sourceDir, 'only', 'folders'), { recursive: true });
		const lishFile = join(dataDir, 'folders.lish');
		await handlers.create({ dataPath: sourceDir, lishFile } as never, undefined as never);
		const lish = JSON.parse(await readFile(lishFile, 'utf8'));
		expect(lish.directories.map((directory: { path: string }) => directory.path)).toEqual(['only', 'only/folders']);
		expect(lish.files ?? []).toEqual([]);
	});
});
