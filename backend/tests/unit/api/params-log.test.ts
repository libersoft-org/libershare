import { describe, it, expect } from 'bun:test';
import { APIServer, canAdministerHostNetwork, networkStateForClient } from '../../../src/api/api.ts';

/** An APIServer with only the dispatch path, to observe what reaches the log. */
function bareServer(handlers: Record<string, (p: any) => any>): any {
	const server: any = Object.create(APIServer.prototype);
	server.handlers = handlers;
	return server;
}

async function logsOf(run: () => Promise<void>): Promise<string> {
	const lines: string[] = [];
	const [log, error, warn] = [console.log, console.error, console.warn];
	console.log = console.error = console.warn = (...args: unknown[]) => lines.push(args.map(String).join(' '));
	try {
		await run();
	} finally {
		[console.log, console.error, console.warn] = [log, error, warn];
	}
	return lines.join(String.fromCharCode(10));
}

describe('the RPC dispatcher never logs request content', () => {
	const secret = 'CAESQK-private-key-material';

	it('a successful call logs the method, not its parameters', async () => {
		const server = bareServer({ 'identity.applyImported': () => true });
		const sent: string[] = [];
		const log = await logsOf(() => server.handleMessage({ send: (m: string) => sent.push(m) }, JSON.stringify({ id: 1, method: 'identity.applyImported', params: { json: `{"privateKey":"${secret}"}` } })));
		expect(log).toContain('identity.applyImported');
		expect(log).not.toContain(secret);
		expect(JSON.parse(sent[0]!)).toEqual({ id: 1, result: true });
	});

	it('a failing call logs the error code, not the error text that quotes the input', async () => {
		const server = bareServer({
			'identity.parseFromJSON': () => {
				throw new Error(`Unexpected token in ${secret}`);
			},
		});
		const sent: string[] = [];
		const log = await logsOf(() => server.handleMessage({ send: (m: string) => sent.push(m) }, JSON.stringify({ id: 2, method: 'identity.parseFromJSON', params: { json: secret } })));
		expect(log).not.toContain(secret);
		expect(log).toContain('INTERNAL_ERROR');
		// The reply to the authorised caller keeps its contract.
		expect(JSON.parse(sent[0]!).errorDetail).toContain(secret);
	});

	it('an unknown method name is not echoed into the log', async () => {
		const server = bareServer({});
		const log = await logsOf(() => server.handleMessage({ send: () => {} }, JSON.stringify({ id: 3, method: `x-${secret}` })));
		expect(log).not.toContain(secret);
		expect(log).toContain('unknown');
	});
});

describe('host network administration trust boundary', () => {
	it('requires both API authentication and a browser on the same host', () => {
		expect(canAdministerHostNetwork(true, true)).toBe(true);
		expect(canAdministerHostNetwork(true, false)).toBe(false);
		expect(canAdministerHostNetwork(false, true)).toBe(false);
	});

	it('removes write capabilities from network state sent to a remote client', () => {
		const state = {
			interfaces: [],
			primaryID: null,
			detail: 'full' as const,
			known: true,
			capabilities: { ipv4: true, wifi: true, staticGatewayRequired: false },
		};
		expect(networkStateForClient(state, true, true).capabilities).toEqual(state.capabilities);
		expect(networkStateForClient(state, true, false).capabilities).toEqual({ ipv4: false, ipv4Elevation: false, wifi: false, staticGatewayRequired: false });
	});
});
