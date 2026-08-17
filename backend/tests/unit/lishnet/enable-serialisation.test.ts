import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Mutex } from 'async-mutex';
import { initLISHnetsTables, addLISHnet, getLISHnet } from '../../../src/db/lishnets.ts';
import { Networks } from '../../../src/lishnet/lishnets.ts';

/**
 * Enable and disable of one lishnet must produce the state the LAST request asked
 * for — in the database, in the pubsub subscription and in the callbacks the
 * transfer layer listens to.
 *
 * Neither operation used to be serialised, and both await for a long time: a join
 * waits on bootstrap dials, a leave disconnects peers one at a time. So an enable
 * could announce a join after a disable had already left, and a leave could keep
 * disconnecting the peers of a network that had just been re-enabled.
 */

const NET = 'net-a';
const BOOTSTRAP = '/ip4/192.0.2.1/tcp/9090/p2p/12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>(res => {
		resolve = res;
	});
	return { promise, resolve };
}

function makeMockNet() {
	return {
		subscribed: [] as string[],
		unsubscribed: [] as string[],
		disconnected: [] as string[],
		/** Set to hold the next bootstrap dial / peer disconnect open. */
		dialGate: null as null | Promise<void>,
		disconnectGate: null as null | Promise<void>,
		topicPeers: new Map<string, string[]>(),
		getTopicPeers(id: string): string[] {
			return this.topicPeers.get(id) ?? [];
		},
		getRecentTopicMembers(): string[] {
			return [];
		},
		subscribeTopic(id: string): void {
			this.subscribed.push(id);
		},
		unsubscribeTopic(id: string): void {
			this.unsubscribed.push(id);
			this.topicPeers.delete(id);
		},
		isBootstrapOrRelayPeer(): boolean {
			return false;
		},
		async disconnectPeer(pid: string): Promise<void> {
			if (this.disconnectGate) await this.disconnectGate;
			this.disconnected.push(pid);
		},
		pruneConfiguredBootstrapPeer(): void {},
		resetBootstrapStatus(): void {},
		pruneBootstrapAddresses(): void {},
		pruneBootstrapStatus(): void {},
		clearRedialSuppressionForNetwork(): void {},
		async addBootstrapPeers(): Promise<void> {
			if (this.dialGate) await this.dialGate;
		},
	};
}

function makeNetworks(net: ReturnType<typeof makeMockNet>, db: Database, joined: string[]) {
	const networks = Object.create(Networks.prototype) as Networks;
	(networks as any).db = db;
	(networks as any).network = net;
	(networks as any).joinedNetworks = new Set(joined);
	(networks as any).networkOperations = new Map<string, Mutex>();
	(networks as any).catalogMutex = new Mutex();
	(networks as any).desiredRevisions = new Map<string, number>();
	(networks as any).announcedJoined = new Map<string, boolean>(joined.map(id => [id, true]));
	const events: string[] = [];
	(networks as any)._onNetworkJoined = (id: string): void => {
		events.push(`joined:${id}`);
	};
	(networks as any)._onNetworkLeft = (id: string): void => {
		events.push(`left:${id}`);
	};
	return { networks, events };
}

describe('Networks.setEnabled — serialised per lishnet', () => {
	let db: Database;
	let net: ReturnType<typeof makeMockNet>;

	beforeEach(() => {
		db = new Database(':memory:');
		initLISHnetsTables(db);
		addLISHnet(db, { networkID: NET, name: 'A', description: '', bootstrapPeers: [BOOTSTRAP], enabled: false, created: new Date().toISOString() });
		net = makeMockNet();
	});

	it('an enable overtaken by a disable never announces the join', async () => {
		const gate = deferred();
		net.dialGate = gate.promise;
		const { networks, events } = makeNetworks(net, db, []);

		const enabling = networks.setEnabled(NET, true);
		await Promise.resolve();
		// The user changes their mind while the bootstrap dial is still outstanding.
		const disabling = networks.setEnabled(NET, false);
		gate.resolve();
		await Promise.all([enabling, disabling]);

		expect(events).toEqual([]);
		expect(getLISHnet(db, NET)!.enabled).toBe(false);
		expect((networks as any).joinedNetworks.has(NET)).toBe(false);
		expect(net.unsubscribed).toEqual([NET]);
	});

	it('a disable overtaken by an enable never announces the leave', async () => {
		net.topicPeers.set(NET, ['p-only-a']);
		const gate = deferred();
		net.disconnectGate = gate.promise;
		const { networks, events } = makeNetworks(net, db, [NET]);

		const disabling = networks.setEnabled(NET, false);
		await Promise.resolve();
		const enabling = networks.setEnabled(NET, true);
		gate.resolve();
		await Promise.all([disabling, enabling]);

		// From the outside nothing changed: the network never stopped being joined.
		expect(events).toEqual([]);
		expect(getLISHnet(db, NET)!.enabled).toBe(true);
		expect((networks as any).joinedNetworks.has(NET)).toBe(true);
		// The disconnect already in flight when the re-enable arrived cannot be recalled,
		// but everything the leave had not reached yet belongs to the network we are back
		// in and must be left alone.
		expect(net.disconnected).not.toContain('p-only-a');
	});

	it('three fast toggles land on the state the last one asked for', async () => {
		const gate = deferred();
		net.dialGate = gate.promise;
		const { networks, events } = makeNetworks(net, db, []);

		const first = networks.setEnabled(NET, true);
		await Promise.resolve();
		const second = networks.setEnabled(NET, false);
		const third = networks.setEnabled(NET, true);
		gate.resolve();
		await Promise.all([first, second, third]);

		expect(getLISHnet(db, NET)!.enabled).toBe(true);
		expect((networks as any).joinedNetworks.has(NET)).toBe(true);
		expect(events).toEqual(['joined:' + NET]);
		expect(net.unsubscribed).toEqual([]);
	});

	it('an uncontested enable still joins and announces it', async () => {
		const { networks, events } = makeNetworks(net, db, []);

		await networks.setEnabled(NET, true);

		expect(events).toEqual(['joined:' + NET]);
		expect(getLISHnet(db, NET)!.enabled).toBe(true);
		expect(net.subscribed).toEqual([NET]);
	});

	it('an uncontested disable still leaves and announces it', async () => {
		net.topicPeers.set(NET, ['p-only-a']);
		const { networks, events } = makeNetworks(net, db, [NET]);

		await networks.setEnabled(NET, false);

		expect(events).toEqual(['left:' + NET]);
		expect(getLISHnet(db, NET)!.enabled).toBe(false);
		expect(net.disconnected).toContain('p-only-a');
	});
});

