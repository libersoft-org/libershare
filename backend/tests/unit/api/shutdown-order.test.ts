import { describe, expect, it } from 'bun:test';
import { drainForShutdown, type ShutdownDeps } from '../../../src/api/shutdown.ts';
import { APIServer } from '../../../src/api/api.ts';

function recordingDeps(log: string[], overrides: Partial<ShutdownDeps> = {}): ShutdownDeps {
	const step = (name: string) => async (): Promise<void> => {
		log.push(name);
	};
	return {
		stopBackgroundWork: () => log.push('background'),
		stopAllCreates: step('creates'),
		drainAcceptedRequests: step('requests'),
		prepareMaintenance: async () => {
			log.push('maintenance');
			return { drain: step('maintenance-drain'), release: () => log.push('release') };
		},
		pauseAllTransfers: step('pause-transfers'),
		pauseAllLISHMutations: step('pause-mutations'),
		stopVerifyAll: step('verify'),
		clearAllTransfers: step('clear-transfers'),
		cancelRunOperations: () => log.push('cancel'),
		stopAllNetworks: step('networks'),
		clearUploadRuntime: () => log.push('upload-runtime'),
		drainUploads: step('uploads'),
		closeServer: step('server'),
		...overrides,
	};
}

describe('drainForShutdown', () => {
	it('drains requests before taking maintenance, stops networks before uploads and closes the server last', async () => {
		const log: string[] = [];
		await drainForShutdown(recordingDeps(log));
		const at = (name: string): number => log.indexOf(name);
		expect(at('background')).toBe(0);
		expect(at('requests')).toBeLessThan(at('maintenance'));
		expect(at('clear-transfers')).toBeLessThan(at('networks'));
		expect(at('maintenance-drain')).toBeLessThan(at('networks'));
		expect(at('networks')).toBeLessThan(at('uploads'));
		expect(log[log.length - 1]).toBe('server');
	});

	it('a network that does not stop rejects the drain and never closes the server', async () => {
		const log: string[] = [];
		const failing = recordingDeps(log, {
			stopAllNetworks: async () => {
				throw new Error('node refused to stop');
			},
		});
		await expect(drainForShutdown(failing)).rejects.toThrow('node refused to stop');
		expect(log).toContain('release');
		expect(log).not.toContain('server');
	});
});

/** An APIServer with only what the request path touches, to exercise the gate directly. */
function bareServer(handlers: Record<string, (p: any) => any>): any {
	const server: any = Object.create(APIServer.prototype);
	server.accepting = true;
	server.acceptedRequests = new Set();
	server.handlers = handlers;
	return server;
}

describe('APIServer request gate', () => {
	it('a request accepted before the gate closed is waited for; one after it is refused', async () => {
		let release!: () => void;
		const held = new Promise<void>(r => (release = r));
		const server = bareServer({ 'slow.op': async () => (await held, 'done') });
		const sent: any[] = [];
		const client = { send: (m: string) => sent.push(JSON.parse(m)) };
		const first = server.handleMessage(client, JSON.stringify({ id: 1, method: 'slow.op' }));
		server.accepting = false;
		await server.handleMessage(client, JSON.stringify({ id: 2, method: 'slow.op' }));
		expect(sent).toEqual([{ id: 2, error: 'INTERNAL_ERROR', errorDetail: 'Backend is shutting down' }]);
		let drained = false;
		const draining = server.drainAcceptedRequests().then(() => (drained = true));
		await Bun.sleep(10);
		expect(drained).toBe(false);
		release();
		await Promise.all([first, draining]);
		expect(sent[1]).toEqual({ id: 1, result: 'done' });
	});
});

describe('APIServer.stop', () => {
	function withListener(listener: { stop: (force?: boolean) => Promise<void> }): any {
		const server = bareServer({});
		server.peerReadAbort = new AbortController();
		server.stopping = null;
		server.clients = new Set();
		server.server = listener;
		server.networks = { getNetwork: () => ({ cancelRunOperations() {} }) };
		server.shutdownDeps = recordingDeps([], { closeServer: () => server.closeServer() });
		return server;
	}

	for (const fail of [false, true]) {
		it(`waits for listener shutdown and ${fail ? 'propagates its failure' : 'finishes only after it resolves'}`, async () => {
			let complete!: () => void;
			let reject!: (error: Error) => void;
			const closing = new Promise<void>((resolve, rejectClose) => {
				complete = resolve;
				reject = rejectClose;
			});
			closing.catch(() => undefined);
			let entered!: () => void;
			const started = new Promise<void>(resolve => (entered = resolve));
			let forceClose: boolean | undefined;
			const server = withListener({
				stop: force => {
					forceClose = force;
					entered();
					return closing;
				},
			});
			const stopping = server.stop() as Promise<void>;
			let settled = false;
			const observed = stopping.then(
				() => {
					settled = true;
					return null;
				},
				error => {
					settled = true;
					return error;
				}
			);
			try {
				await started;
				await Promise.resolve();
				expect(forceClose).toBe(true);
				expect(settled).toBe(false);
				expect(server.stop()).toBe(stopping);
				if (fail) {
					const error = new Error('listener close failed');
					reject(error);
					expect(await observed).toBe(error);
				} else {
					complete();
					expect(await observed).toBeNull();
					expect(server.server).toBeNull();
				}
			} finally {
				complete();
				await observed;
			}
		});
	}

	it('closes a real Bun HTTP listener before completing shutdown', async () => {
		const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ready') });
		const server = withListener(listener);
		const url = listener.url.toString();
		try {
			expect(await (await fetch(url)).text()).toBe('ready');
			await server.stop();
			expect(server.server).toBeNull();
			expect(listener.pendingRequests).toBe(0);
			await expect(fetch(url)).rejects.toThrow();
		} finally {
			await listener.stop(true);
		}
	});

	it('closes the gate, aborts pending peer reads and drains them before closing the server', async () => {
		const log: string[] = [];
		const server = bareServer({
			// A peer read that ends only when shutdown aborts it, as a preview of a silent peer does.
			'peer.read': () =>
				new Promise((_, reject) => {
					server.peerReadAbort.signal.addEventListener('abort', () => {
						log.push('peer-read-aborted');
						reject(new Error('aborted'));
					});
				}),
			'late.op': async () => 'late',
		});
		server.peerReadAbort = new AbortController();
		server.stopping = null;
		let cancelledForGood = false;
		server.networks = { getNetwork: () => ({ cancelRunOperations: (permanent: boolean) => (cancelledForGood = permanent) }) };
		server.shutdownDeps = recordingDeps(log, { drainAcceptedRequests: () => server.drainAcceptedRequests().then(() => void log.push('requests')) });
		const sent: any[] = [];
		const client = { send: (m: string) => sent.push(JSON.parse(m)) };
		const pending = server.handleMessage(client, JSON.stringify({ id: 1, method: 'peer.read' }));

		const stopping = server.stop();
		await server.handleMessage(client, JSON.stringify({ id: 2, method: 'late.op' }));
		const outcome = await Promise.race([stopping.then(() => 'stopped'), Bun.sleep(2000).then(() => 'stuck')]);
		await Promise.race([pending, Bun.sleep(100)]);

		expect(outcome).toBe('stopped');
		expect(cancelledForGood).toBe(true);
		expect(sent.find(m => m.id === 2)).toEqual({ id: 2, error: 'INTERNAL_ERROR', errorDetail: 'Backend is shutting down' });
		expect(log.indexOf('peer-read-aborted')).toBeLessThan(log.indexOf('requests'));
		expect(log[log.length - 1]).toBe('server');
		expect(server.stop()).toBe(stopping);
	});
});
