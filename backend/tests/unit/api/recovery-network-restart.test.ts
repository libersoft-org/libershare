import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorRecovery } from '../../../src/api/error-recovery.ts';
import { initTransferHandlers, initDownloadState } from '../../../src/api/transfer.ts';
import { initUploadState, getEnabledUploads } from '../../../src/protocol/lish-protocol.ts';
import { initLISHsTables, addLISH, setDownloadEnabled, setUploadEnabled, getDownloadEnabledLishs } from '../../../src/db/lishs.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { NetworkRestartManager } from '../../../src/api/network-restart.ts';
import { effectiveNetworkConfig } from '../../../src/protocol/network-settings.ts';
import { Downloader } from '../../../src/protocol/downloader.ts';
import { ErrorCodes } from '@shared';
import { setBusy, clearBusy } from '../../../src/api/busy.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), 'lish-recovery-restart-'));
	const db = new Database(':memory:');
	initLISHsTables(db);
	const data = new DataServer(db);
	const settings = await Settings.create(dir);
	const id = 'recoverable-dataset';
	const parent = join(dir, 'missing-parent');
	addLISH(db, { id, name: 'Recovery', description: '', created: '2026-01-01T00:00:00Z', chunkSize: 65536, checksumAlgo: 'sha256', directory: join(parent, 'download'), files: [{ path: 'payload.bin', size: 1, checksums: [`sha256:${'a'.repeat(64)}`] }] } as never);
	initDownloadState(new Set(), (key, enabled) => setDownloadEnabled(db, key, enabled));
	initUploadState(new Set(), (key, enabled) => setUploadEnabled(db, key, enabled));
	const network = { pauseLISHProtocolHandlersAndDrain: async () => {}, resumeLISHProtocolHandlers() {}, onPeerDisconnect: () => () => {}, broadcast: async () => {}, getTopicPeers: () => [], isRunning: () => true };
	const networks = { getNetwork: () => network, getRunningNetwork: () => network, getEnabled: () => [{ networkID: 'network-a' }], isJoined: () => true };
	let recovery!: ErrorRecovery;
	const start = ErrorRecovery.prototype.start;
	const capture = spyOn(ErrorRecovery.prototype, 'start').mockImplementation(function (this: ErrorRecovery, ...args: Parameters<typeof start>) { recovery = this; return start.apply(this, args); });
	const handlers = initTransferHandlers(networks as never, data, dir, () => {}, () => {}, settings);
	cleanup.push(async () => { await handlers.clearAll(); capture.mockRestore(); db.close(); await rm(dir, { recursive: true, force: true }); });
	await handlers.enableDownload({ lishID: id });
	expect(getDownloadEnabledLishs(db).has(id)).toBe(false);
	expect(recovery.getState(id)?.downloadWasEnabled).toBe(true);
	let running = true, failStart = false;
	let applied = effectiveNetworkConfig(settings.list().network);
	const manager = new NetworkRestartManager({
		prepareMaintenance: async () => ({ drain: async () => {}, release() {} }), cancelRunOperations() {},
		pauseLISHMutations: async () => {}, resumeLISHMutations() {},
		pauseTransfers: handlers.pauseAll, clearTransfers: () => handlers.clearAll({ preserveRecovery: true }),
		restoreTransfers: handlers.restoreAll, resumeTransfers: handlers.resumeAll,
		downloadIntent: () => getDownloadEnabledLishs(db), applyLimits() {},
		isRunning: () => running, appliedNetworkConfig: () => running ? applied : null,
		stopAllNetworks: async () => { running = false; },
		startEnabledNetworks: async () => { if (failStart) throw new Error('port unavailable'); running = true; applied = effectiveNetworkConfig(settings.list().network); },
	});
	settings.setChangeApplier(change => manager.apply(change));
	return { db, id, parent, handlers, recovery, settings, failStart: (value: boolean) => { failStart = value; } };
}

for (const failedFirst of [false, true]) test(`disk error retry survives network restart with failedFirst=${failedFirst}`, async () => {
	const f = await fixture();
	const port = f.settings.list().network.incomingPort + 1;
	if (failedFirst) {
		f.failStart(true);
		await expect(f.settings.set('network.incomingPort', port)).rejects.toThrow('port unavailable');
		expect(f.recovery.getState(f.id)?.timer).toBeNull();
		expect(f.recovery.getState(f.id)?.downloadWasEnabled).toBe(true);
	}
	await mkdir(f.parent);
	const state = f.recovery.getState(f.id)!;
	state.scheduledAt = Date.now() - state.nextRetryDelay;
	f.failStart(false);
	await f.settings.set('network.incomingPort', port);
	const deadline = Date.now() + 2000;
	while (!getDownloadEnabledLishs(f.db).has(f.id) && Date.now() < deadline) await Bun.sleep(10);
	expect(getDownloadEnabledLishs(f.db).has(f.id)).toBe(true);
});

