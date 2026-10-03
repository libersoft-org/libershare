import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import { ErrorCodes, type ILISH } from '@shared';

/**
 * A failed import removes nothing: by path it cannot prove a directory is still the one it made,
 * so it leaves its own empty directories rather than risk one that took their place.
 */
describe('failed import directories', () => {
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

	it('leaves the directories it created, parents included', async () => {
		const downloadPath = join(base, 'new-parent', 'nested');
		await expect(handlers.importManifest(manifest('fresh'), downloadPath, { enableSharing: false, enableDownloading: false })).rejects.toThrow('disk refused the write');
		expect(existsSync(join(downloadPath, 'fresh'))).toBe(true);
	});

	it('keeps a directory that already existed', async () => {
		mkdirSync(join(base, 'kept'), { recursive: true });
		await expect(handlers.importManifest(manifest('kept'), base, { enableSharing: false, enableDownloading: false })).rejects.toThrow('disk refused the write');
		expect(existsSync(join(base, 'kept'))).toBe(true);
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

	it('keeps the old record whole when writing its replacement fails', async () => {
		const original = { id: 'kept-on-write', name: 'kept-on-write', created: '2026-01-01T00:00:00.000Z', chunkSize: 1024, checksumAlgo: 'sha256', files: [{ path: 'a.bin', size: 1024, checksums: ['c0'] }], directory: join(base, 'first') } as const;
		dataServer.add(original as never);
		// The database refuses the new row itself, after the old one was already deleted.
		db.run("CREATE TRIGGER refuse_replacement BEFORE INSERT ON lishs WHEN NEW.name = 'replacement' BEGIN SELECT RAISE(ABORT, 'refused'); END");
		try {
			await expect(handlers.importManifest({ ...original, name: 'replacement' } as never, base, { overwrite: true, enableSharing: false, enableDownloading: false })).rejects.toThrow('refused');
			expect(dataServer.get('kept-on-write' as never)?.name).toBe('kept-on-write');
			expect(dataServer.get('kept-on-write' as never)?.files?.length).toBe(1);
		} finally {
			db.run('DROP TRIGGER refuse_replacement');
		}
	});

	it('refuses a regular file as the destination without replacing the old record', async () => {
		const original = { id: 'kept-file-target', name: 'original', created: '2026-01-01T00:00:00.000Z', chunkSize: 1024, checksumAlgo: 'sha256', files: [{ path: 'a.bin', size: 1024, checksums: ['c0'] }], directory: join(base, 'original') };
		dataServer.add(original as never);
		writeFileSync(join(base, 'file-target'), 'existing data');
		await expect(handlers.importManifest({ ...original, name: 'file-target' } as never, base, { overwrite: true, enableSharing: false, enableDownloading: false })).rejects.toMatchObject({ code: ErrorCodes.FS_NOT_DIRECTORY });
		expect(dataServer.get('kept-file-target' as never)?.name).toBe('original');
		expect(readFileSync(join(base, 'file-target'), 'utf8')).toBe('existing data');
	});

	it('keeps the committed directory if broadcasting the successful write fails', async () => {
		const h = initLISHsHandlers(
			dataServer,
			() => {},
			() => {
				throw new Error('broadcast failed');
			},
			await Settings.create(dataDir)
		);
		const manifest = { id: 'committed', name: 'committed', created: '2026-01-01T00:00:00.000Z', chunkSize: 1024, checksumAlgo: 'sha256', files: [{ path: 'a.bin', size: 1024, checksums: ['c0'] }] };
		await expect(h.importManifest(manifest as never, base, { enableSharing: false, enableDownloading: false })).rejects.toThrow('broadcast failed');
		expect(dataServer.get('committed' as never)?.directory).toBe(join(base, 'committed'));
		expect(existsSync(join(base, 'committed'))).toBe(true);
	});
});
