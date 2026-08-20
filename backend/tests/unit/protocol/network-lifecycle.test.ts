import { describe, it, expect } from 'bun:test';
import { Network } from '../../../src/protocol/network.ts';
import { multiaddr } from '@multiformats/multiaddr';

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

/**
 * A stand-in for libp2p that follows its real stop state machine (libp2p 3.3.3,
 * `libp2p.js`): `stop()` returns immediately unless the status is 'started', sets
 * 'stopping', runs its phases and only then sets 'stopped'. A phase that throws leaves
 * the status at 'stopping' for good, so every later call returns without doing anything.
 * A mock that simply completes the second time cannot show the bug this models.
 */
function fakeNode(body: () => Promise<void> = async () => {}): { status: string; stop: () => Promise<void>; calls: number } {
	const node = {
		status: 'started',
		calls: 0,
		stop: async (): Promise<void> => {
			node.calls++;
			if (node.status !== 'started') return;
			node.status = 'stopping';
			await body();
			node.status = 'stopped';
		},
	};
	return node;
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
		const node = fakeNode(async () => {
			throw new Error('node.stop failed');
		});
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
		(net as any).node = fakeNode(async () => {
			throw new Error('node.stop failed');
		});
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

	it('a stop that reaches "stopped" releases the node and the datastore', async () => {
		const net = bareNetwork();
		let closed = 0;
		const node = fakeNode();
		(net as any).node = node;
		(net as any).datastore = {
			close: async (): Promise<void> => {
				closed++;
			},
		};
		(net as any).lastMeshChange.set('lish/net-a', 123);
		(net as any)._lastMeshSizes.set('net-a', 4);
		(net as any).recentDisconnects.push({ ts: 123, peerID: 'peer-a', remaining: 0, wasBootstrap: false });
		(net as any).bootstrapWorkaroundTimer = setTimeout(() => {}, 60_000);

		await net.stop();
		expect(node.status).toBe('stopped');
		expect(closed).toBe(1);
		expect((net as any).node).toBeNull();
		expect((net as any).datastore).toBeNull();
		expect((net as any).lastMeshChange.size).toBe(0);
		expect((net as any)._lastMeshSizes.size).toBe(0);
		expect((net as any).recentDisconnects).toEqual([]);
		expect((net as any).bootstrapWorkaroundTimer).toBeNull();
		expect(net.getLifecycle()).toBe('stopped');
	});

	it('a datastore that will not close leaves the instance failed, and the retry only closes it', async () => {
		const net = bareNetwork();
		let attempts = 0;
		const node = fakeNode();
		(net as any).node = node;
		const datastore = {
			close: async (): Promise<void> => {
				if (++attempts === 1) throw new Error('sqlite close failed');
			},
		};
		(net as any).datastore = datastore;

		await expect(net.stop()).rejects.toThrow('sqlite close failed');
		// Losing the reference here is what made the open handle unreachable AND let a wipe
		// or a second start run over the database it still holds.
		expect((net as any).datastore).toBe(datastore);
		expect(net.getLifecycle()).toBe('failed');
		await expect(net.clearDatastore()).rejects.toThrow('Network must be stopped');

		// The node was proved down on the first attempt and must not be stopped again — only
		// the phase that is still outstanding repeats.
		await net.stop();
		expect(attempts).toBe(2);
		expect(node.calls).toBe(1);
		expect((net as any).datastore).toBeNull();
		expect(net.getLifecycle()).toBe('stopped');
	});

	it('an interrupted libp2p stop is terminal — a retry is refused, not faked', async () => {
		const net = bareNetwork();
		let closed = 0;
		const node = fakeNode(async () => {
			throw new Error('transport close failed');
		});
		(net as any).node = node;
		(net as any).datastore = {
			close: async (): Promise<void> => {
				closed++;
			},
		};

		await expect(net.stop()).rejects.toThrow('transport close failed');
		expect(node.status).toBe('stopping');
		expect(net.getLifecycle()).toBe('failed');

		// What a "retry" would actually reach: libp2p returns at once because the status is
		// not 'started', having done nothing more. Reading that silent no-op as a successful
		// shutdown is what handed back a node still holding its listener, port and connections.
		await node.stop();
		expect(node.calls).toBe(2);
		expect(node.status).toBe('stopping');

		// So the wrapper refuses to try rather than report a shutdown it cannot perform.
		await expect(net.stop()).rejects.toThrow('restart the process');
		expect(node.calls).toBe(2);
		expect(closed).toBe(0);
		expect((net as any).node).toBe(node);
		expect((net as any).datastore).not.toBeNull();
		expect(net.getLifecycle()).toBe('failed');
		await expect(net.start([])).rejects.toThrow('failed state');
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
		// The window in which `this.node` is still set but the run is over.
		(net as any).node = fakeNode(() => gate.promise);
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

describe('Network periodic work stays bound to its run', () => {
	it('an old status tick stops immediately after its first await', async () => {
		const network = bareNetwork();
		const gate = deferred<unknown[]>();
		const nodeA = {
			getPeers: (): unknown[] => [],
			peerStore: { all: (): Promise<unknown[]> => gate.promise },
			getConnections: (): unknown[] => [],
			getMultiaddrs: (): unknown[] => [],
		};
		const nodeB = {
			getPeers: (): unknown[] => [],
			peerStore: { all: async (): Promise<unknown[]> => [] },
			getConnections: (): unknown[] => [],
			getMultiaddrs: (): unknown[] => [],
		};
		const pubsub = { getTopics: (): string[] => [], getSubscribers: (): unknown[] => [] };
		(network as any).runEpoch = 1;
		(network as any).node = nodeA;
		(network as any).pubsub = pubsub;
		let peerCountChecks = 0;
		let maintenanceRuns = 0;
		(network as any).checkPeerCounts = (): void => {
			peerCountChecks++;
		};
		(network as any).runRedialMaintenance = async (): Promise<void> => {
			maintenanceRuns++;
		};

		const realSetInterval = globalThis.setInterval;
		let tick!: () => Promise<void>;
		globalThis.setInterval = ((fn: () => Promise<void>) => {
			tick = fn;
			return 1 as any;
		}) as typeof globalThis.setInterval;
		try {
			(network as any).setupStatusInterval();
		} finally {
			globalThis.setInterval = realSetInterval;
		}

		const running = tick();
		await Promise.resolve();
		(network as any).runEpoch = 2;
		(network as any).node = nodeB;
		(network as any).pubsub = pubsub;
		gate.resolve([]);
		await running;

		expect(peerCountChecks).toBe(0);
		expect(maintenanceRuns).toBe(0);
		(network as any).statusInterval = null;
	});

	it('a bootstrap fallback timer from an old run never dials the successor node', async () => {
		const network = bareNetwork();
		let oldDials = 0;
		let newDials = 0;
		const nodeA = { getPeers: (): unknown[] => [], dial: async (): Promise<void> => void oldDials++ };
		const nodeB = { getPeers: (): unknown[] => [], dial: async (): Promise<void> => void newDials++ };
		(network as any).runEpoch = 1;
		(network as any).node = nodeA;
		(network as any).bootstrapMultiaddrs = [multiaddr('/ip4/192.0.2.10/tcp/9090')];

		const realSetTimeout = globalThis.setTimeout;
		let fire!: () => void;
		globalThis.setTimeout = ((fn: () => void) => {
			fire = fn;
			return 1 as any;
		}) as typeof globalThis.setTimeout;
		try {
			(network as any).setupBootstrapWorkaround();
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}

		(network as any).runEpoch = 2;
		(network as any).node = nodeB;
		fire();
		for (let i = 0; i < 4; i++) await Promise.resolve();

		expect(oldDials).toBe(0);
		expect(newDials).toBe(0);
		expect((network as any).bootstrapWorkaroundTimer).toBeNull();
	});
});

describe('Network periodic bootstrap promotion validates stored destinations', () => {
	const TARGET = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
	const OTHER = '12D3KooWAnfqA6Wap96ixVfxhHeGUDMriBG4Nncp5tqu8q71EVv2';

	function promotionHarness(address: string) {
		const network = Object.create(Network.prototype) as Network;
		const promoted: string[][] = [];
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).pubsub = { direct: new Set<string>() };
		(network as any).node = {
			peerId: { toString: (): string => 'self' },
			getPeers: (): Array<{ toString(): string }> => [{ toString: (): string => TARGET }],
			peerStore: {
				all: async () => [{ id: { toString: (): string => TARGET }, addresses: [{ multiaddr: multiaddr(address) }] }],
			},
		};
		(network as any).addBootstrapPeers = async (addresses: string[]): Promise<void> => {
			promoted.push(addresses);
		};
		return { network, promoted };
	}

	it('skips a direct address that already names another peer', async () => {
		const { network, promoted } = promotionHarness(`/ip4/192.0.2.10/tcp/9090/p2p/${OTHER}`);

		await (network as any).promoteKnownPeersToBootstrap(1);

		expect(promoted).toEqual([]);
	});

	it('completes a relay circuit with the actual target identity', async () => {
		const { network, promoted } = promotionHarness(`/ip4/192.0.2.10/tcp/9090/p2p/${OTHER}/p2p-circuit`);

		await (network as any).promoteKnownPeersToBootstrap(1);

		expect(promoted).toEqual([[`/ip4/192.0.2.10/tcp/9090/p2p/${OTHER}/p2p-circuit/p2p/${TARGET}`]]);
	});
});

/**
 * Two maintenance operations that each stop and start the node — an identity import and a
 * factory reset, say — both run startEnabledNetworks and both subscribe the same topics.
 * Handlers are held in a set keyed by identity and every subscribe builds a fresh closure,
 * so without care the second one joins the first and the dispatch loop answers every WANT,
 * search and peer-announce twice.
 */
describe('Network.subscribeTopic — one handler per topic', () => {
	function bare() {
		const network = Object.create(Network.prototype) as Network;
		(network as any).topicHandlers = new Map();
		(network as any).pubsub = { subscribe() {}, getTopics: () => [], score: null };
		(network as any).lishHandlers = { handleWant: async () => {}, handleSearchLishs: async () => {} };
		(network as any).peerAnnounce = { handle: async () => {} };
		(network as any).delayedPeerCountTimers = new Set();
		(network as any).runEpoch = 1;
		(network as any).checkPeerCounts = () => {};
		return network;
	}
	const handlersOf = (network: Network, topic: string): number => ((network as any).topicHandlers.get(topic) as Set<unknown> | undefined)?.size ?? 0;
	const stopTimers = (network: Network): void => {
		for (const timer of (network as any).delayedPeerCountTimers) clearTimeout(timer as any);
	};

	it('keeps exactly one handler however often the same topic is subscribed', () => {
		const network = bare();
		network.subscribeTopic('net-a');
		network.subscribeTopic('net-a');
		network.subscribeTopic('net-a');
		expect(handlersOf(network, 'lish/net-a')).toBe(1);
		stopTimers(network);
	});

	it('still keeps the topics apart', () => {
		const network = bare();
		network.subscribeTopic('net-a');
		network.subscribeTopic('net-b');
		expect(handlersOf(network, 'lish/net-a')).toBe(1);
		expect(handlersOf(network, 'lish/net-b')).toBe(1);
		stopTimers(network);
	});

	it('rolls back the pubsub, score and handler state when setup fails', () => {
		const network = bare();
		const topic = 'lish/net-a';
		const oldHandler = (): void => {};
		const handlers = new Map<string, Set<unknown>>([[topic, new Set([oldHandler])]]);
		const realSet = handlers.set.bind(handlers);
		let failNextSet = true;
		handlers.set = ((key: string, value: Set<unknown>) => {
			realSet(key, value);
			if (failNextSet) {
				failNextSet = false;
				throw new Error('handler install failed');
			}
			return handlers;
		}) as typeof handlers.set;
		(network as any).topicHandlers = handlers;
		const scoreTopics: Record<string, unknown> = { [topic]: { old: true } };
		const unsubscribed: string[] = [];
		(network as any).pubsub = {
			subscribe() {},
			unsubscribe(value: string) {
				unsubscribed.push(value);
			},
			getTopics: () => [],
			score: { params: { topics: scoreTopics } },
		};

		expect(() => network.subscribeTopic('net-a')).toThrow('handler install failed');
		expect(unsubscribed).toEqual([topic]);
		expect((handlers.get(topic) as Set<unknown>).has(oldHandler)).toBe(true);
		expect(scoreTopics[topic]).toEqual({ old: true });
		expect((network as any).delayedPeerCountTimers.size).toBe(0);
	});
});
