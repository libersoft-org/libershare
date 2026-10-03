import { expect, it } from 'bun:test';
import { resolve } from 'node:path';

it('reports legacy and current enable outcomes through the real CLI and WebSocket', async () => {
	const cases = [
		{ name: 'legacy failure', result: { success: false, applied: false }, outcome: 'unconfirmed' },
		{ name: 'legacy success', result: { success: true, applied: true }, outcome: 'applied' },
		{ name: 'legacy accepted without apply', result: { success: true, applied: false }, outcome: 'unconfirmed' },
		{ name: 'legacy inconsistent failure', result: { success: false, applied: true }, outcome: 'unconfirmed' },
		{ name: 'current rejected', result: { stored: false, success: false, applied: false }, outcome: 'missing' },
		{ name: 'current stored', result: { stored: true, success: false, applied: false }, outcome: 'stored' },
		{ name: 'current applied', result: { stored: true, success: true, applied: true }, outcome: 'applied' },
	] as const;
	let response: Record<string, unknown> = {};
	const requests: Array<{ method: string; params: unknown }> = [];
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response('WebSocket required', { status: 400 });
		},
		websocket: {
			message(socket, data) {
				const request = JSON.parse(String(data));
				requests.push(request);
				socket.send(JSON.stringify({ id: request.id, result: response }));
			},
		},
	});
	const child = Bun.spawn([process.execPath, 'run', 'cli.ts', '--url', `ws://127.0.0.1:${server.port}`], { cwd: resolve(import.meta.dir, '../../../../cli'), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
	let output = '';
	const drain = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true });
	})();
	const errors = new Response(child.stderr).text();
	const timeout = setTimeout(() => child.kill(), 20_000);
	async function until(read: () => string | undefined): Promise<string> {
		const deadline = Date.now() + 5000;
		for (;;) {
			const value = read();
			if (value !== undefined) return value;
			if (child.exitCode !== null || Date.now() > deadline) throw new Error(`CLI stopped responding: ${output}`);
			await Bun.sleep(10);
		}
	}
	try {
		await until(() => (output.includes('Type "help" for commands') ? 'ready' : undefined));
		for (const enabled of [true, false]) {
			const done = enabled ? 'enabled' : 'disabled';
			for (const scenario of cases) {
				response = { ...scenario.result, transitioned: false, joined: enabled && scenario.result.applied };
				const start = output.length;
				child.stdin.write(`lishnets.${enabled ? 'enable' : 'disable'} test-network\n`);
				await child.stdin.flush();
				const line = await until(() => output.slice(start).match(/[!✓✗] Network [^\r\n]+/)?.[0]);
				const expected = scenario.outcome === 'unconfirmed' ? `! Network change to ${done} was not confirmed by the server` : scenario.outcome === 'missing' ? '✗ Network not found' : scenario.outcome === 'stored' ? `! Network saved as ${done}, but the running node has not applied it yet` : `✓ Network ${done}`;
				expect({ scenario: scenario.name, line }).toEqual({ scenario: scenario.name, line: expected });
				expect(requests[requests.length - 1]).toMatchObject({ method: 'lishnets.setEnabled', params: { networkID: 'test-network', enabled } });
			}
		}
		expect(requests).toHaveLength(14);
		child.stdin.write('quit\n');
		await child.stdin.flush();
		expect(await child.exited).toBe(0);
		expect(await errors).toBe('');
	} finally {
		clearTimeout(timeout);
		if (child.exitCode === null) child.kill();
		await child.exited;
		await drain;
		await errors;
		await server.stop(true);
	}
}, 25_000);
