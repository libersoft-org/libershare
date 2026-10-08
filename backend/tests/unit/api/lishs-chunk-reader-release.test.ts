import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import { type ChunkID, type LISHid } from '@shared';

const hash = (text: string): ChunkID => new Bun.CryptoHasher('sha256').update(text).digest('hex') as ChunkID;
const exists = (path: string): Promise<boolean> =>
	access(path).then(
		() => true,
		() => false
	);

async function sharedDataset(id: string) {
	const base = await mkdtemp(join(tmpdir(), 'lish-reader-release-'));
	const db = openDatabase(base);
	const data = new DataServer(db);
	const add = async (lishID: string, folder: string, contents: string) => {
		const source = join(base, folder);
		await mkdir(source);
		await writeFile(join(source, 'data.bin'), contents);
		data.addDataset({ id: lishID, name: folder, created: '2026-01-01', chunkSize: 4, checksumAlgo: 'sha256', directory: source, files: [{ path: 'data.bin', size: 4, checksums: [hash(contents)] }], chunks: [hash(contents)] }, { kind: 'explicit', path: source });
		return source;
	};
	const source = await add(id, 'source', 'abcd');
	const handlers = initLISHsHandlers(
		data,
		() => {},
		() => {},
		await Settings.create(base)
	);
	return {
		base,
		source,
		data,
		handlers,
		add,
		async close() {
			await handlers.stopVerifyAll();
			db.close();
			await rm(base, { recursive: true, force: true });
		},
	};
}

// A stream's chunk reader keeps the file it served open for the next request; on Windows that open
// handle refuses deletion and renaming. A local delete or move must not fail on it.
test('deletes the data of a LISH a chunk reader served moments ago', async () => {
	const t = await sharedDataset('release-delete');
	const reader = t.data.createChunkReader(60_000);
	try {
		expect(await reader.getChunk('release-delete' as LISHid, hash('abcd'))).toBeInstanceOf(Uint8Array);
		expect(await t.handlers.delete({ lishID: 'release-delete', deleteLISH: true, deleteData: true })).toBe(true);
		expect(await exists(join(t.source, 'data.bin'))).toBe(false);
	} finally {
		await reader.close();
		await t.close();
	}
});

test('deletes the data while the same reader keeps serving another LISH', async () => {
	const t = await sharedDataset('release-busy');
	await t.add('release-other', 'other', 'wxyz');
	const reader = t.data.createChunkReader(60_000);
	try {
		await reader.getChunk('release-busy' as LISHid, hash('abcd'));
		const serving = (async () => {
			for (let i = 0; i < 20; i++) {
				await reader.getChunk('release-other' as LISHid, hash('wxyz'));
				await Bun.sleep(5);
			}
		})();
		expect(await t.handlers.delete({ lishID: 'release-busy', deleteLISH: false, deleteData: true })).toBe(true);
		expect(await exists(join(t.source, 'data.bin'))).toBe(false);
		await serving;
	} finally {
		await reader.close();
		await t.close();
	}
});

test('moves the data of a LISH a chunk reader served moments ago', async () => {
	const t = await sharedDataset('release-move');
	const reader = t.data.createChunkReader(60_000);
	try {
		await reader.getChunk('release-move' as LISHid, hash('abcd'));
		expect(await t.handlers.move({ lishID: 'release-move', newDirectory: join(t.base, 'moved'), createSubdirectory: false, moveData: true })).toEqual({ success: true });
		expect(await exists(join(t.base, 'moved', 'data.bin'))).toBe(true);
		expect(await exists(join(t.source, 'data.bin'))).toBe(false);
		// Serving resumes from the new location once the move is done.
		expect(new TextDecoder().decode((await reader.getChunk('release-move' as LISHid, hash('abcd'))) as Uint8Array)).toBe('abcd');
	} finally {
		await reader.close();
		await t.close();
	}
});
