import { it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('stops relay polling before waiting for accepted API requests', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'lish-relay-shutdown-'));
	const script = `
		import assert from 'node:assert/strict';
		import { mock } from 'bun:test';
		mock.module('./src/api/system.ts', () => ({
			initSystemHandlers: () => ({ startPolling() {}, stopPolling() {} }),
			restrictNetworkCapabilities: state => state,
		}));
		const timers = new Map();
		globalThis.setInterval = (callback, delay) => {
			const handle = { unref() { return this; } };
			timers.set(handle, { callback, delay });
			return handle;
		};
		globalThis.clearInterval = handle => timers.delete(handle);
		const { APIServer } = await import('./src/api/api.ts');
		const { Settings } = await import('./src/settings.ts');
		const settings = await Settings.create(${JSON.stringify(dir)});
		let reads = 0;
		const networks = {
			getLibp2pNode: () => { reads++; return { getConnections: () => [] }; },
			getNetwork: () => ({ cancelRunOperations() {}, pauseLISHProtocolHandlersAndDrain: async () => {} }),
			prepareMaintenance: async () => ({ drain: async () => {}, release() {} }),
			stopAllNetworks: async () => {},
		};
		const server = new APIServer(${JSON.stringify(dir)}, {}, networks, settings, {
			host: '127.0.0.1', port: 0, secure: false, keyFile: undefined, certFile: undefined, apiToken: 'relay-shutdown-test-token',
		});
		const events = [];
		let tickingTimer;
		let relayTimer;
		server.clients.add({
			data: { subscribedEvents: new Set(['relay:stats']) },
			send: message => { relayTimer = tickingTimer; events.push(JSON.parse(message)); },
			close() {},
		});
		const tick = () => {
			for (const [handle, { callback, delay }] of [...timers]) {
				if (delay === 1000) { tickingTimer = handle; callback(); }
			}
		};
		let release;
		const accepted = new Promise(resolve => { release = resolve; });
		server.acceptedRequests.add(accepted);
		accepted.then(() => server.acceptedRequests.delete(accepted));
		try {
			tick();
			assert.equal(events.length, 1);
			assert.ok(timers.has(relayTimer));
			assert.ok(reads > 0);
			const before = reads;
			const stopping = server.stop();
			tick();
			assert.equal(reads, before, 'relay must not read network state during shutdown');
			assert.equal(events.length, 1, 'relay must not broadcast during shutdown');
			release();
			await stopping;
			assert.equal(timers.has(relayTimer), false);
		} finally {
			release();
			await server.stop();
		}
	`;
	try {
		const child = Bun.spawn([process.execPath, '--eval', script], { cwd: join(import.meta.dir, '../../..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
		const timeout = setTimeout(() => child.kill(), 10_000);
		try {
			const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
			if (code !== 0) throw new Error(`relay shutdown fixture exited ${code}: ${stderr || stdout}`);
		} finally {
			clearTimeout(timeout);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}, 15_000);
