import { afterAll, describe, expect, it } from 'bun:test';
import { cp, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRoot = join(import.meta.dir, '../../../..');
const stagedDirs: string[] = [];
const TOKEN = 'proxy-test-token';

afterAll(async () => {
	for (const dir of stagedDirs) await rm(dir, { recursive: true, force: true });
});

/**
 * Lay the proxy out the way its container image does — `frontend.Dockerfile`
 * copies `shared/src/product.{ts,json}` in beside the script, which is where its
 * `./product.ts` import resolves. Running the real script keeps this test
 * honest about the file that actually ships, rather than a copy of its logic.
 */
async function stageProxy(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'lish-proxy-'));
	stagedDirs.push(dir);
	await cp(join(repoRoot, 'docker/frontend-server.ts'), join(dir, 'frontend-server.ts'));
	await cp(join(repoRoot, 'shared/src/product.ts'), join(dir, 'product.ts'));
	await cp(join(repoRoot, 'shared/src/product.json'), join(dir, 'product.json'));
	return join(dir, 'frontend-server.ts');
}

interface Upstream {
	url: string;
	port: number;
	/** Raw query strings the backend's `/status` received, in order. */
	statusQueries: string[];
	/** WebSocket handshakes the backend received, accepted or not. */
	dials: number;
	stop: () => void;
}

interface UpstreamOptions {
	/** Replace the `/status` answer. */
	status?: (req: Request) => Response | Promise<Response>;
	/** Refuse every WebSocket handshake, or never answer it. */
	ws?: 'echo' | 'refuse' | 'hang';
}

/**
 * A stand-in backend with the real `/status` contract: 200 for exactly one matching `token`,
 * 401 otherwise, a 204 preflight, and a WebSocket that echoes what it is sent.
 */
function startUpstream(options: UpstreamOptions = {}, port = 0): Upstream {
	const state = { statusQueries: [] as string[], dials: 0 };
	const server = Bun.serve<Record<string, never>, never>({
		port,
		fetch: (req, s) => {
			const url = new URL(req.url);
			if (url.pathname === '/status') {
				state.statusQueries.push(url.search);
				if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'x-internal': 'secret' } });
				if (options.status) return options.status(req);
				const ok = url.searchParams.getAll('token').length === 1 && url.searchParams.get('token') === TOKEN;
				return Response.json({ ok, authRequired: true, authenticated: ok }, { status: ok ? 200 : 401 });
			}
			state.dials++;
			if (options.ws === 'refuse') return new Response('no', { status: 403 });
			if (options.ws === 'hang') return new Promise<Response>(() => {});
			return s.upgrade(req, { data: {} }) ? undefined : new Response('expected websocket', { status: 400 });
		},
		websocket: {
			message(ws, message): void {
				ws.send(message);
			},
		},
	});
	const actual = Number(server.port);
	return {
		url: `ws://127.0.0.1:${actual}`,
		port: actual,
		get statusQueries() {
			return state.statusQueries;
		},
		get dials() {
			return state.dials;
		},
		stop: () => server.stop(true),
	};
}

/** A port nothing listens on. */
function deadPort(): number {
	const placeholder = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
	const port = placeholder.port;
	placeholder.stop(true);
	return port;
}

