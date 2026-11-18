import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCodes } from '@shared';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';

describe('lishs.create without files', () => {
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

	it('refuses a folder holding only empty subfolders and stores nothing', async () => {
		await mkdir(join(sourceDir, 'only', 'folders'), { recursive: true });
		await expect(handlers.create({ dataPath: sourceDir, addToSharing: true } as never, undefined as never)).rejects.toMatchObject({ code: ErrorCodes.DIRECTORY_EMPTY });
		expect(dataServer.list()).toHaveLength(0);
	});
});
