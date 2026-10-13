import { test, expect, spyOn } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import { getDownloadEnabledLishs, initDownloadState, initTransferHandlers, setEnableDownloadFn } from '../../../src/api/transfer.ts';
import { Downloader } from '../../../src/protocol/downloader.ts';

/**
 * A verification interrupted by a crash or shutdown used to be forgotten: after the restart
 * the LISH sat at the progress it had reached, and nothing finished checking the data.
 */
async function setup(name: string, extraIDs: string[] = []) {
	const base = await mkdtemp(join(tmpdir(), `verify-resume-${name}-`));
	await writeFile(join(base, 'file'), 'safe');
	const id = `verify-resume-${name}`;
	// Verifications of a LISH listed here wait in openDataset until the test releases them.
	const held = new Map<string, { promise: Promise<void>; resolve: () => void }>();
	const hold = (lishID: string): (() => void) => {
		const gate = Promise.withResolvers<void>();
		held.set(lishID, gate);
		return () => {
			held.delete(lishID);
			gate.resolve();
		};
	};
	/** One run of the backend over the data dir: a fresh database connection, data server and handlers. */
	// Verifications of a LISH listed here fail in openDataset the way a permission error does.
	const failing = new Set<string>();
	const start = async () => {
		const db = openDatabase(base);
		const data = new DataServer(db);
		const openDataset = data.openDataset.bind(data);
		data.openDataset = (async (lishID: string) => {
			await held.get(lishID)?.promise;
			if (failing.has(lishID)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
			return openDataset(lishID as never);
		}) as typeof data.openDataset;
		const handlers = initLISHsHandlers(
			data,
			() => {},
			() => {},
			await Settings.create(base)
		);
		return { db, data, handlers };
	};
	let run = await start();
	for (const lishID of [id, ...extraIDs]) {
		run.data.add({ id: lishID, created: '2026-01-01', chunkSize: 4, checksumAlgo: 'sha256', directory: base, files: [{ path: 'file', size: 4, checksums: [new Bun.CryptoHasher('sha256').update('safe').digest('hex')] }] });
		run.data.setDatasetRoot(lishID, { kind: 'explicit', path: base });
	}
	const settle = async (): Promise<void> => {
		const limit = Date.now() + 2000;
		while (run.handlers.list().verifying && Date.now() < limit) await Bun.sleep(5);
	};
	/** Shut the backend down the way the app does, then start it again on the same database. */
	const restart = async (): Promise<void> => {
		await run.handlers.stopVerifyAll();
		run.db.close();
		run = await start();
	};
	const cleanup = async (): Promise<void> => {
		for (const gate of held.values()) gate.resolve();
		await run.handlers.stopVerifyAll();
		run.db.close();
		await rm(base, { recursive: true, force: true });
	};
	return { run: () => run, id, hold, failing, settle, restart, cleanup };
}

test('the start-up download resume leaves a LISH alone while its failed verification is still owed', async () => {
	const { run, id, failing, settle, cleanup } = await setup('owed');
	const node = { pauseLISHProtocolHandlersAndDrain: async () => {}, resumeLISHProtocolHandlers: () => {}, onPeerDisconnect: () => () => {}, broadcast: async () => {}, getTopicPeers: () => [], isRunning: () => true };
	const networks = { getNetwork: () => node, getRunningNetwork: () => node, getEnabled: () => [{ networkID: 'network-a' }], isJoined: (networkID: string) => networkID === 'network-a' } as never;
	const enabled: string[] = [];
	run().data.setDownloadEnabled(id, true);
	initDownloadState(new Set([id]), (lishID, value) => run().data.setDownloadEnabled(lishID, value));
	const transfer = initTransferHandlers(
		networks,
		run().data,
		join(tmpdir(), 'verify-resume-owed-downloads'),
		() => {},
		(event, data) => {
			if (event === 'transfer.download:enabled') enabled.push(data.lishID);
		},
		undefined,
		run().handlers.startVerification
	);
	const init = spyOn(Downloader.prototype, 'init').mockImplementation(async () => {});
	try {
		// Left by the previous run, which stopped mid-verification.
		run().data.setVerifyPending(id, true);
		failing.add(id);
		run().handlers.resumePendingVerifications();
		await settle();
		// Past the moment the transfer handlers resume every download that was on before the start.
		await Bun.sleep(3300);
		expect(run().data.getVerifyPendingLishs()).toEqual([id]);
		expect(init).not.toHaveBeenCalled();
		expect(enabled).toEqual([]);
	} finally {
		init.mockRestore();
		await transfer.clearAll();
		initDownloadState(new Set(), () => {});
		await cleanup();
	}
}, 10_000);

test('a network restart restores no download while a failed verification is still owed', async () => {
	const { run, id, failing, settle, cleanup } = await setup('owed-restore');
	const node = { pauseLISHProtocolHandlersAndDrain: async () => {}, resumeLISHProtocolHandlers: () => {}, onPeerDisconnect: () => () => {}, broadcast: async () => {}, getTopicPeers: () => [], isRunning: () => true };
	const networks = { getNetwork: () => node, getRunningNetwork: () => node, getEnabled: () => [{ networkID: 'network-a' }], isJoined: (networkID: string) => networkID === 'network-a' } as never;
	run().data.setDownloadEnabled(id, true);
	initDownloadState(new Set([id]), (lishID, value) => run().data.setDownloadEnabled(lishID, value));
	const enabled: string[] = [];
	const transfer = initTransferHandlers(
		networks,
		run().data,
		join(tmpdir(), 'verify-resume-owed-restore'),
		() => {},
		(event, data) => {
			if (event === 'transfer.download:enabled') enabled.push(data.lishID);
		},
		undefined,
		run().handlers.startVerification
	);
	try {
		failing.add(id);
		await run().handlers.verify({ lishID: id });
		await settle();
		await transfer.restoreAll(new Set([id]));
		expect(enabled).toEqual([]);
		expect(getDownloadEnabledLishs().has(id)).toBe(true);
		expect(run().data.getVerifyPendingLishs()).toEqual([id]);
	} finally {
		await transfer.clearAll();
		initDownloadState(new Set(), () => {});
		await cleanup();
	}
});

test('a verification that failed on a data error resumes no download and is finished after the restart', async () => {
	const { run, id, failing, settle, restart, cleanup } = await setup('failed');
	initDownloadState(new Set([id]), () => {});
	let resumed = 0;
	setEnableDownloadFn(async () => {
		resumed++;
		return { success: true };
	});
	try {
		failing.add(id);
		await run().handlers.verify({ lishID: id });
		await settle();
		expect(run().data.getVerifyPendingLishs()).toEqual([id]);
		expect(resumed).toBe(0);

		failing.delete(id);
		await restart();
		run().handlers.resumePendingVerifications();
		await settle();

		expect(run().data.getDetail(id)?.verifiedChunks).toBe(1);
		expect(run().data.getVerifyPendingLishs()).toEqual([]);
		expect(resumed).toBe(1);
	} finally {
		initDownloadState(new Set(), () => {});
		setEnableDownloadFn(async () => ({ success: false }));
		await cleanup();
	}
});

test('a verification interrupted by a shutdown is finished after the restart', async () => {
	const { run, id, hold, settle, restart, cleanup } = await setup('restart');
	try {
		const release = hold(id);
		await run().handlers.verify({ lishID: id });
		const stopping = restart();
		release();
		await stopping;
		expect(run().data.getVerifyPendingLishs()).toEqual([id]);
		expect(run().data.getDetail(id)?.verifiedChunks).toBe(0);

		run().handlers.resumePendingVerifications();
		await settle();

		expect(run().handlers.list().verifying).toBeNull();
		expect(run().data.getDetail(id)?.verifiedChunks).toBe(1);
		expect(run().data.getVerifyPendingLishs()).toEqual([]);
	} finally {
		await cleanup();
	}
});

test('a shutdown leaves the started verification pending for the next start', async () => {
	const { run, id, cleanup } = await setup('shutdown');
	try {
		await run().handlers.verify({ lishID: id });
		await run().handlers.stopVerifyAll();
		expect(run().data.getVerifyPendingLishs()).toEqual([id]);
	} finally {
		await cleanup();
	}
});

test('verifications the user stopped all at once are not resumed', async () => {
	const { run, id, cleanup } = await setup('user-stop-all');
	try {
		await run().handlers.verify({ lishID: id });
		await run().handlers.cancelVerifyAll();
		expect(run().data.getVerifyPendingLishs()).toEqual([]);
	} finally {
		await cleanup();
	}
});

test('a verification requested while "stop all" waits keeps its mark for the next start', async () => {
	const { run, id, hold, cleanup } = await setup('stop-all-race', ['verify-resume-stop-all-race-b']);
	const other = 'verify-resume-stop-all-race-b';
	try {
		const releaseFirst = hold(id);
		hold(other);
		await run().handlers.verify({ lishID: id });
		// "Stop all" now waits for the first verification to leave openDataset.
		const cancelling = run().handlers.cancelVerifyAll();
		await run().handlers.verify({ lishID: other });
		releaseFirst();
		await cancelling;
		expect(run().data.getVerifyPendingLishs()).toEqual([other]);
	} finally {
		await cleanup();
	}
});

test('a verification the user stopped is not resumed', async () => {
	const { run, id, cleanup } = await setup('user-stop');
	try {
		await run().handlers.verify({ lishID: id });
		await run().handlers.stopVerify({ lishID: id });
		expect(run().data.getVerifyPendingLishs()).toEqual([]);
	} finally {
		await cleanup();
	}
});
