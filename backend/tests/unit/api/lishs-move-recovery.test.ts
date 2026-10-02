import { expect, test, spyOn } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import { initDownloadState, getDownloadEnabledLishs, setActiveDownloadersRef, setEnableDownloadFn, forceDisableDownload } from '../../../src/api/transfer.ts';
import { initUploadState, getEnabledUploads, resetUploadState } from '../../../src/protocol/lish-protocol.ts';
import { SafeDataset } from '../../../src/lish/safe-dataset-files.ts';
import { getBusyReason } from '../../../src/api/busy.ts';

function gate() {
	let release!: () => void;
	const promise = new Promise<void>(resolve => {
		release = resolve;
	});
	return { promise, release };
}

test.each([true, false])('an old move cannot clear a replacement import verification (existing target: %s)', async existingTarget => {
	const f = await fixture();
	if (!existingTarget) await rm(f.target, { recursive: true });
	const sourceEntered = gate();
	const releaseSource = gate();
	const verifyEntered = gate();
	const releaseVerify = gate();
	const originalPrepare = SafeDataset.prototype.prepare;
	let sourceHeld = false;
	const prepare = spyOn(SafeDataset.prototype, 'prepare').mockImplementation(async function (this: SafeDataset, manifest, options) {
		await originalPrepare.call(this, manifest, options);
		if (!sourceHeld && options?.writable === false) {
			sourceHeld = true;
			sourceEntered.release();
			await releaseSource.promise;
		}
	});
	const open = f.data.openDataset.bind(f.data);
	const verifying = spyOn(f.data, 'openDataset').mockImplementation(async id => {
		verifyEntered.release();
		await releaseVerify.promise;
		return open(id);
	});
	let moved: ReturnType<typeof f.start> | undefined;
	try {
		moved = f.start();
		await f.stopping.promise;
		f.stopped.release();
		await sourceEntered.promise;
		const imported = await f.handlers.importFromJSON({ json: JSON.stringify(f.data.get(f.id)), downloadPath: join(f.base, 'replacement'), overwrite: true, enableDownloading: false, enableSharing: false });
		await verifyEntered.promise;
		expect(getBusyReason(f.id)).toBe('verifying');
		releaseSource.release();
		const result = await moved;
		expect(result).toBeInstanceOf(Error);
		expect(getBusyReason(f.id)).toBe('verifying');
		expect(f.data.get(f.id)?.directory).toBe(imported.directory);
		expect(await readFile(join(f.source, 'folder/data.bin'), 'utf8')).toBe('abcd');
		expect(f.resumes()).toBe(0);
	} finally {
		releaseSource.release();
		releaseVerify.release();
		f.stopped.release();
		await moved;
		prepare.mockRestore();
		verifying.mockRestore();
		await f.close();
	}
});

async function fixture() {
	const base = await mkdtemp(join(tmpdir(), 'move-recovery-'));
	const source = join(base, 'source');
	const target = join(base, 'target');
	await mkdir(join(source, 'folder'), { recursive: true });
	await mkdir(target);
	await writeFile(join(source, 'folder/data.bin'), 'abcd');
	await writeFile(join(target, 'sentinel'), 'keep');
	const db = openDatabase(base);
	const data = new DataServer(db);
	const id = 'move-recovery';
	data.addDataset({ id, name: 'dataset', created: '2026-01-01', chunkSize: 4, checksumAlgo: 'sha256', directory: source, files: [{ path: 'folder/data.bin', size: 4, checksums: [new Bun.CryptoHasher('sha256').update('abcd').digest('hex')] }] }, { kind: 'explicit', path: source });
	data.setDownloadEnabled(id, true);
	initDownloadState(new Set([id]), (id, enabled) => data.setDownloadEnabled(id, enabled));
	initUploadState(new Set(), (id, enabled) => data.setUploadEnabled(id, enabled));
	const stopping = gate();
	const stopped = gate();
	let destroys = 0;
	let resumes = 0;
	const active = new Map<string, any>([
		[
			id,
			{
				destroy: async () => {
					destroys++;
					stopping.release();
					await stopped.promise;
				},
			},
		],
	]);
	setActiveDownloadersRef(active);
	setEnableDownloadFn(async ({ lishID }) => {
		resumes++;
		active.set(lishID, { destroy: async () => {} });
		return { success: true };
	});
	const events: { event: string; data: any }[] = [];
	const handlers = initLISHsHandlers(
		data,
		() => {},
		(event, payload) => events.push({ event, data: payload }),
		await Settings.create(base)
	);
	async function settled() {
		const limit = Date.now() + 2000;
		while (handlers.list().verifying && Date.now() < limit) await Bun.sleep(5);
		expect(handlers.list().verifying).toBeNull();
	}
	return {
		base,
		source,
		target,
		data,
		db,
		id,
		active,
		stopping,
		stopped,
		handlers,
		events,
		settled,
		destroys: () => destroys,
		resumes: () => resumes,
		start() {
			return handlers.move({ lishID: id, newDirectory: target, createSubdirectory: false, moveData: true }).then(
				value => value,
				error => error
			);
		},
		async close() {
			stopped.release();
			await handlers.stopVerifyAll();
			setActiveDownloadersRef(new Map());
			setEnableDownloadFn(async () => ({ success: false }));
			initDownloadState(new Set(), () => {});
			initUploadState(new Set(), () => {});
			resetUploadState();
			db.close();
			await rm(base, { recursive: true, force: true });
		},
	};
}

