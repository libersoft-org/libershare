import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Mutex } from 'async-mutex';
import { initLISHnetsTables, addLISHnet, deleteLISHnet, setLISHnetEnabled } from '../../../src/db/lishnets.ts';
import { Networks } from '../../../src/lishnet/lishnets.ts';

/**
 * Startup used to snapshot the enabled networks BEFORE the (slow) node start and then
 * subscribe from that copy. Anything the API did during the start — disable, delete, or
 * a full stop — was reconciled against a runtime that had joined nothing yet, so it had
 * nothing to undo, and the loop went on to join the network from its stale list.
 */

const NET = 'net-a';

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>(res => {
		resolve = res;
	});
	return { promise, resolve };
}

/** A Network stub whose start() can be held open, tracking subscribe/unsubscribe. */
function makeMockNet(startGate: Promise<void>) {
	return {
		subscribed: [] as string[],
		unsubscribed: [] as string[],
		running: false,
		async start(): Promise<void> {
			await startGate;
			this.running = true;
		},
		async stop(): Promise<void> {
			this.running = false;
			this.events.push('stop');
		},
		stopTerminal: false,
		isStopTerminal(): boolean {
			return this.stopTerminal;
		},
		isRunning(): boolean {
			return this.running;
		},
		subscribeTopic(id: string): boolean {
			this.subscribed.push(id);
			return true;
		},
		unsubscribeTopic(id: string): void {
			this.unsubscribed.push(id);
			this.events.push(`unsubscribe:${id}`);
		},
		/** Ordered log of the runtime calls a shutdown has to sequence correctly. */
		events: [] as string[],
		getTopicPeers: (): string[] => [],
		getRecentTopicMembers: (): string[] => [],
		isBootstrapOrRelayPeer: (): boolean => false,
		disconnectPeer: async (): Promise<void> => {},
		pruneConfiguredBootstrapPeer(): void {},
		resetBootstrapStatus(): void {},
		pruneBootstrapAddresses(): void {},
		pruneBootstrapStatus(): void {},
		clearRedialSuppressionForNetwork(): void {},
		getRunEpoch(): number {
			return 1;
		},
		dialsCancelled: 0,
		cancelRunOperations(): void {
			this.dialsCancelled++;
		},
		/** Set to hold the bootstrap dial of a join open. */
		dialGate: null as null | Promise<void>,
		bootstrapDials: [] as string[][],
		async addBootstrapPeers(peers: string[]): Promise<'completed' | 'incomplete'> {
			this.bootstrapDials.push(peers);
			if (this.dialGate) await this.dialGate;
			return this.dialResult;
		},
		/** What the dial run reports back: `'incomplete'` models a list it never walked. */
		dialResult: 'completed' as 'completed' | 'incomplete',
	};
}

function makeNetworks(net: ReturnType<typeof makeMockNet>, db: Database): Networks {
	const networks = Object.create(Networks.prototype) as Networks;
	(networks as any).db = db;
	(networks as any).network = net;
	(networks as any).joinedNetworks = new Set<string>();
	(networks as any).networkOperations = new Map<string, Mutex>();
	(networks as any).catalogMutex = new Mutex();
	(networks as any).activeReconciles = new Set();
	(networks as any).announcedJoined = new Map<string, boolean>();
	(networks as any).appliedBootstrap = new Map();
	(networks as any).stopRequested = false;
	(networks as any).reconcileAdmissionClosed = false;
	(networks as any)._onNetworkJoined = null;
	(networks as any)._onNetworkLeft = null;
	return networks;
}

const BOOTSTRAP = '/ip4/192.0.2.1/tcp/9090/p2p/12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';

/**
 * Make the next stop fail the way the real one does.
 *
 * A mock that merely threw and left `running` true described a node that survives its own
 * failed shutdown, which `Network.stop()` never produces: it leaves the instance `failed` —
 * refusing `start()`, reading as not running, with its dial controller aborted for good. A
 * `terminal` failure is one libp2p itself could not be stopped from; otherwise the node is
 * down and only the cleanup after it is outstanding, which a retried stop finishes.
 */
function breakStop(net: ReturnType<typeof makeMockNet>, terminal: boolean): void {
	net.stop = async (): Promise<void> => {
		net.running = false;
		net.stopTerminal = terminal;
		net.events.push('stop-failed');
		throw new Error('node.stop failed');
	};
}

