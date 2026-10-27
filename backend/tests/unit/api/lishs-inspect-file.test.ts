import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import { ErrorCodes, MAX_API_MESSAGE_SIZE, type ILISH } from '@shared';

/**
 * Opening a .lish file in the file browser shows what it holds before anything is imported.
 * The check must be the one an import would do, per manifest, and must leave no trace.
 */
describe('lishs.inspectFile', () => {
	let dataDir: string;
	let filesDir: string;
	let db: ReturnType<typeof openDatabase>;
	let dataServer: DataServer;
	let handlers: ReturnType<typeof initLISHsHandlers>;

	const valid: ILISH = {
		id: 'b0000000-0000-4000-8000-000000000001',
		name: 'Valid',
		created: '2026-01-01T00:00:00.000Z',
		chunkSize: 1024,
		checksumAlgo: 'sha256',
		files: [
			{ path: 'a.bin', size: 2500, checksums: ['a1', 'a2', 'a3'] },
			{ path: 'b.bin', size: 10, checksums: ['b1'] },
		],
	};
	// One checksum short of ceil(2500 / 1024).
	const wrongCount: ILISH = { ...valid, id: 'b0000000-0000-4000-8000-000000000002', name: 'Wrong count', files: [{ path: 'short.bin', size: 2500, checksums: ['c1', 'c2'] }] };
	// Over the default network.maxChunkSize of 100 MiB.
	const hugeChunks: ILISH = { ...valid, id: 'b0000000-0000-4000-8000-000000000003', name: 'Huge chunks', chunkSize: 200 * 1024 * 1024, files: [{ path: 'h.bin', size: 10, checksums: ['d1'] }] };

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'lish-inspect-data-'));
		filesDir = await mkdtemp(join(tmpdir(), 'lish-inspect-files-'));
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
		for (const dir of [dataDir, filesDir]) await rm(dir, { recursive: true, force: true });
	});

	function write(name: string, content: string | Uint8Array): string {
		const path = join(filesDir, name);
		writeFileSync(path, content);
		return path;
	}

	it('summarizes a single .lish without its checksums', async () => {
		const result = await handlers.inspectFile({ filePath: write('one.lish', JSON.stringify(valid)) });
		expect(result).toHaveLength(1);
		expect(result[0]!.error).toBeUndefined();
		expect(result[0]!.detail).toMatchObject({ id: valid.id, name: 'Valid', totalSize: 2510, totalChunks: 4, fileCount: 2 });
		expect(JSON.stringify(result)).not.toContain('checksums');
	});

	it('reports each manifest of a .lishs on its own, refusing what an import would refuse', async () => {
		const [ok, short, huge] = await handlers.inspectFile({ filePath: write('many.lishs', JSON.stringify([valid, wrongCount, hugeChunks])) });
		expect(ok!.detail!.totalChunks).toBe(4);
		expect(ok!.error).toBeUndefined();
		expect(short!.error).toBe(ErrorCodes.LISH_INVALID_MANIFEST);
		expect(short!.errorDetail).toContain('short.bin');
		expect(short!.errorDetail).toContain('expected 3 checksums');
		expect(short!.detail).toBeUndefined();
		expect(huge!.error).toBe(ErrorCodes.LISH_CHUNK_SIZE_TOO_LARGE);
		expect(huge!.detail).toBeUndefined();
	});

	it('reads a compressed .lishs the same way', async () => {
		const plain = await handlers.inspectFile({ filePath: write('plain.lishs', JSON.stringify([valid, wrongCount])) });
		const gzipped = await handlers.inspectFile({ filePath: write('packed.lishs.gz', Bun.gzipSync(JSON.stringify([valid, wrongCount]))) });
		expect(gzipped).toEqual(plain);
		expect(gzipped[1]!.error).toBe(ErrorCodes.LISH_INVALID_MANIFEST);
	});

	it('shows an empty .lishs as empty', async () => {
		expect(await handlers.inspectFile({ filePath: write('empty.lishs', '[]') })).toEqual([]);
	});

	it('fails the whole file when it is not JSON at all', async () => {
		await expect(handlers.inspectFile({ filePath: write('broken.lish', '{ not json') })).rejects.toMatchObject({ code: ErrorCodes.INVALID_JSON });
	});

	it('keeps the valid manifests of a .lishs when another one fails the import checks', async () => {
		const noID = { ...valid, id: '' };
		const { created: _created, ...noCreated } = valid;
		const badAlgo = { ...valid, checksumAlgo: 'md5' };
		const [ok, missingID, missingCreated, unsupported, notObject] = await handlers.inspectFile({ filePath: write('mixed.lishs', JSON.stringify([valid, noID, noCreated, badAlgo, 42])) });
		expect(ok!.detail).toMatchObject({ id: valid.id, totalChunks: 4 });
		expect(missingID).toEqual({ error: ErrorCodes.LISH_MISSING_ID, errorDetail: undefined });
		expect(missingCreated!.error).toBe(ErrorCodes.LISH_MISSING_CREATED);
		expect(unsupported!.error).toBe(ErrorCodes.LISH_UNSUPPORTED_CHECKSUM);
		expect(notObject!.error).toBe(ErrorCodes.LISH_INVALID_FORMAT);
	});

	it('refuses a path the import would refuse, as the import does', async () => {
		const unsafe: ILISH = { ...valid, files: [{ path: 'C:/a.bin', size: 10, checksums: ['e1'] }] };
		const [inspected] = await handlers.inspectFile({ filePath: write('unsafe.lish', JSON.stringify(unsafe)) });
		expect(inspected!.error).toBe(ErrorCodes.LISH_UNSAFE_PATH);
		expect(inspected!.detail).toBeUndefined();
		const downloadPath = await mkdtemp(join(tmpdir(), 'lish-inspect-dest-'));
		try {
			await expect(handlers.importFromFile({ filePath: join(filesDir, 'unsafe.lish'), downloadPath })).rejects.toMatchObject({ code: ErrorCodes.LISH_UNSAFE_PATH });
		} finally {
			await rm(downloadPath, { recursive: true, force: true });
		}
	});

	it('reports a single .lish without an ID as its own refusal', async () => {
		expect(await handlers.inspectFile({ filePath: write('noid.lish', JSON.stringify({ ...valid, id: '' })) })).toEqual([{ error: ErrorCodes.LISH_MISSING_ID, errorDetail: undefined }]);
	});

	it('refuses a compressed file that expands past the API message limit', async () => {
		const bomb = Bun.gzipSync(new Uint8Array(MAX_API_MESSAGE_SIZE + 1).fill(0x20));
		await expect(handlers.inspectFile({ filePath: write('bomb.lish.gz', bomb) })).rejects.toMatchObject({ code: ErrorCodes.DECOMPRESSED_TOO_LARGE });
	});

	it('imports nothing and writes nothing', async () => {
		const before = readdirSync(filesDir).sort();
		const dataBefore = readdirSync(dataDir).sort();
		await handlers.inspectFile({ filePath: write('again.lishs', JSON.stringify([valid, hugeChunks])) });
		expect(dataServer.list()).toHaveLength(0);
		expect(readdirSync(filesDir).sort()).toEqual([...before, 'again.lishs'].sort());
		expect(readdirSync(dataDir).sort()).toEqual(dataBefore);
	});
});