test('a destination collision restores enabled work on the original dataset and preserves EEXIST', async () => {
	const f = await fixture();
	try {
		const moved = f.start();
		await f.stopping.promise;
		expect(f.destroys()).toBe(1);
		f.stopped.release();
		expect(await moved).toMatchObject({ code: 'EEXIST' });
		await f.settled();
		expect(f.resumes()).toBe(1);
		expect(f.active.has(f.id)).toBe(true);
		expect(getDownloadEnabledLishs().has(f.id)).toBe(true);
		expect(f.data.getDownloadEnabledLishs().has(f.id)).toBe(true);
		expect(f.data.get(f.id)?.directory).toBe(f.source);
		expect(await readFile(join(f.source, 'folder/data.bin'), 'utf8')).toBe('abcd');
		expect(await readFile(join(f.target, 'sentinel'), 'utf8')).toBe('keep');
	} finally {
		await f.close();
	}
});

test('manual disable while stopping a move is not undone after collision', async () => {
	const f = await fixture();
	try {
		const moved = f.start();
		await f.stopping.promise;
		const disabled = forceDisableDownload(f.id);
		f.stopped.release();
		await disabled;
		expect(await moved).toMatchObject({ code: 'EEXIST' });
		await f.settled();
		expect(f.resumes()).toBe(0);
		expect(getDownloadEnabledLishs().has(f.id)).toBe(false);
		expect(f.data.getDownloadEnabledLishs().has(f.id)).toBe(false);
	} finally {
		await f.close();
	}
});

test('a reset closing admission prevents restoration after a failed move', async () => {
	const f = await fixture();
	try {
		const moved = f.start();
		await f.stopping.promise;
		const paused = f.handlers.pauseMutations();
		f.stopped.release();
		expect(await moved).toMatchObject({ code: 'EEXIST' });
		await paused;
		expect(f.resumes()).toBe(0);
		expect(f.events.some(item => item.event === 'lishs:verify' && item.data.started)).toBe(false);
	} finally {
		await f.close();
	}
});

test('deletion during a failed move does not revive the removed dataset', async () => {
	const f = await fixture();
	try {
		const moved = f.start();
		await f.stopping.promise;
		const deleted = f.handlers.delete({ lishID: f.id, deleteLISH: true, deleteData: false });
		f.stopped.release();
		expect(await moved).toMatchObject({ code: 'INTERNAL_ERROR', detail: 'Dataset changed while its move was in progress' });
		await deleted;
		await f.settled();
		expect(f.resumes()).toBe(0);
		expect(f.data.get(f.id)).toBeNull();
	} finally {
		await f.close();
	}
});

test('an unsafe source remains stopped after a move is refused', async () => {
	const f = await fixture();
	try {
		await rename(join(f.source, 'folder'), join(f.base, 'outside'));
		await symlink(join(f.base, 'outside'), join(f.source, 'folder'), process.platform === 'win32' ? 'junction' : 'dir');
		const moved = f.start();
		await f.stopping.promise;
		f.stopped.release();
		expect(await moved).toMatchObject({ code: 'LISH_UNSAFE_PATH' });
		await f.settled();
		expect(f.resumes()).toBe(0);
		expect(f.events.some(item => item.event === 'lishs:verify' && item.data.started)).toBe(false);
		expect(getDownloadEnabledLishs().has(f.id)).toBe(false);
		expect(f.data.getDownloadEnabledLishs().has(f.id)).toBe(false);
		expect(getEnabledUploads().has(f.id)).toBe(false);
		expect(await readFile(join(f.base, 'outside/data.bin'), 'utf8')).toBe('abcd');
	} finally {
		await f.close();
	}
});

test('a disable during recovery verification prevents the later download restart', async () => {
	const f = await fixture();
	const checking = gate();
	const checked = gate();
	const open = f.data.openDataset.bind(f.data);
	const verifying = spyOn(f.data, 'openDataset').mockImplementation(async id => {
		checking.release();
		await checked.promise;
		return open(id);
	});
	try {
		const moved = f.start();
		await f.stopping.promise;
		f.stopped.release();
		expect(await moved).toMatchObject({ code: 'EEXIST' });
		await checking.promise;
		await forceDisableDownload(f.id);
		checked.release();
		await f.settled();
		expect(f.resumes()).toBe(0);
		expect(getDownloadEnabledLishs().has(f.id)).toBe(false);
	} finally {
		checked.release();
		await f.handlers.stopVerifyAll();
		verifying.mockRestore();
		await f.close();
	}
});

test('a verification cancellation during a move revokes recovery', async () => {
	const f = await fixture();
	try {
		const moved = f.start();
		await f.stopping.promise;
		await f.handlers.stopVerify({ lishID: f.id });
		f.stopped.release();
		expect(await moved).toMatchObject({ code: 'INTERNAL_ERROR', detail: 'Dataset changed while its move was in progress' });
		await f.settled();
		expect(f.resumes()).toBe(0);
		expect(f.events.some(item => item.event === 'lishs:verify' && item.data.started)).toBe(false);
	} finally {
		await f.close();
	}
});
