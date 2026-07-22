import { describe, it, expect } from 'bun:test';
import { KEEP_ALIVE } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import { Network } from '../../../src/protocol/network.ts';

/**
 * Unit tests for Network.disconnectPeer tag hygiene: hanging up a peer must
 * remove BOTH keep-alive tags — the custom 'keep-alive-fleet' tag and the
 * native libp2p KEEP_ALIVE tag. Leaving either behind makes libp2p re-dial
 * the peer right after the hangUp, silently undoing the disconnect.
 */

const PEER_ID = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';

function makeNetwork() {
	const merges: Array<{ tags: Record<string, unknown> }> = [];
	const hungUp: string[] = [];
	const deleted: string[] = [];
	const network = Object.create(Network.prototype) as Network;
	(network as any).redialSuppressed = new Set<string>();
	(network as any).bootstrapPeerIDs = new Set<string>();
	(network as any).node = {
		getConnections: () => [],
		peerStore: {
			async merge(_pid: unknown, patch: { tags: Record<string, unknown> }): Promise<void> {
				merges.push(patch);
			},
			async delete(pid: { toString(): string }): Promise<void> {
				deleted.push(pid.toString());
			},
		},
		async hangUp(pid: { toString(): string }): Promise<void> {
			hungUp.push(pid.toString());
		},
	};
	return { network, merges, hungUp, deleted };
}

describe('Network.disconnectPeer — keep-alive tag removal', () => {
	it('clears both keep-alive-fleet and native KEEP_ALIVE tags before hanging up', async () => {
		const { network, merges, hungUp } = makeNetwork();
		await network.disconnectPeer(PEER_ID);
		expect(merges.length).toBe(1);
		const tags = merges[0]!.tags;
		expect(Object.keys(tags)).toContain('keep-alive-fleet');
		expect(Object.keys(tags)).toContain(KEEP_ALIVE);
		expect(tags['keep-alive-fleet']).toBeUndefined();
		expect(tags[KEEP_ALIVE]).toBeUndefined();
		expect(hungUp).toEqual([PEER_ID]);
	});

	it('still hangs up when tag removal fails', async () => {
		const { network, hungUp } = makeNetwork();
		(network as any).node.peerStore.merge = async (): Promise<void> => {
			throw new Error('merge failed');
		};
		await network.disconnectPeer(PEER_ID);
		expect(hungUp).toEqual([PEER_ID]);
	});

	it('is a no-op for an invalid peer id', async () => {
		const { network, merges, hungUp } = makeNetwork();
		await network.disconnectPeer('not-a-peer-id');
		expect(merges).toEqual([]);
		expect(hungUp).toEqual([]);
	});

	it('suppresses the hung-up peer from redial maintenance', async () => {
		const { network } = makeNetwork();
		await network.disconnectPeer(PEER_ID);
		expect((network as any).redialSuppressed.has(PEER_ID)).toBe(true);
	});

	it('forgets the peerStore entry so the disconnect survives a restart', async () => {
		const { network, deleted } = makeNetwork();
		await network.disconnectPeer(PEER_ID);
		expect(deleted).toEqual([PEER_ID]);
	});
});

/**
 * runRedialMaintenance must not re-dial peers that leave-network just hung up
 * (they sit in redialSuppressed), and must drop that suppression the moment the
 * peer is observed connected again so normal maintenance resumes.
 */
