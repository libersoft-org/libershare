import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import type { ILISH } from '@shared';

/**
 * An import that fails before its record is stored must not leave the empty directory it made
 * for the data behind — and must never remove one that was already there.
 */
describe('failed import cleanup', () => {
	let dataDir: string;
	let base: string;
	let db: ReturnType<typeof openDatabase>;
	let dataServer: DataServer;
	let handlers: ReturnType<typeof initLISHsHandlers>;

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'lish-import-cleanup-data-'));
		base = await mkdtemp(join(tmpdir(), 'lish-import-cleanup-dl-'));
		db = openDatabase(dataDir);
		dataServer = new DataServer(db);
		handlers = initLISHsHandlers(
			dataServer,
			() => {},
			() => {},
			await Settings.create(dataDir)
		);
		// The store refuses every write, so each import fails after preparing its directory.
		dataServer.add = (): never => {
			throw new Error('disk refused the write');
		};
	});

	afterAll(async () => {
		db.close();
		for (const dir of [dataDir, base]) await rm(dir, { recursive: true, force: true });
	});

	const manifest = (id: string): ILISH => ({ id, name: id, created: '2026-01-01T00:00:00.000Z', chunkSize: 1024, checksumAlgo: 'sha256', files: [{ path: 'a.bin', size: 1024, checksums: ['c0'] }] });

	it('removes the directories it created, parents included', async () => {
		const downloadPath = join(base, 'new-parent', 'nested');
		await expect(handlers.importManifest(manifest('fresh'), downloadPath, { enableSharing: false, enableDownloading: false })).rejects.toThrow('disk refused the write');
		expect(existsSync(join(base, 'new-parent'))).toBe(false);
		expect(existsSync(base)).toBe(true);
	});

	it('keeps a directory that already existed', async () => {
		mkdirSync(join(base, 'kept'), { recursive: true });
		await expect(handlers.importManifest(manifest('kept'), base, { enableSharing: false, enableDownloading: false })).rejects.toThrow('disk refused the write');
		expect(existsSync(join(base, 'kept'))).toBe(true);
	});

	it('keeps an existing parent and removes only the new leaf', async () => {
		mkdirSync(join(base, 'parent'), { recursive: true });
		await expect(handlers.importManifest(manifest('leaf'), join(base, 'parent'), { enableSharing: false, enableDownloading: false })).rejects.toThrow('disk refused the write');
		expect(existsSync(join(base, 'parent', 'leaf'))).toBe(false);
		expect(existsSync(join(base, 'parent'))).toBe(true);
	});
});

describe('failed overwrite import', () => {
	let dataDir: string;
	let base: string;
	let db: ReturnType<typeof openDatabase>;
	let dataServer: DataServer;
	let handlers: ReturnType<typeof initLISHsHandlers>;

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'lish-overwrite-data-'));
		base = await mkdtemp(join(tmpdir(), 'lish-overwrite-dl-'));
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
		for (const dir of [dataDir, base]) await rm(dir, { recursive: true, force: true });
	});

	it('keeps the record it would replace when the new directory cannot be made', async () => {
		const original = { id: 'kept-record', name: 'kept-record', created: '2026-01-01T00:00:00.000Z', chunkSize: 1024, checksumAlgo: 'sha256', files: [{ path: 'a.bin', size: 1024, checksums: ['c0'] }], directory: join(base, 'original') } as const;
		dataServer.add(original as never);
		// A regular file where the download directory's parent should be: mkdir must fail.
		writeFileSync(join(base, 'blocker'), 'not a directory');
		await expect(handlers.importManifest({ ...original, name: 'replacement' } as never, join(base, 'blocker'), { overwrite: true, enableSharing: false, enableDownloading: false })).rejects.toThrow();
		expect(dataServer.get('kept-record' as never)?.name).toBe('kept-record');
	});
});
