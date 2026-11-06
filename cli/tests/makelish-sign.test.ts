import { afterAll, expect, it } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * `makelish` as a real process against a stand-in backend that records the `lishs.create`
 * request and refuses it: `--sign` must reach the backend as `sign: true`, its absence as no signing.
 */

const MAKELISH = join(import.meta.dir, '..', 'makelish.ts');
const fixture = mkdtempSync(join(tmpdir(), 'libershare-cli-sign-'));
const input = join(fixture, 'payload.txt');
writeFileSync(input, 'CLI signing fixture');
const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
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
			ws.send(JSON.stringify(request.method === 'lishs.create' ? { id: request.id, error: 'NODE_NOT_RUNNING' } : { id: request.id, result: true }));
		},
	},
});
// Not awaited: after its sockets have closed, the promise from stop() may never settle.
afterAll(() => {
	void server.stop(true);
	rmSync(fixture, { recursive: true });
});

async function createParams(extra: string[]): Promise<Record<string, unknown> | undefined> {
	requests.length = 0;
	const proc = Bun.spawn([process.execPath, MAKELISH, '--url', `ws://127.0.0.1:${server.port}`, '--input', input, ...extra], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
	const timer = setTimeout(() => proc.kill(), 15_000);
	await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	clearTimeout(timer);
	await proc.exited;
	return requests.find(r => r.method === 'lishs.create')?.params;
}

it('sends sign: true with --sign', async () => {
	expect((await createParams(['--sign']))?.['sign']).toBe(true);
}, 30_000);

it('does not ask for a signature without --sign', async () => {
	const params = await createParams([]);
	expect(params).toBeDefined();
	expect(params?.['sign']).toBeFalsy();
}, 30_000);
