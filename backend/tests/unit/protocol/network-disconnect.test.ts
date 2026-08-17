import { describe, it, expect } from 'bun:test';
import { KEEP_ALIVE } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import { Network, normalizeMultiaddrForCompare } from '../../../src/protocol/network.ts';

/**
 * Unit tests for Network.disconnectPeer tag hygiene: hanging up a peer must
 * remove BOTH keep-alive tags — the custom 'keep-alive-fleet' tag and the
 * native libp2p KEEP_ALIVE tag. Leaving either behind makes libp2p re-dial
 * the peer right after the hangUp, silently undoing the disconnect.
 */

const PEER_ID = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
const NET = 'net-a';

function makeNetwork() {
	const merges: Array<{ tags: Record<string, unknown> }> = [];
	const hungUp: string[] = [];
	const deleted: string[] = [];
	const network = Object.create(Network.prototype) as Network;
	(network as any).redialSuppressedByNet = new Map<string, Set<string>>();
	(network as any).configuredBootstrapPeerIDs = new Set<string>();
	(network as any).pubsub = null;
	(network as any).bootstrapGeneration = new Map();
	(network as any).inFlightBootstrapDials = new Set<string>();
	(network as any).dialAbort = new AbortController();
	(network as any).bootstrapPeerIDs = new Set<string>();
	(network as any).bootstrapMultiaddrs = [];
	(network as any).redialBackoff = new Map();
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
	const suppressed = (pid: string): boolean => (network as any).isRedialSuppressed(pid);
	return { network, merges, hungUp, deleted, suppressed };
}

describe('Network.disconnectPeer — keep-alive tag removal', () => {
	it('clears both keep-alive-fleet and native KEEP_ALIVE tags before hanging up', async () => {
		const { network, merges, hungUp } = makeNetwork();
		await network.disconnectPeer(PEER_ID, NET);
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
		await network.disconnectPeer(PEER_ID, NET);
		expect(hungUp).toEqual([PEER_ID]);
	});

	it('is a no-op for an invalid peer id', async () => {
		const { network, merges, hungUp } = makeNetwork();
		await network.disconnectPeer('not-a-peer-id', NET);
		expect(merges).toEqual([]);
		expect(hungUp).toEqual([]);
	});

	it('suppresses the hung-up peer from redial maintenance', async () => {
		const { network, suppressed } = makeNetwork();
		await network.disconnectPeer(PEER_ID, NET);
		expect(suppressed(PEER_ID)).toBe(true);
	});

	it('forgets the peerStore entry so the disconnect survives a restart', async () => {
		const { network, deleted } = makeNetwork();
		await network.disconnectPeer(PEER_ID, NET);
		expect(deleted).toEqual([PEER_ID]);
	});
});

/**
 * Join and leave of DIFFERENT lishnets run concurrently, but the peerStore, the keep-alive
 * tags, the connections and the redial suppression they work on are global. `leaveNetwork`
 * snapshots which peers are exclusive to the lishnet it is leaving and then works through
 * them one await at a time, so a lishnet joined half-way down that list — or a remote
 * SUBSCRIBE on a topic we are already in — is invisible to the snapshot. The claim it
 * missed has to be noticed here instead.
 */
