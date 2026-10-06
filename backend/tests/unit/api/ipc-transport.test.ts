import { describe, expect, it } from 'bun:test';
import { PassThrough, Writable } from 'node:stream';
import { IPC_KIND, IPC_VERSION, IpcFrameDecoder, encodeIpcFrame, type IpcFrame } from '@shared/ipc-frame.ts';
import { StdioTransport } from '../../../src/api/stdio-transport.ts';
import type { APIClient } from '../../../src/api/client.ts';

function harness(message: (client: APIClient, data: string | Buffer) => Promise<void> = async () => {}) {
	const input = new PassThrough();
	const output = new PassThrough();
	const decoder = new IpcFrameDecoder();
	const frames: IpcFrame[] = [];
	const clients: APIClient[] = [];
	const closed: APIClient[] = [];
	const disconnected: boolean[] = [];
	output.on('data', (chunk: Buffer) => frames.push(...decoder.push(chunk)));
	const transport = new StdioTransport({ open: client => clients.push(client), close: client => closed.push(client), message, disconnect: failed => disconnected.push(failed) }, input, output);
	transport.start();
	transport.ready();
	return { input, output, frames, clients, closed, disconnected, transport };
}

describe('desktop IPC sessions', () => {
	it('carries a request to the desktop app and settles it with the matching reply', async () => {
		const h = harness();
		const call = h.transport.hostCall('{"operation":"state"}');
		await Bun.sleep(0);
		const request = h.frames.find(frame => frame.kind === IPC_KIND.HostRequest)!;
		expect(Buffer.from(request.payload).toString()).toBe('{"operation":"state"}');
		h.input.write(encodeIpcFrame(IPC_KIND.HostReply, request.session, Buffer.from('{"result":[]}')));
		expect(await call).toBe('{"result":[]}');
	});

	it('treats a reply to no request as a broken pipe and refuses waiting requests when input ends', async () => {
		const h = harness();
		const call = h.transport.hostCall('{}');
		call.catch(() => {});
		h.input.write(encodeIpcFrame(IPC_KIND.HostReply, 999, Buffer.from('{}')));
		await Bun.sleep(0);
		expect(h.disconnected).toEqual([true]);
		await expect(call).rejects.toThrow('disconnected');
		await expect(h.transport.hostCall('{}')).rejects.toThrow('not connected');
	});

	it('keeps session ownership and writes accepted replies after orderly EOF', async () => {
		let release!: () => void;
		const held = new Promise<void>(resolve => {
			release = resolve;
		});
		let completed!: () => void;
		const done = new Promise<void>(resolve => {
			completed = resolve;
		});
		const h = harness(async client => {
			await held;
			client.send('accepted result');
			completed();
		});
		h.input.write(encodeIpcFrame(IPC_KIND.Open, 1));
		h.input.write(encodeIpcFrame(IPC_KIND.Text, 1, Buffer.from('{}')));
		h.input.end();
		await Bun.sleep(0);
		expect(h.disconnected).toEqual([false]);
		expect(h.closed).toEqual([]);
		release();
		await done;
		expect(h.closed).toEqual([]);
		await h.transport.stop();
		expect(h.frames.filter(frame => frame.kind === IPC_KIND.Text).map(frame => Buffer.from(frame.payload).toString())).toEqual(['accepted result']);
		expect(h.closed).toEqual([h.clients[0]!]);
	});

	it('upgrades EOF to failure when stdout fails without cancelling accepted work', async () => {
		const h = harness();
		h.input.write(encodeIpcFrame(IPC_KIND.Open, 1));
		h.input.end();
		await Bun.sleep(0);
		h.output.emit('error', new Error('write failed'));
		h.output.emit('error', new Error('same broken pipe'));
		expect(h.disconnected).toEqual([false, true]);
		expect(h.closed).toEqual([]);
		expect(h.clients[0]!.send('late accepted reply')).toBe(false);
		expect(h.closed).toEqual([]);
		await h.transport.stop();
		expect(h.closed).toEqual([h.clients[0]!]);
	});

	it('bounds a blocked writer during API drain without closing the accepted session early', async () => {
		const input = new PassThrough();
		let release!: () => void;
		const output = new Writable({
			write(_chunk, _encoding, done) {
				release = done;
			},
		});
		let client!: APIClient;
		const closed: APIClient[] = [],
			failures: boolean[] = [];
		const transport = new StdioTransport(
			{
				open: value => {
					client = value;
				},
				close: value => closed.push(value),
				message: async () => {},
				disconnect: failed => failures.push(failed),
			},
			input,
			output
		);
		transport.start();
		transport.ready();
		input.write(encodeIpcFrame(IPC_KIND.Open, 1));
		transport.beginShutdown();
		for (let i = 0; i < 520; i++) client.send('pending');
		expect(failures).toEqual([true]);
		expect(closed).toEqual([]);
		await transport.stop();
		expect(closed).toEqual([client]);
		release();
	});

	it('closes a session while its request waits and drops its late response', async () => {
		let complete!: () => void;
		const waiting = new Promise<void>(resolve => (complete = resolve));
		const h = harness(async client => {
			await waiting;
			client.send('{"id":"old","result":true}');
		});
		h.input.write(encodeIpcFrame(IPC_KIND.Open, 1));
		h.input.write(encodeIpcFrame(IPC_KIND.Text, 1, Buffer.from('{"id":"old","method":"settings.list"}')));
		h.input.write(encodeIpcFrame(IPC_KIND.Close, 1));
		h.input.write(encodeIpcFrame(IPC_KIND.Open, 2));
		expect(h.closed).toEqual([h.clients[0]!]);
		expect(h.clients[1]).not.toBe(h.clients[0]);
		complete();
		await waiting;
		h.clients[1]!.send('{"id":"new","result":true}');
		await h.transport.stop();
		expect(h.frames[0]).toEqual({ kind: IPC_KIND.Ready, session: 0, payload: new Uint8Array([IPC_VERSION]) });
		const replies = h.frames.filter(frame => frame.kind === IPC_KIND.Text);
		expect(replies).toHaveLength(1);
		expect(replies[0]!.session).toBe(2);
		expect(Buffer.from(replies[0]!.payload).toString()).toContain('new');
	});

	it('rejects reusing a retired session and disconnects only once', async () => {
		const h = harness();
		h.input.write(encodeIpcFrame(IPC_KIND.Open, 1));
		h.input.write(encodeIpcFrame(IPC_KIND.Close, 1));
		h.input.write(encodeIpcFrame(IPC_KIND.Open, 1));
		h.input.end();
		await Bun.sleep(0);
		expect(h.disconnected).toEqual([true]);
		expect(h.clients).toHaveLength(1);
		await h.transport.stop();
	});

	it('closes the flooding session without retaining its queued messages', async () => {
		const input = new PassThrough();
		let resume!: () => void;
		const bytes: Buffer[] = [];
		let block = true;
		const output = new Writable({
			write(chunk: Buffer, _encoding, done) {
				bytes.push(Buffer.from(chunk));
				if (block) {
					block = false;
					resume = done;
				} else done();
			},
		});
		const clients: APIClient[] = [],
			closed: APIClient[] = [];
		const transport = new StdioTransport({ open: client => clients.push(client), close: client => closed.push(client), message: async () => {}, disconnect: () => {} }, input, output);
		transport.start();
		transport.ready();
		input.write(encodeIpcFrame(IPC_KIND.Open, 1));
		input.write(encodeIpcFrame(IPC_KIND.Open, 2));
		for (let i = 0; i < 520; i++) clients[0]!.send('stale');
		expect(closed).toEqual([clients[0]!]);
		clients[1]!.send('healthy');
		resume();
		await Bun.sleep(0);
		const decoder = new IpcFrameDecoder();
		const frames = bytes.flatMap(chunk => decoder.push(chunk));
		expect(frames.some(frame => frame.kind === IPC_KIND.Close && frame.session === 1)).toBe(true);
		expect(frames.filter(frame => frame.kind === IPC_KIND.Text).map(frame => Buffer.from(frame.payload).toString())).toEqual(['healthy']);
		await transport.stop();
	});

	it('drains queued replies before Close during an orderly stop', async () => {
		const input = new PassThrough();
		const bytes: Buffer[] = [];
		let resume: (() => void) | undefined;
		let block = false;
		const output = new Writable({
			write(chunk: Buffer, _encoding, done) {
				bytes.push(Buffer.from(chunk));
				if (block) {
					block = false;
					resume = done;
				} else done();
			},
		});
		let client!: APIClient;
		const transport = new StdioTransport(
			{
				open: value => {
					client = value;
				},
				close: () => {},
				message: async () => {},
				disconnect: () => {},
			},
			input,
			output
		);
		transport.start();
		transport.ready();
		input.write(encodeIpcFrame(IPC_KIND.Open, 1));
		await Bun.sleep(0);
		block = true;
		client.send('first');
		client.send('second');
		let stopped = false;
		const stop = transport.stop().then(() => {
			stopped = true;
		});
		await Bun.sleep(0);
		expect(stopped).toBe(false);
		resume!();
		await stop;
		const decoder = new IpcFrameDecoder();
		const frames = bytes.flatMap(chunk => decoder.push(chunk));
		expect(frames.slice(-3).map(frame => frame.kind)).toEqual([IPC_KIND.Text, IPC_KIND.Text, IPC_KIND.Close]);
		expect(frames.filter(frame => frame.kind === IPC_KIND.Text).map(frame => Buffer.from(frame.payload).toString())).toEqual(['first', 'second']);
	});

	for (const [name, bytes] of [
		['inbound ready', encodeIpcFrame(IPC_KIND.Ready, 0, new Uint8Array([1]))],
		['open with payload', encodeIpcFrame(IPC_KIND.Open, 1, new Uint8Array([1]))],
		['request without open', encodeIpcFrame(IPC_KIND.Text, 1, Buffer.from('{}'))],
		['truncated frame', new Uint8Array([0, 0])],
	] as const) {
		it(`rejects ${name} without delivering a request`, async () => {
			let delivered = 0;
			const h = harness(async () => {
				delivered++;
			});
			h.input.end(bytes);
			await Bun.sleep(0);
			expect(delivered).toBe(0);
			expect(h.disconnected).toEqual([true]);
			await h.transport.stop();
		});
	}
});
