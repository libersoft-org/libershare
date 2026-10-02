import { afterEach, expect, test } from 'bun:test';
import { RpcClient, MAX_UPLOAD_CHUNK_SIZE, type RpcSession, type RpcTransport } from '@shared';

type Handlers = Parameters<RpcTransport['connect']>[0];
const clients: RpcClient[] = [];
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => {
	for (const client of clients.splice(0)) client.destroy();
});

class ControlledTransport implements RpcTransport {
	links: Array<{ handlers: Handlers; signal: AbortSignal; open: () => void }> = [];
	frames: Array<string | Uint8Array> = [];
	sendError = false;
	closed = 0;
	connect(handlers: Handlers, signal: AbortSignal): Promise<RpcSession> {
		return new Promise(resolve => {
			this.links.push({
				handlers,
				signal,
				open: () =>
					resolve({
						send: frame => {
							if (this.sendError) throw new Error('send failed');
							this.frames.push(frame);
						},
						close: () => {
							this.closed++;
						},
					}),
			});
		});
	}
}
async function setup() {
	const transport = new ControlledTransport();
	const states: boolean[] = [];
	const client = new RpcClient(transport, state => states.push(state.connected));
	client.setAutoReconnect(false);
	clients.push(client);
	await tick();
	transport.links[0]!.open();
	await tick();
	return { client, transport, states };
}
const request = (transport: ControlledTransport, index = 0): { id: string } => JSON.parse(transport.frames[index] as string);

test('both concurrent RPC replies resolve by id and preserve error details', async () => {
	const { client, transport } = await setup();
	const one = client.call('one');
	const two = client.call('two');
	const rejected = two.catch(error => error);
	await tick();
	transport.links[0]!.handlers.message(JSON.stringify({ id: request(transport, 1).id, error: 'DENIED', errorDetail: 'reason' }));
	transport.links[0]!.handlers.message(JSON.stringify({ id: request(transport).id, result: 42 }));
	expect(await one).toBe(42);
	expect(await rejected).toMatchObject({ code: 'DENIED', detail: 'reason' });
});

test('a send error rejects immediately and a following request still works', async () => {
	const { client, transport } = await setup();
	transport.sendError = true;
	await expect(client.call('broken', {}, 60000)).rejects.toThrow('send failed');
	transport.sendError = false;
	const next = client.call('next');
	await tick();
	transport.links[0]!.handlers.message(JSON.stringify({ id: request(transport).id, result: true }));
	expect(await next).toBe(true);
});

test('timeouts include connection setup and expired calls are never sent', async () => {
	const transport = new ControlledTransport();
	const client = new RpcClient(transport, () => {});
	clients.push(client);
	client.setAutoReconnect(false);
	await expect(client.call('late', {}, 20)).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
	transport.links[0]!.open();
	await tick();
	expect(transport.frames).toHaveLength(0);
});

test('late responses cannot resolve the next request', async () => {
	const { client, transport } = await setup();
	await expect(client.call('late', {}, 20)).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
	const next = client.call('next');
	await tick();
	transport.links[0]!.handlers.message(JSON.stringify({ id: request(transport).id, result: 'old' }));
	transport.links[0]!.handlers.message(JSON.stringify({ id: request(transport, 1).id, result: 'new' }));
	expect(await next).toBe('new');
});

test('disconnect rejects pending calls and old connections cannot affect a new session', async () => {
	const { client, transport, states } = await setup();
	const events: unknown[] = [];
	client.on('progress', value => events.push(value));
	const waiting = client.call('pending').catch(error => error);
	await tick();
	const old = transport.links[0]!;
	old.handlers.closed(new Error('lost'));
	expect((await waiting).message).toBe('lost');
	const next = client.call('next');
	await tick();
	transport.links[1]!.open();
	await tick();
	old.handlers.closed(new Error('stale'));
	old.handlers.message(JSON.stringify({ id: request(transport, 1).id, result: 'stale' }));
	old.handlers.message(JSON.stringify({ event: 'progress', data: 'stale' }));
	transport.links[1]!.handlers.message(JSON.stringify({ id: request(transport, 1).id, result: 'current' }));
	transport.links[1]!.handlers.message(JSON.stringify({ event: 'progress', data: 'current' }));
	expect(await next).toBe('current');
	expect(states).toEqual([true, false, true]);
	expect(events).toEqual(['current']);
});

test('event callbacks and wildcard callbacks can be removed', async () => {
	const { client, transport } = await setup();
	const events: unknown[] = [];
	const off = client.on('progress', data => events.push(data));
	const wildcard = client.on('*', data => events.push(data));
	transport.links[0]!.handlers.message(JSON.stringify({ event: 'progress', data: 5 }));
	off();
	wildcard();
	transport.links[0]!.handlers.message(JSON.stringify({ event: 'progress', data: 6 }));
	expect(events).toEqual([5, { event: 'progress', data: 5 }]);
});

test('binary requests preserve subarray bytes and enforce the upload ceiling', async () => {
	const { client, transport } = await setup();
	const bytes = Uint8Array.from([9, 1, 2, 3, 9]);
	const pending = client.callBinary('upload.chunk', { uploadID: 'fixture' }, bytes.subarray(1, 4));
	await tick();
	const frame = transport.frames[0] as Uint8Array;
	const headerSize = new DataView(frame.buffer, frame.byteOffset).getUint32(0);
	const header = JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + headerSize)));
	expect([...frame.subarray(4 + headerSize)]).toEqual([1, 2, 3]);
	transport.links[0]!.handlers.message(JSON.stringify({ id: header.id, result: true }));
	await pending;
	await expect(client.callBinary('upload.chunk', {}, new Uint8Array(MAX_UPLOAD_CHUNK_SIZE + 1))).rejects.toMatchObject({ code: 'UPLOAD_CHUNK_TOO_LARGE' });
	expect(transport.frames).toHaveLength(1);
});

test('pending requests have a finite ceiling and destroy releases their promises', async () => {
	const { client } = await setup();
	const requests = Array.from({ length: 1024 }, () =>
		client.call('waiting').then(
			() => false,
			() => true
		)
	);
	await expect(client.call('overflow')).rejects.toThrow('RPC queue is full');
	client.destroy();
	expect((await Promise.all(requests)).every(Boolean)).toBe(true);
	await expect(client.call('after destroy')).rejects.toThrow('destroyed');
});
