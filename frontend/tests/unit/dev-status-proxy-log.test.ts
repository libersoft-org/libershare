/**
 * With the backend down, the development server's `/status` proxy fails and Vite logs the
 * request it could not forward. That URL carries the API token; the log must not.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';

const SECRET = `dev-log-secret-${crypto.randomUUID()}`;
let vite: ReturnType<typeof Bun.spawn> | null = null;
let base = '';
let output = '';

async function collect(stream: ReadableStream<Uint8Array>): Promise<void> {
	const decoder = new TextDecoder();
	for await (const chunk of stream) output += decoder.decode(chunk);
}

beforeAll(async () => {
	// A port that was just free: nothing answers there, so every proxied request fails.
	const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
	const deadPort = probe.port;
	probe.stop(true);
	const port = 30000 + Math.floor(Math.random() * 20000);
	base = `http://127.0.0.1:${port}`;
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	delete env['VITE_LISH_TOKEN'];
	env['VITE_BACKEND_URL'] = `ws://127.0.0.1:${deadPort}`;
	const root = join(import.meta.dir, '../..');
	vite = Bun.spawn([process.execPath, '--bun', join(root, 'node_modules/vite/bin/vite.js'), 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
	void collect(vite.stdout as ReadableStream<Uint8Array>);
	void collect(vite.stderr as ReadableStream<Uint8Array>);
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
});

test('a failed /status proxy is logged without the token', async () => {
	const response = await fetch(`${base}/status?token=${SECRET}`);
	expect(response.status).toBe(502);
	for (let i = 0; i < 50 && !output.includes('http proxy error'); i++) await Bun.sleep(100);
	expect(output).toContain('http proxy error');
	expect(output).not.toContain(SECRET);
}, 30_000);
