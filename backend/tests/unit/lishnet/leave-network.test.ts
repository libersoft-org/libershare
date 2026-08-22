import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Mutex } from 'async-mutex';
import { initLISHnetsTables, addLISHnet, getLISHnet } from '../../../src/db/lishnets.ts';
import { Networks } from '../../../src/lishnet/lishnets.ts';

/**
 * Unit tests for Networks.leaveNetwork peer-disconnect behaviour:
 * on leaving a lishnet, peers that belonged exclusively to it are hung up,
 * while peers shared with another joined lishnet and bootstrap/relay peers
 * stay connected. Uses a bare instance (Object.create) so no real libp2p
 * node or database is needed.
 */

interface MockNet {
	topicPeers: Map<string, string[]>;
	recentMembers: Map<string, string[]>;
	unsubscribed: string[];
	subscribed: string[];
	disconnected: string[];
	bootstrapOrRelay: Set<string>;
	prunedBootstrap: string[];
	getTopicPeers(id: string): string[];
	getRecentTopicMembers(id: string): string[];
	unsubscribeTopic(id: string): void;
	isRunning(): boolean;
	subscribeTopic(id: string): boolean;
	isBootstrapOrRelayPeer(pid: string): boolean;
	disconnectPeer(pid: string, networkID: string, epoch?: number): Promise<void>;
	/** Epoch each disconnect was bound to, in call order. */
	disconnectEpochs: Array<number | undefined>;
	/** Set to hold the next peer disconnect open. */
	disconnectGate: Promise<void> | null;
	runEpoch: number;
	getRunEpoch(): number;
	pruneConfiguredBootstrapPeer(pid: string): void;
	bumpBootstrapGeneration(networkID: string): void;
	generationBumps: string[];
	pruneBootstrapAddresses(addresses: string[], networkID: string): void;
	prunedAddresses: string[][];
	/** Address releases with the owning network that is giving them up. */
	addressReleases: Array<{ addresses: string[]; networkID: string }>;
	reconcilePeerAfterBootstrapRemoval(pid: string, addresses: string[], networkID: string): Promise<void>;
	/** Peer reconciliations requested after a config change, in call order. */
	reconciled: Array<{ pid: string; addresses: string[]; networkID: string }>;
	pruneBootstrapStatus(networkID: string, keep: string[]): void;
	prunedStatus: Array<{ networkID: string; keep: string[] }>;
	addBootstrapPeers(peers: string[], networkID: string, origin: string): Promise<'completed' | 'incomplete'>;
	dialledLists: Array<{ networkID: string; peers: string[]; origin: string }>;
	clearRedialSuppressionForNetwork(networkID: string): void;
	suppressionClearedFor: string[];
}

function makeMockNet(): MockNet {
	return {
		topicPeers: new Map(),
		recentMembers: new Map(),
		unsubscribed: [],
		subscribed: [],
		disconnected: [],
		bootstrapOrRelay: new Set(),
		prunedBootstrap: [],
		suppressionClearedFor: [],
		generationBumps: [],
		statusResets: [],
		prunedAddresses: [],
		addressReleases: [],
		reconciled: [],
		prunedStatus: [],
		dialledLists: [],
		getTopicPeers(id) {
			return this.topicPeers.get(id) ?? [];
		},
		getRecentTopicMembers(id) {
			return this.recentMembers.get(id) ?? [];
		},
		unsubscribeTopic(id) {
			this.unsubscribed.push(id);
			// Mirror real pubsub: after unsubscribe the topic reports no peers.
			this.topicPeers.delete(id);
		},
		isRunning() {
			return true;
		},
		subscribeTopic(id) {
			this.subscribed.push(id);
			return true;
		},
		isBootstrapOrRelayPeer(pid) {
			return this.bootstrapOrRelay.has(pid);
		},
		disconnectEpochs: [],
		disconnectGate: null,
		runEpoch: 1,
		getRunEpoch() {
			return this.runEpoch;
		},
		async disconnectPeer(pid, _networkID, epoch) {
			if (this.disconnectGate) await this.disconnectGate;
			this.disconnected.push(pid);
			this.disconnectEpochs.push(epoch);
		},
		pruneConfiguredBootstrapPeer(pid) {
			this.prunedBootstrap.push(pid);
		},
		bumpBootstrapGeneration(networkID) {
			this.generationBumps.push(networkID);
		},
		pruneBootstrapAddresses(addresses, networkID) {
			this.prunedAddresses.push(addresses);
			this.addressReleases.push({ addresses, networkID });
		},
		async reconcilePeerAfterBootstrapRemoval(pid, addresses, networkID) {
			this.reconciled.push({ pid, addresses, networkID });
		},
		pruneBootstrapStatus(networkID, keep) {
			this.prunedStatus.push({ networkID, keep });
		},
		async addBootstrapPeers(peers, networkID, origin) {
			this.dialledLists.push({ networkID, peers, origin });
			return 'completed' as const;
		},
		clearRedialSuppressionForNetwork(networkID) {
			this.suppressionClearedFor.push(networkID);
		},
	};
}