test('manual disable cancels the retry before a network restart', async () => {
	const f = await fixture();
	expect(f.handlers.disableDownload({ lishID: f.id }).success).toBe(true);
	await f.settings.set('network.incomingPort', f.settings.list().network.incomingPort + 1);
	expect(f.recovery.getState(f.id)).toBeUndefined();
	expect(getDownloadEnabledLishs(f.db).has(f.id)).toBe(false);
});

test('an overdue recovery waits for verification without consuming its retry allowance', async () => {
	const f = await fixture();
	await mkdir(f.parent);
	setBusy(f.id, 'verifying');
	try {
		const original = f.recovery.getState(f.id)!;
		original.scheduledAt = Date.now() - original.nextRetryDelay;
		await f.settings.set('network.incomingPort', f.settings.list().network.incomingPort + 1);
		const attempted = Date.now() + 2000;
		while (f.recovery.getState(f.id) === original && Date.now() < attempted) await Bun.sleep(10);
		const deferred = f.recovery.getState(f.id);
		expect(deferred).not.toBe(original);
		expect(deferred?.downloadWasEnabled).toBe(true);
		expect(deferred?.retryCount).toBe(0);
		expect(getDownloadEnabledLishs(f.db).has(f.id)).toBe(false);
		clearBusy(f.id);
		await f.recovery.pauseAllAndDrain();
		deferred!.scheduledAt = Date.now() - deferred!.nextRetryDelay;
		f.recovery.resumeAll();
		const deadline = Date.now() + 2000;
		while (!getDownloadEnabledLishs(f.db).has(f.id) && Date.now() < deadline) await Bun.sleep(10);
		expect(getDownloadEnabledLishs(f.db).has(f.id)).toBe(true);
	} finally { clearBusy(f.id); }
});

test('an admitted recovery finishes restoring upload before transfer admission closes', async () => {
	const f = await fixture();
	await mkdir(join(f.parent, 'download'), { recursive: true });
	f.recovery.stop(f.id);
	f.recovery.start(f.id, ErrorCodes.DISK_FULL, { downloadEnabled: true, uploadEnabled: true });
	await f.recovery.pauseAllAndDrain();
	const state = f.recovery.getState(f.id)!;
	state.scheduledAt = Date.now() - state.nextRetryDelay;
	const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	const init = Downloader.prototype.initFromManifest;
	const held = spyOn(Downloader.prototype, 'initFromManifest').mockImplementation(async function (this: Downloader, ...args: Parameters<typeof init>) { entered.resolve(); await release.promise; return init.apply(this, args); });
	let pausing: Promise<void> | undefined;
	try {
		f.recovery.resumeAll();
		await entered.promise;
		pausing = f.handlers.pauseAll();
		release.resolve();
		await pausing;
		expect(getDownloadEnabledLishs(f.db).has(f.id)).toBe(true);
		expect(getEnabledUploads().has(f.id)).toBe(true);
		await f.settings.set('network.incomingPort', f.settings.list().network.incomingPort + 1);
		expect(getDownloadEnabledLishs(f.db).has(f.id)).toBe(true);
		expect(getEnabledUploads().has(f.id)).toBe(true);
	} finally {
		release.resolve();
		await pausing;
		held.mockRestore();
	}
});

for (const cancelled of [false, true]) test(`a deferred in-flight attempt survives only maintenance pause, cancelled=${cancelled}`, async () => {
	const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<'deferred'>();
	const recovery = new ErrorRecovery({
		attemptRecover: async () => { entered.resolve(); return release.promise; },
		broadcast() {}, getLISH: id => ({ id, directory: tmpdir() }), checkAccess: async () => {},
	});
	try {
		recovery.start('held-retry', ErrorCodes.DISK_FULL, { downloadEnabled: true, uploadEnabled: true });
		await recovery.pauseAllAndDrain();
		const state = recovery.getState('held-retry')!;
		state.scheduledAt = Date.now() - state.nextRetryDelay;
		recovery.resumeAll();
		await entered.promise;
		const pausing = recovery.pauseAllAndDrain();
		if (cancelled) recovery.stop('held-retry');
		release.resolve('deferred');
		await pausing;
		if (cancelled) expect(recovery.getState('held-retry')).toBeUndefined();
		else expect(recovery.getState('held-retry')).toMatchObject({ downloadWasEnabled: true, uploadWasEnabled: true, retryCount: 0, timer: null });
		recovery.resumeAll();
		if (!cancelled) expect(recovery.getState('held-retry')?.timer).not.toBeNull();
	} finally { release.resolve('deferred'); await recovery.stopAllAndDrain(); }
});
