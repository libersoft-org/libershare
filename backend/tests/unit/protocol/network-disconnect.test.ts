import { describe, it, expect } from 'bun:test';
import { KEEP_ALIVE } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import { Network, normalizeMultiaddrForCompare } from '../../../src/protocol/network.ts';
import { installBootstrapRegistry, type IRegistrySeed } from '../helpers/bootstrap-registry.ts';

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
	(network as any).bootstrapGeneration = new Map();
	(network as any).bootstrapPeerIDs = new Set<string>();
	installBootstrapRegistry(network, []);
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

	/**
	 * Suppression used to be recorded only AFTER the tag removal and the hangUp, both of
	 * which yield. A dial started inside that window read "not suppressed", went ahead,
	 * and landed after hangUp had already found no connection to close — leaving the
	 * peer connected and re-tagged with the leave apparently complete.
	 */
	it('claims suppression before the first await, not after the hangUp', async () => {
		const { network, suppressed } = makeNetwork();
		const observedDuringMerge: boolean[] = [];
		let release = (): void => {};
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		(network as any).node.peerStore.merge = async (): Promise<void> => {
			observedDuringMerge.push(suppressed(PEER_ID));
			await gate;
		};
		const pending = network.disconnectPeer(PEER_ID, NET);
		// The tag-removal await is where every racing dial path reads the flag.
		expect(observedDuringMerge).toEqual([true]);
		release();
		await pending;
		expect(suppressed(PEER_ID)).toBe(true);
	});

	it('claims it even when the hangUp itself throws', async () => {
		const { network, suppressed } = makeNetwork();
		(network as any).node.hangUp = async (): Promise<never> => {
			throw new Error('hangUp failed');
		};
		await network.disconnectPeer(PEER_ID, NET);
		expect(suppressed(PEER_ID)).toBe(true);
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
		(network as any).noReachableSince = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
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
 * Zero-connection recovery walks the bootstrap registry when the node has no
 * connections. It must skip peers leave-network deliberately hung up, or a left
 * bootstrap comes straight back the moment connections briefly hit zero.
 */
describe('Network.runZeroConnectionRecovery — leave-peer suppression', () => {
	function bareNetwork(suppressed: string[], seeds: IRegistrySeed[]) {
		const dialed: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).redialSuppressedByNet = new Map([['net-x', new Set<string>(suppressed)]]);
		(network as any).redialBackoff = new Map();
		(network as any).recoveryBackoff = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapPeerIDs = new Set<string>();
		installBootstrapRegistry(network, seeds);
		(network as any).recentDisconnects = [];
		(network as any).bootstrapTracker = { entries: () => [] };
		(network as any).node = {
			getPeers: () => [],
			async dial(ma: { toString(): string }): Promise<void> {
				dialed.push(ma.toString());
			},
		};
		return { network, dialed };
	}

	const run = (network: Network, connected: any[]): Promise<void> => (network as any).runZeroConnectionRecovery(connected);
	const ADDR = `/ip4/192.0.2.1/tcp/9090/p2p/${PEER_ID}`;

	it('does not dial a bootstrap peer suppressed by leave-network', async () => {
		const { network, dialed } = bareNetwork([PEER_ID], [{ address: ADDR }]);
		await run(network, []);
		expect(dialed).toEqual([]);
	});

	/**
	 * A failed recovery dial paces the address it failed on. Without that an isolated
	 * node re-dialed a dead peer every tick forever: re-dial maintenance stops counting
	 * its failures once there is no other connection to prove we are online, so nothing
	 * else was slowing it down.
	 */
	it('skips a discovered bootstrap address inside its backoff window', async () => {
		const { network, dialed } = bareNetwork([], [{ address: ADDR }]);
		(network as any).recoveryBackoff = new Map([[normalizeMultiaddrForCompare(multiaddr(ADDR).toString()), { nextAttempt: Date.now() + 60_000, failCount: 1 }]]);
		await run(network, []);
		expect(dialed).toEqual([]);
	});

	it('gives a CONFIGURED address an immediate first attempt — it is the way back in', async () => {
		const { network, dialed } = bareNetwork([], [{ address: ADDR, configuredBy: ['net-a'] }]);
		(network as any).configuredBootstrapPeerIDs = new Set([PEER_ID]);
		await run(network, []);
		expect(dialed).toEqual([multiaddr(ADDR).toString()]);
	});

	it('paces a CONFIGURED address too, once it has actually failed', async () => {
		const { network, dialed } = bareNetwork([], [{ address: ADDR, configuredBy: ['net-a'] }]);
		(network as any).recoveryBackoff = new Map([[normalizeMultiaddrForCompare(multiaddr(ADDR).toString()), { nextAttempt: Date.now() + 60_000, failCount: 1 }]]);
		await run(network, []);
		expect(dialed).toEqual([]);
	});

	it('skips a discovered bootstrap peer still inside its unreachable quarantine', async () => {
		const { network, dialed } = bareNetwork([], [{ address: ADDR }]);
		(network as any).unreachableQuarantine = new Map([[PEER_ID, Date.now() - 60_000]]);
		await run(network, []);
		expect(dialed).toEqual([]);
	});

	it('still dials a non-suppressed bootstrap peer', async () => {
		const { network, dialed } = bareNetwork([], [{ address: ADDR }]);
		await run(network, []);
		expect(dialed).toEqual([multiaddr(ADDR).toString()]);
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
		(network as any).unreachableQuarantine = new Map();
		(network as any).bootstrapGeneration = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		installBootstrapRegistry(network, []);
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
		expect((network as any).isRedialSuppressed(PEER_ID)).toBe(false);
	});

	it('does not lift suppression for a discovered (non-configured) re-add', async () => {
		const network = bareNetwork([PEER_ID]);
		await (network as any).addBootstrapPeers([`/ip4/192.0.2.1/tcp/9090/p2p/${PEER_ID}`], 'net-a', 'discovered');
		expect((network as any).isRedialSuppressed(PEER_ID)).toBe(true);
	});
});
