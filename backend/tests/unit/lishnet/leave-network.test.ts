import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initLISHnetsTables, addLISHnet } from '../../../src/db/lishnets.ts';
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
	subscribeTopic(id: string): void;
	isBootstrapOrRelayPeer(pid: string): boolean;
	disconnectPeer(pid: string, networkID: string): Promise<void>;
	pruneConfiguredBootstrapPeer(pid: string): void;
	bumpBootstrapGeneration(networkID: string): void;
	generationBumps: string[];
	pruneBootstrapStatus(networkID: string, keep: string[]): void;
	prunedStatus: Array<{ networkID: string; keep: string[] }>;
	addBootstrapPeers(peers: string[], networkID: string, origin: string): Promise<void>;
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
		subscribeTopic(id) {
			this.subscribed.push(id);
		},
		isBootstrapOrRelayPeer(pid) {
			return this.bootstrapOrRelay.has(pid);
		},
		async disconnectPeer(pid) {
			this.disconnected.push(pid);
		},
		pruneConfiguredBootstrapPeer(pid) {
			this.prunedBootstrap.push(pid);
		},
		bumpBootstrapGeneration(networkID) {
			this.generationBumps.push(networkID);
		},
		pruneBootstrapStatus(networkID, keep) {
			this.prunedStatus.push({ networkID, keep });
		},
		async addBootstrapPeers(peers, networkID, origin) {
			this.dialledLists.push({ networkID, peers, origin });
		},
		clearRedialSuppressionForNetwork(networkID) {
			this.suppressionClearedFor.push(networkID);
		},
	};
}

// bootstrapPeers per network id, exposed to the class via `get`.
function makeNetworks(net: MockNet, joined: string[], configs: Record<string, string[]> = {}): Networks {
	const networks = Object.create(Networks.prototype) as Networks;
	(networks as any).network = net;
	(networks as any).joinedNetworks = new Set(joined);
	(networks as any)._onNetworkLeft = null;
	(networks as any)._onNetworkJoined = null;
	(networks as any).get = (id: string) => (configs[id] ? { networkID: id, bootstrapPeers: configs[id] } : undefined);
	return networks;
}

const leave = (networks: Networks, id: string): Promise<void> => (networks as any).leaveNetwork(id);
const join = (networks: Networks, id: string): Promise<void> => (networks as any).joinNetwork(id);

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
describe('Networks.update — a changed bootstrap list reaches the running node', () => {
	const NET = 'net-a';
	const PEER_A = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
	const PEER_B = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fp';
	const ADDR_A = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_A}`;
	const ADDR_B = `/ip4/203.0.113.10/tcp/9090/p2p/${PEER_B}`;

	function seeded(bootstrapPeers: string[]) {
		const db = new Database(':memory:');
		initLISHnetsTables(db);
		addLISHnet(db, { networkID: NET, name: 'A', description: '', bootstrapPeers, enabled: true, created: '2026-01-01T00:00:00.000Z' });
		const mock = makeMockNet();
		const networks = Object.create(Networks.prototype) as Networks;
		(networks as any).network = mock;
		(networks as any).db = db;
		(networks as any).joinedNetworks = new Set([NET]);
		return { networks, mock };
	}

	const edit = (networks: Networks, bootstrapPeers: string[]): boolean => (networks as any).update({ networkID: NET, name: 'A', description: '', bootstrapPeers, enabled: true, created: '2026-01-01T00:00:00.000Z' });

	it('prunes the status and dials the new list when the entries change', () => {
		const { networks, mock } = seeded([ADDR_A]);
		edit(networks, [ADDR_B]);
		expect(mock.prunedStatus).toEqual([{ networkID: NET, keep: [ADDR_B] }]);
		expect(mock.dialledLists).toEqual([{ networkID: NET, peers: [ADDR_B], origin: 'configured' }]);
	});

	it('drops the bootstrap exemption of a peer removed through the form', () => {
		const { networks, mock } = seeded([ADDR_A, ADDR_B]);
		edit(networks, [ADDR_A]);
		expect(mock.prunedBootstrap).toEqual([PEER_B]);
	});

	it('leaves the running node alone when only the name changed', () => {
		const { networks, mock } = seeded([ADDR_A]);
		edit(networks, [ADDR_A]);
		expect(mock.prunedStatus).toEqual([]);
		expect(mock.dialledLists).toEqual([]);
		expect(mock.prunedBootstrap).toEqual([]);
	});

	it('does not dial for a network that is not joined', () => {
		const { networks, mock } = seeded([ADDR_A]);
		(networks as any).joinedNetworks = new Set<string>();
		edit(networks, [ADDR_B]);
		expect(mock.dialledLists).toEqual([]);
		expect(mock.prunedStatus).toHaveLength(1);
	});
});
