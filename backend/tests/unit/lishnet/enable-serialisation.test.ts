import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Mutex } from 'async-mutex';
import { initLISHnetsTables, addLISHnet, getLISHnet, setLISHnetEnabled } from '../../../src/db/lishnets.ts';
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
 *
 * Each request now runs to completion and then the next one converges on the row it
 * left behind, so a contested toggle costs one redundant pass and reports honestly
 * what happened. Abandoning the loser mid-flight instead is what left a cleanup
 * half-done with a successor that had nothing left to finish.
 */

const NET = 'net-a';
const NAMED = { networkID: 'net-a', name: 'A' };
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
		isRunning(): boolean {
			return true;
		},
		subscribeTopic(id: string): boolean {
			this.subscribed.push(id);
			return true;
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

	it('an enable overtaken by a disable ends disabled, both transitions announced', async () => {
		const gate = deferred();
		net.dialGate = gate.promise;
		const { networks, events } = makeNetworks(net, db, []);

		const enabling = networks.setEnabled(NET, true);
		// Enough turns for the enable to take its locks, subscribe, and park on the dial —
		// the disable has to arrive with the join already half-done for this to mean
		// anything.
		for (let i = 0; i < 10; i++) await Promise.resolve();
		// The user changes their mind while the bootstrap dial is still outstanding.
		const disabling = networks.setEnabled(NET, false);
		gate.resolve();
		await Promise.all([enabling, disabling]);

		// The join really did happen — it subscribed the topic before it parked — so saying
		// so and then saying it was undone is the honest report. Cancelling it half-way is
		// what left the subscription and the dials behind with nobody to clean them up.
		expect(events).toEqual([`joined:${NET}`, `left:${NET}`]);
		expect(getLISHnet(db, NET)!.enabled).toBe(false);
		expect((networks as any).joinedNetworks.has(NET)).toBe(false);
		expect(net.unsubscribed).toEqual([NET]);
	});

	it('a disable overtaken by an enable finishes its cleanup before the rejoin', async () => {
		net.topicPeers.set(NET, ['p-only-a']);
		const gate = deferred();
		net.disconnectGate = gate.promise;
		const { networks, events } = makeNetworks(net, db, [NET]);

		const disabling = networks.setEnabled(NET, false);
		// Enough turns for the leave to be genuinely mid-cleanup, parked on a peer disconnect,
		// when the re-enable arrives.
		for (let i = 0; i < 10; i++) await Promise.resolve();
		const enabling = networks.setEnabled(NET, true);
		gate.resolve();
		await Promise.all([disabling, enabling]);

		expect(events).toEqual([`left:${NET}`, `joined:${NET}`]);
		expect(getLISHnet(db, NET)!.enabled).toBe(true);
		expect((networks as any).joinedNetworks.has(NET)).toBe(true);
		// The peer the leave was disconnecting when the re-enable arrived is disconnected,
		// not stranded: abandoning the loop there left the tag, the peerStore record and the
		// connection installed with the successor believing the leave was already done.
		expect(net.disconnected).toContain('p-only-a');
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
		// Three toggles still cost one join. The database phases are short and run first, so
		// by the time the second and third reconciles get the lock the row already holds the
		// final value and there is nothing left for them to change — the collapse falls out
		// of converging on the row rather than out of cancelling anybody.
		expect(events).toEqual([`joined:${NET}`]);
		expect(net.unsubscribed).toEqual([]);
	});

	/**
	 * Two identical disables. The first used to bail out of its peer-disconnect loop the
	 * moment the second merely ARRIVED, and the second then found the network already
	 * unsubscribed and returned at once — so the peers of a network nobody was in kept
	 * their connections, and nothing was ever going to come back for them.
	 */
	it('a second identical disable does not strand the first one’s peer cleanup', async () => {
		net.topicPeers.set(NET, ['p-one', 'p-two', 'p-three']);
		const gate = deferred();
		net.disconnectGate = gate.promise;
		const { networks } = makeNetworks(net, db, [NET]);

		const first = networks.setEnabled(NET, false);
		for (let i = 0; i < 10; i++) await Promise.resolve();
		const second = networks.setEnabled(NET, false);
		gate.resolve();
		await Promise.all([first, second]);

		for (const pid of ['p-one', 'p-two', 'p-three']) expect(net.disconnected).toContain(pid);
		expect((networks as any).joinedNetworks.has(NET)).toBe(false);
	});

	/**
	 * The transfer-layer observers iterate downloaders and mutate them, and one that throws
	 * used to come back out as a failed RPC — with the row written, the topic subscribed and
	 * `announcedJoined` already holding the new state. Retrying found nothing left to
	 * announce, so the event never reached the client for a network that really had joined.
	 */
	it('an observer that throws does not fail the transition it was told about', async () => {
		const { networks } = makeNetworks(net, db, []);
		(networks as any)._onNetworkJoined = (): void => {
			throw new Error('downloader blew up');
		};

		const result = await networks.setEnabled(NET, true);

		expect(result).toEqual({ found: true, transitioned: true, joined: true, network: NAMED });
		expect(net.subscribed).toEqual([NET]);
		expect(getLISHnet(db, NET)!.enabled).toBe(true);
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
		expect(enabled).toEqual({ found: false, transitioned: false, joined: false });
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
 * The API turns this result into a `lishnets:joined` / `lishnets:left` broadcast, so it
 * has to say what actually happened. A bare "the network exists" made an overruled
 * request and an idempotent one both look like a settled transition, and the client was
 * told the network had joined when it had just been disabled.
 */
describe('Networks.setEnabled — what the result claims', () => {
	let db: Database;
	let net: ReturnType<typeof makeMockNet>;

	beforeEach(() => {
		db = new Database(':memory:');
		initLISHnetsTables(db);
		addLISHnet(db, { networkID: NET, name: 'A', description: '', bootstrapPeers: [BOOTSTRAP], enabled: true, created: new Date().toISOString() });
		net = makeMockNet();
	});

	it('a request whose state was already settled by then reports no transition', async () => {
		net.topicPeers.set(NET, ['p-only-a']);
		const gate = deferred();
		net.disconnectGate = gate.promise;
		const { networks } = makeNetworks(net, db, [NET]);

		const holding = networks.setEnabled(NET, false);
		for (let i = 0; i < 10; i++) await Promise.resolve();
		const older = networks.setEnabled(NET, true);
		const newer = networks.setEnabled(NET, false);
		gate.resolve();
		const [holdingResult, olderResult, newerResult] = await Promise.all([holding, older, newer]);

		// The enable in the middle is the interesting one: the disable after it wrote the row
		// before either reconcile ran, so by the enable's turn the desired state was already
		// "disabled" and it had nothing to apply. `transitioned: false` with `joined: false`
		// is what the API needs to hear — it must not broadcast a join that did not happen.
		expect(holdingResult).toEqual({ found: true, transitioned: true, joined: false, network: NAMED });
		expect(olderResult).toEqual({ found: true, transitioned: false, joined: false, network: NAMED });
		expect(newerResult).toEqual({ found: true, transitioned: false, joined: false, network: NAMED });
		expect(getLISHnet(db, NET)!.enabled).toBe(false);
	});

	it('an enable of an already-joined network reports no transition', async () => {
		const { networks } = makeNetworks(net, db, [NET]);

		expect(await networks.setEnabled(NET, true)).toEqual({ found: true, transitioned: false, joined: true, network: NAMED });
	});

	/**
	 * The API broadcasts `lishnets:joined` / `lishnets:left` from this result. It used to
	 * read the row itself before awaiting the call, which raced the catalog both ways: a
	 * network still being added read as undefined and its join was never broadcast at all,
	 * and a rename queued ahead of the enable made the event carry the previous name.
	 */
	it('names the row the enable settled, not one a queued rename has replaced', async () => {
		setLISHnetEnabled(db, NET, false);
		const { networks } = makeNetworks(net, db, []);
		const release = await (networks as any).catalogMutex.acquire();

		const renaming = networks.update({ networkID: NET, name: 'renamed', description: '', bootstrapPeers: [BOOTSTRAP], enabled: false, created: new Date().toISOString() });
		const enabling = networks.setEnabled(NET, true);
		release();
		const [, result] = await Promise.all([renaming, enabling]);

		// Whichever of the two reconciles reaches the lock first settles the join; what this
		// pins down is the name — it is the one this call's own critical section wrote, never
		// a value read before or after the await.
		expect(result.joined).toBe(true);
		expect(result.network).toEqual({ networkID: NET, name: 'renamed' });
	});

	it('names a network that only came into existence while it waited', async () => {
		const { networks } = makeNetworks(net, db, []);
		const release = await (networks as any).catalogMutex.acquire();

		const adding = networks.addIfNotExists({ networkID: 'net-new', name: 'New', description: '', bootstrapPeers: [], created: new Date().toISOString() });
		const enabling = networks.setEnabled('net-new', true);
		release();
		const [, result] = await Promise.all([adding, enabling]);

		expect(result).toEqual({ found: true, transitioned: true, joined: true, network: { networkID: 'net-new', name: 'New' } });
	});

	it('a real enable reports the transition it settled', async () => {
		setLISHnetEnabled(db, NET, false);
		const { networks } = makeNetworks(net, db, []);

		expect(await networks.setEnabled(NET, true)).toEqual({ found: true, transitioned: true, joined: true, network: NAMED });
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

	/**
	 * The user's last request has to win, whichever API it came through. Every public writer
	 * queues on the catalog mutex before it awaits anything else, and the mutex dispatches
	 * first come, first served, so the last request also writes its row last and the
	 * reconcile that follows converges on it.
	 */
	function rowOf(id: string) {
		return { networkID: id, name: 'A', description: '', bootstrapPeers: [BOOTSTRAP], enabled: false, created: new Date().toISOString() };
	}

	it('a setEnabled issued after an update wins over it', async () => {
		const gate = deferred();
		net.dialGate = gate.promise;
		const { networks } = makeNetworks(net, db, []);

		// Something holds net-a's lock, so both writers below queue behind it.
		const holdingA = networks.setEnabled(NET, true);
		await settle();
		const updating = networks.update({ ...rowOf(NET), name: 'renamed', enabled: false });
		const enabling = networks.setEnabled(NET, true);

		gate.resolve();
		await Promise.all([holdingA, updating, enabling]);

		expect(getLISHnet(db, NET)!.enabled).toBe(true);
		expect((networks as any).joinedNetworks.has(NET)).toBe(true);
		// The edit's own field change is not the newer request's to discard.
		expect(getLISHnet(db, NET)!.name).toBe('renamed');
	});

	it('an update issued after a setEnabled wins over it', async () => {
		const gate = deferred();
		net.dialGate = gate.promise;
		const { networks } = makeNetworks(net, db, []);

		const holdingA = networks.setEnabled(NET, true);
		await settle();
		const enabling = networks.setEnabled(NET, true);
		const updating = networks.update({ ...rowOf(NET), enabled: false });

		gate.resolve();
		await Promise.all([holdingA, enabling, updating]);

		expect(getLISHnet(db, NET)!.enabled).toBe(false);
		expect((networks as any).joinedNetworks.has(NET)).toBe(false);
	});

	it('a setEnabled issued after an import wins over it', async () => {
		const gate = deferred();
		net.dialGate = gate.promise;
		const { networks } = makeNetworks(net, db, []);

		const holdingA = networks.setEnabled(NET, true);
		await settle();
		const importing = networks.importFromLISHnet({ networkID: NET, name: 'A', description: '', bootstrapPeers: [BOOTSTRAP], created: new Date().toISOString() } as any, false);
		const enabling = networks.setEnabled(NET, true);

		gate.resolve();
		await Promise.all([holdingA, importing, enabling]);

		expect(getLISHnet(db, NET)!.enabled).toBe(true);
		expect((networks as any).joinedNetworks.has(NET)).toBe(true);
	});

	it('a setEnabled issued after a replace wins over it', async () => {
		const gate = deferred();
		net.dialGate = gate.promise;
		const { networks } = makeNetworks(net, db, []);

		const holdingA = networks.setEnabled(NET, true);
		await settle();
		const replacing = networks.replace([rowOf(NET)]);
		const enabling = networks.setEnabled(NET, true);

		gate.resolve();
		await Promise.all([holdingA, replacing, enabling]);

		expect(getLISHnet(db, NET)!.enabled).toBe(true);
		expect((networks as any).joinedNetworks.has(NET)).toBe(true);
	});

	it('a network dropped by replace is cleaned up terminally, like a delete', async () => {
		db = new Database(':memory:');
		initLISHnetsTables(db);
		addLISHnet(db, { networkID: NET, name: 'A', description: '', bootstrapPeers: [BOOTSTRAP], enabled: true, created: new Date().toISOString() });
		net.topicPeers.set(NET, ['p-only-a']);
		const gate = deferred();
		net.disconnectGate = gate.promise;
		const { networks } = makeNetworks(net, db, [NET]);

		const replacing = networks.replace([]);
		await settle();
		// The enable's row is already gone, so it answers "not found" and reconciles nothing.
		// If the leave it arrived during were abortable, nothing would ever finish this
		// cleanup: no row, no subscription, and the peers still connected.
		const enabling = networks.setEnabled(NET, true);
		gate.resolve();
		await Promise.all([replacing, enabling]);

		expect(getLISHnet(db, NET)).toBeUndefined();
		expect(net.disconnected).toContain('p-only-a');
	});

	/**
	 * The global catalog lock used to be held for the whole of a join, bootstrap dials and
	 * all — seconds per address, sequentially. Every unrelated lishnet's edit, add, delete
	 * and import queued behind whichever single network happened to be dialing, and so did
	 * the shutdown and the factory reset, which presented to the user as a frozen app.
	 */
	it('a slow join of one lishnet does not block writes to another', async () => {
		const gate = deferred();
		net.dialGate = gate.promise;
		const { networks } = makeNetworks(net, db, []);

		const joining = networks.setEnabled(NET, true);
		await settle();

		// net-b shares nothing with net-a — no bootstrap peers of its own, so it has no dial
		// to wait on — and neither of these may wait on net-a's.
		expect(await networks.add({ ...rowOf(NET_B), name: 'B', bootstrapPeers: [] })).toBe(true);
		expect(await networks.setEnabled(NET_B, true)).toEqual({ found: true, transitioned: true, joined: true, network: { networkID: NET_B, name: 'B' } });
		expect(getLISHnet(db, NET)!.enabled).toBe(true);

		gate.resolve();
		await joining;
	});

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
