import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initTransferHandlers, initDownloadState } from '../../../src/api/transfer.ts';
import { initUploadState } from '../../../src/protocol/lish-protocol.ts';
import { initLISHsTables, addLISH, setDownloadEnabled, setUploadEnabled } from '../../../src/db/lishs.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

/** A complete LISH without a chunk, stored in `download`, with the transfer handlers over a network that has no peers. */
async function fixture(files: { path: string; size: number; checksums: string[] }[]) {
	const dir = await mkdtemp(join(tmpdir(), 'lish-missing-folders-'));
	const db = new Database(':memory:');
	initLISHsTables(db);
	const data = new DataServer(db);
	const id = 'folders-dataset';
	const download = join(dir, 'download');
	await mkdir(download);
	addLISH(db, { id, name: 'Folders', created: '2026-01-01T00:00:00Z', chunkSize: 65536, checksumAlgo: 'sha256', directory: download, directories: [{ path: 'Saves' }], ...(files.length > 0 ? { files } : {}) } as never);
	initDownloadState(new Set(), (key, enabled) => setDownloadEnabled(db, key, enabled));
	initUploadState(new Set(), (key, enabled) => setUploadEnabled(db, key, enabled));
	const network = { pauseLISHProtocolHandlersAndDrain: async () => {}, resumeLISHProtocolHandlers() {}, onPeerDisconnect: () => () => {}, broadcast: async () => {}, getTopicPeers: () => [], isRunning: () => true };
	const networks = { getNetwork: () => network, getRunningNetwork: () => network, getEnabled: () => [{ networkID: 'network-a' }], isJoined: () => true };
	const handlers = initTransferHandlers(
		networks as never,
		data,
		dir,
		() => {},
		() => {},
		await Settings.create(dir)
	);
	cleanup.push(async () => {
		await handlers.clearAll();
		initUploadState(new Set(), () => {});
		initDownloadState(new Set(), () => {});
		db.close();
		await rm(dir, { recursive: true, force: true });
	});
	return { id, download, handlers };
}

/** The download that creates a folder runs after the call returned. */
async function appears(path: string): Promise<boolean> {
	for (const deadline = Date.now() + 3000; !existsSync(path) && Date.now() < deadline;) await Bun.sleep(20);
	return existsSync(path);
}

test('a network restart creates a folder again that went missing from a complete LISH with folders only', async () => {
	const f = await fixture([]);
	await mkdir(join(f.download, 'Saves'));
	await f.handlers.restoreAll(new Set([f.id]));
	await rm(join(f.download, 'Saves'), { recursive: true });
	await f.handlers.restoreAll(new Set([f.id]));
	expect(await appears(join(f.download, 'Saves'))).toBe(true);
});

test('enabling the download creates a missing folder even when an empty file of the LISH is in place', async () => {
	const f = await fixture([{ path: 'empty.txt', size: 0, checksums: [] }]);
	await writeFile(join(f.download, 'empty.txt'), '');
	expect(await f.handlers.enableDownload({ lishID: f.id })).toEqual({ success: true });
	expect(await appears(join(f.download, 'Saves'))).toBe(true);
});
