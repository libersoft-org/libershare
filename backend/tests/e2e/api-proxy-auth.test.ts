import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Socket } from 'bun';
import { startNodes, stopNodes, getNodeURL, getNodeLog } from './helpers/node-manager.ts';

/**
 * Real backends behind the real Docker frontend proxy. The proxy must answer `/status` with the
 * backend's JSON, refuse a wrong token before the upgrade, and — when the backend behind it
 * changes its token between the proxy's check and its upstream handshake — close the client
 * with 1011 instead of retrying, so the browser checks again and shows the login form.
 */

const REPO = resolve(import.meta.dir, '../../..');
const TOKEN_A = `synthetic-a-${crypto.randomUUID()}`;
const TOKEN_B = `synthetic-b-${crypto.randomUUID()}`;

interface GateData {
	upstream?: Socket<undefined>;
	pending: Uint8Array[] | null;
}

/**
 * A TCP gate in front of backend A that switches to backend B at the first WebSocket handshake
 * it sees — the moment a backend restart with a new token would have to land to slip between
 * the proxy's status check and its upstream dial. Connections opened before the switch are cut
 * so no pooled HTTP connection keeps talking to A.
 */
function startGate(portA: number, portB: number): { port: number; wsDials: () => number; stop: () => void } {
	let target = portA;
	let wsDials = 0;
	const open = new Set<Socket<GateData>>();
	const server = Bun.listen<GateData>({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			open(client) {
				client.data = { pending: [] };
				open.add(client);
			},
			data(client, chunk) {
				if (client.data.upstream) {
					client.data.upstream.write(chunk);
					return;
				}
				if (client.data.pending === null) return;
				client.data.pending.push(new Uint8Array(chunk));
				if (client.data.pending.length > 1) return;
				if (/upgrade:\s*websocket/i.test(new TextDecoder().decode(chunk))) {
					wsDials++;
					if (target === portA) {
						target = portB;
						for (const other of open) if (other !== client) other.end();
					}
				}
				void Bun.connect({
					hostname: '127.0.0.1',
					port: target,
					socket: {
						open(upstream) {
							client.data.upstream = upstream;
							for (const buffered of client.data.pending ?? []) upstream.write(buffered);
							client.data.pending = null;
						},
						data(_upstream, reply) {
							client.write(reply);
						},
						close() {
							client.end();
						},
						error() {
							client.end();
						},
					},
				}).catch(() => client.end());
			},
			close(client) {
				open.delete(client);
				client.data.upstream?.end();
			},
		},
	});
	return { port: server.port, wsDials: () => wsDials, stop: () => server.stop(true) };
}

async function startProxy(backendUrl: string): Promise<{ http: string; ws: string; output: () => Promise<string>; stop: () => Promise<void>; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), 'lish-proxy-e2e-'));
	await cp(join(REPO, 'docker/frontend-server.ts'), join(dir, 'frontend-server.ts'));
	await cp(join(REPO, 'shared/src/product.ts'), join(dir, 'product.ts'));
	await cp(join(REPO, 'shared/src/product.json'), join(dir, 'product.json'));
	const port = 20000 + Math.floor(Math.random() * 20000);
	const env: Record<string, string> = { ...(process.env as Record<string, string>), PORT: String(port), BACKEND_WS_URL: backendUrl };
	delete env['LISH_TOKEN'];
	const proc = Bun.spawn([process.execPath, join(dir, 'frontend-server.ts')], { env, stdout: 'pipe', stderr: 'pipe' });
	const http = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 200; i++) {
		const up = await fetch(`${http}/status`, { method: 'PUT' }).then(
			() => true,
			() => false
		);
		if (up) break;
		await Bun.sleep(50);
	}
	return {
		http,
		ws: `ws://127.0.0.1:${port}`,
		dir,
		output: async () => {
			proc.kill();
			await proc.exited;
			return (await new Response(proc.stdout as ReadableStream).text()) + (await new Response(proc.stderr as ReadableStream).text());
		},
		stop: async () => {
			proc.kill();
			await proc.exited;
			await rm(dir, { recursive: true, force: true });
		},
	};
}

