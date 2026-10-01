import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import { getBusyReason } from '../../../src/api/busy.ts';

test('moving partial data keeps verification busy until the new location has been checked', async () => {
	const base = await mkdtemp(join(tmpdir(), 'lish-move-'));
	const source = join(base, 'source');
	await mkdir(source);
	const contents = 'abcd\0\0\0\0';
	await writeFile(join(source, 'data.bin'), contents);
	const db = openDatabase(base);
	const data = new DataServer(db);
	const id = 'partial-move';
	const hash = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');
	data.addDataset({ id, name: 'dataset', created: '2026-01-01', chunkSize: 4, checksumAlgo: 'sha256', directory: source, files: [{ path: 'data.bin', size: 8, checksums: [hash('abcd'), hash('efgh')] }] }, { kind: 'explicit', path: source });
	const handlers = initLISHsHandlers(data, () => {}, () => {}, await Settings.create(base));
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const open = data.openDataset.bind(data);
	const pendingVerification = spyOn(data, 'openDataset').mockImplementation(async lishID => { await gate; return open(lishID); });
	try {
		expect(await handlers.move({ lishID: id, newDirectory: join(base, 'finished'), moveData: true })).toEqual({ success: true });
		expect(getBusyReason(id)).toBe('verifying');
		expect(await readFile(join(base, 'finished/dataset/data.bin'), 'utf8')).toBe(contents);
		release();
		const deadline = Date.now() + 2000;
		while (handlers.list().verifying && Date.now() < deadline) await Bun.sleep(5);
		expect(handlers.list().verifying).toBeNull();
		expect(data.getMissingChunks(id)).toHaveLength(1);
	} finally {
		release();
		await handlers.stopVerifyAll();
		pendingVerification.mockRestore();
		db.close();
		await rm(base, { recursive: true, force: true });
	}
});
