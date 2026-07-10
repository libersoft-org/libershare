/**
 * Throwaway helper for manual/Playwright UI verification of the leave-lishnet disconnect behaviour.
 * Boots two nodes on FIXED ports, joins a shared lishnet, shares an 8 MB LISH
 * from node1 and starts a throttled download on node2 — then keeps running so
 * a frontend (pointed at node2) can be inspected. Ctrl+C / kill to stop.
 *
 * Run from repo root: bun run backend/tests/dev/ui-scenario-leave-network.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { TestClient } from '../e2e/helpers/ws-test-client.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const NET_ID = 'net-leave-ui';
const WS1 = 44911;
const WS2 = 44912;

const tmp = mkdtempSync(join(tmpdir(), 'lish-leave-ui-'));
const dirs = { node1: join(tmp, 'node1'), node2: join(tmp, 'node2'), share: join(tmp, 'share'), dl2: join(tmp, 'dl2') };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
writeFileSync(join(dirs.node1, 'settings.json'), JSON.stringify({ network: { incomingPort: WS1 + 1000 } }));
writeFileSync(join(dirs.node2, 'settings.json'), JSON.stringify({ network: { incomingPort: WS2 + 1000, maxDownloadSpeed: 64 } }));
writeFileSync(join(dirs.share, 'payload.bin'), randomBytes(8 * 1024 * 1024));

function spawnNode(datadir: string, port: number, logPath: string) {
	return Bun.spawn(['bun', 'run', 'backend/src/app.ts', '--datadir', datadir, '--port', String(port), '--host', '127.0.0.1'], {
		cwd: REPO_ROOT,
		stdout: Bun.file(logPath),
		stderr: Bun.file(logPath + '.err'),
		stdin: 'ignore',
	});
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const p1 = spawnNode(dirs.node1, WS1, join(tmp, 'node1.log'));
const p2 = spawnNode(dirs.node2, WS2, join(tmp, 'node2.log'));
console.log(`[ui-leave] node1 pid=${p1.pid} ws=${WS1}, node2 pid=${p2.pid} ws=${WS2}, tmp=${tmp}`);

const node1 = new TestClient(`ws://127.0.0.1:${WS1}`);
const node2 = new TestClient(`ws://127.0.0.1:${WS2}`);
await node1.waitConnected(30000);
await node2.waitConnected(30000);

const netDef = { networkID: NET_ID, name: 'Net leave UI', description: '', bootstrapPeers: [], created: new Date().toISOString(), enabled: true };
await node1.call('lishnets.add', { network: netDef });
await node2.call('lishnets.add', { network: netDef });
await node1.call('lishnets.setEnabled', { networkID: NET_ID, enabled: true });
await node2.call('lishnets.setEnabled', { networkID: NET_ID, enabled: true });

const addrs: string[] = await node1.call('lishnets.getAddresses');
const loop = addrs.find(a => a.includes('127.0.0.1')) ?? addrs[0]!;
await node2.call('lishnets.connect', { multiaddr: loop });

for (let i = 0; i < 60; i++) {
	const s2 = await node2.call('lishnets.getStatus', { networkID: NET_ID }).catch(() => undefined);
	if ((s2?.connectedPeers?.length ?? 0) >= 1) break;
	await sleep(500);
}

const created = await node1.call('lishs.create', { name: 'lish-leave-ui', dataPath: dirs.share, addToSharing: true });
const lishID: string = created?.id ?? created?.lishID ?? created?.lish?.id;
await node1.call('transfer.enableUpload', { lishID }).catch(() => {});

const lishFile = join(tmp, 'manifest.lish');
await node1.call('lishs.exportToFile', { lishID, filePath: lishFile });
await node2.call('lishs.importFromFile', { filePath: lishFile, downloadPath: dirs.dl2, enableDownloading: true });

for (let i = 0; i < 60; i++) {
	const snap = await node2.call('transfer.debugPeers', { lishID }).catch(() => undefined);
	if ((snap?.entries ?? []).filter((e: any) => e.direction === 'download').length >= 1) break;
	await sleep(1000);
}

console.log(`READY lishID=${lishID} ws1=${WS1} ws2=${WS2}`);
// keep the nodes alive for interactive/Playwright inspection
setInterval(() => {}, 60_000);
