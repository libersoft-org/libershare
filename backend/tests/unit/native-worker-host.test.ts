import { expectWorkerRejection } from '../helpers/worker-rejection.ts';
import { expect, test } from 'bun:test';
import { NativeSnapshotReader, NativeWorkerChannel, NativeWorkerFailure } from '../../src/native/worker-host.ts';

const entry = new URL('../helpers/native-blocking-worker.ts', import.meta.url).href;

test('subscription events do not consume call replies and stop with their worker', async () => {
	const events: unknown[] = [];
	let exits = 0;
	const channel = new NativeWorkerChannel('mutation', entry, { onEvent: event => events.push(event), onExit: () => exits++ });
	try {
		expect(await channel.call<number>({ method: 'event', args: { value: 37 } })).toBe(37);
		expect(events).toEqual([{ event: 'changed', value: 37 }]);
		expect(channel.close()).toBe(true);
		await channel.waitUntilClosed();
		expect(exits).toBe(1);
		expect(events).toHaveLength(1);
	} finally {
		channel.close();
	}
});

async function waitForStart(marker: Int32Array): Promise<void> {
	const deadline = performance.now() + 3000;
	while (!Atomics.load(marker, 0)) {
		if (performance.now() >= deadline) throw new Error('Worker did not enter the native call');
		await Bun.sleep(5);
	}
}

test('a native blocking mutation keeps running while an independent reader responds', async () => {
	const mutation = new NativeWorkerChannel('mutation', entry);
	const read = new NativeWorkerChannel('read', entry);
	const marker = new Int32Array(new SharedArrayBuffer(8));
	try {
		await read.call({ method: 'read', args: { value: 1 } }, 3000);
		const changing = mutation.call({ method: 'block', args: { marker, milliseconds: 400, value: 2 } });
		await waitForStart(marker);
		expect(mutation.close()).toBe(false);
		const started = performance.now();
		expect(await read.call<number>({ method: 'read', args: { value: 3 } }, 1000)).toBe(3);
		expect(performance.now() - started).toBeLessThan(100);
		expect(Atomics.load(marker, 1)).toBe(0);
		expect(await changing).toBe(2);
		expect(Atomics.load(marker, 1)).toBe(1);
	} finally {
		read.close();
		mutation.close();
	}
});

test('a timed out reader returns its last snapshot without affecting a mutation', async () => {
	const channel = new NativeWorkerChannel('read', entry);
	const reader = new NativeSnapshotReader<number>(channel);
	const marker = new Int32Array(new SharedArrayBuffer(12));
	try {
		expect(await reader.read({ method: 'read', args: { value: 7 } }, 3000)).toEqual({ value: 7, stale: false });
		expect(await reader.read({ method: 'block', args: { marker, milliseconds: 200, value: 8 } }, 20)).toEqual({ value: 7, stale: true });
		expect(await reader.read({ method: 'read', args: { value: 9 } }, 3000)).toEqual({ value: 7, stale: true });
		await Bun.sleep(250);
		expect(Atomics.load(marker, 2)).toBe(1);
		expect(await reader.read({ method: 'read', args: { value: 9 } }, 3000)).toEqual({ value: 9, stale: false });
	} finally {
		channel.close();
	}
});

test('worker exit before reply is uncertain and the mutation channel cannot retry', async () => {
	const channel = new NativeWorkerChannel('mutation', entry);
	try {
		const error = await channel.call({ method: 'exit', args: {} }).catch(value => value);
		expect(error).toBeInstanceOf(NativeWorkerFailure);
		expect((error as NativeWorkerFailure).mayHaveRun).toBe(true);
		const retry = await channel.call({ method: 'read', args: {} }).catch(value => value);
		expect((retry as NativeWorkerFailure).mayHaveRun).toBe(false);
	} finally {
		channel.close();
	}
});

test('mutation timeouts and unbounded reads are rejected before dispatch', async () => {
	const read = new NativeWorkerChannel('read', entry);
	const mutation = new NativeWorkerChannel('mutation', entry);
	try {
		await expectWorkerRejection(read.call({ method: 'read' }), 'finite positive timeout');
		await expectWorkerRejection(mutation.call({ method: 'read' }, 20), 'cannot have a transport timeout');
	} finally {
		read.close();
		mutation.close();
	}
});

test('the production read worker rejects durable writes and returns real process identity', async () => {
	const channel = new NativeWorkerChannel('read');
	try {
		const identity = await channel.call<{ executor: { pid: number; started: string } }>({ method: 'identity.current' }, 3000);
		expect(identity.executor.pid).toBe(process.pid);
		expect(identity.executor.started.length).toBeGreaterThan(0);
		await expectWorkerRejection(channel.call({ method: 'journal.begin', args: {} }, 3000), 'cannot execute mutations');
		await expectWorkerRejection(channel.call({ method: 'linux.wifi.agent.provide', args: {} }, 3000), 'cannot execute mutations');
		await expectWorkerRejection(channel.call({ method: 'linux.wifi.agent.release', args: {} }, 3000), 'cannot execute mutations');
		await expectWorkerRejection(channel.call({ method: 'linux.dbus', args: { request: { kind: 'mutation' } } }, 3000), 'cannot execute mutations');
		await expectWorkerRejection(channel.call({ method: 'win32.network.ipv4.write', args: {} }, 3000), 'cannot execute mutations');
	} finally {
		channel.close();
	}
});