describe('Network.disconnectPeer — a peer claimed while it is being let go', () => {
	/** A network whose pubsub starts empty and can gain a subscriber mid-disconnect. */
	function claimable() {
		const merges: Array<{ tags: Record<string, unknown> }> = [];
		const hungUp: string[] = [];
		const deleted: string[] = [];
		const subscribers: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map<string, Set<string>>();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).redialBackoff = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).pubsub = {
			getTopics: (): string[] => ['lish/net-b'],
			getSubscribers: (): Array<{ toString(): string }> => subscribers.map(p => ({ toString: () => p })),
		};
		(network as any).peerAnnounce = { getRecentMembers: (): string[] => [] };
		(network as any).node = {
			getConnections: (): unknown[] => [],
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
		return { network, merges, hungUp, deleted, subscribers };
	}

	it('leaves a peer alone when a joined lishnet already needs it', async () => {
		const { network, merges, hungUp, deleted, subscribers } = claimable();
		subscribers.push(PEER_ID);

		await network.disconnectPeer(PEER_ID, NET);

		expect(merges).toEqual([]);
		expect(hungUp).toEqual([]);
		expect(deleted).toEqual([]);
		expect((network as any).isRedialSuppressed(PEER_ID)).toBe(false);
	});

	it('gives the peer back when the claim lands during the tag removal', async () => {
		const { network, hungUp, deleted, merges, subscribers } = claimable();
		// The other lishnet's join completes while this disconnect is inside peerStore.merge.
		(network as any).node.peerStore.merge = async (_pid: unknown, patch: { tags: Record<string, unknown> }): Promise<void> => {
			merges.push(patch);
			if (merges.length === 1) subscribers.push(PEER_ID);
		};

		await network.disconnectPeer(PEER_ID, NET);

		// Neither destructive step ran, and the two global effects already applied are undone:
		// the suppression that would stop every maintenance path from dialing the peer back,
		// and the keep-alive tag libp2p needs to hold the connection open.
		expect(hungUp).toEqual([]);
		expect(deleted).toEqual([]);
		expect((network as any).isRedialSuppressed(PEER_ID)).toBe(false);
		expect(merges[1]?.tags).toHaveProperty(KEEP_ALIVE);
		expect(merges[1]!.tags[KEEP_ALIVE]).toEqual({ value: 1 });
	});

	it('gives the peer back when the claim lands during the hangUp', async () => {
		const { network, deleted, subscribers } = claimable();
		(network as any).node.hangUp = async (): Promise<void> => {
			subscribers.push(PEER_ID);
		};

		await network.disconnectPeer(PEER_ID, NET);

		// The connection is gone, but the peerStore record — the only thing that survives a
		// restart — is not purged, and nothing is left suppressing the reconnect.
		expect(deleted).toEqual([]);
		expect((network as any).isRedialSuppressed(PEER_ID)).toBe(false);
	});

	it('lifts the suppression when the claim lands during the purge', async () => {
		const { network, deleted, subscribers } = claimable();
		(network as any).node.peerStore.delete = async (pid: { toString(): string }): Promise<void> => {
			deleted.push(pid.toString());
			subscribers.push(PEER_ID);
		};

		await network.disconnectPeer(PEER_ID, NET);

		// Too late to keep the record, but the suppression is global and would otherwise make
		// every maintenance path refuse the peer a joined lishnet is now asking for.
		expect(deleted).toEqual([PEER_ID]);
		expect((network as any).isRedialSuppressed(PEER_ID)).toBe(false);
	});

	/**
	 * The mirror image of the race above, and the one the first fix opened. The claim was read
	 * only BEFORE the keep-alive restore, so the last owner leaving while that merge was in
	 * flight got its own cleanup finished and then had this restore land on top of it — a
	 * keep-alive tag put back on a peer nobody is in a lishnet with, and the caller told to
	 * stop, so the hangUp and the purge never happened.
	 */
	it('carries on when the claim disappears again during the restore', async () => {
		const { network, hungUp, deleted, merges, subscribers } = claimable();
		// Another lishnet claims the peer during the tag removal, and its own leave finishes
		// while the keep-alive restore that claim triggered is still in flight.
		(network as any).node.peerStore.merge = async (_pid: unknown, patch: { tags: Record<string, unknown> }): Promise<void> => {
			merges.push(patch);
			if (merges.length === 1) subscribers.push(PEER_ID);
			else if (patch.tags[KEEP_ALIVE] !== undefined) subscribers.length = 0;
		};

		await network.disconnectPeer(PEER_ID, NET);

		// The disconnect ran to the end, and the tag the restore put back is off again.
		expect(hungUp).toEqual([PEER_ID]);
		expect(deleted).toEqual([PEER_ID]);
		expect((network as any).isRedialSuppressed(PEER_ID)).toBe(true);
		expect(merges[merges.length - 1]!.tags[KEEP_ALIVE]).toBeUndefined();
	});

	it('still tears down a peer nobody claims', async () => {
		const { network, hungUp, deleted } = claimable();

		await network.disconnectPeer(PEER_ID, NET);

		expect(hungUp).toEqual([PEER_ID]);
		expect(deleted).toEqual([PEER_ID]);
		expect((network as any).isRedialSuppressed(PEER_ID)).toBe(true);
	});
});

