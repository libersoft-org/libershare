import { describe, it, expect, beforeEach } from 'bun:test';
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
	unsubscribed: string[];
	disconnected: string[];
	bootstrapOrRelay: Set<string>;
	prunedBootstrap: string[];
	getTopicPeers(id: string): string[];
	unsubscribeTopic(id: string): void;
	isBootstrapOrRelayPeer(pid: string): boolean;
	disconnectPeer(pid: string): Promise<void>;
	pruneConfiguredBootstrapPeer(pid: string): void;
}

function makeMockNet(): MockNet {
	return {
		topicPeers: new Map(),
		unsubscribed: [],
		disconnected: [],
		bootstrapOrRelay: new Set(),
		prunedBootstrap: [],
		getTopicPeers(id) {
			return this.topicPeers.get(id) ?? [];
		},
		unsubscribeTopic(id) {
			this.unsubscribed.push(id);
			// Mirror real pubsub: after unsubscribe the topic reports no peers.
			this.topicPeers.delete(id);
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
	};
}

// bootstrapPeers per network id, exposed to the class via `get`.
function makeNetworks(net: MockNet, joined: string[], configs: Record<string, string[]> = {}): Networks {
	const networks = Object.create(Networks.prototype) as Networks;
	(networks as any).network = net;
	(networks as any).joinedNetworks = new Set(joined);
	(networks as any)._onNetworkLeft = null;
	(networks as any).get = (id: string) => (configs[id] ? { networkID: id, bootstrapPeers: configs[id] } : undefined);
	return networks;
}

const leave = (networks: Networks, id: string): Promise<void> => (networks as any).leaveNetwork(id);

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
});