// bootstrapPeers per network id, exposed to the class via `get`. The rows stand in for the
// database: reconcileLocked converges on what `get` says, so a transition edits the row.
function makeNetworks(net: MockNet, joined: string[], configs: Record<string, string[]> = {}): Networks {
	const networks = Object.create(Networks.prototype) as Networks;
	const rows = new Map<string, { networkID: string; bootstrapPeers: string[]; enabled: boolean }>();
	for (const id of new Set([...joined, ...Object.keys(configs)])) rows.set(id, { networkID: id, bootstrapPeers: configs[id] ?? [], enabled: joined.includes(id) });
	(networks as any).network = net;
	(networks as any).rows = rows;
	(networks as any).joinedNetworks = new Set(joined);
	(networks as any).networkOperations = new Map();
	(networks as any).catalogMutex = new Mutex();
	(networks as any).activeReconciles = new Set();
	// Same seeding startEnabledNetworks does: already-joined at construction time.
	(networks as any).announcedJoined = new Map(joined.map(id => [id, true]));
	// The list each joined network installed when it was joined.
	(networks as any).appliedBootstrap = new Map(joined.map(id => [id, { addresses: configs[id] ?? [], complete: true }]));
	(networks as any)._onNetworkLeft = null;
	(networks as any)._onNetworkJoined = null;
	(networks as any).get = (id: string) => rows.get(id);
	return networks;
}

// Both go through reconcileLocked(), which is where the join/leave notifications live.
// Same shape the real writers use: write the row, then converge the runtime on it.
function transition(networks: Networks, id: string, enabled: boolean): Promise<void> {
	const n = networks as any;
	const row = n.rows.get(id);
	const previous = row ? { ...row } : undefined;
	if (row) row.enabled = enabled;
	else n.rows.set(id, { networkID: id, bootstrapPeers: [], enabled });
	return n.operationLock(id).runExclusive(() => n.reconcileLocked(id, previous));
}
const leave = (networks: Networks, id: string): Promise<void> => transition(networks, id, false);
const join = (networks: Networks, id: string): Promise<void> => transition(networks, id, true);