/** Give the row a bootstrap peer, so a join has a dial to park on. Leaves it disabled. */
function reseedWithBootstrap(db: Database): void {
	deleteLISHnet(db, NET);
	addLISHnet(db, { networkID: NET, name: 'A', description: '', bootstrapPeers: [BOOTSTRAP], enabled: false, created: '2026-01-01T00:00:00.000Z' });
}

/** Let the startup loop get past its awaits. */
async function settle(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('Networks.startEnabledNetworks — coordinated with concurrent changes', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(':memory:');
		initLISHnetsTables(db);
		addLISHnet(db, { networkID: NET, name: 'A', description: '', bootstrapPeers: [], enabled: true, created: '2026-01-01T00:00:00.000Z' });
	});

	it('does not join a network disabled while the node was starting', async () => {
		const gate = deferred();
		const net = makeMockNet(gate.promise);
		const networks = makeNetworks(net, db);

		const starting = networks.startEnabledNetworks();
		await settle();
		// The API disables the network while start() is still outstanding.
		setLISHnetEnabled(db, NET, false);
		gate.resolve();
		await starting;

		expect(net.subscribed).toEqual([]);
		expect((networks as any).joinedNetworks.has(NET)).toBe(false);
	});

	it('does not join a network deleted while the node was starting', async () => {
		const gate = deferred();
		const net = makeMockNet(gate.promise);
		const networks = makeNetworks(net, db);

		const starting = networks.startEnabledNetworks();
		await settle();
		deleteLISHnet(db, NET);
		gate.resolve();
		await starting;

		expect(net.subscribed).toEqual([]);
		expect((networks as any).joinedNetworks.has(NET)).toBe(false);
	});

	it('does not claim a network as joined once a stop has begun', async () => {
		const gate = deferred();
		const net = makeMockNet(gate.promise);
		const networks = makeNetworks(net, db);

		const starting = networks.startEnabledNetworks();
		await settle();
		gate.resolve();
		// The stop lands the moment the node is up, before the subscribe loop runs.
		const stopping = networks.stopAllNetworks();
		await Promise.all([starting, stopping]);

		// Claiming membership of a topic on a stopped node is the failure this guards.
		expect((networks as any).joinedNetworks.has(NET)).toBe(false);
		expect(net.subscribed).toEqual([]);
	});

	it('a stop forgets what it had announced, so the next change is announced again', async () => {
		const net = makeMockNet(Promise.resolve());
		const networks = makeNetworks(net, db);
		const events: string[] = [];
		(networks as any)._onNetworkJoined = (id: string): void => {
			events.push(`joined:${id}`);
		};

		await networks.startEnabledNetworks();
		expect((networks as any).announcedJoined.get(NET)).toBe(true);

		await networks.stopAllNetworks();
		// Surviving the stop, the `true` here made the rejoin below look like no change at
		// all — the runtime had gone down and come back and nobody was told.
		expect((networks as any).announcedJoined.has(NET)).toBe(false);

		// The node has to be back up before an enable can join anything at all, and it
		// comes back with the network disabled — the case that used to be silent.
		setLISHnetEnabled(db, NET, false);
		await networks.startEnabledNetworks();
		expect((networks as any).announcedJoined.has(NET)).toBe(false);

		await networks.setEnabled(NET, true);
		expect(events).toEqual([`joined:${NET}`]);
	});

	/**
	 * stopAllNetworks used to set a flag and stop the node without waiting for, or blocking,
	 * the per-network operations. An enable queued behind a slow one then woke up after the
	 * stop, subscribed a dead pubsub (a logged no-op) and recorded the network as joined
	 * anyway — a membership with no subscription that the next startup skips as "already
	 * joined".
	 */
	it('an enable that arrives during a shutdown joins nothing', async () => {
		const net = makeMockNet(Promise.resolve());
		const networks = makeNetworks(net, db);
		await networks.startEnabledNetworks();
		await networks.setEnabled(NET, false);
		const subscribedBefore = [...net.subscribed];

		const stopping = networks.stopAllNetworks();
		const enabling = networks.setEnabled(NET, true);
		await Promise.all([stopping, enabling]);

		expect(net.running).toBe(false);
		expect(net.subscribed).toEqual(subscribedBefore);
		expect((networks as any).joinedNetworks.has(NET)).toBe(false);
	});

	/**
	 * Admission used to close from the SYNCHRONOUS start of the stop, ahead of the catalog.
	 * A writer already queued on the catalog then reached its database write first and still
	 * got neither a reservation nor a ticket, so the barrier had nothing to drain: the row it
	 * had just written never reached the runtime and the node went down still subscribed.
	 */
	it('drains a writer that reached the catalog before the stop did', async () => {
		const net = makeMockNet(Promise.resolve());
		const networks = makeNetworks(net, db);
		await networks.startEnabledNetworks();
		expect((networks as any).joinedNetworks.has(NET)).toBe(true);

		// Hold the catalog, so the disable queues on it and the stop queues behind the disable.
		const release = await (networks as any).catalogMutex.acquire();
		const disabling = networks.setEnabled(NET, false);
		const stopping = networks.stopAllNetworks();
		await settle();
		release();
		const [result] = await Promise.all([disabling, stopping]);

		// The disable was admitted and drained: its leave ran, and it ran before the node went
		// down rather than being dropped on the floor by the barrier.
		expect(net.events).toEqual([`unsubscribe:${NET}`, 'stop']);
		expect(result).toMatchObject({ found: true, transitioned: true, joined: false });
		expect((networks as any).joinedNetworks.has(NET)).toBe(false);
	});

	it('a stop that fails keeps the membership it could not prove gone', async () => {
		const net = makeMockNet(Promise.resolve());
		const networks = makeNetworks(net, db);
		await networks.startEnabledNetworks();
		expect((networks as any).joinedNetworks.has(NET)).toBe(true);

		breakStop(net, false);
		await expect(networks.stopAllNetworks()).rejects.toThrow('node.stop failed');

		// Discarding it would claim a leave that never happened — and a retried stop, the one
		// thing that can still make progress here, would then have nothing to release.
		expect((networks as any).joinedNetworks.has(NET)).toBe(true);
	});

	/**
	 * The failed stop used to REOPEN admission, on the assumption that the node was still
	 * operable. It never is: the instance is left `failed`, refusing start() and reading as not
	 * running, with its dial controller aborted for good. So the write below was stored, sent
	 * to a runtime that can no longer dial anything, and reported as applied.
	 */
	it('a stop that fails does not admit work back onto the broken runtime', async () => {
		const net = makeMockNet(Promise.resolve());
		const networks = makeNetworks(net, db);
		await networks.startEnabledNetworks();
		breakStop(net, true);
		await expect(networks.stopAllNetworks()).rejects.toThrow('node.stop failed');
		const dialsBefore = net.bootstrapDials.length;

		// A bootstrap change is stored — the row is the desired state and the next start
		// converges on it — but nothing pretends it reached the node.
		const updated = await networks.updateBootstrapPeers(NET, [BOOTSTRAP]);
		expect(updated?.bootstrapPeers).toEqual([BOOTSTRAP]);
		expect(net.bootstrapDials.length).toBe(dialsBefore);

		// And a disable does not tear down peer state on a half-stopped node.
		const result = await networks.setEnabled(NET, false);
		expect(result).toMatchObject({ found: true, transitioned: false, joined: true });
		expect(net.unsubscribed).toEqual([]);
	});

	/**
	 * Where libp2p itself went down and only the cleanup after it failed, a retried stop
	 * finishes the job — which is the whole reason the membership above is kept.
	 */
	it('a retried stop finishes a shutdown whose cleanup failed', async () => {
		const net = makeMockNet(Promise.resolve());
		const networks = makeNetworks(net, db);
		await networks.startEnabledNetworks();
		breakStop(net, false);
		await expect(networks.stopAllNetworks()).rejects.toThrow('node.stop failed');

		net.stop = async (): Promise<void> => {
			net.running = false;
			net.events.push('stop');
		};
		await networks.stopAllNetworks();
		expect((networks as any).joinedNetworks.has(NET)).toBe(false);
		expect((networks as any).announcedJoined.size).toBe(0);
	});

	/**
	 * A start that throws leaves no node at all, so clearing the flags before it — as the
	 * reopening path did — admitted work onto nothing. Most sharply after a failed stop:
	 * `Network.start()` refuses a `failed` instance outright, and the refusal would have
	 * reopened the door that the stop's failure closed.
	 */
	it('a start that fails leaves admission closed', async () => {
		const net = makeMockNet(Promise.resolve());
		const networks = makeNetworks(net, db);
		await networks.startEnabledNetworks();
		breakStop(net, false);
		await expect(networks.stopAllNetworks()).rejects.toThrow('node.stop failed');

		net.start = async (): Promise<void> => {
			throw new Error('network is in a failed state');
		};
		await expect(networks.startEnabledNetworks()).rejects.toThrow('failed state');
		expect((networks as any).reconcileAdmissionClosed).toBe(true);

		const before = [...net.unsubscribed];
		await networks.setEnabled(NET, false);
		expect(net.unsubscribed).toEqual(before);
	});

	/**
	 * The catalog mutex only ever guarded the database phase, so holding it said nothing
	 * about the runtime work in flight: an operation could be between its two phases, queued
	 * on a per-lishnet lock, or half-way through a join when the node was pulled out from
	 * under it. The stop now waits for everything that was reserved before it closed the door.
	 */
	it('waits for an operation already under way before stopping the node', async () => {
		const net = makeMockNet(Promise.resolve());
		const networks = makeNetworks(net, db);
		setLISHnetEnabled(db, NET, false);
		await networks.startEnabledNetworks();
		reseedWithBootstrap(db);

		const gate = deferred();
		net.dialGate = gate.promise;
		const enabling = networks.setEnabled(NET, true);
		await settle();
		const stopping = networks.stopAllNetworks();
		await settle();

		// The join is parked on its bootstrap dial, so the node must still be up — and the
		// stop must have asked the dials to end rather than simply waiting them out.
		expect(net.running).toBe(true);
		expect(net.dialsCancelled).toBe(1);

		gate.resolve();
		await Promise.all([enabling, stopping]);
		expect(net.running).toBe(false);
	});

	/**
	 * The join used to drop its own membership claim as soon as a stop had been ASKED for.
	 * A stop that then fails is not a stop that happened: the topic subscription this join
	 * made was never undone by anyone, so nothing would record that we are in the lishnet —
	 * and a retried stop would find no membership to release.
	 */
	it('a stop that fails keeps the membership of the join it interrupted', async () => {
		const net = makeMockNet(Promise.resolve());
		const networks = makeNetworks(net, db);
		setLISHnetEnabled(db, NET, false);
		await networks.startEnabledNetworks();
		reseedWithBootstrap(db);

		const gate = deferred();
		net.dialGate = gate.promise;
		const enabling = networks.setEnabled(NET, true);
		await settle();
		breakStop(net, false);
		const stopping = networks.stopAllNetworks();
		await settle();
		gate.resolve();
		await expect(stopping).rejects.toThrow('node.stop failed');
		await enabling;

		expect(net.subscribed).toContain(NET);
		expect((networks as any).joinedNetworks.has(NET)).toBe(true);
	});

	/**
	 * What a membership installed was recorded as the whole target list before the dials ran —
	 * right as a cleanup baseline, wrong as proof of convergence. A run cut short after the
	 * first address left the rest undialed, and the next reconcile compared the desired list
	 * against itself, found no difference and attempted nothing: the remaining addresses were
	 * never dialed again for the life of the run.
	 */
	it('re-runs an identical bootstrap list its last run never finished', async () => {
		const net = makeMockNet(Promise.resolve());
		const networks = makeNetworks(net, db);
		setLISHnetEnabled(db, NET, false);
		await networks.startEnabledNetworks();
		reseedWithBootstrap(db);

		net.dialResult = 'incomplete';
		await networks.setEnabled(NET, true);
		expect(net.bootstrapDials).toEqual([[BOOTSTRAP]]);

		// Same list, so nothing about the CONFIG has changed — only that nobody ever walked it.
		net.dialResult = 'completed';
		await networks.updateBootstrapPeers(NET, [BOOTSTRAP]);
		await settle();
		expect(net.bootstrapDials).toEqual([[BOOTSTRAP], [BOOTSTRAP]]);

		// And once a run has walked it, an identical write is the no-op it always was.
		await networks.updateBootstrapPeers(NET, [BOOTSTRAP]);
		await settle();
		expect(net.bootstrapDials).toEqual([[BOOTSTRAP], [BOOTSTRAP]]);
	});

	it('an undisturbed startup still joins every enabled network', async () => {
		const net = makeMockNet(Promise.resolve());
		const networks = makeNetworks(net, db);

		await networks.startEnabledNetworks();

		expect(net.subscribed).toEqual([NET]);
		expect((networks as any).joinedNetworks.has(NET)).toBe(true);
		expect((networks as any).announcedJoined.get(NET)).toBe(true);
	});
});
