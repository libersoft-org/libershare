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
	getTopicPeers(id: string): string[];
	unsubscribeTopic(id: string): void;
	isBootstrapOrRelayPeer(pid: string): boolean;
	disconnectPeer(pid: string): Promise<void>;
}

function makeMockNet(): MockNet {
	return {
		topicPeers: new Map(),
		unsubscribed: [],
		disconnected: [],
		bootstrapOrRelay: new Set(),
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
	};
}

function makeNetworks(net: MockNet, joined: string[]): Networks {
	const networks = Object.create(Networks.prototype) as Networks;
	(networks as any).network = net;
	(networks as any).joinedNetworks = new Set(joined);
	(networks as any)._onNetworkLeft = null;
	// leaveNetwork resolves the lishnet name only for logging — no DB here.
	(networks as any).get = () => undefined;
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
});