describe('Networks.leaveNetwork — exclusive peer disconnect', () => {
	let net: MockNet;

	beforeEach(() => {
		net = makeMockNet();
	});

	it('disconnects peers that were only in the left lishnet, keeps shared ones', async () => {
		net.topicPeers.set('net-a', ['p-only-a', 'p-shared']);
		net.topicPeers.set('net-b', ['p-shared']);
		const networks = makeNetworks(net, ['net-a', 'net-b']);
		await leave(networks, 'net-a');
		expect(net.disconnected).toEqual(['p-only-a']);
	});

	/**
	 * `disconnectPeer` defaults its epoch per call, so a leave parked inside one peer's
	 * hangUp picked up the CURRENT run for the next peer — surviving a stop and a start and
	 * then tearing peers off a node instance that had never heard of this lishnet.
	 */
	it('binds every peer of one leave to the run it started on', async () => {
		net.topicPeers.set('net-a', ['p-one', 'p-two']);
		const networks = makeNetworks(net, ['net-a']);
		let release!: () => void;
		net.disconnectGate = new Promise<void>(res => {
			release = res;
		});

		const leaving = leave(networks, 'net-a');
		for (let i = 0; i < 10; i++) await Promise.resolve();
		// The node is stopped and started again while the first peer is being hung up.
		net.runEpoch = 2;
		release();
		await leaving;

		expect(net.disconnectEpochs).toEqual([1, 1]);
	});

	/**
	 * The leave promises to run to completion once it has started, but both of its peer loops
	 * reach the next peer only by returning from the disconnect. Nothing on this side enforced
	 * that: one rejection would abandon every remaining peer with the topic already
	 * unsubscribed and no successor left to finish the cleanup.
	 */
	it('finishes the remaining peers when one teardown fails', async () => {
		net.topicPeers.set('net-a', ['p-first', 'p-second']);
		const networks = makeNetworks(net, ['net-a']);
		const disconnect = net.disconnectPeer.bind(net);
		net.disconnectPeer = async (pid: string, networkID: string, epoch?: number): Promise<void> => {
			if (pid === 'p-first') throw new Error('peerStore delete failed');
			await disconnect(pid, networkID, epoch);
		};

		await leave(networks, 'net-a');

		expect(net.disconnected).toEqual(['p-second']);
		expect(net.unsubscribed).toEqual(['net-a']);
	});

	it('disconnects a recently-seen content peer offline at leave time', async () => {
		// Not a live subscriber right now, but seen within TTL and still in the peerStore —
		// must be suppressed too, or maintenance would redial it after the leave.
		net.topicPeers.set('net-a', ['p-live']);
		net.recentMembers.set('net-a', ['p-live', 'p-offline']);
		const networks = makeNetworks(net, ['net-a']);
		await leave(networks, 'net-a');
		expect(net.disconnected.sort()).toEqual(['p-live', 'p-offline']);
	});

	it('keeps a momentarily offline peer that also belongs to a still-joined lishnet', async () => {
		// The left network is measured with the TTL widening (live subscribers plus
		// recently-seen members), so the still-joined networks must be measured the
		// same way. Comparing a widened set against a live-only one made a peer that
		// belongs to BOTH look exclusive to the one we left, purely because it was
		// disconnected at that moment — and it was hung up and redial-suppressed
		// despite our still sharing a lishnet with it.
		net.recentMembers.set('net-a', ['p-shared-offline']);
		net.recentMembers.set('net-b', ['p-shared-offline']);
		const networks = makeNetworks(net, ['net-a', 'net-b']);
		await leave(networks, 'net-a');
		expect(net.disconnected).toEqual([]);
	});

	it('still disconnects a recently-seen peer that belongs only to the left lishnet', async () => {
		// The widening must not make the leave path toothless: a peer seen only in
		// the network we left is still hung up.
		net.recentMembers.set('net-a', ['p-only-a']);
		net.recentMembers.set('net-b', ['p-other']);
		const networks = makeNetworks(net, ['net-a', 'net-b']);
		await leave(networks, 'net-a');
		expect(net.disconnected).toEqual(['p-only-a']);
	});

	it('keeps bootstrap/relay peers even when exclusive to the left lishnet', async () => {
		net.topicPeers.set('net-a', ['p-bootstrap', 'p-plain']);
		net.bootstrapOrRelay.add('p-bootstrap');
		const networks = makeNetworks(net, ['net-a']);
		await leave(networks, 'net-a');
		expect(net.disconnected).toEqual(['p-plain']);
	});

	it('snapshots topic peers before unsubscribing', async () => {
		net.topicPeers.set('net-a', ['p1', 'p2']);
		const networks = makeNetworks(net, ['net-a']);
		await leave(networks, 'net-a');
		// The mock wipes the topic on unsubscribe — a post-unsubscribe read would
		// have seen [] and disconnected nobody.
		expect(net.unsubscribed).toEqual(['net-a']);
		expect(net.disconnected).toEqual(['p1', 'p2']);
	});

	it('is a no-op for a lishnet that is not joined', async () => {
		net.topicPeers.set('net-a', ['p1']);
		const networks = makeNetworks(net, []);
		let leftFired = 0;
		networks.onNetworkLeft = () => leftFired++;
		await leave(networks, 'net-a');
		expect(net.unsubscribed).toEqual([]);
		expect(net.disconnected).toEqual([]);
		expect(leftFired).toBe(0);
	});

	it('fires onNetworkLeft with the left lishnet id and un-joins it', async () => {
		net.topicPeers.set('net-a', []);
		const networks = makeNetworks(net, ['net-a']);
		const leftIDs: string[] = [];
		networks.onNetworkLeft = id => leftIDs.push(id);
		await leave(networks, 'net-a');
		expect(leftIDs).toEqual(['net-a']);
		expect((networks as any).joinedNetworks.has('net-a')).toBe(false);
	});

	it('prunes bootstrap exemption for peers configured only for the left lishnet', async () => {
		net.topicPeers.set('net-a', []);
		const networks = makeNetworks(net, ['net-a', 'net-b'], {
			'net-a': ['/ip4/192.0.2.1/tcp/9090/p2p/pOnlyA', '/ip4/192.0.2.2/tcp/9090/p2p/pShared'],
			'net-b': ['/ip4/192.0.2.3/tcp/9090/p2p/pShared'],
		});
		await leave(networks, 'net-a');
		// pOnlyA is bootstrap only for the left network → exemption pruned.
		// pShared is still bootstrap for the joined net-b → exemption kept.
		expect(net.prunedBootstrap).toEqual(['pOnlyA']);
	});

	it('prunes the final /p2p target id for a relayed bootstrap multiaddr, not the relay', async () => {
		net.topicPeers.set('net-a', []);
		const networks = makeNetworks(net, ['net-a'], {
			// Relayed entry: /p2p/<relay>/p2p-circuit/p2p/<target>. The bootstrap
			// identity is the target (final /p2p), never the relay.
			'net-a': ['/ip4/192.0.2.10/tcp/9090/p2p/pRelay/p2p-circuit/p2p/pTarget'],
		});
		await leave(networks, 'net-a');
		expect(net.prunedBootstrap).toEqual(['pTarget']);
	});

	it('disconnects an offline configured bootstrap peer of the left lishnet', async () => {
		// pBootA is configured bootstrap for net-a only and is NOT a current topic
		// subscriber (offline at leave time). It must still be disconnected so its
		// keep-alive tag is stripped and redial maintenance cannot reconnect it.
		net.topicPeers.set('net-a', []);
		const networks = makeNetworks(net, ['net-a'], {
			'net-a': ['/ip4/192.0.2.5/tcp/9090/p2p/pBootA'],
		});
		await leave(networks, 'net-a');
		expect(net.disconnected).toEqual(['pBootA']);
		expect(net.prunedBootstrap).toEqual(['pBootA']);
	});

	it('keeps an offline bootstrap peer still configured for another joined lishnet', async () => {
		net.topicPeers.set('net-a', []);
		const networks = makeNetworks(net, ['net-a', 'net-b'], {
			'net-a': ['/ip4/192.0.2.5/tcp/9090/p2p/pShared'],
			'net-b': ['/ip4/192.0.2.6/tcp/9090/p2p/pShared'],
		});
		await leave(networks, 'net-a');
		expect(net.disconnected).toEqual([]);
		expect(net.prunedBootstrap).toEqual([]);
	});

	it('keeps a left-lishnet bootstrap peer that still subscribes another joined lishnet', async () => {
		net.topicPeers.set('net-a', []);
		net.topicPeers.set('net-b', ['pBootA']); // pBootA is a live subscriber of net-b
		const networks = makeNetworks(net, ['net-a', 'net-b'], {
			'net-a': ['/ip4/192.0.2.5/tcp/9090/p2p/pBootA'],
		});
		await leave(networks, 'net-a');
		expect(net.disconnected).toEqual([]); // kept — subscriber of joined net-b
		expect(net.prunedBootstrap).toEqual(['pBootA']); // exemption still pruned
	});

	/**
	 * Cleanup keyed on the identity alone cannot express "this peer is configured in both
	 * networks, under two different addresses". The identity is in use elsewhere, so the
	 * whole cleanup is skipped and the left network's own address goes on counting as a
	 * configured bootstrap — dialed by the parked probe and exempt from removal.
	 */
	it('drops the left network address of a peer configured elsewhere under another address', async () => {
		net.topicPeers.set('net-a', []);
		const networks = makeNetworks(net, ['net-a', 'net-b'], {
			'net-a': ['/ip4/192.0.2.1/tcp/9090/p2p/pShared'],
			'net-b': ['/ip4/192.0.2.2/tcp/9090/p2p/pShared'],
		});
		await leave(networks, 'net-a');
		expect(net.prunedAddresses).toEqual([['/ip4/192.0.2.1/tcp/9090/p2p/pShared']]);
		expect(net.prunedBootstrap).toEqual([]); // the identity itself is still configured
	});

	it('keeps an address the still-joined network configures identically', async () => {
		net.topicPeers.set('net-a', []);
		const networks = makeNetworks(net, ['net-a', 'net-b'], {
			'net-a': ['/ip4/192.0.2.1/tcp/9090/p2p/pShared'],
			'net-b': ['/ip4/192.0.2.1/tcp/9090/p2p/pShared'],
		});
		await leave(networks, 'net-a');
		expect(net.prunedAddresses).toEqual([[]]);
	});

	it('drops every address of a network left with nothing else configured', async () => {
		net.topicPeers.set('net-a', []);
		const networks = makeNetworks(net, ['net-a'], {
			'net-a': ['/ip4/192.0.2.1/tcp/9090/p2p/pOnlyA', '/ip4/192.0.2.2/tcp/9090/p2p/pAlsoA'],
		});
		await leave(networks, 'net-a');
		expect(net.prunedAddresses).toEqual([['/ip4/192.0.2.1/tcp/9090/p2p/pOnlyA', '/ip4/192.0.2.2/tcp/9090/p2p/pAlsoA']]);
	});

	/**
	 * The rows describe a membership that has ended. Kept, a later rejoin opens on the
	 * previous session's connected/error/discovered results until fresh dials happen to
	 * overwrite each one.
	 */
	it('drops the bootstrap status of the network it left', async () => {
		net.topicPeers.set('net-a', []);
		const networks = makeNetworks(net, ['net-a'], { 'net-a': ['/ip4/192.0.2.1/tcp/9090/p2p/pOnlyA'] });
		await leave(networks, 'net-a');
		expect(net.statusResets).toEqual(['net-a']);
	});

	it('keeps a left-lishnet bootstrap peer that is still an active circuit relay', async () => {
		net.topicPeers.set('net-a', []);
		net.bootstrapOrRelay.add('pRelayNode'); // still relaying another connection
		const networks = makeNetworks(net, ['net-a'], {
			'net-a': ['/ip4/192.0.2.7/tcp/9090/p2p/pRelayNode'],
		});
		await leave(networks, 'net-a');
		expect(net.disconnected).toEqual([]);
		// Exemption is still pruned — the relay status alone keeps it connected.
		expect(net.prunedBootstrap).toEqual(['pRelayNode']);
	});
});

