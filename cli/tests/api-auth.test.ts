import { afterAll, expect, it } from 'bun:test';
import { join } from 'node:path';

/**
 * The CLI as a real process against a stand-in server that records each handshake URL. The
 * token comes from `LISH_TOKEN` or the URL, reaches the server exactly once, and never appears
 * in what the CLI prints.
 */

const CLI = join(import.meta.dir, '..', 'cli.ts');
const SECRET = `cli-secret-${crypto.randomUUID()}`;
const seen: string[] = [];
const server = Bun.serve({
	port: 0,
	hostname: '127.0.0.1',
	fetch(req, s) {
		seen.push(new URL(req.url).search);
		return s.upgrade(req, { data: {} }) ? undefined : new Response('expected websocket', { status: 400 });
	},
	websocket: {
		open(ws) {
			ws.close();
		},
		message() {},
	},
});
// Not awaited: after its sockets have closed, the promise from stop() may never settle.
afterAll(() => {
	void server.stop(true);
});

async function run(url: string, token: string | undefined): Promise<{ code: number; output: string }> {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	delete env['LISH_TOKEN'];
	if (token !== undefined) env['LISH_TOKEN'] = token;
	// A CLI that connects waits at its prompt until `quit`; one that refuses the URL exits first,
	// and writing to the pipe of an exited process blocks on Windows, so it gets no input.
	const connects = !url.includes('token=a&token=b');
	const proc = Bun.spawn([process.execPath, CLI, '--url', url], { env, stdout: 'pipe', stderr: 'pipe', stdin: connects ? 'pipe' : 'ignore' });
	if (connects && proc.stdin) {
		proc.stdin.write('quit' + String.fromCharCode(10));
		proc.stdin.end();
	}
	const timer = setTimeout(() => proc.kill(), 15_000);
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	clearTimeout(timer);
	return { code: await proc.exited, output: out + err };
}

const base = `ws://127.0.0.1:${server.port}`;

it('adds LISH_TOKEN as the only token and never prints it', async () => {
	seen.length = 0;
	const { output } = await run(base, SECRET);
	expect(seen[0]).toBe(`?token=${SECRET}`);
	expect(output).toContain(`Connecting to ${base}/`);
	expect(output).not.toContain(SECRET);
}, 30_000);

it('lets a token in --url win over LISH_TOKEN, and hides it too', async () => {
	seen.length = 0;
	const { output } = await run(`${base}/?token=${SECRET}`, 'other-token');
	expect(seen[0]).toBe(`?token=${SECRET}`);
	expect(output).not.toContain(SECRET);
}, 30_000);

it('refuses two tokens in --url without connecting', async () => {
	seen.length = 0;
	const { code, output } = await run(`${base}/?token=a&token=b`, undefined);
	expect(code).toBe(1);
	expect(output).toContain('more than one token');
	expect(seen).toEqual([]);
}, 30_000);
