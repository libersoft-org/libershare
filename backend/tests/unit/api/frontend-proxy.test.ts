import { afterAll, describe, expect, it } from 'bun:test';
import { cp, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRoot = join(import.meta.dir, '../../../..');
const stagedDirs: string[] = [];

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

/** A stand-in backend that accepts WebSockets and echoes what it is sent. */
function startUpstream(): { url: string; port: number; stop: () => void } {
	const server = Bun.serve<Record<string, never>, never>({
		port: 0,
		fetch: (req, s) => (s.upgrade(req, { data: {} }) ? undefined : new Response('expected websocket', { status: 400 })),
		websocket: {
			message(ws, message): void {
				ws.send(message);
			},
		},
	});
	const port = Number(server.port);
	return { url: `ws://127.0.0.1:${port}`, port, stop: () => server.stop(true) };
}

/** Spawn the proxy against `backendUrl` and wait until it is accepting connections. */
async function startProxy(backendUrl: string): Promise<{ url: string; stop: () => void }> {
	const script = await stageProxy();
	const port = 20000 + Math.floor(Math.random() * 20000);
	const proc = Bun.spawn(['bun', script], {
		env: { ...process.env, PORT: String(port), BACKEND_WS_URL: backendUrl },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const url = `ws://127.0.0.1:${port}`;
	for (let attempt = 0; attempt < 100; attempt++) {
		const probe = new WebSocket(`${url}/ws`);
		const open = await new Promise<boolean>(resolve => {
			probe.onopen = () => resolve(true);
			probe.onerror = () => resolve(false);
		});
		probe.close();
		if (open) return { url, stop: () => proc.kill() };
		await Bun.sleep(50);
	}
	proc.kill();
	throw new Error('proxy did not start');
}

describe('frontend websocket proxy', () => {
	it('closes the browser socket when an established upstream session dies', async () => {
		const upstream = startUpstream();
		const proxy = await startProxy(upstream.url);
		try {
			const client = new WebSocket(`${proxy.url}/ws`);
			await new Promise<void>((resolve, reject) => {
				client.onopen = () => resolve();
				client.onerror = () => reject(new Error('client failed to connect'));
			});
			// Prove the session is really established end to end before killing it,
			// so the close below cannot be mistaken for a failed initial connect.
			const echoed = new Promise<string>(resolve => (client.onmessage = e => resolve(String(e.data))));
			client.send('hello');
			expect(await echoed).toBe('hello');

			const closed = new Promise<number>(resolve => (client.onclose = e => resolve(e.code)));
			upstream.stop();
			// Without this the proxy quietly reconnects underneath a browser that is
			// still waiting on a reply the dead socket took with it, and whose
			// upload id the replacement socket does not own.
			expect(await closed).toBe(1011);
		} finally {
			proxy.stop();
			upstream.stop();
		}
	}, 30000);

	it('holds only one upstream connection once a late backend appears', async () => {
		// A failed dial fires both onerror and onclose (verified on this Bun), and
		// each used to schedule its own retry while `reconnectTimer` kept only the
		// later one. When the backend finally answers, every pending timer's dial
		// succeeds — and the client ends up with more than one live upstream, of
		// which only the last is the one `ws.data.upstream` routes to. An upload
		// begun on one and chunked over the other is the failure that follows.
		const placeholder = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
		const port = placeholder.port;
		placeholder.stop(true);

		const proxy = await startProxy(`ws://127.0.0.1:${port}`);
		let live = 0;
		let peak = 0;
		let backend: ReturnType<typeof Bun.serve> | null = null;
		try {
			const client = new WebSocket(`${proxy.url}/ws`);
			await new Promise<void>((resolve, reject) => {
				client.onopen = () => resolve();
				client.onerror = () => reject(new Error('client failed to connect'));
			});
			// Long enough for several backoff rounds to queue up while nothing answers.
			await Bun.sleep(1500);
			backend = Bun.serve<Record<string, never>, never>({
				port,
				fetch: (req, s) => (s.upgrade(req, { data: {} }) ? undefined : new Response('expected websocket', { status: 400 })),
				websocket: {
					open(): void {
						live++;
						peak = Math.max(peak, live);
					},
					close(): void {
						live--;
					},
					message(ws, message): void {
						ws.send(message);
					},
				},
			});
			await Bun.sleep(3000);
			expect(peak).toBe(1);
			client.close();
		} finally {
			proxy.stop();
			backend?.stop(true);
		}
	}, 30000);

	it('reconnects transparently while the backend has never come up', async () => {
		// Nothing is listening on this port yet, so the proxy's first dials fail —
		// there is no session to lose and the browser socket must survive.
		const dead = startUpstream();
		const port = dead.port;
		dead.stop();
		const proxy = await startProxy(`ws://127.0.0.1:${port}`);
		try {
			const client = new WebSocket(`${proxy.url}/ws`);
			await new Promise<void>((resolve, reject) => {
				client.onopen = () => resolve();
				client.onerror = () => reject(new Error('client failed to connect'));
			});
			let closeCode: number | null = null;
			client.onclose = e => (closeCode = e.code);
			// Several backoff rounds' worth: an error and a close both fire per failed
			// dial, so a missing one-shot guard shows up as a burst of attempts here.
			await Bun.sleep(2000);
			expect(closeCode).toBeNull();
			client.close();
		} finally {
			proxy.stop();
		}
	}, 30000);
});
