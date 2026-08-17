import { describe, it, expect } from 'bun:test';
import { Network } from '../../../src/protocol/network.ts';

/**
 * Unit tests for the transactional start()/stop() lifecycle.
 *
 * The node used to be considered "running" the moment `this.node` was assigned —
 * half-way through start(), and for the whole of stop(). That made four things
 * possible, each covered below: a phantom running state after a failed start, a
 * leaked datastore handle, two concurrent starts both building a node, and a stop
 * that reported success while node.stop() had thrown.
 *
 * The last one is what `failed` exists for: a node that would not stop keeps its
 * reference and its datastore, refuses a new start and every destructive operation,
 * and can only be left by a stop that actually succeeds.
 */

/** A Network with no libp2p behind it — start()/stop() orchestration only. */
function bareNetwork(): Network {
	return new Network('/nonexistent/data-dir', {} as any, { list: (): any => ({}) } as any);
}

/** A promise plus the handles to settle it, so a test can hold a step open. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('Network lifecycle', () => {
	it('a second start() while the first is still building does not build a second node', async () => {
		const net = bareNetwork();
		const gate = deferred();
		let started = 0;
		(net as any).startLocked = async (): Promise<void> => {
			started++;
			await gate.promise;
		};

		const first = net.start([]);
		// Second caller arrives while the first is parked inside startLocked — exactly the
		// window in which `if (this.node)` was still false and let both through.
		const second = net.start([]);
		await Promise.resolve();
		expect(started).toBe(1);

		gate.resolve();
		await Promise.all([first, second]);
		expect(started).toBe(1);
		expect(net.isRunning()).toBe(true);
		expect(net.getLifecycle()).toBe('running');
	});

	it('a failed start leaves nothing running and does not block the next start', async () => {
		const net = bareNetwork();
		let torndown = 0;
		(net as any).teardown = async (): Promise<void> => {
			torndown++;
		};
		(net as any).startLocked = async (): Promise<void> => {
			throw new Error('createLibp2p exploded');
		};

		await expect(net.start([])).rejects.toThrow('createLibp2p exploded');
		expect(torndown).toBe(1);
		expect(net.isRunning()).toBe(false);
		expect(net.getLifecycle()).toBe('stopped');

		// The whole point: a start that failed must be retryable in-process.
		(net as any).startLocked = async (): Promise<void> => {};
		await net.start([]);
		expect(net.isRunning()).toBe(true);
	});

	it('start() is not reported as running until it has fully finished', async () => {
		const net = bareNetwork();
		const gate = deferred();
		(net as any).startLocked = async (): Promise<void> => {
			// Whatever a partially built start has assigned, it is not running yet.
			(net as any).node = { stop: async (): Promise<void> => {} };
			await gate.promise;
		};

		const running = net.start([]);
		await Promise.resolve();
		expect(net.isRunning()).toBe(false);
		expect(net.getLifecycle()).toBe('starting');

		gate.resolve();
		await running;
		expect(net.isRunning()).toBe(true);
	});

	it('stop() waits for an in-flight start instead of tearing it down mid-build', async () => {
		const net = bareNetwork();
		const gate = deferred();
		const order: string[] = [];
		(net as any).startLocked = async (): Promise<void> => {
			order.push('start:begin');
			await gate.promise;
			order.push('start:end');
		};
		(net as any).teardown = async (): Promise<void> => {
			order.push('teardown');
		};

		const starting = net.start([]);
		await Promise.resolve();
		const stopping = net.stop();
		// Give the stop every chance to cut in front of the unfinished start.
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(['start:begin']);

		gate.resolve();
		await Promise.all([starting, stopping]);
		expect(order).toEqual(['start:begin', 'start:end', 'teardown']);
		expect(net.getLifecycle()).toBe('stopped');
	});

	it('a node that refuses to stop leaves the instance failed, not stopped', async () => {
		const net = bareNetwork();
		let closed = 0;
		const node = {
			stop: async (): Promise<void> => {
				throw new Error('node.stop failed');
			},
		};
		(net as any).node = node;
		(net as any).datastore = {
			close: async (): Promise<void> => {
				closed++;
			},
		};

		await expect(net.stop()).rejects.toThrow('node.stop failed');

		// The node may still hold its listener, its connections and its port. Closing the
		// datastore under it and dropping the reference would make that both permanent and
		// unretryable, and `stopped` would invite a second node over the same identity.
		expect(closed).toBe(0);
		expect((net as any).node).toBe(node);
		expect((net as any).datastore).not.toBeNull();
		expect(net.getLifecycle()).toBe('failed');
		expect(net.isRunning()).toBe(false);
	});

	it('a failed stop refuses a new start and every destructive operation', async () => {
		const net = bareNetwork();
		(net as any).node = {
			stop: async (): Promise<void> => {
				throw new Error('node.stop failed');
			},
		};
		(net as any).datastore = { close: async (): Promise<void> => {} };
		await expect(net.stop()).rejects.toThrow('node.stop failed');

		let started = 0;
		(net as any).startLocked = async (): Promise<void> => {
			started++;
		};
		await expect(net.start([])).rejects.toThrow('failed state');
		expect(started).toBe(0);

		await expect(net.clearDatastore()).rejects.toThrow('Network must be stopped');
		await expect(net.clearPeerstore()).rejects.toThrow('Network must be stopped');
		await expect(net.clearIdentityKey()).rejects.toThrow('Network must be stopped');
		await expect(net.writeIdentityKey(new Uint8Array([1, 2, 3]))).rejects.toThrow('Network must be stopped');
	});

	it('a retried stop that succeeds releases everything and clears the failed state', async () => {
		const net = bareNetwork();
		let attempts = 0;
		let closed = 0;
		(net as any).node = {
			stop: async (): Promise<void> => {
				if (++attempts === 1) throw new Error('node.stop failed');
			},
		};
		(net as any).datastore = {
			close: async (): Promise<void> => {
				closed++;
			},
		};

		await expect(net.stop()).rejects.toThrow('node.stop failed');
		expect(net.getLifecycle()).toBe('failed');

		// Retrying the shutdown is the only way out — and it has to be possible, which is
		// exactly what dropping the node reference used to take away.
		await net.stop();
		expect(attempts).toBe(2);
		expect(closed).toBe(1);
		expect((net as any).node).toBeNull();
		expect(net.getLifecycle()).toBe('stopped');
	});

	it('a failed start whose cleanup also fails refuses the next start', async () => {
		const net = bareNetwork();
		(net as any).teardown = async (): Promise<void> => {
			throw new Error('node.stop failed');
		};
		(net as any).startLocked = async (): Promise<void> => {
			throw new Error('createLibp2p exploded');
		};

		// Both reasons survive: what broke the start, and why the instance is now unusable.
		const err = await net.start([]).then(
			() => null,
			(e: unknown) => e
		);
		expect(err).toBeInstanceOf(AggregateError);
		expect((err as AggregateError).errors.map((e: unknown) => String((e as Error).message))).toEqual(['createLibp2p exploded', 'node.stop failed']);
		expect(net.getLifecycle()).toBe('failed');

		let started = 0;
		(net as any).startLocked = async (): Promise<void> => {
			started++;
		};
		await expect(net.start([])).rejects.toThrow('failed state');
		expect(started).toBe(0);
	});

	it('a start() that arrives while stop() is inside node.stop() is not answered "already running"', async () => {
		const net = bareNetwork();
		const gate = deferred();
		let started = 0;
		(net as any).node = {
			stop: async (): Promise<void> => {
				// The window in which `this.node` is still set but the run is over.
				await gate.promise;
			},
		};
		(net as any).startLocked = async (): Promise<void> => {
			started++;
		};

		const stopping = net.stop();
		await Promise.resolve();
		const starting = net.start([]);
		gate.resolve();
		await Promise.all([stopping, starting]);

		// A pre-check on `this.node` outside the mutex would have logged "already
		// running" and returned, leaving the caller with a stopped network.
		expect(started).toBe(1);
		expect(net.getLifecycle()).toBe('running');
	});

	it('a datastore wipe cannot land inside an in-progress start', async () => {
		const net = bareNetwork();
		const gate = deferred();
		let wiped = 0;
		(net as any).startLocked = async (): Promise<void> => {
			// Mirrors the real start: the datastore is open and the identity read long
			// before `this.node` is assigned.
			await gate.promise;
		};

		const starting = net.start([]);
		await Promise.resolve();
		expect(net.getLifecycle()).toBe('starting');

		let refusal: unknown = null;
		const wiping = net.clearDatastore().then(
			() => {
				wiped++;
			},
			(err: unknown) => {
				refusal = err;
			}
		);
		gate.resolve();
		await starting;
		await wiping;

		// The wipe must be refused for the right reason. Guarding on `this.node` let it
		// through here, because a start has no node yet while it has a datastore.
		expect(wiped).toBe(0);
		expect(String((refusal as Error)?.message)).toContain('Network must be stopped');
		expect(net.getLifecycle()).toBe('running');
	});

	it('identity and peerstore writes are refused unless the lifecycle is stopped', async () => {
		const net = bareNetwork();
		(net as any).startLocked = async (): Promise<void> => {};
		await net.start([]);

		await expect(net.clearPeerstore()).rejects.toThrow('Network must be stopped');
		await expect(net.clearIdentityKey()).rejects.toThrow('Network must be stopped');
		await expect(net.writeIdentityKey(new Uint8Array([1, 2, 3]))).rejects.toThrow('Network must be stopped');
	});
});
