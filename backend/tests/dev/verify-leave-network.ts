/**
 * Live 2-node verification of the leave-lishnet disconnect behaviour.
 *
 * Scenario from the bug report: a node that shares content leaves the
 * network, yet other nodes still find it via search and an in-flight
 * download keeps running. After the fix, leaving must:
 *   1. stop the leaver from answering searches of that lishnet,
 *   2. starve any in-flight download sourced from the leaver (peer dropped),
 *   3. disable a download whose LAST joined lishnet was left (downloader side).
 *
 * Run from the repo root:  bun run backend/tests/dev/verify-leave-network.ts
 * Exit code 0 = all checks passed.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { TestClient } from '../e2e/helpers/ws-test-client.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const NET_ID = 'net-leave-verify';
const LISH_NAME = 'lish-leave-verify';
const WS_PORT_1 = 44700 + Math.floor(Math.random() * 100);
const WS_PORT_2 = WS_PORT_1 + 1;

const results: Array<{ name: string; pass: boolean; note?: string }> = [];
function check(name: string, pass: boolean, note?: string): void {
	results.push(note === undefined ? { name, pass } : { name, pass, note });
	console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

async function poll<T>(label: string, timeoutMs: number, intervalMs: number, fn: () => Promise<T | undefined>): Promise<T | undefined> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const v = await fn();
			if (v !== undefined) return v;
		} catch {
			// endpoint may not be ready yet — keep polling
		}
		await sleep(intervalMs);
	}
	console.log(`[poll] ${label}: timed out after ${timeoutMs}ms`);
	return undefined;
}

const P2P_PORT_1 = WS_PORT_1 + 1000;
const P2P_PORT_2 = WS_PORT_2 + 1000;

const tmp = mkdtempSync(join(tmpdir(), 'lish-leave-verify-'));
const dirs = {
	node1: join(tmp, 'node1'),
	node2: join(tmp, 'node2'),
	share: join(tmp, 'share'),
	dl2: join(tmp, 'dl2'),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
// Pre-seed partial settings (deep-merged over defaults on load): unique p2p
// listen ports so the two nodes (and any locally running instance) don't
// collide on the default incomingPort, plus a download cap on node2.
writeFileSync(join(dirs.node1, 'settings.json'), JSON.stringify({ network: { incomingPort: P2P_PORT_1 } }));
writeFileSync(join(dirs.node2, 'settings.json'), JSON.stringify({ network: { incomingPort: P2P_PORT_2, maxDownloadSpeed: 256 } }));
// 8 MB payload + 256 KB/s cap on the downloader ⇒ ~32 s transfer window,
// long enough to leave the network mid-flight.
writeFileSync(join(dirs.share, 'payload.bin'), randomBytes(8 * 1024 * 1024));

const log1 = join(tmp, 'node1.log');
const log2 = join(tmp, 'node2.log');

function spawnNode(datadir: string, port: number, logPath: string) {
	// --host 127.0.0.1 keeps the bind IPv4 — plain `localhost` binds only [::1]
	// on Windows and the ws:// client below would never connect.
	return Bun.spawn(['bun', 'run', 'backend/src/app.ts', '--datadir', datadir, '--port', String(port), '--host', '127.0.0.1'], {
		cwd: REPO_ROOT,
		stdout: Bun.file(logPath),
		stderr: Bun.file(logPath + '.err'),
		stdin: 'ignore',
	});
}

/** `bun run` wraps the app in a child process — kill the whole tree. */
function killTree(pid: number): void {
	if (process.platform === 'win32') Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(pid)], { stdout: 'ignore', stderr: 'ignore' });
	else {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// already gone
		}
	}
}

function tail(path: string, lines = 15): string {
	if (!existsSync(path)) return '(no log)';
	const all = readFileSync(path, 'utf8').trim().split('\n');
	return all.slice(-lines).join('\n');
}

