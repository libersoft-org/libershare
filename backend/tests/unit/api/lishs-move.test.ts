import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import { SafeDataset } from '../../../src/lish/safe-dataset-files.ts';
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
	const handlers = initLISHsHandlers(
		data,
		() => {},
		() => {},
		await Settings.create(base)
	);
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	const open = data.openDataset.bind(data);
	const pendingVerification = spyOn(data, 'openDataset').mockImplementation(async lishID => {
		await gate;
		return open(lishID);
	});
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

async function completeDataset(withLink = false) {
	const base = await mkdtemp(join(tmpdir(), 'lish-move-review-'));
	const source = join(base, 'source');
	await mkdir(source);
	await writeFile(join(source, 'data.bin'), 'abcd');
	const db = openDatabase(base);
	const data = new DataServer(db);
	const id = 'move-review';
	const manifest = { id, name: 'dataset', created: '2026-01-01', chunkSize: 4, checksumAlgo: 'sha256' as const, directory: source, files: [{ path: 'data.bin', size: 4, checksums: [new Bun.CryptoHasher('sha256').update('abcd').digest('hex')] }], ...(withLink ? { links: [{ path: 'copy.bin', target: join(source, 'data.bin') }] } : {}) };
	data.addDataset(manifest, { kind: 'derived', base, component: 'source' });
	const events: { event: string; data: any }[] = [];
	const handlers = initLISHsHandlers(
		data,
		() => {},
		(event, payload) => events.push({ event, data: payload }),
		await Settings.create(base)
	);
	return {
		base,
		source,
		db,
		data,
		id,
		manifest,
		events,
		handlers,
		async close() {
			await handlers.stopVerifyAll();
			db.close();
			await rm(base, { recursive: true, force: true });
		},
	};
}

for (const operation of ['move', 'finalize'] as const) {
	test(`${operation} commits successfully despite source cleanup permission errors`, async () => {
		const f = await completeDataset();
		const destination = join(f.base, 'target');
		if (operation === 'finalize') {
			f.data.updateFinalDirectory(f.id, destination);
			f.data.setDatasetRoot(f.id, { kind: 'derived', base: f.base, component: 'target' }, true);
		}
		const cleanup = spyOn(SafeDataset.prototype, 'removeFile').mockRejectedValue(Object.assign(new Error('Cleanup refused'), { code: 'EACCES' }));
		try {
			const response = operation === 'move' ? await f.handlers.move({ lishID: f.id, newDirectory: destination, moveData: true, createSubdirectory: false }) : await f.handlers.finalizeDownload(f.id);
			expect(response).toEqual({ success: true });
			expect(f.data.get(f.id)?.directory).toBe(destination);
			expect(await readFile(join(destination, 'data.bin'), 'utf8')).toBe('abcd');
			expect(await readFile(join(f.source, 'data.bin'), 'utf8')).toBe('abcd');
			expect(f.events.some(item => item.event === 'lishs:move')).toBe(true);
			expect(f.events.some(item => item.event === 'lishs:move:cleanup' && item.data.warnings[0]?.code === 'EACCES')).toBe(true);
			expect(f.events.some(item => item.event === 'lishs:finalize:error')).toBe(false);
			if (operation === 'move') expect(f.events.some(item => item.event === 'lishs:verify' && item.data.started)).toBe(true);
			else {
				expect(f.data.get(f.id)?.finalDirectory).toBeUndefined();
				expect(f.events.some(item => item.event === 'lishs:finalize')).toBe(true);
			}
		} finally {
			cleanup.mockRestore();
			await f.close();
		}
	});
}

for (const operation of ['move', 'finalize'] as const) {
	test(`an absolute internal link survives a manual move followed by ${operation}`, async () => {
		const f = await completeDataset(true);
		const first = join(f.base, 'first');
		const second = join(f.base, 'second');
		try {
			expect(await f.handlers.move({ lishID: f.id, newDirectory: first, moveData: true, createSubdirectory: false })).toEqual({ success: true });
			await f.handlers.stopVerifyAll();
			expect(f.data.getDatasetLinkBindings(f.id)).toMatchObject([{ path: 'copy.bin', target: join(f.source, 'data.bin'), source: 'data.bin', hardlink: false }]);
			expect(typeof f.data.getDatasetLinkBindings(f.id)[0]?.materializedIdentity).toBe('string');
			if (operation === 'finalize') {
				f.data.updateFinalDirectory(f.id, second);
				f.data.setDatasetRoot(f.id, { kind: 'derived', base: f.base, component: 'second' }, true);
			}
			const result = operation === 'move' ? await f.handlers.move({ lishID: f.id, newDirectory: second, moveData: true, createSubdirectory: false }) : await f.handlers.finalizeDownload(f.id);
			expect(result).toEqual({ success: true });
			expect(await readFile(join(second, 'data.bin'), 'utf8')).toBe('abcd');
			expect(await readFile(join(second, 'copy.bin'), 'utf8')).toBe('abcd');
			expect(f.data.get(f.id)?.links).toEqual(f.manifest.links);
			expect(f.data.get(f.id)?.directory).toBe(second);
		} finally {
			await f.close();
		}
	});
}

test('a changed absolute link target cannot reuse a prior local association', async () => {
	const f = await completeDataset(true);
	const first = join(f.base, 'first');
	const second = join(f.base, 'second');
	try {
		await f.handlers.move({ lishID: f.id, newDirectory: first, moveData: true, createSubdirectory: false });
		await f.handlers.stopVerifyAll();
		const changed = { ...f.data.get(f.id)!, links: [{ path: 'copy.bin', target: join(f.base, 'external') }] };
		f.data.add(changed);
		await expect(f.handlers.move({ lishID: f.id, newDirectory: second, moveData: true, createSubdirectory: false })).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
		expect(f.data.get(f.id)?.directory).toBe(first);
		expect(await readFile(join(first, 'copy.bin'), 'utf8')).toBe('abcd');
	} finally {
		await f.close();
	}
});


test('the dialog can move directly into an existing empty folder', async () => {
 const f = await completeDataset();
 const target = join(f.base, 'selected');
 await mkdir(target);
 try {
  expect(await f.handlers.move({lishID:f.id,newDirectory:target,moveData:true,createSubdirectory:false})).toEqual({success:true});
  expect(f.data.get(f.id)?.directory).toBe(target);
  expect(await readFile(join(target,'data.bin'),'utf8')).toBe('abcd');
  expect(f.events.some(event=>event.event==='lishs:move' && event.data.directory===target)).toBe(true);
 } finally {await f.close();}
});
