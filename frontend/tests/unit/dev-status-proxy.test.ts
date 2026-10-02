/**
 * The development server's `/status` proxy, run as the real Vite with the real config.
 *
 * The login form asks `/status` before it opens the socket. Without the route Vite answers
 * with its HTML fallback, and a target carrying a path would send `/status/status`. The query
 * — with the token and any duplicate of it — must reach the backend exactly as sent.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';

interface Seen {
	method: string;
	url: string;
}

const seen: Seen[] = [];
const upstream = Bun.serve({
	port: 0,
	hostname: '127.0.0.1',
	fetch(req) {
		const url = new URL(req.url);
		seen.push({ method: req.method, url: url.pathname + url.search });
		if (url.searchParams.get('probe') === 'redirect') return new Response(null, { status: 302, headers: { location: 'http://192.0.2.1/elsewhere' } });
		if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type' } });
		const tokens = url.searchParams.getAll('token');
		const ok = tokens.length === 1 && tokens[0] === 'synthetic-a';
		return Response.json({ ok, authRequired: true, authenticated: ok }, { status: ok ? 200 : 401 });
	},
});

let vite: ReturnType<typeof Bun.spawn> | null = null;
let base = '';

beforeAll(async () => {
	const port = 30000 + Math.floor(Math.random() * 20000);
	base = `http://127.0.0.1:${port}`;
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	delete env['VITE_LISH_TOKEN'];
	// A target with a path and a query: the status route must still hit the bare origin.
	env['VITE_BACKEND_URL'] = `ws://127.0.0.1:${upstream.port}/api/ws?stray=1`;
	const root = join(import.meta.dir, '../..');
	vite = Bun.spawn([process.execPath, '--bun', join(root, 'node_modules/vite/bin/vite.js'), 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, env, stdout: 'ignore', stderr: 'ignore' });
	for (let i = 0; i < 1000; i++) {
		const up = await fetch(`${base}/@vite/client`, { signal: AbortSignal.timeout(2000) }).then(
			() => true,
			() => false
		);
		if (up) return;
		await Bun.sleep(100);
	}
	throw new Error('vite did not start');
}, 120_000);

afterAll(() => {
	vite?.kill();
	upstream.stop(true);
});

test('GET reaches exactly /status with the query unchanged, duplicates included', async () => {
	const response = await fetch(`${base}/status?token=synthetic-a&token=synthetic-b&probe=1`);
	expect(response.status).toBe(401);
	expect(response.headers.get('content-type')).toContain('application/json');
	expect(seen.at(-1)).toEqual({ method: 'GET', url: '/status?token=synthetic-a&token=synthetic-b&probe=1' });
});

test('a single valid token is accepted', async () => {
	const response = await fetch(`${base}/status?token=synthetic-a`);
	expect(response.status).toBe(200);
	expect(((await response.json()) as { authenticated: boolean }).authenticated).toBe(true);
});

test('the preflight is answered by the backend, not by Vite', async () => {
	const response = await fetch(`${base}/status?token=synthetic-a&token=synthetic-b&probe=1`, { method: 'OPTIONS', headers: { origin: 'http://example.test', 'access-control-request-method': 'GET' } });
	expect(response.status).toBe(204);
	expect(response.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
	expect(seen.at(-1)).toEqual({ method: 'OPTIONS', url: '/status?token=synthetic-a&token=synthetic-b&probe=1' });
});

test('a redirect goes back to the client instead of being followed', async () => {
	const count = seen.length;
	const response = await fetch(`${base}/status?probe=redirect`, { redirect: 'manual' });
	expect(response.status).toBe(302);
	expect(seen.length).toBe(count + 1);
});