describe('Network.runRedialMaintenance — leave-peer suppression', () => {
	function bareNetwork(suppressed: string[]) {
		const dialed: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).redialBackoff = new Map();
		(network as any).redialSuppressed = new Set<string>(suppressed);
		(network as any).node = {
			async dial(id: { toString(): string }): Promise<void> {
				dialed.push(id.toString());
			},
			getConnections: () => [],
		};
		return { network, dialed };
	}

	const run = (network: Network, connected: any[], all: any[]): Promise<void> => (network as any).runRedialMaintenance(connected, all);

	it('does not re-dial a peer suppressed by leave-network', async () => {
		const { network, dialed } = bareNetwork(['pLeft']);
		const peer = { id: { toString: () => 'pLeft' }, addresses: [{ multiaddr: multiaddr('/ip4/203.0.113.5/tcp/9090') }] };
		await run(network, [], [peer]);
		expect(dialed).toEqual([]);
		expect((network as any).redialSuppressed.has('pLeft')).toBe(true);
	});

	it('clears suppression once the peer is observed connected again', async () => {
		const { network, dialed } = bareNetwork(['pBack']);
		const peer = { id: { toString: () => 'pBack' } };
		await run(network, [{ toString: () => 'pBack' }], [peer]);
		expect(dialed).toEqual([]);
		expect((network as any).redialSuppressed.has('pBack')).toBe(false);
	});
});

/**
 * Zero-connection recovery dials bootstrapMultiaddrs when the node has no
 * connections. It must skip peers leave-network deliberately hung up, or a left
 * bootstrap comes straight back the moment connections briefly hit zero.
 */
describe('Network.runZeroConnectionRecovery — leave-peer suppression', () => {
	function bareNetwork(suppressed: string[], bootstrapMaStrs: string[]) {
		const dialed: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).redialSuppressed = new Set<string>(suppressed);
		(network as any).bootstrapMultiaddrs = bootstrapMaStrs.map(s => multiaddr(s));
		(network as any).recentDisconnects = [];
		(network as any).bootstrapTracker = { entries: () => [] };
		(network as any).node = {
			async dial(ma: { toString(): string }): Promise<void> {
				dialed.push(ma.toString());
			},
		};
		return { network, dialed };
	}

	const run = (network: Network, connected: any[]): Promise<void> => (network as any).runZeroConnectionRecovery(connected);

	it('does not dial a bootstrap peer suppressed by leave-network', async () => {
		const ma = `/ip4/192.0.2.1/tcp/9090/p2p/${PEER_ID}`;
		const { network, dialed } = bareNetwork([PEER_ID], [ma]);
		await run(network, []);
		expect(dialed).toEqual([]);
	});

	it('still dials a non-suppressed bootstrap peer', async () => {
		const ma = `/ip4/192.0.2.1/tcp/9090/p2p/${PEER_ID}`;
		const { network, dialed } = bareNetwork([], [ma]);
		await run(network, []);
		expect(dialed).toEqual([multiaddr(ma).toString()]);
	});
});

/**
 * Re-configuring a bootstrap peer (network re-join) must lift any redial
 * suppression left by a prior leaveNetwork — otherwise maintenance skips it
 * forever if the single explicit join-dial fails or drops before the next tick.
 */
describe('Network.addBootstrapPeers — rejoin clears suppression', () => {
	function bareNetwork(suppressed: string[]) {
		const network = Object.create(Network.prototype) as Network;
		(network as any).redialSuppressed = new Set<string>(suppressed);
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapTracker = { markPending() {}, recordOutcome() {} };
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getConnections: () => [],
			async dial(): Promise<void> {},
			peerStore: { async merge(): Promise<void> {} },
		};
		return network;
	}

	it('lifts suppression for a re-configured bootstrap peer', async () => {
		const network = bareNetwork([PEER_ID]);
		await (network as any).addBootstrapPeers([`/ip4/192.0.2.1/tcp/9090/p2p/${PEER_ID}`], 'net-a', 'configured');
		expect((network as any).redialSuppressed.has(PEER_ID)).toBe(false);
	});

	it('does not lift suppression for a discovered (non-configured) re-add', async () => {
		const network = bareNetwork([PEER_ID]);
		await (network as any).addBootstrapPeers([`/ip4/192.0.2.1/tcp/9090/p2p/${PEER_ID}`], 'net-a', 'discovered');
		expect((network as any).redialSuppressed.has(PEER_ID)).toBe(true);
	});
});
