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
		},
		isRunning(): boolean {
			return this.running;
		},
		subscribeTopic(id: string): void {
			this.subscribed.push(id);
		},
		unsubscribeTopic(id: string): void {
			this.unsubscribed.push(id);
		},
		getTopicPeers: (): string[] => [],
		getRecentTopicMembers: (): string[] => [],
		isBootstrapOrRelayPeer: (): boolean => false,
		disconnectPeer: async (): Promise<void> => {},
		pruneConfiguredBootstrapPeer(): void {},
		resetBootstrapStatus(): void {},
		pruneBootstrapAddresses(): void {},
		pruneBootstrapStatus(): void {},
		clearRedialSuppressionForNetwork(): void {},
		addBootstrapPeers: async (): Promise<void> => {},
	};
}

function makeNetworks(net: ReturnType<typeof makeMockNet>, db: Database): Networks {
	const networks = Object.create(Networks.prototype) as Networks;
	(networks as any).db = db;
	(networks as any).network = net;
	(networks as any).joinedNetworks = new Set<string>();
	(networks as any).networkOperations = new Map<string, Mutex>();
	(networks as any).catalogMutex = new Mutex();
	(networks as any).desiredRevisions = new Map<string, number>();
	(networks as any).announcedJoined = new Map<string, boolean>();
	(networks as any).shuttingDown = false;
	(networks as any)._onNetworkJoined = null;
	(networks as any)._onNetworkLeft = null;
	return networks;
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

		await networks.setEnabled(NET, true);
		expect(events).toEqual([`joined:${NET}`]);
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
