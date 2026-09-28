import { expect, test } from 'bun:test';
import { TestClient } from '../e2e/helpers/ws-test-client.ts';

async function outcome(promise: Promise<unknown>): Promise<string> {
	return Promise.race([
		promise.then(
			() => 'resolved',
			error => error.message
		),
		Bun.sleep(500).then(() => 'pending'),
	]);
}

test('destroy rejects a pending connection immediately', async () => {
	let release!: () => void;
	const held = new Promise<void>(resolve => (release = resolve));
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: async () => {
			await held;
			return new Response('closed', { status: 503 });
		},
	});
	const client = new TestClient(`ws://127.0.0.1:${server.port}`);
	try {
		const connecting = outcome(client.waitConnected(5000));
		client.destroy();
		expect(await connecting).toBe('client destroyed');
		expect(await outcome(client.waitConnected())).toBe('client destroyed');
	} finally {
		release();
		client.destroy();
		void server.stop(true);
	}
});

for (const cause of ['destroy', 'disconnect']) {
	test(`${cause} rejects event waits and collections and removes their subscriptions`, async () => {
		let socket: any;
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('upgrade required', { status: 400 })),
			websocket: {
				open: ws => {
					socket = ws;
				},
				message() {},
			},
		});
		const client = new TestClient(`ws://127.0.0.1:${server.port}`);
		try {
			await client.waitConnected();
			const event = outcome(client.waitForEvent('tick', undefined, 5000));
			const collection = outcome(client.collectEvents('tick', 5000));
			if (cause === 'destroy') client.destroy();
			else socket.close();
			const error = cause === 'destroy' ? 'client destroyed' : 'WebSocket disconnected';
			expect(await event).toBe(error);
			expect(await collection).toBe(error);
			expect((client as any).waits.size).toBe(0);
			expect((client as any).client.eventListeners.get('tick')?.size ?? 0).toBe(0);
			client.destroy();
			expect(await outcome(client.collectEvents('tick', 0))).toBe('client destroyed');
		} finally {
			client.destroy();
			void server.stop(true);
		}
	});
}