/**
 * Address ownership is per (address, network); the identity-level cleanup is per peer.
 * Deciding the whole cleanup by peer ID skipped the address release whenever the same
 * IDENTITY was configured somewhere else, so the left network's own claim survived —
 * pinning the address against expiry and keeping the parked probe force-dialing it.
 */
describe('Networks.leaveNetwork — configured address release', () => {
	let net: MockNet;

	beforeEach(() => {
		net = makeMockNet();
	});

	it('releases the left network claim on an address a second network also lists', async () => {
		// Case (a): both networks list the SAME address of the same peer. The
		// identity-level loop sees "still configured elsewhere" and skips, so nothing
		// ever released net-a's claim and the address stayed pinned by it forever.
		const shared = '/ip4/192.0.2.5/tcp/9090/p2p/pShared';
		const networks = makeNetworks(net, ['net-a', 'net-b'], { 'net-a': [shared], 'net-b': [shared] });
		await leave(networks, 'net-a');
		expect(net.addressReleases).toContainEqual({ addresses: [shared], networkID: 'net-a' });
	});

	it('releases the left network address when the peer is listed elsewhere under another one', async () => {
		// Case (b): same peer ID, different addresses. net-a's address was never
		// released, so recovery and the parked probe went on dialing it.
		const onlyA = '/ip4/192.0.2.5/tcp/9090/p2p/pShared';
		const networks = makeNetworks(net, ['net-a', 'net-b'], { 'net-a': [onlyA], 'net-b': ['/ip4/192.0.2.6/tcp/9090/p2p/pShared'] });
		await leave(networks, 'net-a');
		expect(net.addressReleases).toContainEqual({ addresses: [onlyA], networkID: 'net-a' });
	});

	it('names the leaving network as the owner giving the claim up', async () => {
		// Releasing under the wrong network id would drop somebody else's claim.
		const address = '/ip4/192.0.2.5/tcp/9090/p2p/pBootA';
		const networks = makeNetworks(net, ['net-a'], { 'net-a': [address] });
		await leave(networks, 'net-a');
		expect(net.addressReleases.every(r => r.networkID === 'net-a')).toBe(true);
	});
});