/** Send one RPC over a raw socket and resolve with its reply, or null if the socket closes first. */
function rpc(ws: WebSocket, method: string): Promise<any> {
	const id = crypto.randomUUID();
	return new Promise(resolve => {
		ws.addEventListener('message', e => {
			const msg = JSON.parse(String(e.data));
			if (msg.id === id) resolve(msg);
		});
		ws.addEventListener('close', () => resolve(null));
		ws.send(JSON.stringify({ id, method, params: {} }));
	});
}

const portOf = (url: string): number => Number(new URL(url).port);

let gate: ReturnType<typeof startGate>;
let proxy: Awaited<ReturnType<typeof startProxy>>;

beforeAll(async () => {
	await startNodes(2, [TOKEN_A, TOKEN_B]);
}, 120_000);

afterAll(async () => {
	gate?.stop();
	await stopNodes();
}, 60_000);

describe('the Docker proxy in front of a real backend', () => {
	it('answers /status and the preflight with the backend responses, and relays a session', async () => {
		const p = await startProxy(`ws://127.0.0.1:${portOf(getNodeURL(0))}`);
		try {
			const denied = await fetch(`${p.http}/status`);
			expect(denied.status).toBe(401);
			expect(await denied.json()).toEqual({ ok: false, authRequired: true, authenticated: false, error: 'UNAUTHORIZED' });
			expect((await fetch(`${p.http}/status?token=${TOKEN_A}`)).status).toBe(200);
			expect((await fetch(`${p.http}/status?token=${TOKEN_A}&token=${TOKEN_A}`)).status).toBe(401);

			const preflight = await fetch(`${p.http}/status`, { method: 'OPTIONS', headers: { origin: 'https://ui.example', 'access-control-request-method': 'GET' } });
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
			expect(await preflight.text()).toBe('');

			const refused = await fetch(`${p.http}/ws?token=wrong`, { headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
			expect(refused.status).toBe(401);

			const ws = new WebSocket(`${p.ws}/ws?token=${TOKEN_A}`);
			await new Promise<void>((ok, fail) => {
				ws.onopen = () => ok();
				ws.onerror = () => fail(new Error('proxy refused a valid token'));
			});
			const reply = await rpc(ws, 'settings.list');
			expect(reply?.result?.network).toBeDefined();
			ws.close();

			const output = await p.output();
			expect(output).not.toContain(TOKEN_A);
			expect(getNodeLog(0)).not.toContain(TOKEN_A);
		} finally {
			await p.stop();
		}
	}, 60_000);

	it('closes the client with 1011 when the first upstream handshake is refused, then works with the new token', async () => {
		gate = startGate(portOf(getNodeURL(0)), portOf(getNodeURL(1)));
		proxy = await startProxy(`ws://127.0.0.1:${gate.port}`);
		try {
			// The proxy's status check reaches A and passes; its upstream dial reaches B, which
			// refuses token A.
			const ws = new WebSocket(`${proxy.ws}/ws?token=${TOKEN_A}`);
			await new Promise<void>((ok, fail) => {
				ws.onopen = () => ok();
				ws.onerror = () => fail(new Error('status check with A should have passed'));
			});
			const closed = new Promise<number>(res => ws.addEventListener('close', e => res(e.code)));
			const queued = rpc(ws, 'settings.list');
			expect(await closed).toBe(1011);
			expect(await queued).toBeNull();
			await Bun.sleep(1000);
			expect(gate.wsDials()).toBe(1);

			// A fresh check now sees B: A is refused, B is accepted and gets a working session.
			expect((await fetch(`${proxy.http}/status?token=${TOKEN_A}`)).status).toBe(401);
			expect((await fetch(`${proxy.http}/status?token=${TOKEN_B}`)).status).toBe(200);
			const next = new WebSocket(`${proxy.ws}/ws?token=${TOKEN_B}`);
			await new Promise<void>((ok, fail) => {
				next.onopen = () => ok();
				next.onerror = () => fail(new Error('proxy refused token B'));
			});
			const reply = await rpc(next, 'settings.list');
			expect(reply?.result?.network).toBeDefined();
			expect(gate.wsDials()).toBe(2);
			next.close();

			const output = await proxy.output();
			for (const token of [TOKEN_A, TOKEN_B]) expect(output).not.toContain(token);
		} finally {
			await proxy.stop();
		}
	}, 60_000);
});
