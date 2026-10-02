import { afterAll, expect, it } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { APIClient, redactTokens, withToken } from '../api-client';

/**
 * The CLI as a real process against a stand-in server that records each handshake URL. The
 * token comes from `LISH_TOKEN` or the URL, reaches the server exactly once, and never appears
 * in what the CLI prints.
 */

const CLI = join(import.meta.dir, '..', 'cli.ts');
const MAKELISH = join(import.meta.dir, '..', 'makelish.ts');
const fixture = mkdtempSync(join(tmpdir(), 'libershare-cli-auth-'));
const input = join(fixture, 'payload.txt');
writeFileSync(input, 'CLI authentication fixture');
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
	rmSync(fixture, { recursive: true });
});

async function run(url: string, token: string | undefined, entry: string = CLI): Promise<{ code: number; output: string }> {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	delete env['LISH_TOKEN'];
	if (token !== undefined) env['LISH_TOKEN'] = token;
	// A CLI that connects waits at its prompt until `quit`; one that refuses the URL exits first,
	// and writing to the pipe of an exited process blocks on Windows, so it gets no input.
	const connects = /^wss?:\/\//i.test(url) && !url.includes('token=a&token=b') && !url.includes('#') && !url.includes('[');
	const proc = Bun.spawn([process.execPath, entry, '--url', url, ...(entry === MAKELISH ? ['--input', input] : [])], { env, stdout: 'pipe', stderr: 'pipe', stdin: connects && entry === CLI ? 'pipe' : 'ignore' });
	if (connects && entry === CLI && proc.stdin) {
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

it('refuses a URL with a fragment without printing the token', async () => {
	seen.length = 0;
	const { code, output } = await run(`${base}/#fragment`, SECRET);
	expect(code).toBe(1);
	expect(output).toContain('fragment');
	expect(output).not.toContain(SECRET);
	expect(seen).toEqual([]);
}, 30_000);

it('hides a token in a --url that cannot be parsed', async () => {
	const { code, output } = await run(`ws://[bad/?token=${SECRET}`, undefined);
	expect(code).toBe(1);
	expect(output).toContain('Invalid --url');
	expect(output).not.toContain(SECRET);
}, 30_000);

for (const entry of [CLI, MAKELISH]) {
	it(`does not echo a malformed URL with an encoded token parameter in ${entry === CLI ? 'cli' : 'makelish'}`, async () => {
		seen.length = 0;
		const url = `ws://[bad/?%74oken=${SECRET}`;
		const { code, output } = await run(url, undefined, entry);
		expect(code).toBe(1);
		expect(output).toContain('Invalid --url: the URL cannot be parsed');
		expect(output).not.toContain(SECRET);
		expect(output).not.toContain(url);
		expect(seen).toEqual([]);
	}, 30_000);
}

it('rejects a malformed URL without echoing it from the shared client constructor', () => {
	expect(() => new APIClient(`ws://[bad/?%74oken=${SECRET}`)).toThrow(/^Invalid --url: the URL cannot be parsed$/);
});

it('authenticates makelish using LISH_TOKEN without printing it', async () => {
	seen.length = 0;
	const { output } = await run(base, SECRET, MAKELISH);
	expect(seen[0]).toBe(`?token=${SECRET}`);
	expect(output).not.toContain(SECRET);
}, 30_000);

it('uses the makelish URL token instead of LISH_TOKEN and hides both', async () => {
	seen.length = 0;
	const { output } = await run(`${base}/?token=${SECRET}`, 'unused-env-token', MAKELISH);
	expect(seen[0]).toBe(`?token=${SECRET}`);
	expect(output).not.toContain(SECRET);
	expect(output).not.toContain('unused-env-token');
}, 30_000);

it('rejects a malformed makelish URL without exposing its token', async () => {
	seen.length = 0;
	const { code, output } = await run(`ws://[bad/?token=${SECRET}`, undefined, MAKELISH);
	expect(code).toBe(1);
	expect(output).toContain('Invalid --url');
	expect(output).not.toContain(SECRET);
	expect(seen).toEqual([]);
}, 30_000);

for (const entry of [CLI, MAKELISH]) {
	it(`rejects invalid schemes and empty fragments without encoded token leaks in ${entry === CLI ? 'cli' : 'makelish'}`, async () => {
		for (const [url, token, encoded, reason] of [
			['ftp://127.0.0.1/?%74oken=%64eadbeefcafef00d', 'deadbeefcafef00d', '%64eadbeefcafef00d', 'must use ws:// or wss://'],
			['http://127.0.0.1/?to%6ben=%71x', 'qx', '%71x', 'must use ws:// or wss://'],
			[`${base}/?%74oken=%64eadbeefcafef00d#`, 'deadbeefcafef00d', '%64eadbeefcafef00d', 'fragment'],
			[`${base}/?to%6ben=%71x#`, 'qx', '%71x', 'fragment'],
		] as const) {
			seen.length = 0;
			const { code, output } = await run(url, SECRET, entry);
			expect(code).toBe(1);
			expect(output).toContain(`Invalid --url: the URL ${reason === 'fragment' ? 'must not have a fragment' : reason}`);
			expect(output).not.toContain(url);
			expect(output).not.toContain(token);
			expect(output).not.toContain(encoded);
			expect(output).not.toContain(SECRET);
			expect(seen).toEqual([]);
		}
	}, 30_000);

	it(`keeps an encoded URL token ahead of LISH_TOKEN in ${entry === CLI ? 'cli' : 'makelish'}`, async () => {
		seen.length = 0;
		const { output } = await run(`${base}/?%74oken=%64eadbeefcafef00d`, SECRET, entry);
		expect(new URLSearchParams(seen[0]).getAll('token')).toEqual(['deadbeefcafef00d']);
		expect(output).not.toContain('deadbeefcafef00d');
		expect(output).not.toContain('%64eadbeefcafef00d');
		expect(output).not.toContain(SECRET);
	}, 30_000);
}

it('accepts ws and wss while rejecting encoded duplicate token names', () => {
	for (const protocol of ['ws', 'wss']) expect(new URL(withToken(`${protocol}://example.test/?%74oken=%71x`, SECRET)).searchParams.getAll('token')).toEqual(['qx']);
	expect(() => withToken(`${base}/?%74oken=a&to%6ben=b`, SECRET)).toThrow('more than one token');
});

it('redacts partial percent encodings in URLs and error text, including short tokens', () => {
	for (const [value, encoded] of [
		['deadbeefcafef00d', '%64eadbeefcafef00d'],
		['qx', '%71x'],
		['Z', '%5a'],
		['a&b"/ž', '%61%26b%22/%C5%be'],
	] as const) {
		for (const key of ['token', '%74oken', 'to%6ben', '%74%6F%6b%65%6E']) {
			const url = `${base}/?${key}=${encoded}`;
			expect(redactTokens(`rejected ${url}`, url, undefined)).toBe(`rejected ${base}/?${key}=***`);
		}
		expect(redactTokens(`rejected '${encoded}'`, `${base}/?token=${encodeURIComponent(value)}`, undefined)).toBe("rejected '***'");
		expect(redactTokens(`rejected '${encoded}'`, base, value)).toBe("rejected '***'");
	}
	expect(redactTokens('rejected /?%74oken=%78', 'not a URL', undefined)).toBe('rejected /?%74oken=***');
});

it('does not expose a WebSocket constructor error even if the runtime quotes a URL', async () => {
	const original = globalThis.WebSocket;
	const echoed = `${base}/?%74oken=%64eadbeefcafef00d`;
	globalThis.WebSocket = class {
		constructor() {
			throw new Error(`runtime error: ${echoed}`);
		}
	} as unknown as typeof WebSocket;
	try {
		const client = new APIClient(`${base}/?token=deadbeefcafef00d`);
		await expect(client.connect()).rejects.toThrow(/^WebSocket connection could not be created$/);
	} finally {
		globalThis.WebSocket = original;
	}
});