describe('Networks.joinNetwork — onNetworkJoined notification', () => {
	let net: MockNet;

	beforeEach(() => {
		net = makeMockNet();
	});

	it('fires onNetworkJoined with the joined lishnet id and joins it', async () => {
		const networks = makeNetworks(net, []);
		const joinedIDs: string[] = [];
		networks.onNetworkJoined = id => joinedIDs.push(id);
		await join(networks, 'net-a');
		expect(net.subscribed).toEqual(['net-a']);
		expect(joinedIDs).toEqual(['net-a']);
		expect((networks as any).joinedNetworks.has('net-a')).toBe(true);
	});

	it('does not fire onNetworkJoined for a lishnet already joined', async () => {
		const networks = makeNetworks(net, ['net-a']);
		let fired = 0;
		networks.onNetworkJoined = () => fired++;
		await join(networks, 'net-a');
		expect(fired).toBe(0);
		expect(net.subscribed).toEqual([]);
	});

	it('lifts redial suppression for the joined lishnet so its left peers can reconnect', async () => {
		const networks = makeNetworks(net, []);
		await join(networks, 'net-a');
		expect(net.suppressionClearedFor).toEqual(['net-a']);
	});
});

/**
 * The bootstrap list can be edited from two screens: the participants view, which
 * calls updateBootstrapPeers, and the ordinary "edit network" form, which calls
 * update. Only the first used to reach the running node, so a list changed through
 * the form was written to the database and then ignored until restart — the node
 * kept dialing the peers the user had just removed.
 */
