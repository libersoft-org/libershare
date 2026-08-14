import { describe, it, expect } from 'bun:test';
import { Network } from '../../../src/protocol/network.ts';

/**
 * Guards on the DESTRUCTIVE peer-eviction paths. The pure decision helpers are covered
 * in peer-eviction.test.ts; what is exercised here is the part that actually closes
 * connections and deletes peerStore entries, where the damage from getting it wrong is
 * not a wrong boolean but a live peer evicted from the wrong libp2p node.
 */

const PEER_ID = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
/**
 * A peerStore entry with no addresses at all is the deterministic form of "nothing the
 * dial gater will let us try" — using a real address would make the test depend on
 * which subnets this host happens to be on.
 */
const NO_ADDRESSES: Array<{ multiaddr: { toString(): string } }> = [];

function peerIdLike(id: string) {
	return { toString: () => id, equals: (o: any) => String(o) === id };
}

describe('purgeStalePeer — epoch guard', () => {
	function bareNetwork(onClose?: () => void) {
		const deleted: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).redialBackoff = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).node = {
			getConnections: () => [
				{
					async close(): Promise<void> {
						onClose?.();
					},
				},
			],
			peerStore: {
				async delete(pid: { toString(): string }): Promise<void> {
					deleted.push(pid.toString());
				},
				async merge(): Promise<void> {},
			},
		};
		return { network, deleted };
	}

	it('deletes the peerStore entry while the run still owns the node', async () => {
		const { network, deleted } = bareNetwork();
		await (network as any).purgeStalePeer(PEER_ID, 'test', 1);
		expect(deleted).toEqual([PEER_ID]);
	});

	it('does not touch the peerStore when stop() lands while connections are closing', async () => {
		// The exact race the epoch counter exists for: stop()/start() swaps in a new
		// node during the close await, and the old run must not delete a peer from it.
		const { network, deleted } = bareNetwork();
		const net = network as any;
		net.node.getConnections = () => [
			{
				async close(): Promise<void> {
					net.runEpoch++; // stop() during the await
				},
			},
		];
		await net.purgeStalePeer(PEER_ID, 'test', 1);
		expect(deleted).toEqual([]);
	});

	it('refuses to start at all for a stale epoch', async () => {
		const { network, deleted } = bareNetwork();
		(network as any).runEpoch = 2;
		await (network as any).purgeStalePeer(PEER_ID, 'test', 1);
		expect(deleted).toEqual([]);
	});
});

/**
 * A peer whose every stored address is rejected by the dial gater is not proof the peer
 * is gone — a LAN/VPN-only peer looks exactly like this the moment our own interface
 * drops. This path must therefore take the same self-online evidence as the
 * dial-failure path, or a local outage evicts the whole non-configured peerStore.
 */
describe('runRedialMaintenance — eviction with no reachable address', () => {
	function bareNetwork(opts: { weAreOnline: boolean; sinceMsAgo: number; configured?: boolean }) {
		const purged: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialBackoff = new Map();
		(network as any).redialSuppressedByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).noReachableSince = new Map([[PEER_ID, Date.now() - opts.sinceMsAgo]]);
		(network as any).configuredPeerIDs = new Set(opts.configured ? [PEER_ID] : []);
		(network as any).bootstrapTracker = { deleteDiscoveredByPeerID() {} };
		(network as any).pubsub = { getTopics: () => [], getSubscribers: () => [] };
		(network as any).node = { getConnections: () => [] };
		// Only the peer itself is ever asked about; "online" means we hold a connection
		// to somebody else.
		(network as any).hasConnectionOtherThan = () => opts.weAreOnline;
		(network as any).purgeStalePeer = async (pid: string): Promise<void> => {
			purged.push(pid);
		};
		return { network, purged };
	}

	const undialablePeer = { id: peerIdLike(PEER_ID), addresses: NO_ADDRESSES };
	const run = (network: Network): Promise<void> => (network as any).runRedialMaintenance([], [undialablePeer], 1);

	it('evicts once the window has passed and we are demonstrably online', async () => {
		const { network, purged } = bareNetwork({ weAreOnline: true, sinceMsAgo: 45 * 60_000 });
		await run(network);
		expect(purged).toEqual([PEER_ID]);
	});

	it('keeps the peer when the outage is ours', async () => {
		const { network, purged } = bareNetwork({ weAreOnline: false, sinceMsAgo: 45 * 60_000 });
		await run(network);
		expect(purged).toEqual([]);
	});

	it('slides the window forward during our outage instead of accumulating', async () => {
		// Otherwise the first tick after connectivity returns would evict everything
		// that went unreachable while we were down.
		const { network } = bareNetwork({ weAreOnline: false, sinceMsAgo: 45 * 60_000 });
		await run(network);
		const since = (network as any).noReachableSince.get(PEER_ID) as number;
		expect(Date.now() - since).toBeLessThan(60_000);
	});

	it('never evicts a configured peer', async () => {
		const { network, purged } = bareNetwork({ weAreOnline: true, sinceMsAgo: 45 * 60_000, configured: true });
		await run(network);
		expect(purged).toEqual([]);
	});

	it('keeps a peer that reconnected while the window was running', async () => {
		const { network, purged } = bareNetwork({ weAreOnline: true, sinceMsAgo: 45 * 60_000 });
		(network as any).node = { getConnections: () => [{}] }; // live again
		await run(network);
		expect(purged).toEqual([]);
	});
});
