import { describe, it, expect } from 'bun:test';
import { Network } from '../../../src/protocol/network.ts';

/**
 * Guards on the DESTRUCTIVE peer-eviction paths. The pure decision helpers are covered
 * in peer-eviction.test.ts; what is exercised here is the part that actually closes
 * connections and deletes peerStore entries, where the damage from getting it wrong is
 * not a wrong boolean but a live peer evicted from the wrong libp2p node.
 */

const PEER_ID = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
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