/** Spawn the proxy against `backendUrl` and wait until it answers HTTP. */
async function startProxy(backendUrl: string): Promise<{ http: string; ws: string; stop: () => void }> {
	const script = await stageProxy();
	const port = 20000 + Math.floor(Math.random() * 20000);
	const proc = Bun.spawn([process.execPath, script], {
		env: { ...process.env, PORT: String(port), BACKEND_WS_URL: backendUrl },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const http = `http://127.0.0.1:${port}`;
	for (let attempt = 0; attempt < 100; attempt++) {
		const up = await fetch(`${http}/status`, { method: 'PUT' }).then(
			() => true,
			() => false
		);
		if (up) return { http, ws: `ws://127.0.0.1:${port}`, stop: () => proc.kill() };
		await Bun.sleep(50);
	}
	proc.kill();
	throw new Error('proxy did not start');
}

/** Open a client socket; resolves with it once open, rejects on a refused handshake. */
function openClient(url: string): Promise<WebSocket> {
	const client = new WebSocket(url);
	return new Promise((resolve, reject) => {
		client.onopen = () => resolve(client);
		client.onerror = () => reject(new Error('client failed to connect'));
	});
}

async function withProxy(upstream: Upstream | null, backendUrl: string, run: (proxy: { http: string; ws: string }) => Promise<void>): Promise<void> {
	const proxy = await startProxy(backendUrl);
	try {
		await run(proxy);
	} finally {
		proxy.stop();
		upstream?.stop();
	}
}

describe('frontend proxy /status', () => {
	it('forwards the backend answer and the raw query, duplicates included', async () => {
		const upstream = startUpstream();
		await withProxy(upstream, upstream.url, async proxy => {
			const ok = await fetch(`${proxy.http}/status?token=${TOKEN}`);
			expect(ok.status).toBe(200);
			expect(ok.headers.get('cache-control')).toBe('no-store');
			expect(((await ok.json()) as { authenticated: boolean }).authenticated).toBe(true);

			const wrong = await fetch(`${proxy.http}/status?token=nope`);
			expect(wrong.status).toBe(401);

			// Collapsing the duplicate to one value would let the proxy and backend disagree.
			const dup = await fetch(`${proxy.http}/status?token=${TOKEN}&token=${TOKEN}`);
			expect(dup.status).toBe(401);
			expect(upstream.statusQueries).toContain(`?token=${TOKEN}&token=${TOKEN}`);
		});
	}, 30000);

	it('answers 503 when the backend is down and 504 when it does not answer in time', async () => {
		await withProxy(null, `ws://127.0.0.1:${deadPort()}`, async proxy => {
			const down = await fetch(`${proxy.http}/status?token=${TOKEN}`);
			expect(down.status).toBe(503);
			expect(down.headers.get('cache-control')).toBe('no-store');
		});
		const slow = startUpstream({ status: () => new Promise<Response>(() => {}) });
		await withProxy(slow, slow.url, async proxy => {
			const started = Date.now();
			const late = await fetch(`${proxy.http}/status?token=${TOKEN}`);
			expect(late.status).toBe(504);
			expect(Date.now() - started).toBeLessThan(6000);
		});
	}, 30000);

	it('refuses a redirect, a malformed body and an oversized body with 502', async () => {
		for (const status of [() => Response.redirect('http://192.0.2.1/status', 302), () => new Response('not json', { status: 200 }), () => Response.json({ ok: true, authRequired: true, authenticated: true, pad: 'x'.repeat(8192) })]) {
			const upstream = startUpstream({ status });
			await withProxy(upstream, upstream.url, async proxy => {
				expect((await fetch(`${proxy.http}/status?token=${TOKEN}`, { redirect: 'manual' })).status).toBe(502);
			});
		}
	}, 30000);

	it('passes a preflight through with only its CORS headers and refuses other methods', async () => {
		const upstream = startUpstream();
		await withProxy(upstream, upstream.url, async proxy => {
			const preflight = await fetch(`${proxy.http}/status`, { method: 'OPTIONS', headers: { origin: 'http://example.test', 'access-control-request-method': 'GET' } });
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
			expect(preflight.headers.get('x-internal')).toBeNull();

			const post = await fetch(`${proxy.http}/status`, { method: 'POST' });
			expect(post.status).toBe(405);
			expect(post.headers.get('allow')).toBe('GET, OPTIONS');
		});
	}, 30000);
});

describe('frontend websocket proxy', () => {
	it('refuses to start with credentials in BACKEND_WS_URL', async () => {
		const script = await stageProxy();
		for (const backend of ['ws://user:pass@127.0.0.1:1', 'ws://127.0.0.1:1/?token=x']) {
			const proc = Bun.spawn([process.execPath, script], { env: { ...process.env, PORT: '0', BACKEND_WS_URL: backend }, stdout: 'pipe', stderr: 'pipe' });
			expect(await proc.exited).not.toBe(0);
		}
	}, 30000);

	it('refuses a wrong token before the upgrade, without dialing the backend', async () => {
		const upstream = startUpstream();
		await withProxy(upstream, upstream.url, async proxy => {
			const response = await fetch(`${proxy.http}/ws?token=nope`, { headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
			expect(response.status).toBe(401);
			expect(upstream.dials).toBe(0);
		});
	}, 30000);

	it('carries the token to the backend and relays the session', async () => {
		const upstream = startUpstream();
		await withProxy(upstream, upstream.url, async proxy => {
			const client = await openClient(`${proxy.ws}/ws?token=${TOKEN}`);
			const echoed = new Promise<string>(resolve => (client.onmessage = e => resolve(String(e.data))));
			client.send('hello');
			expect(await echoed).toBe('hello');
			expect(upstream.dials).toBe(1);
			client.close();
		});
	}, 30000);

	it('closes the browser socket when an established upstream session dies', async () => {
		const upstream = startUpstream();
		await withProxy(upstream, upstream.url, async proxy => {
			const client = await openClient(`${proxy.ws}/ws?token=${TOKEN}`);
			// Prove the session is really established end to end before killing it.
			const echoed = new Promise<string>(resolve => (client.onmessage = e => resolve(String(e.data))));
			client.send('hello');
			expect(await echoed).toBe('hello');

			const closed = new Promise<number>(resolve => (client.onclose = e => resolve(e.code)));
			upstream.stop();
			expect(await closed).toBe(1011);
		});
	}, 30000);

	it('closes with 1011 after one refused upstream dial instead of retrying', async () => {
		const upstream = startUpstream({ ws: 'refuse' });
		await withProxy(upstream, upstream.url, async proxy => {
			const client = new WebSocket(`${proxy.ws}/ws?token=${TOKEN}`);
			const code = await new Promise<number>(resolve => (client.onclose = e => resolve(e.code)));
			expect(code).toBe(1011);
			await Bun.sleep(1000);
			expect(upstream.dials).toBe(1);
		});
	}, 30000);

	it('closes with 1011 when the upstream handshake never completes', async () => {
		const upstream = startUpstream({ ws: 'hang' });
		await withProxy(upstream, upstream.url, async proxy => {
			const started = Date.now();
			const client = new WebSocket(`${proxy.ws}/ws?token=${TOKEN}`);
			const code = await new Promise<number>(resolve => (client.onclose = e => resolve(e.code)));
			expect(code).toBe(1011);
			expect(Date.now() - started).toBeLessThan(6000);
			expect(upstream.dials).toBe(1);
		});
	}, 30000);
});
