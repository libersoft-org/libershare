import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * A lishnet switched off while the node was down never ran its leave, so its peers stayed in
 * the peer store and were redialled after the next start. Two real backends from source: A
 * joins B's lishnet, B goes away, A's node goes down through a failed restart, the lishnet is
 * switched off, A starts again — and B must be gone from A's datastore.
 */

const repo = resolve(import.meta.dir, '../../..');
const lan = Object.values(networkInterfaces())
	.flat()
	.find(a => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))!.address;
const TOKEN = 'e2e-peer-cleanup-token';
const free = (): number => {
	const s = Bun.listen({ hostname: '0.0.0.0', port: 0, socket: { data() {} } });
	const port = s.port;
	s.stop(true);
	return port;
};

/** A backend process; given `existingRoot` it starts over that node's data as it was left. */
function node(tag: string, apiPort: number, p2pPort: number, existingRoot?: string) {
	const root = existingRoot ?? mkdtempSync(join(tmpdir(), `lish-291-${tag}-`));
	const storage = (name: string): string => {
		const dir = join(root, 'storage', name);
		mkdirSync(dir, { recursive: true });
		return dir;
	};
	if (!existingRoot) writeFileSync(join(root, 'settings.json'), JSON.stringify({ storage: { downloadPath: storage('finished'), tempPath: storage('temp'), lishPath: storage('lish'), lishnetPath: storage('lishnet'), backupPath: storage('backup') }, network: { incomingPort: p2pPort, mdnsEnabled: false, upnpEnabled: false, allowRelay: false, useRelayClients: false, autoConnectNewNetworks: false, peerExchange: { enabled: false } } }));
	const proc = Bun.spawn([process.execPath, 'run', 'backend/src/app.ts', '--datadir', root, '--port', String(apiPort), '--host', '127.0.0.1', '--token', TOKEN], { cwd: repo, env: { ...process.env, MEMTRACE: '0', HEAP_TRIGGER: '0' } as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
	let log = '';
	(async () => {
		for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) log += new TextDecoder().decode(chunk);
	})();
	return { root, proc, log: () => log, apiPort };
}

async function client(apiPort: number) {
	const ws = new WebSocket(`ws://localhost:${apiPort}?token=${TOKEN}`);
	await new Promise<void>((ok, fail) => {
		ws.onopen = () => ok();
		ws.onerror = () => fail(new Error('no ws'));
	});
	let n = 0;
	return {
		call: (method: string, params: Record<string, unknown> = {}): Promise<any> =>
			new Promise(resolve => {
				const id = `r${++n}`;
				const onMessage = (e: MessageEvent): void => {
					const msg = JSON.parse(String(e.data));
					if (msg.id === id) {
						ws.removeEventListener('message', onMessage);
						resolve(msg);
					}
				};
				ws.addEventListener('message', onMessage);
				ws.send(JSON.stringify({ id, method, params }));
			}),
		close: () => ws.close(),
	};
}

async function ready(n: ReturnType<typeof node>): Promise<void> {
	for (let i = 0; i < 160 && !n.log().includes('WebSocket server listening'); i++) await Bun.sleep(250);
}

describe('peer cleanup across a process restart', () => {
	it('removes the peers of a lishnet whose leave never ran before the node starts again', async () => {
		const NET = crypto.randomUUID();
		const network = (bootstrapPeers: string[]) => ({ network: { networkID: NET, name: 'live-291', description: '', bootstrapPeers, created: new Date().toISOString(), enabled: true } });

		const b = node('b', free(), free());
		await ready(b);
		const bc = await client(b.apiPort);
		await bc.call('lishnets.add', network([]));
		let info: any;
		for (let i = 0; i < 40; i++) {
			info = (await bc.call('lishnets.getNodeInfo')).result;
			if (info?.addresses?.some((a: string) => a.includes(`/ip4/${lan}/`))) break;
			await Bun.sleep(250);
		}
		const bAddress = `${info.addresses.find((a: string) => a.includes(`/ip4/${lan}/`))}`;
		const bootstrap = bAddress.includes('/p2p/') ? bAddress : `${bAddress}/p2p/${info.peerID}`;

		const a = node('a', free(), free());
		await ready(a);
		const ac = await client(a.apiPort);
		await ac.call('lishnets.add', network([bootstrap]));
		let connected = 0;
		for (let i = 0; i < 80 && connected < 1; i++) {
			connected = (await ac.call('lishnets.getStatus', { networkID: NET })).result?.connected ?? 0;
			await Bun.sleep(250);
		}
		expect(connected).toBeGreaterThanOrEqual(1);

		bc.close();
		b.proc.kill();
		await b.proc.exited;

		// Take A's node down through a failed restart, then switch the lishnet off: its leave cannot run.
		const taken = free();
		const blocker = Bun.listen({ hostname: '0.0.0.0', port: taken, socket: { data() {} } });
		let reply = await ac.call('settings.set', { path: 'network.incomingPort', value: taken });
		expect(reply.error).toBe('NETWORK_PORT_IN_USE');
		reply = await ac.call('lishnets.setEnabled', { networkID: NET, enabled: false });
		expect(reply.result).toMatchObject({ stored: true, joined: false });
		blocker.stop(true);
		// The process ends with the leave still undone; only what reached the disk survives.
		ac.close();
		a.proc.kill();
		await a.proc.exited;

		// A new process over the same data: the queue is the one thing that remembers B.
		const restarted = node('a', free(), free(), a.root);
		await ready(restarted);
		expect(restarted.log()).toContain('removed before start');
		restarted.proc.kill();
		await restarted.proc.exited;

		const { peerIdFromString } = await import(join(repo, 'backend/node_modules/@libp2p/peer-id/dist/src/index.js'));
		const bKey = `/peers/${peerIdFromString(info.peerID).toCID().toString()}`;
		const db = new Database(join(a.root, 'datastore.db'), { readonly: true });
		const present = db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM datastore WHERE key = ?').get(bKey)!.n;
		db.close();
		expect(present).toBe(0);
	}, 240_000);
});
