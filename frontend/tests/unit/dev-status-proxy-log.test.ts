import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('Vite proxy errors omit the request URL, including encoded token names', async () => {
	const secret = 'synthetic-proxy-secret-' + crypto.randomUUID();
	let broken = false;
	const upstream = Bun.listen<{ request: string }>({
		port: 0,
		hostname: '127.0.0.1',
		data: { request: '' },
		socket: {
			open(socket) {
				socket.data = { request: '' };
			},
			data(socket, chunk) {
				socket.data.request += new TextDecoder().decode(chunk);
				if (!socket.data.request.includes('\r\n\r\n')) return;
				if (broken) {
					socket.end('invalid HTTP response\r\n\r\n');
					return;
				}
				const path = socket.data.request.split(' ')[1]!;
				const tokens = new URL(path, 'http://localhost').searchParams.getAll('token');
				const authenticated = tokens.length === 1 && tokens[0] === secret;
				const body = JSON.stringify({ ok: authenticated, authRequired: true, authenticated });
				socket.end(`HTTP/1.1 ${authenticated ? '200 OK' : '401 Unauthorized'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
			},
		},
	});
	const reservation = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
	const port = reservation.port;
	await reservation.stop(true);
	const root = join(import.meta.dir, '../..');
	const env: Record<string, string | undefined> = { ...process.env, VITE_BACKEND_URL: `ws://127.0.0.1:${upstream.port}` };
	delete env['VITE_LISH_TOKEN'];
	delete env['VITE_SSL_KEY'];
	delete env['VITE_SSL_CERT'];
	const vite = Bun.spawn([process.execPath, '--bun', join(root, 'node_modules/vite/bin/vite.js'), 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
	let output = '';
	const drains = [vite.stdout, vite.stderr].map(async stream => {
		for await (const chunk of stream) output += new TextDecoder().decode(chunk);
	});
	const base = `http://127.0.0.1:${port}`;
	try {
		const deadline = Date.now() + 100_000;
		for (;;) {
			if (vite.exitCode !== null) throw new Error('Vite exited before readiness');
			const ready = await fetch(`${base}/@vite/client`, { signal: AbortSignal.timeout(1000) }).then(
				() => true,
				() => false
			);
			if (ready) break;
			if (Date.now() > deadline) throw new Error('Vite readiness timed out');
			await Bun.sleep(100);
		}
		const encoded = await fetch(`${base}/status?%74oken=${secret}`);
		expect(encoded.status).toBe(200);
		expect((await encoded.json()).authenticated).toBe(true);
		broken = true;
		for (const query of [`token=${secret}`, `%74oken=${secret}`, `%74%6f%6b%65%6e=${secret}`, `private=${secret}`]) {
			const response = await fetch(`${base}/status?${query}`, { signal: AbortSignal.timeout(5000) });
			expect(response.status).toBe(502);
		}
	} finally {
		vite.kill();
		await vite.exited;
		await upstream.stop(true);
		await Promise.all(drains);
	}
	expect(output).not.toContain(secret);
	expect(output).not.toContain('/status?');
	expect(output).toContain('[proxy] Backend connection failed');
}, 120_000);