/**
 * A delete is a row write AND a runtime change, and the two used to be separate lock
 * acquisitions with an abortable leave in between. An enable arriving in that window
 * superseded the leave, rejoined the topic, and then watched the delete remove the row:
 * subscribed to a lishnet the database has never heard of.
 */
describe('Networks.delete — terminal against a concurrent enable', () => {
	let db: Database;
	let net: ReturnType<typeof makeMockNet>;

	beforeEach(() => {
		db = new Database(':memory:');
		initLISHnetsTables(db);
		addLISHnet(db, { networkID: NET, name: 'A', description: '', bootstrapPeers: [BOOTSTRAP], enabled: true, created: new Date().toISOString() });
		net = makeMockNet();
	});

	/** Let the parked operation actually reach its gate before the racer arrives. */
	async function settle(): Promise<void> {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	}

	it('an enable that lands mid-delete gets "not found" instead of rejoining', async () => {
		net.topicPeers.set(NET, ['p-only-a']);
		const gate = deferred();
		net.disconnectGate = gate.promise;
		const { networks } = makeNetworks(net, db, [NET]);

		const deleting = networks.delete(NET);
		await settle();
		const enabling = networks.setEnabled(NET, true);
		gate.resolve();
		const [deleted, enabled] = await Promise.all([deleting, enabling]);

		expect(deleted).toBe(true);
		expect(enabled).toBe(false);
		expect(getLISHnet(db, NET)).toBeUndefined();
		// The three things that must agree: no row, not joined, not subscribed.
		expect((networks as any).joinedNetworks.has(NET)).toBe(false);
		expect(net.subscribed).toEqual([]);
		expect(net.unsubscribed).toEqual([NET]);
	});

	it('deleting an unknown lishnet reports it rather than pretending', async () => {
		const { networks } = makeNetworks(net, db, []);
		expect(await networks.delete('no-such-net')).toBe(false);
	});
});

/**
 * replace() decides which per-ID locks it needs from a snapshot of the ID set, so an ID
 * that comes into existence while it waits was reconciled — and could be deleted from the
 * database — with nobody holding its lock, right through the add that was still joining
 * it. The catalog mutex is what stops the set from moving between the snapshot and the
 * locks.
 */
describe('Networks — operations that change the set of lishnets', () => {
	const NET_B = 'net-b';
	let db: Database;
	let net: ReturnType<typeof makeMockNet>;

	beforeEach(() => {
		db = new Database(':memory:');
		initLISHnetsTables(db);
		addLISHnet(db, { networkID: NET, name: 'A', description: '', bootstrapPeers: [BOOTSTRAP], enabled: false, created: new Date().toISOString() });
		net = makeMockNet();
	});

	async function settle(): Promise<void> {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	}

	it('a network added while replace waits is not wiped out behind its back', async () => {
		const gate = deferred();
		net.dialGate = gate.promise;
		const { networks } = makeNetworks(net, db, []);

		// Something is holding net-a's lock, so replace() parks with a snapshot of the ID
		// set that predates net-b entirely.
		const holdingA = networks.setEnabled(NET, true);
		await settle();
		const replacing = networks.replace([{ networkID: NET, name: 'A', description: '', bootstrapPeers: [BOOTSTRAP], enabled: true, created: new Date().toISOString() }]);
		await settle();
		const adding = networks.add({ networkID: NET_B, name: 'B', description: '', bootstrapPeers: [BOOTSTRAP], enabled: true, created: new Date().toISOString() });
		await settle();

		gate.resolve();
		await Promise.all([holdingA, replacing, adding]);

		// Without the catalog mutex, replace's rewrite of the list dropped net-b's row while
		// the add was still joining it: subscribed, in joinedNetworks, and no row at all.
		expect(getLISHnet(db, NET_B)).toBeDefined();
		expect((networks as any).joinedNetworks.has(NET_B)).toBe(true);
	});
});
