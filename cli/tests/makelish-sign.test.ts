import { afterAll, expect, it } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const MAKELISH = join(import.meta.dir, '..', 'makelish.ts');
const fixture = mkdtempSync(join(tmpdir(), 'libershare-cli-sign-'));
const input = join(fixture, 'payload.txt');
writeFileSync(input, 'CLI signing fixture');
const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
let signedReply: { result: { lishID: string; publisher?: string } } | { error: string };
const server = Bun.serve({
	port: 0,
	hostname: '127.0.0.1',
	fetch(req, s) {
		return s.upgrade(req, { data: {} }) ? undefined : new Response('expected websocket', { status: 400 });
	},
	websocket: {
		message(ws, frame) {
			const request = JSON.parse(String(frame)) as { id: number; method: string; params: Record<string, unknown> };
			requests.push(request);
			const reply = request.method === 'lishs.createSigned' ? signedReply : { result: { lishID: 'test-item' } };
			ws.send(JSON.stringify({ id: request.id, ...reply }));
		},
	},
});
// Not awaited: after its sockets have closed, the promise from stop() may never settle.
afterAll(() => {
	void server.stop(true);
	rmSync(fixture, { recursive: true });
});

async function runMakelish(extra: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	requests.length = 0;
	const proc = Bun.spawn([process.execPath, MAKELISH, '--url', `ws://127.0.0.1:${server.port}`, '--input', input, ...extra], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
	const timer = setTimeout(() => proc.kill(), 15_000);
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	clearTimeout(timer);
	return { code: await proc.exited, stdout, stderr };
}

it('uses the signing method and reports the confirmed publisher', async () => {
	signedReply = { result: { lishID: 'test-item', publisher: 'test-publisher' } };
	const result = await runMakelish(['--sign']);
	expect(result.code).toBe(0);
	expect(result.stdout).toContain('test-publisher');
	expect(requests.find(request => request.method === 'lishs.createSigned')?.params['sign']).toBe(true);
	expect(requests.some(request => request.method === 'lishs.create')).toBe(false);
}, 30_000);

it('refuses to fall back to unsigned creation on an older server', async () => {
	signedReply = { error: 'UNKNOWN_METHOD' };
	const result = await runMakelish(['--sign']);
	expect(result.code).toBe(1);
	expect(result.stderr).toContain('LISH_SIGNING_UNSUPPORTED_SERVER');
	expect(requests.some(request => request.method === 'lishs.create')).toBe(false);
}, 30_000);

it('fails when the signing method did not confirm a publisher', async () => {
	signedReply = { result: { lishID: 'test-item' } };
	const result = await runMakelish(['--sign']);
	expect(result.code).toBe(1);
	expect(result.stderr).toContain('did not confirm the publisher');
	expect(result.stdout).not.toContain('LISH created successfully');
}, 30_000);

it('does not ask for a signature without --sign', async () => {
	expect((await runMakelish([])).code).toBe(0);
	const params = requests.find(request => request.method === 'lishs.create')?.params;
	expect(params).toBeDefined();
	expect(params?.['sign']).toBeFalsy();
}, 30_000);
