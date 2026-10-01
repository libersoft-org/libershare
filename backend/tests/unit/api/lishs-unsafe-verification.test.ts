import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/database.ts';
import { DataServer } from '../../../src/lish/data-server.ts';
import { Settings } from '../../../src/settings.ts';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import { getEnabledUploads, initUploadState, resetUploadState } from '../../../src/protocol/lish-protocol.ts';
import { initDownloadState, getDownloadEnabledLishs, setEnableDownloadFn } from '../../../src/api/transfer.ts';

test('unsafe verification records the error and never restarts an enabled download', async () => {
 const base = await mkdtemp(join(tmpdir(), 'verify-unsafe-'));
 const source = join(base, 'source');
 const outside = join(base, 'outside');
 await mkdir(source); await mkdir(outside);
 await writeFile(join(outside, 'sentinel'), 'safe');
 await symlink(outside, join(source, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
 const db = openDatabase(base);
 const data = new DataServer(db);
 const id = 'unsafe-verification';
 data.add({ id, created: '2026-01-01', chunkSize: 4, checksumAlgo: 'sha256', directory: source, files: [{ path: 'redirect/sentinel', size: 4, checksums: [new Bun.CryptoHasher('sha256').update('safe').digest('hex')] }] });
 data.setDatasetRoot(id, { kind: 'explicit', path: source });
 data.setDownloadEnabled(id, true); data.setUploadEnabled(id, true);
 initUploadState(new Set([id]), (id, value) => data.setUploadEnabled(id, value));
 initDownloadState(new Set([id]), (id, value) => data.setDownloadEnabled(id, value));
 let resumed = 0;
 setEnableDownloadFn(async () => { resumed++; return { success: true }; });
 const events: any[] = [];
 const handlers = initLISHsHandlers(data, () => {}, (event, payload) => events.push({ event, payload }), await Settings.create(base));
 try {
  await handlers.verify({ lishID: id });
  const limit = Date.now() + 2000;
  while (handlers.list().verifying && Date.now() < limit) await Bun.sleep(5);
  expect(handlers.list().verifying).toBeNull();
  expect(data.listSummaries()[0]?.errorCode).toBe('LISH_UNSAFE_PATH');
  expect(getEnabledUploads().has(id)).toBe(false);
  expect(getDownloadEnabledLishs().has(id)).toBe(false);
  expect(resumed).toBe(0);
  expect(events.some(entry => entry.event === 'transfer.download:error' && entry.payload.error === 'LISH_UNSAFE_PATH')).toBe(true);
  expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('safe');
 } finally {
  await handlers.stopVerifyAll();
  initDownloadState(new Set(), () => {}); initUploadState(new Set(), () => {}); resetUploadState();
  setEnableDownloadFn(async () => ({ success: false }));
  db.close(); await rm(base, { recursive: true, force: true });
 }
});


test('import refuses a linked derived root without deleting the overwritten record', async () => {
 const base = await mkdtemp(join(tmpdir(), 'import-root-'));
 const outside = join(base, 'outside');
 const destination = join(base, 'imports');
 await mkdir(outside); await mkdir(destination);
 await writeFile(join(outside, 'sentinel'), 'safe');
 await symlink(outside, join(destination, 'Dataset'), process.platform === 'win32' ? 'junction' : 'dir');
 const db = openDatabase(base);
 const data = new DataServer(db);
 const id = 'existing-import';
 const old = { id, name: 'Original', created: '2026-01-01', chunkSize: 4, checksumAlgo: 'sha256' as const, directory: outside };
 data.add(old);
 const handlers = initLISHsHandlers(data, () => {}, () => {}, await Settings.create(base));
 try {
  await expect(handlers.importFromJSON({ json: JSON.stringify({ ...old, name: 'Dataset' }), downloadPath: destination, overwrite: true })).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
  expect(data.get(id)?.name).toBe('Original');
  expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('safe');
 } finally { await handlers.stopVerifyAll(); db.close(); await rm(base, { recursive: true, force: true }); }
});
