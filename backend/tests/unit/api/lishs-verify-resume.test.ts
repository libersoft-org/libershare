import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';

/**
 * A verification interrupted by a crash or shutdown used to be forgotten: after the restart
 * the LISH sat at the progress it had reached, and nothing finished checking the data.
 */
async function setup(name: string) {
	const base = await mkdtemp(join(tmpdir(), `verify-resume-${name}-`));
	await writeFile(join(base, 'file'), 'safe');
	const db = openDatabase(base);
	const data = new DataServer(db);
	const id = `verify-resume-${name}`;
	data.add({ id, created: '2026-01-01', chunkSize: 4, checksumAlgo: 'sha256', directory: base, files: [{ path: 'file', size: 4, checksums: [new Bun.CryptoHasher('sha256').update('safe').digest('hex')] }] });
	data.setDatasetRoot(id, { kind: 'explicit', path: base });
	const handlers = initLISHsHandlers(
		data,
		() => {},
		() => {},
		await Settings.create(base)
	);
	const settle = async (): Promise<void> => {
		const limit = Date.now() + 2000;
		while (handlers.list().verifying && Date.now() < limit) await Bun.sleep(5);
	};
	const cleanup = async (): Promise<void> => {
		await handlers.stopVerifyAll();
		db.close();
		await rm(base, { recursive: true, force: true });
	};
	return { data, handlers, id, settle, cleanup };
}

test('a verification interrupted before a restart is finished at startup', async () => {
	const { data, handlers, id, settle, cleanup } = await setup('restart');
	try {
		data.setVerifyPending(id, true);
		handlers.resumePendingVerifications();
		await settle();
		expect(handlers.list().verifying).toBeNull();
		expect(data.getDetail(id)?.verifiedChunks).toBe(1);
		expect(data.getVerifyPendingLishs()).toEqual([]);
	} finally {
		await cleanup();
	}
});

test('a shutdown leaves the started verification pending for the next start', async () => {
	const { data, handlers, id, cleanup } = await setup('shutdown');
	try {
		await handlers.verify({ lishID: id });
		await handlers.stopVerifyAll();
		expect(data.getVerifyPendingLishs()).toEqual([id]);
	} finally {
		await cleanup();
	}
});

test('a verification the user stopped is not resumed', async () => {
	const { data, handlers, id, cleanup } = await setup('user-stop');
	try {
		await handlers.verify({ lishID: id });
		await handlers.stopVerify({ lishID: id });
		expect(data.getVerifyPendingLishs()).toEqual([]);
	} finally {
		await cleanup();
	}
});
