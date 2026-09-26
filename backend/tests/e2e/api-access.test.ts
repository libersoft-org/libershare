import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startNodes, stopNodes, getNodeURL, TEST_API_TOKEN } from './helpers/node-manager.ts';
import { TestClient } from './helpers/ws-test-client.ts';

const REPO = resolve(import.meta.dir, '../../..');

describe('a backend without a token', () => {
	it('refuses to start and creates no data', async () => {
		const root = mkdtempSync(join(tmpdir(), 'lish-notoken-'));
		const dataDir = join(root, 'data');
		// The default storage paths live under the home directory: pointed into the test root,
		// a regression of the token check writes there instead of into the user's own.
		const home = join(root, 'home');
		try {
			const env: Record<string, string> = { ...(process.env as Record<string, string>), MEMTRACE: '0', HEAP_TRIGGER: '0', HOME: home, USERPROFILE: home };
			delete env['LISH_TOKEN'];
			const proc = Bun.spawn([process.execPath, 'run', 'backend/src/app.ts', '--datadir', dataDir, '--port', '0'], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
			const code = await Promise.race([proc.exited, Bun.sleep(30_000).then(() => 'timeout' as const)]);
			if (code === 'timeout') {
				proc.kill(9);
				await proc.exited;
			}
			expect(code).toBe(78);
			expect(existsSync(dataDir) ? readdirSync(dataDir) : []).toEqual([]);
			// `.bun` is the runtime's own cache, created before any backend code runs.
			expect((existsSync(home) ? readdirSync(home) : []).filter(entry => entry !== '.bun')).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 40_000);
});

describe('a backend with a token', () => {
	let base = '';
	beforeAll(async () => {
		await startNodes(1);
		base = getNodeURL(0).replace('ws://', 'http://').replace(/\?.*$/, '');
	}, 90_000);
	afterAll(async () => {
		await stopNodes();
	}, 60_000);

	it('/status answers 401 without the token and 200 with it, never cached', async () => {
		const denied = await fetch(`${base}/status`);
		expect(denied.status).toBe(401);
		expect(await denied.json()).toEqual({ ok: false, authRequired: true, authenticated: false, error: 'UNAUTHORIZED' });
		expect(denied.headers.get('cache-control')).toBe('no-store');
		const allowed = await fetch(`${base}/status?token=${TEST_API_TOKEN}`);
		expect(allowed.status).toBe(200);
		expect((await fetch(`${base}/status?token=${TEST_API_TOKEN}&token=${TEST_API_TOKEN}`)).status).toBe(401);
	});

	it('refuses the WebSocket upgrade without the right token, from any origin', async () => {
		for (const query of ['', '?token=wrong', `?token=${TEST_API_TOKEN}x`]) {
			const res = await fetch(`${base}/${query}`, { headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', origin: 'https://evil.example' } });
			expect(res.status).toBe(401);
		}
	});

	it('serves a client with the token regardless of its origin', async () => {
		const client = new TestClient(getNodeURL(0));
		try {
			await client.waitConnected();
			const settings = await client.call('settings.list');
			expect(settings.network).toBeDefined();
		} finally {
			client.destroy();
		}
	});
});