/**
 * Per-network suppression: rejoining one lishnet must lift only ITS left peers,
 * a legitimate reconnect lifts a peer from all lishnets.
 */
describe('Network per-network redial suppression', () => {
	function bareNetwork() {
		const network = Object.create(Network.prototype) as Network;
		(network as any).redialSuppressedByNet = new Map<string, Set<string>>();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).pubsub = null;
		return network;
	}

	it('rejoin of one lishnet lifts only its suppressed peers', () => {
		const net = bareNetwork();
		(net as any).addRedialSuppression('net-a', 'pA');
		(net as any).addRedialSuppression('net-b', 'pB');
		expect((net as any).isRedialSuppressed('pA')).toBe(true);
		expect((net as any).isRedialSuppressed('pB')).toBe(true);
		net.clearRedialSuppressionForNetwork('net-a');
		expect((net as any).isRedialSuppressed('pA')).toBe(false);
		expect((net as any).isRedialSuppressed('pB')).toBe(true); // still-left net-b unaffected
	});

	it('observed reconnect lifts the peer from every lishnet', () => {
		const net = bareNetwork();
		(net as any).addRedialSuppression('net-a', 'pX');
		(net as any).addRedialSuppression('net-b', 'pX');
		(net as any).clearRedialSuppressionForPeer('pX');
		expect((net as any).isRedialSuppressed('pX')).toBe(false);
	});
});

/**
 * runRedialMaintenance must not re-dial peers that leave-network just hung up,
 * and must drop that suppression the moment the peer is observed connected again.
 */
