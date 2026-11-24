import { afterAll, expect, it } from 'bun:test';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'cli.ts');
const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
/** What the fake backend answers to a download that does not carry the user's agreement. */
let refusal: { error: string; errorDetail: string };
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
			let reply: object = { result: null };
			if (request.method === 'lishnets.list') reply = { result: [{ networkID: 'net-1', enabled: true }] };
			if (request.method === 'transfer.download') reply = request.params['acceptUnverified'] === true ? { result: { downloadDir: '/downloads/item' } } : refusal;
			ws.send(JSON.stringify({ id: request.id, ...reply }));
		},
	},
});
// Not awaited: after its sockets have closed, the promise from stop() may never settle.
afterAll(() => {
	void server.stop(true);
});

async function runCLI(command: string): Promise<string> {
	requests.length = 0;
	const proc = Bun.spawn([process.execPath, CLI, '--url', `ws://127.0.0.1:${server.port}`], { stdout: 'pipe', stderr: 'pipe', stdin: 'pipe' });
	const timer = setTimeout(() => proc.kill(), 15_000);
	proc.stdin.write(`${command}\n`);
	// The download answers before the next line is read, so quitting right behind it loses nothing.
	while (!requests.some(request => request.method === 'transfer.download')) await Bun.sleep(10);
	await Bun.sleep(100);
	proc.stdin.write('quit\n');
	proc.stdin.end();
	const stdout = await new Response(proc.stdout).text();
	clearTimeout(timer);
	await proc.exited;
	return stdout;
}

function downloads(): Array<Record<string, unknown>> {
	return requests.filter(request => request.method === 'transfer.download').map(request => request.params);
}

it('says why an unverified LISH was not downloaded and how to download it anyway', async () => {
	for (const [error, checks, reason] of [
		['LISH_UNSIGNED', { signed: false }, 'it is not signed'],
		['LISH_INVALID_SIGNATURE', { signed: true, signatureValid: false, idMatchesPublisher: true }, 'the signature does not match'],
		['LISH_ID_MISMATCH', { signed: true, signatureValid: true, idMatchesPublisher: false }, 'the ID does not belong to test-publisher'],
	] as const) {
		refusal = { error, errorDetail: JSON.stringify({ checks, publisher: 'test-publisher' }) };
		const stdout = await runCLI('download item.lish');
		expect(stdout).toContain(`Not downloaded: ${reason}`);
		expect(stdout).toContain('download --accept-unverified item.lish');
		// The CLI never agrees on the user's behalf.
		expect(downloads()).toEqual([{ networkID: 'net-1', lishPath: 'item.lish' }]);
	}
}, 60_000);

it('passes the agreement on when the user gives it', async () => {
	const stdout = await runCLI('download --accept-unverified my item.lish');
	expect(stdout).toContain('Download started. Directory: /downloads/item');
	expect(downloads()).toEqual([{ networkID: 'net-1', lishPath: 'my item.lish', acceptUnverified: true }]);
}, 30_000);

it('reports any other refusal as an error, without offering the flag', async () => {
	refusal = { error: 'LISH_INVALID_MANIFEST', errorDetail: 'files is not an array' };
	const stdout = await runCLI('download item.lish');
	expect(stdout).toContain('Error: LISH_INVALID_MANIFEST');
	expect(stdout).not.toContain('--accept-unverified item.lish');
}, 30_000);
