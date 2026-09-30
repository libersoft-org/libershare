import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { IPC_KIND } from '@shared';
import { TauriTransport, type TauriHost } from '../../src/scripts/tauri-transport.ts';

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
function hostFixture(open: () => Promise<number> = () => Promise.resolve(7)) {
	const calls: Array<{ command: string; args: Record<string, unknown> | Uint8Array | undefined }> = [];
	const host: TauriHost = {
		__BACKEND_IPC__: true,
		__TAURI_INTERNALS__: {
			invoke: <T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T> => {
				calls.push({ command, args });
				return (command === 'backend_open' ? open() : Promise.resolve(undefined)) as Promise<T>;
			},
		},
	};
	return { host, calls, transport: new TauriTransport(host) };
}

test('native frames before open resolves are bounded, handled and acknowledged', async () => {
	const frames: string[] = [];
	const fixture = hostFixture(async () => {
		expect(fixture.host.__LIBERSHARE_IPC_RECEIVE__).toBeFunction();
		fixture.host.__LIBERSHARE_IPC_RECEIVE__!({ session: 7, sequence: 1, type: 'message', data: 'early' });
		return 7;
	});
	const session = await fixture.transport.connect({ message: frame => frames.push(frame), closed: () => {} }, new AbortController().signal);
	expect(frames).toEqual(['early']);
	expect(fixture.calls.find(call => call.command === 'backend_ack')?.args).toEqual({ session: 7, sequence: 1 });
	fixture.host.__LIBERSHARE_IPC_RECEIVE__!({ session: 7, sequence: 1, type: 'message', data: 'duplicate' });
	expect(frames).toEqual(['early']);
	await session.close();
	expect(fixture.host.__LIBERSHARE_IPC_RECEIVE__).toBeUndefined();
});

test('native send uses raw bytes and preserves a subarray exactly', async () => {
	const { host, calls, transport } = hostFixture();
	const session = await transport.connect({ message: () => {}, closed: () => {} }, new AbortController().signal);
	await session.send('ž');
	await session.send(Uint8Array.from([9, 1, 2, 3, 9]).subarray(1, 4));
	const bodies = calls.filter(call => call.command === 'backend_send').map(call => call.args as Uint8Array);
	expect(bodies.every(body => body instanceof Uint8Array)).toBe(true);
	expect([...bodies[0]!]).toEqual([IPC_KIND.Text, 0, 0, 0, 7, ...new TextEncoder().encode('ž')]);
	expect([...bodies[1]!]).toEqual([IPC_KIND.Binary, 0, 0, 0, 7, 1, 2, 3]);
	await session.close();
	expect(host.__LIBERSHARE_IPC_RECEIVE__).toBeUndefined();
});

test('an aborted open cannot replace or close the next native session', async () => {
	let finish!: (session: number) => void;
	let count = 0;
	const fixture = hostFixture(() =>
		++count === 1
			? new Promise(resolve => {
					finish = resolve;
				})
			: Promise.resolve(8)
	);
	const controller = new AbortController();
	const old = fixture.transport
		.connect(
			{
				message: () => {
					throw new Error('old callback');
				},
				closed: () => {},
			},
			controller.signal
		)
		.catch(error => error);
	controller.abort();
	expect((await old).message).toContain('cancelled');
	const frames: string[] = [];
	const next = await fixture.transport.connect(
		{
			message: frame => frames.push(frame),
			closed: () => {
				throw new Error('new session closed by old frame');
			},
		},
		new AbortController().signal
	);
	finish(7);
	await tick();
	fixture.host.__LIBERSHARE_IPC_RECEIVE__!({ session: 7, sequence: 0, type: 'closed' });
	fixture.host.__LIBERSHARE_IPC_RECEIVE__!({ session: 8, sequence: 1, type: 'message', data: 'current' });
	expect(frames).toEqual(['current']);
	expect(fixture.calls.some(call => call.command === 'backend_close' && (call.args as Record<string, unknown>)?.['session'] === 7)).toBe(true);
	await next.close();
});

test('a failed callback is still acknowledged and backend close is delivered', async () => {
	const { host, calls, transport } = hostFixture();
	let closed = 0;
	await transport.connect(
		{
			message: () => {
				throw new Error('handler failed');
			},
			closed: () => {
				closed++;
			},
		},
		new AbortController().signal
	);
	expect(() => host.__LIBERSHARE_IPC_RECEIVE__!({ session: 7, sequence: 1, type: 'message', data: '{}' })).toThrow('handler failed');
	expect(calls.at(-1)).toEqual({ command: 'backend_ack', args: { session: 7, sequence: 1 } });
	host.__LIBERSHARE_IPC_RECEIVE__!({ session: 7, sequence: 0, type: 'closed' });
	expect(closed).toBe(1);
	expect(host.__LIBERSHARE_IPC_RECEIVE__).toBeUndefined();
});

test('too many frames while opening reject the session instead of growing the buffer', async () => {
	const fixture = hostFixture(async () => {
		const receive = fixture.host.__LIBERSHARE_IPC_RECEIVE__!;
		for (let sequence = 1; sequence <= 17; sequence++) receive({ session: 7, sequence, type: 'message', data: '{}' });
		return 7;
	});
	await expect(fixture.transport.connect({ message: () => {}, closed: () => {} }, new AbortController().signal)).rejects.toThrow();
	expect(fixture.host.__LIBERSHARE_IPC_RECEIVE__).toBeUndefined();
});

test('native bootstrap and upload never touch backend HTTP or WebSocket', async () => {
	const child = Bun.spawn([process.execPath, 'run', fileURLToPath(new URL('../fixtures/native-client.ts', import.meta.url))], { cwd: fileURLToPath(new URL('../..', import.meta.url)), stdout: 'pipe', stderr: 'pipe' });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
	expect(stdout).toContain('native bootstrap, upload and disconnect passed');
}, 15000);
