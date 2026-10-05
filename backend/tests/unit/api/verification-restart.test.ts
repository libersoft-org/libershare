import { expect, it, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IStoredLISH } from '@shared';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import { getBusyReason } from '../../../src/api/busy.ts';
import { initDownloadState, getDownloadEnabledLishs, initTransferHandlers } from '../../../src/api/transfer.ts';
import { Downloader } from '../../../src/protocol/downloader.ts';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => {
		resolve = done;
	});
	return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Verification did not reach the expected state');
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), 'lish-verification-restart-'));
	const db = openDatabase(directory);
	const data = new DataServer(db);
	const settings = await Settings.create(directory);
	const events: Array<{ event: string; data: any }> = [];
	const handlers = initLISHsHandlers(
		data,
		() => {},
		(event, value) => events.push({ event, data: value }),
		settings
	);
	const manifests: IStoredLISH[] = [];
	for (const name of ['a', 'b']) {
		const content = Buffer.from(name);
		await writeFile(join(directory, name + '.bin'), content);
		const checksum = new Bun.CryptoHasher('sha256').update(content).digest('hex');
		const manifest: IStoredLISH = { id: randomUUID(), name, created: '2026-01-01T00:00:00Z', chunkSize: 65536, checksumAlgo: 'sha256', directory, files: [{ path: name + '.bin', size: 1, checksums: [checksum] }] };
		data.add(manifest);
		manifests.push(manifest);
	}
	const [a, b] = manifests as [IStoredLISH, IStoredLISH];
	const entered = deferred();
	const release = deferred();
	// Hold the first read of a.bin mid-verification, where the dataset opens that file.
	const openDataset = data.openDataset.bind(data);
	let first = true;
	const files = spyOn(data, 'openDataset').mockImplementation(async lishID => {
		const dataset = await openDataset(lishID);
		if (lishID !== a.id) return dataset;
		const openFile = dataset.openFile.bind(dataset);
		dataset.openFile = (async (path, mode) => {
			if (first && path === 'a.bin') {
				first = false;
				entered.resolve();
				await release.promise;
			}
			return openFile(path, mode);
		}) as typeof dataset.openFile;
		return dataset;
	});
	return {
		directory,
		data,
		settings,
		handlers,
		events,
		a,
		b,
		entered,
		release,
		cleanup: async () => {
			release.resolve();
			await handlers.stopVerifyAll();
			files.mockRestore();
			db.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

it('restart drains the interrupted verifier and resumes the same busy queue once', async () => {
	const f = await fixture();
	try {
		f.handlers.startVerification(f.a.id);
		await f.entered.promise;
		f.handlers.startVerification(f.b.id);
		let drained = false;
		const pause = f.handlers.pauseForNetworkRestart().then(() => {
			drained = true;
		});
		const again = f.handlers.pauseForNetworkRestart();
		await Promise.resolve();
		expect(drained).toBe(false);
		await expect(f.handlers.runMutation(async () => {})).rejects.toThrow('paused');
		f.release.resolve();
		await Promise.all([pause, again]);
		expect(f.handlers.list().verifying).toBeNull();
		expect(f.handlers.list().pendingVerification).toEqual([f.a.id, f.b.id]);
		for (const lish of [f.a, f.b]) {
			expect(getBusyReason(lish.id)).toBe('verifying');
			expect(f.data.getDetail(lish.id)!.verifiedChunks).toBe(0);
		}
		expect(f.events.some(event => event.data.done)).toBe(false);
		f.handlers.resumeMutations();
		await until(() => f.handlers.list().verifying === null && f.handlers.list().pendingVerification.length === 0);
		for (const lish of [f.a, f.b]) {
			expect(f.data.getDetail(lish.id)!.verifiedChunks).toBe(1);
			expect(getBusyReason(lish.id)).toBeUndefined();
		}
		expect(f.events.filter(event => event.data.started).map(event => event.data.lishID)).toEqual([f.a.id, f.a.id, f.b.id]);
	} finally {
		await f.cleanup();
	}
});

it('an import admitted before pause can enqueue verification but cannot start it while paused', async () => {
	const f = await fixture();
	const admitted = deferred();
	const releaseImport = deferred();
	try {
		const path = join(f.directory, 'late');
		await mkdir(path);
		await writeFile(join(path, 'a.bin'), 'a');
		const manifest = { ...f.a, id: randomUUID(), name: 'late' };
		const importing = f.handlers.runMutation(async () => {
			admitted.resolve();
			await releaseImport.promise;
			return f.handlers.importManifestAdmitted(manifest, f.directory);
		});
		await admitted.promise;
		const paused = f.handlers.pauseForNetworkRestart();
		releaseImport.resolve();
		await importing;
		await paused;
		expect(f.handlers.list().verifying).toBeNull();
		expect(f.handlers.list().pendingVerification).toEqual([manifest.id]);
		expect(getBusyReason(manifest.id)).toBe('verifying');
		expect(f.data.getDetail(manifest.id)!.verifiedChunks).toBe(0);
		f.handlers.resumeMutations();
		await until(() => f.data.getDetail(manifest.id)!.verifiedChunks === 1 && f.handlers.list().verifying === null);
	} finally {
		releaseImport.resolve();
		await f.cleanup();
	}
});

it('restart does not revive a verification the user already cancelled', async () => {
	const f = await fixture();
	try {
		f.handlers.startVerification(f.a.id);
		await f.entered.promise;
		f.handlers.startVerification(f.b.id);
		await f.handlers.stopVerify({ lishID: f.a.id });
		const paused = f.handlers.pauseForNetworkRestart();
		f.release.resolve();
		await paused;
		expect(f.handlers.list().pendingVerification).toEqual([f.b.id]);
		expect(getBusyReason(f.a.id)).toBeUndefined();
		f.handlers.resumeMutations();
		await until(() => f.data.getDetail(f.b.id)!.verifiedChunks === 1 && f.handlers.list().verifying === null);
		expect(f.data.getDetail(f.a.id)!.verifiedChunks).toBe(0);
	} finally {
		await f.cleanup();
	}
});

it('an explicit stop-all still removes the preserved verification queue', async () => {
	const f = await fixture();
	try {
		f.handlers.startVerification(f.a.id);
		await f.entered.promise;
		f.handlers.startVerification(f.b.id);
		const paused = f.handlers.pauseForNetworkRestart();
		f.release.resolve();
		await paused;
		await f.handlers.stopVerifyAll();
		f.handlers.resumeMutations();
		expect(f.handlers.list().verifying).toBeNull();
		expect(f.handlers.list().pendingVerification).toEqual([]);
		for (const lish of [f.a, f.b]) {
			expect(getBusyReason(lish.id)).toBeUndefined();
			expect(f.data.getDetail(lish.id)!.verifiedChunks).toBe(0);
		}
	} finally {
		await f.cleanup();
	}
});

it('real transfer restoration waits for verification and retains download intent after a failed restart', async () => {
	const f = await fixture();
	const node = { pauseLISHProtocolHandlersAndDrain: async () => {}, resumeLISHProtocolHandlers: () => {}, onPeerDisconnect: () => () => {}, broadcast: async () => {}, getTopicPeers: () => [], isRunning: () => true };
	const networks = { getNetwork: () => node, getRunningNetwork: () => node, getEnabled: () => [{ networkID: 'network-a' }], isJoined: (id: string) => id === 'network-a' } as never;
	const transferEvents: Array<{ event: string; lishID: string; busy: string | undefined }> = [];
	const transfer = initTransferHandlers(
		networks,
		f.data,
		f.directory,
		() => {},
		(event, data) => transferEvents.push({ event, lishID: data.lishID, busy: getBusyReason(data.lishID) }),
		f.settings,
		f.handlers.startVerification
	);
	const init = spyOn(Downloader.prototype, 'init');
	try {
		const enabled = new Set([f.a.id, f.b.id]);
		for (const id of enabled) f.data.setDownloadEnabled(id, true);
		initDownloadState(enabled, (id, value) => f.data.setDownloadEnabled(id, value));
		f.handlers.startVerification(f.a.id);
		await f.entered.promise;
		f.handlers.startVerification(f.b.id);
		const paused = f.handlers.pauseForNetworkRestart();
		await transfer.pauseAll();
		f.release.resolve();
		await paused;
		const snapshot = await transfer.clearAll({ preserveRecovery: true });
		await transfer.restoreAll(enabled, snapshot);
		expect(init).not.toHaveBeenCalled();
		expect(getDownloadEnabledLishs()).toEqual(enabled);
		expect(transferEvents.filter(event => event.event === 'transfer.download:enabled')).toEqual([]);
		// A failed network start keeps transfer admission closed while local verification resumes.
		f.handlers.resumeMutations();
		await until(() => f.handlers.list().verifying === null && f.handlers.list().pendingVerification.length === 0);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(transferEvents.filter(event => event.event === 'transfer.download:enabled')).toEqual([]);
		expect(init).not.toHaveBeenCalled();
		for (const id of enabled) expect(f.data.getDownloadEnabledLishs().has(id)).toBe(true);
		await transfer.restoreAll(enabled, snapshot);
		transfer.resumeAll();
		expect(transferEvents.filter(event => event.event === 'transfer.download:enabled').map(event => event.lishID)).toEqual([...enabled]);
		expect(transferEvents.every(event => event.busy !== 'verifying')).toBe(true);
	} finally {
		f.release.resolve();
		await f.handlers.stopVerifyAll();
		await transfer.clearAll();
		init.mockRestore();
		initDownloadState(new Set(), () => {});
		await f.cleanup();
	}
});