describe('Network.runRedialMaintenance — leave-peer suppression', () => {
	function bareNetwork(suppressed: string[], sharedTopicPeers: string[] = []) {
		const dialed: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).redialBackoff = new Map();
		(network as any).redialSuppressedByNet = new Map([['net-x', new Set<string>(suppressed)]]);
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).noReachableSince = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		// A reconnected peer's suppression is lifted only if it currently shares a joined
		// topic — model that via a pubsub whose subscribers list the "back on topic" peers.
		(network as any).pubsub = {
			getTopics: () => ['lish/net-x'],
			getSubscribers: () => sharedTopicPeers.map(p => ({ toString: () => p })),
		};
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
		expect((network as any).isRedialSuppressed('pLeft')).toBe(true);
	});

	it('clears suppression when a reconnected peer is back on a shared topic', async () => {
		const { network, dialed } = bareNetwork(['pBack'], ['pBack']);
		const peer = { id: { toString: () => 'pBack' } };
		await run(network, [{ toString: () => 'pBack' }], [peer]);
		expect(dialed).toEqual([]);
		expect((network as any).isRedialSuppressed('pBack')).toBe(false);
	});

	it('keeps suppression for a reconnected peer NOT back on a shared topic', async () => {
		// A left peer dialing us back (keep-alive/mDNS) without rejoining a shared topic
		// must stay suppressed — otherwise canListSharesTo would serve it our catalog.
		const { network } = bareNetwork(['pBack'], []);
		const peer = { id: { toString: () => 'pBack' } };
		await run(network, [{ toString: () => 'pBack' }], [peer]);
		expect((network as any).isRedialSuppressed('pBack')).toBe(true);
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
		(network as any).redialSuppressedByNet = new Map([['net-x', new Set<string>(suppressed)]]);
		(network as any).redialBackoff = new Map();
		(network as any).addressProbeBackoff = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).bootstrapMultiaddrs = bootstrapMaStrs.map(s => multiaddr(s));
		(network as any).recentDisconnects = [];
		(network as any).bootstrapTracker = {
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			entries: () => [],
		};
		(network as any).node = {
			// Recovery reads connectivity itself rather than trusting the tick's snapshot.
			getPeers: () => [],
			async dial(ma: { toString(): string }): Promise<void> {
				dialed.push(ma.toString());
			},
		};
		return { network, dialed };
	}

	const run = (network: Network): Promise<void> => (network as any).runZeroConnectionRecovery();

	it('does not dial a bootstrap peer suppressed by leave-network', async () => {
		const ma = `/ip4/192.0.2.1/tcp/9090/p2p/${PEER_ID}`;
		const { network, dialed } = bareNetwork([PEER_ID], [ma]);
		await run(network);
		expect(dialed).toEqual([]);
	});

	/**
	 * Recovery shares the pacing records with re-dial maintenance. Without that an
	 * isolated node re-dialed a dead discovered peer every tick forever: maintenance
	 * stops counting its failures once there is no other connection to prove we are
	 * online, so nothing else was slowing it down.
	 */
	it('skips a discovered bootstrap peer inside its backoff window', async () => {
		const ma = `/ip4/192.0.2.1/tcp/9090/p2p/${PEER_ID}`;
		const { network, dialed } = bareNetwork([], [ma]);
		(network as any).redialBackoff = new Map([[PEER_ID, { nextAttempt: Date.now() + 60_000 }]]);
		await run(network);
		expect(dialed).toEqual([]);
	});

	it('still dials a CONFIGURED peer inside a backoff window — it is the way back in', async () => {
		const ma = `/ip4/192.0.2.1/tcp/9090/p2p/${PEER_ID}`;
		const { network, dialed } = bareNetwork([], [ma]);
		(network as any).redialBackoff = new Map([[PEER_ID, { nextAttempt: Date.now() + 60_000 }]]);
		(network as any).configuredBootstrapPeerIDs = new Set([PEER_ID]);
		(network as any).configuredBootstrapAddresses = new Set([normalizeMultiaddrForCompare(multiaddr(ma).toString())]);
		await run(network);
		expect(dialed).toEqual([multiaddr(ma).toString()]);
	});

	it('skips a discovered bootstrap peer still inside its unreachable quarantine', async () => {
		const ma = `/ip4/192.0.2.1/tcp/9090/p2p/${PEER_ID}`;
		const { network, dialed } = bareNetwork([], [ma]);
		(network as any).unreachableQuarantine = new Map([[PEER_ID, Date.now() - 60_000]]);
		await run(network);
		expect(dialed).toEqual([]);
	});

	it('still dials a non-suppressed bootstrap peer', async () => {
		const ma = `/ip4/192.0.2.1/tcp/9090/p2p/${PEER_ID}`;
		const { network, dialed } = bareNetwork([], [ma]);
		await run(network);
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
		(network as any).redialSuppressedByNet = new Map([['net-a', new Set<string>(suppressed)]]);
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Set<string>();
		(network as any).dialAbort = new AbortController();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapTracker = {
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			markPending() {},
			recordOutcome() {},
		};
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
		expect((network as any).isRedialSuppressed(PEER_ID)).toBe(false);
	});

	it('does not lift suppression for a discovered (non-configured) re-add', async () => {
		const network = bareNetwork([PEER_ID]);
		await (network as any).addBootstrapPeers([`/ip4/192.0.2.1/tcp/9090/p2p/${PEER_ID}`], 'net-a', 'discovered');
		expect((network as any).isRedialSuppressed(PEER_ID)).toBe(true);
	});
});