describe('Networks.update — a changed bootstrap list reaches the running node', async () => {
	const NET = 'net-a';
	const PEER_A = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
	const PEER_B = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fp';
	const ADDR_A = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_A}`;
	const ADDR_B = `/ip4/203.0.113.10/tcp/9090/p2p/${PEER_B}`;

	function seeded(bootstrapPeers: string[], enabled = true) {
		const db = new Database(':memory:');
		initLISHnetsTables(db);
		addLISHnet(db, { networkID: NET, name: 'A', description: '', bootstrapPeers, enabled, created: '2026-01-01T00:00:00.000Z' });
		const mock = makeMockNet();
		const networks = Object.create(Networks.prototype) as Networks;
		(networks as any).network = mock;
		(networks as any).db = db;
		(networks as any).joinedNetworks = new Set(enabled ? [NET] : []);
		(networks as any).networkOperations = new Map();
		(networks as any).catalogMutex = new Mutex();
		(networks as any).activeReconciles = new Set();
		(networks as any).announcedJoined = new Map(enabled ? [[NET, true]] : []);
		// What a startup join would have installed for an already-joined network.
		(networks as any).appliedBootstrap = new Map(enabled ? [[NET, { addresses: bootstrapPeers, complete: true }]] : []);
		return { networks, mock, db };
	}

	const edit = async (networks: Networks, bootstrapPeers: string[]): Promise<boolean> => (networks as any).update({ networkID: NET, name: 'A', description: '', bootstrapPeers, enabled: true, created: '2026-01-01T00:00:00.000Z' });

	it('prunes the status and dials the new list when the entries change', async () => {
		const { networks, mock } = seeded([ADDR_A]);
		await edit(networks, [ADDR_B]);
		expect(mock.prunedStatus).toEqual([{ networkID: NET, keep: [ADDR_B] }]);
		expect(mock.dialledLists).toEqual([{ networkID: NET, peers: [ADDR_B], origin: 'configured' }]);
	});

	it('drops the bootstrap exemption of a peer removed through the form', async () => {
		const { networks, mock } = seeded([ADDR_A, ADDR_B]);
		await edit(networks, [ADDR_A]);
		expect(mock.prunedBootstrap).toEqual([PEER_B]);
	});

	it('leaves the running node alone when only the name changed', async () => {
		const { networks, mock } = seeded([ADDR_A]);
		await edit(networks, [ADDR_A]);
		expect(mock.prunedStatus).toEqual([]);
		expect(mock.dialledLists).toEqual([]);
		expect(mock.prunedBootstrap).toEqual([]);
	});

	/**
	 * The form can submit blank rows. Persisting them raw while the runtime worked from
	 * the filtered copy left the database and the live node disagreeing about what the
	 * network's bootstrap list actually is.
	 */
	it('persists the cleaned list, not the blank rows the form submitted', async () => {
		const { networks, db } = seeded([ADDR_A]);
		await edit(networks, ['', ADDR_B, '   ']);
		expect(getLISHnet(db, NET)?.bootstrapPeers).toEqual([ADDR_B]);
	});

	/**
	 * Editing only the host or port keeps the peer ID, so the identity-level prune sees
	 * nothing to do. Without an address-level prune the replaced address stays on the
	 * autodial list and recovery keeps dialing it.
	 */
	it('drops the replaced address when only the host changed', async () => {
		const moved = `/ip4/203.0.113.99/tcp/9090/p2p/${PEER_A}`;
		const { networks, mock } = seeded([ADDR_A]);
		await edit(networks, [moved]);
		expect(mock.prunedAddresses).toEqual([[ADDR_A]]);
		expect(mock.prunedBootstrap).toEqual([]);
	});

	/**
	 * Releasing a claim is not a delete. Another joined network listing the same address
	 * holds its own claim and keeps the entry alive, so there is no reason to skip this
	 * network's release — skipping it left a claim nothing could ever drop.
	 */
	it('releases this network claim on an address another network also configures', async () => {
		const { networks, mock } = seeded([ADDR_A]);
		(networks as any).get = (nid: string) => (nid === 'net-other' ? { networkID: nid, bootstrapPeers: [ADDR_A] } : { networkID: NET, bootstrapPeers: [ADDR_A] });
		(networks as any).joinedNetworks = new Set([NET, 'net-other']);
		await edit(networks, [ADDR_B]);
		expect(mock.prunedAddresses).toEqual([[ADDR_A]]);
	});

	/**
	 * The autodial prune compares addresses canonically, so the "did this entry leave
	 * the list" check has to as well — otherwise one spelling of an address counts as a
	 * removal here and as the same entry there.
	 */
	it('treats two spellings of one address as the same entry', async () => {
		const upper = `/dns4/BOOTSTRAP.EXAMPLE.ORG./tcp/9090/p2p/${PEER_A}`;
		const lower = `/dns4/bootstrap.example.org/tcp/9090/p2p/${PEER_A}`;
		const { networks, mock } = seeded([upper]);
		await edit(networks, [lower]);
		expect(mock.prunedAddresses).toEqual([[]]);
	});

	/**
	 * Releasing the registry claim is not enough: the address stays in the peerStore
	 * with its keep-alive tags, and redial maintenance takes its candidates FROM the
	 * peerStore — so the deleted bootstrap came back on the next tick.
	 */
	it('reconciles the peer of every address that left the list', async () => {
		const { networks, mock } = seeded([ADDR_A, ADDR_B]);
		await edit(networks, [ADDR_A]);
		expect(mock.reconciled).toEqual([{ pid: PEER_B, addresses: [ADDR_B], networkID: NET }]);
	});

	it('reconciles only the replaced address when the peer ID stayed', async () => {
		const moved = `/ip4/203.0.113.99/tcp/9090/p2p/${PEER_A}`;
		const { networks, mock } = seeded([ADDR_A]);
		await edit(networks, [moved]);
		expect(mock.reconciled).toEqual([{ pid: PEER_A, addresses: [ADDR_A], networkID: NET }]);
	});

	/**
	 * Order matters: the teardown suppresses re-dials, so running it after the new list
	 * was dialed would tear down the connection that dial had just established.
	 */
	it('reconciles before dialing the new list', async () => {
		const order: string[] = [];
		const { networks, mock } = seeded([ADDR_A]);
		mock.reconcilePeerAfterBootstrapRemoval = async (): Promise<void> => void order.push('reconcile');
		mock.addBootstrapPeers = async (): Promise<void> => void order.push('dial');
		await edit(networks, [ADDR_B]);
		expect(order).toEqual(['reconcile', 'dial']);
	});

	it('does not dial for a network that is not joined', async () => {
		const { networks, mock } = seeded([ADDR_A]);
		(networks as any).joinedNetworks = new Set<string>();
		await edit(networks, [ADDR_B]);
		expect(mock.dialledLists).toEqual([]);
		expect(mock.prunedStatus).toEqual([]);
		expect(mock.prunedBootstrap).toEqual([]);
		expect(mock.prunedAddresses).toEqual([]);
	});

	/**
	 * The edit form carries the enabled flag too, so it can turn a network on or off —
	 * and that has to reach the node, not just the database row.
	 */
	it('joins a network the edit enabled', async () => {
		const { networks, mock } = seeded([ADDR_A], false);
		await edit(networks, [ADDR_A], true);
		expect(mock.subscribed).toEqual([NET]);
		expect(mock.dialledLists).toEqual([{ networkID: NET, peers: [ADDR_A], origin: 'configured' }]);
	});

	it('leaves a network the edit disabled', async () => {
		const { networks, mock } = seeded([ADDR_A], true);
		await edit(networks, [ADDR_A], false);
		expect(mock.unsubscribed).toEqual([NET]);
	});
});

/**
 * The disable path writes the row first and reconciles the runtime afterwards, so the
 * leave cannot ask the database what it is leaving — by then the row holds the INCOMING
 * list, or has been deleted outright. It used to do exactly that, which meant the old
 * addresses and identities kept their bootstrap exemption on the live node: still
 * force-dialled, still exempt from the stale sweep, still reconnectable after removal.
 */
describe('Networks — leaving cleans the configuration it is leaving, not the new one', () => {
	const NET = 'net-a';
	const PEER_A = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
	const PEER_B = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fp';
	const ADDR_A = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_A}`;
	const ADDR_B = `/ip4/203.0.113.10/tcp/9090/p2p/${PEER_B}`;
	const ROW = (bootstrapPeers: string[], enabled: boolean) => ({ networkID: NET, name: 'A', description: '', bootstrapPeers, enabled, created: '2026-01-01T00:00:00.000Z' });

	/** A joined network with `bootstrapPeers`, over a real in-memory row. */
	function joined(bootstrapPeers: string[]) {
		const db = new Database(':memory:');
		initLISHnetsTables(db);
		addLISHnet(db, ROW(bootstrapPeers, true));
		const mock = makeMockNet();
		const networks = Object.create(Networks.prototype) as Networks;
		(networks as any).network = mock;
		(networks as any).db = db;
		(networks as any).joinedNetworks = new Set([NET]);
		(networks as any).networkOperations = new Map();
		(networks as any).catalogMutex = new Mutex();
		(networks as any).activeReconciles = new Set();
		(networks as any).announcedJoined = new Map([[NET, true]]);
		// What a startup join would have installed for an already-joined network.
		(networks as any).appliedBootstrap = new Map([[NET, { addresses: bootstrapPeers, complete: true }]]);
		return { networks, mock, db };
	}

	/**
	 * The cleanup used to be computed from the row as it stood before one particular write,
	 * so a convergence that failed took its baseline away with it: the next writer's
	 * `previous` was the row the FAILED one had written, and the list actually installed on
	 * the node was never mentioned again by any delta. Converging from what the membership
	 * really installed makes the repair the next write's job automatically.
	 */
	it('still cleans up the installed list after a failed convergence', async () => {
		const MID = `/ip4/203.0.113.50/tcp/9090/p2p/${PEER_B}`;
		const { networks, mock } = joined([ADDR_A]);
		mock.pruneBootstrapStatus = (): never => {
			throw new Error('status prune blew up');
		};

		await expect((networks as any).update(ROW([MID], true))).rejects.toThrow('status prune blew up');
		mock.pruneBootstrapStatus = (networkID, keep): void => {
			mock.prunedStatus.push({ networkID, keep });
		};
		mock.prunedAddresses.length = 0;
		await (networks as any).update(ROW([ADDR_B], true));

		// ADDR_A is what the node was actually dialing. A baseline of MID — a list that never
		// reached the runtime — would have pruned nothing and left it installed for good.
		expect(mock.prunedAddresses.flat()).toContain(ADDR_A);
	});

	it('an edit that swaps the list and disables at once still prunes the old address', async () => {
		const { networks, mock } = joined([ADDR_A]);
		await (networks as any).update(ROW([ADDR_B], false));
		expect(mock.unsubscribed).toEqual([NET]);
		// Re-reading the row gave [ADDR_B] here, so ADDR_A was never pruned and PEER_A
		// kept its exemption while PEER_B — a peer we never joined with — lost its own.
		expect(mock.prunedAddresses.flat()).toEqual([ADDR_A]);
		expect(mock.prunedBootstrap).toEqual([PEER_A]);
	});

	it('a replace() that removes a joined network prunes its bootstraps', async () => {
		const { networks, mock } = joined([ADDR_A]);
		await networks.replace([]);
		expect(mock.unsubscribed).toEqual([NET]);
		// The row is gone by the time the leave runs, so a re-read yielded nothing at all.
		expect(mock.prunedAddresses.flat()).toEqual([ADDR_A]);
		expect(mock.prunedBootstrap).toEqual([PEER_A]);
	});

	it('a replace() that changes the list and disables at once prunes the old address', async () => {
		const { networks, mock } = joined([ADDR_A]);
		await networks.replace([ROW([ADDR_B], false)]);
		expect(mock.unsubscribed).toEqual([NET]);
		expect(mock.prunedAddresses.flat()).toEqual([ADDR_A]);
		expect(mock.prunedBootstrap).toEqual([PEER_A]);
	});
});