const proc1 = spawnNode(dirs.node1, WS_PORT_1, log1);
const proc2 = spawnNode(dirs.node2, WS_PORT_2, log2);
console.log(`[setup] node1 ws:${WS_PORT_1} pid:${proc1.pid}, node2 ws:${WS_PORT_2} pid:${proc2.pid}, tmp: ${tmp}`);

const node1 = new TestClient(`ws://127.0.0.1:${WS_PORT_1}`);
const node2 = new TestClient(`ws://127.0.0.1:${WS_PORT_2}`);

let failedHard = false;
try {
	await node1.waitConnected(30000);
	await node2.waitConnected(30000);
	check('both nodes started and accept WS', true);

	node2.subscribeAll();
	node2.subscribe('search:lishs:update');
	node2.subscribe('search:lishs:complete');
	await sleep(300);

	// --- join the same lishnet on both nodes -------------------------------
	const netDef = { networkID: NET_ID, name: 'Net leave verify', description: '', bootstrapPeers: [], created: new Date().toISOString(), enabled: true };
	await node1.call('lishnets.add', { network: netDef });
	await node2.call('lishnets.add', { network: netDef });
	await node1.call('lishnets.setEnabled', { networkID: NET_ID, enabled: true });
	await node2.call('lishnets.setEnabled', { networkID: NET_ID, enabled: true });

	const addrs: string[] = await node1.call('lishnets.getAddresses');
	const loop = addrs.find(a => a.includes('127.0.0.1')) ?? addrs[0];
	if (!loop) throw new Error('node1 has no listen addresses');
	await node2.call('lishnets.connect', { multiaddr: loop });

	const meshUp = await poll('mesh up', 40000, 500, async () => {
		const s1 = await node1.call('lishnets.getStatus', { networkID: NET_ID });
		const s2 = await node2.call('lishnets.getStatus', { networkID: NET_ID });
		return (s1.connectedPeers?.length ?? 0) >= 1 && (s2.connectedPeers?.length ?? 0) >= 1 ? true : undefined;
	});
	check('nodes joined the lishnet and see each other', meshUp === true);
	if (!meshUp) throw new Error('mesh never formed');

	// --- share content on node1 --------------------------------------------
	const created = await node1.call('lishs.create', { name: LISH_NAME, dataPath: dirs.share, addToSharing: true });
	const lishID: string = created?.id ?? created?.lishID ?? created?.lish?.id;
	if (!lishID) throw new Error(`lishs.create gave no id: ${JSON.stringify(created).slice(0, 200)}`);
	console.log(`[setup] created LISH ${lishID.slice(0, 12)}…`);
	await node1.call('transfer.enableUpload', { lishID }).catch(() => {});

	// --- positive control: search finds the seeder --------------------------
	// retried a few times: right after subscribe the gossipsub mesh may still
	// be grafting, so the first publish can miss the other node
	const searchOnce = async (timeoutMs: number): Promise<any> => {
		const wait = node2.waitForEvent('search:lishs:update', d => (d.lishs ?? []).some((l: any) => l.id === lishID), timeoutMs).catch(() => undefined);
		await node2.call('search.startSearch', { query: LISH_NAME });
		return await wait;
	};
	let found: any;
	for (let i = 0; i < 3 && found === undefined; i++) found = await searchOnce(8000);
	check('search from node2 finds the LISH while node1 is joined', found !== undefined);

	// --- start the download on node2 ----------------------------------------
	const lishFile = join(tmp, 'manifest.lish');
	await node1.call('lishs.exportToFile', { lishID, filePath: lishFile });
	await node2.call('lishs.importFromFile', { filePath: lishFile, downloadPath: dirs.dl2, enableDownloading: true });

	const downloadPeerCount = async (): Promise<number> => {
		const snap = await node2.call('transfer.debugPeers', { lishID });
		return (snap?.entries ?? []).filter((e: any) => e.direction === 'download').length;
	};

	const downloading = await poll('download has a peer', 60000, 1000, async () => ((await downloadPeerCount()) >= 1 ? true : undefined));
	check('node2 download is running with node1 as peer', downloading === true);
	if (!downloading) throw new Error('download never started');

	// =====================================================================
	// ACTION 1 — the SEEDER (node1) leaves the lishnet mid-transfer
	// =====================================================================
	await node1.call('lishnets.setEnabled', { networkID: NET_ID, enabled: false });
	console.log('[action] node1 left the lishnet');

	const starved = await poll('download starved', 30000, 1000, async () => ((await downloadPeerCount()) === 0 ? true : undefined));
	check('in-flight download loses the leaver as peer (transfer stops)', starved === true);

	// The peer must STAY gone: the downloader re-dials stored addresses on its
	// ~10s retry cycle, and without the getChunk serve-gate the transfer would
	// silently resume over the fresh transport connection. Watch two retry
	// cycles with a tight tick to catch even a short-lived re-add.
	let cameBack = false;
	if (starved === true) {
		const watchUntil = Date.now() + 25000;
		while (Date.now() < watchUntil) {
			if ((await downloadPeerCount()) > 0) {
				cameBack = true;
				break;
			}
			await sleep(500);
		}
	}
	check('leaver does not come back as a download peer (retry re-dial is refused)', starved === true && !cameBack);

	// search must no longer find the leaver
	const foundAfter = await (async () => {
		const wait = node2.waitForEvent('search:lishs:update', d => (d.lishs ?? []).some((l: any) => l.id === lishID), 12000).catch(() => undefined);
		await node2.call('search.startSearch', { query: LISH_NAME });
		return await wait;
	})();
	check('search from node2 NO LONGER finds the LISH after node1 left', foundAfter === undefined);

	// informative only: transport-level connection state (reconnect from the
	// other side via its own keep-alive tag is possible and harmless)
	const peers1 = await node1.call('lishnets.getPeers', {}).catch(() => []);
	console.log(`[info] node1 connection count after leave: ${Array.isArray(peers1) ? peers1.length : '?'}`);

	// =====================================================================
	// ACTION 2 — the DOWNLOADER (node2) leaves its last joined lishnet
	// =====================================================================
	const disabledEvt = node2.waitForEvent('transfer.download:disabled', d => d.lishID === lishID, 20000).catch(() => undefined);
	await node2.call('lishnets.setEnabled', { networkID: NET_ID, enabled: false });
	console.log('[action] node2 left the lishnet');

	const gotDisabled = await disabledEvt;
	let disabledViaPoll = false;
	if (gotDisabled === undefined) {
		// fallback: poll lishs.list until the LISH drops out of the downloadEnabled set
		disabledViaPoll =
			(await poll('download disabled', 15000, 1000, async () => {
				const list = await node2.call('lishs.list');
				const enabled: string[] = list?.downloadEnabled ?? [];
				return enabled.includes(lishID) ? undefined : true;
			})) === true;
	}
	check('download bound to the left lishnet is disabled on the downloader side', gotDisabled !== undefined || disabledViaPoll);
} catch (err: any) {
	failedHard = true;
	console.error(`\n[verify] aborted: ${err?.message ?? err}`);
	console.error('--- node1 log tail ---\n' + tail(log1) + '\n--- node1 err tail ---\n' + tail(log1 + '.err'));
	console.error('--- node2 log tail ---\n' + tail(log2) + '\n--- node2 err tail ---\n' + tail(log2 + '.err'));
} finally {
	node1.destroy();
	node2.destroy();
	killTree(proc1.pid);
	killTree(proc2.pid);
	await sleep(500);
	if (failedHard || results.some(r => !r.pass)) {
		console.log(`[verify] keeping tmp dir for inspection: ${tmp}`);
	} else {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			// Windows can hold file locks briefly after kill — leftover tmp is harmless
		}
	}
}

console.log('\n================ LEAVE-NETWORK VERIFY SUMMARY ================');
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
const failed = results.filter(r => !r.pass).length + (failedHard ? 1 : 0);
console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
