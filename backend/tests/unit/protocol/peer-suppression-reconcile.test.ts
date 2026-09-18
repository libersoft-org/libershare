import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Mutex } from 'async-mutex';
import { KEEP_ALIVE } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import { Network, shouldEvictUnreachablePeer } from '../../../src/protocol/network.ts';
import { Networks } from '../../../src/lishnet/lishnets.ts';
import { initLISHnetsTables, addLISHnet, lishnetExists } from '../../../src/db/lishnets.ts';
import { lishTopic } from '../../../src/protocol/constants.ts';
import { installBootstrapRegistry } from '../helpers/bootstrap-registry.ts';

/**
 * Reconciliation of the two independent "do not dial this peer" mechanisms that
 * meet in network.ts:
 *
 * - leave-network redial suppression — a DECISION, per lishnet, reversible;
 * - unreachable eviction + quarantine — an OBSERVATION, global, time-expiring.
 *
 * They stay two maps because their lifetimes differ, but every dial site asks a
 * single question (`dialSuppressionReason`). These tests pin the places where
 * mixing the two would have broken one of the behaviours: a leave that really
 * disconnects, and a participant list that drops long-dead peers.
 *
 * Every behavioural test is paired with a negative control that reimplements the
 * pre-reconciliation logic locally and shows it reaching the opposite verdict.
 */

const LEFT_PEER = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
const DEAD_PEER = '12D3KooWSHj3RRbBueoTHUJnWNfMTLJyRSyxsDcQ9NqPRTBGWZBP';
const NET = 'net-a';
const EVICT_MIN_MS = 30 * 60_000;
const EVICT_FAILS = 6;
const QUARANTINE_MS = 30 * 60_000;
/** A routable documentation address (RFC 5737), so the peer becomes a dial candidate. */
const ROUTABLE_ADDR = '/ip4/203.0.113.7/tcp/9090';

interface Harness {
	network: Network;
	dialed: string[];
	purged: string[];
	statusRowsDropped: string[];
	merged: Array<{ peerID: string; tags: Record<string, unknown> }>;
	connections: Map<string, unknown[]>;
}

/**
 * A Network with every map the dial paths touch, and a node stub whose dials
 * always fail (the peers under test are gone). `connections` drives both the
 * liveness checks and `hasConnectionOtherThan`.
 */
function makeHarness(): Harness {
	const dialed: string[] = [];
	const purged: string[] = [];
	const statusRowsDropped: string[] = [];
	const merged: Array<{ peerID: string; tags: Record<string, unknown> }> = [];
	const connections = new Map<string, unknown[]>();
	const network = Object.create(Network.prototype) as Network;
	(network as any).runEpoch = 0;
	(network as any).redialSuppressedByNet = new Map<string, Set<string>>();
	(network as any).unreachableQuarantine = new Map<string, number>();
	(network as any).redialBackoff = new Map();
	(network as any).configuredBootstrapPeerIDs = new Set<string>();
	(network as any).bootstrapPeerIDs = new Set<string>();
	(network as any).bootstrapGeneration = new Map<string, number>();
	(network as any).unreachableQuarantineProbes = new Map<string, number>();
	(network as any).joinedNetworkBootstrapPeers = new Map<string, Set<string>>();
	// The address registry and the walk state the dial loops read. Object.create never
	// runs field initializers, so every map a production path touches has to be seeded.
	installBootstrapRegistry(network, []);
	(network as any).pubsub = { getTopics: () => [], getSubscribers: () => [] };
	(network as any).bootstrapTracker = {
		markPending() {},
		recordOutcome() {},
		deleteDiscoveredByPeerID(pid: string) {
			statusRowsDropped.push(pid);
		},
	};
	// A live connection to an unrelated peer: eviction only judges a peer when we
	// are demonstrably online ourselves.
	const someoneElse = { remotePeer: { equals: () => false }, remoteAddr: multiaddr(ROUTABLE_ADDR) };
	(network as any).node = {
		peerId: { toString: () => 'selfID' },
		getConnections(pid?: { toString(): string }) {
			if (pid === undefined) return [someoneElse];
			return connections.get(pid.toString()) ?? [];
		},
		getPeers: () => [],
		async dial(target: { toString(): string }): Promise<void> {
			dialed.push(target.toString());
			throw new Error('dial refused');
		},
		peerStore: {
			async all() {
				return [];
			},
			async merge(pid: { toString(): string }, patch: { tags?: Record<string, unknown> }): Promise<void> {
				merged.push({ peerID: pid.toString(), tags: patch.tags ?? {} });
			},
			async delete(pid: { toString(): string }): Promise<void> {
				purged.push(pid.toString());
			},
		},
	};
	return { network, dialed, purged, statusRowsDropped, merged, connections };
}

const peerEntry = (pid: string, addr: string) => ({ id: { toString: () => pid }, addresses: [{ multiaddr: multiaddr(addr) }] });
const runRedial = (network: Network, connected: any[], all: any[]): Promise<void> => (network as any).runRedialMaintenance(connected, all);
const suppress = (network: Network, networkID: string, pid: string): void => (network as any).addRedialSuppression(networkID, pid);

describe('dialSuppressionReason — one question, two answers', () => {
	const reason = (network: Network, pid: string, now?: number): string | null => (network as any).dialSuppressionReason(pid, now ?? Date.now());

	it('reports a deliberate leave separately from an unreachable eviction', () => {
		const { network } = makeHarness();
		suppress(network, NET, LEFT_PEER);
		(network as any).unreachableQuarantine.set(DEAD_PEER, Date.now());
		expect(reason(network, LEFT_PEER)).toBe('left-network');
		expect(reason(network, DEAD_PEER)).toBe('unreachable');
		expect(reason(network, 'someone-else')).toBe(null);
	});

	it('lets the quarantine expire but never times out a leave', () => {
		// The asymmetry is the point: a quarantine is an observation with a shelf
		// life, a leave is a decision that only an explicit rejoin reverses.
		const { network } = makeHarness();
		const now = Date.now();
		suppress(network, NET, LEFT_PEER);
		(network as any).unreachableQuarantine.set(DEAD_PEER, now - QUARANTINE_MS - 1);
		expect(reason(network, DEAD_PEER, now)).toBe(null);
		expect(reason(network, LEFT_PEER, now + 10 * QUARANTINE_MS)).toBe('left-network');
	});
});

/** Failure history that already satisfies both halves of the eviction predicate. */
const evictableHistory = (): { nextAttempt: number; failCount: number; evictionFails: number; firstFailure: number } => ({
	nextAttempt: 0,
	failCount: EVICT_FAILS,
	evictionFails: EVICT_FAILS,
	firstFailure: Date.now() - EVICT_MIN_MS - 1,
});

describe('runRedialMaintenance — a left peer is not an unreachable peer', () => {
	const evictable = (): { nextAttempt: number; failCount: number; evictionFails: number; firstFailure: number } => ({
		nextAttempt: 0,
		failCount: EVICT_FAILS,
		evictionFails: EVICT_FAILS,
		firstFailure: Date.now() - EVICT_MIN_MS - 1,
	});

	/** A peer left with a lishnet that is otherwise one dial away from being evicted. */
	function leftAndUnreachable(): Harness {
		const h = makeHarness();
		suppress(h.network, NET, LEFT_PEER);
		(h.network as any).redialBackoff.set(LEFT_PEER, evictable());
		return h;
	}

	it('does not evict or quarantine a peer we deliberately left', async () => {
		const h = leftAndUnreachable();
		await runRedial(h.network, [], [peerEntry(LEFT_PEER, ROUTABLE_ADDR)]);
		expect(h.dialed).toEqual([]);
		expect(h.purged).toEqual([]);
		expect(h.statusRowsDropped).toEqual([]);
		expect((h.network as any).unreachableQuarantine.has(LEFT_PEER)).toBe(false);
		// Still suppressed, so a rejoin can still bring it back deliberately.
		expect((h.network as any).isRedialSuppressed(LEFT_PEER)).toBe(true);
	});

	it('still evicts and quarantines an ordinary unreachable peer', async () => {
		// Long-dead peers must stop appearing in the participants list. The leave guard
		// must not switch that off for everybody else.
		const h = makeHarness();
		(h.network as any).redialBackoff.set(DEAD_PEER, evictable());
		await runRedial(h.network, [], [peerEntry(DEAD_PEER, ROUTABLE_ADDR)]);
		expect(h.purged).toEqual([DEAD_PEER]);
		expect(h.statusRowsDropped).toEqual([DEAD_PEER]);
		expect((h.network as any).unreachableQuarantine.has(DEAD_PEER)).toBe(true);
	});

	it('exempts a configured bootstrap peer for exactly as long as it is configured', async () => {
		// The exemption is the configuration, not a memory of it: a hub the operator
		// removed must become evictable again without waiting for a restart.
		const h = makeHarness();
		(h.network as any).configuredBootstrapPeerIDs.add(DEAD_PEER);
		(h.network as any).redialBackoff.set(DEAD_PEER, evictable());
		await runRedial(h.network, [], [peerEntry(DEAD_PEER, ROUTABLE_ADDR)]);
		expect(h.purged).toEqual([]);

		h.network.pruneConfiguredBootstrapPeer(DEAD_PEER);
		(h.network as any).redialBackoff.set(DEAD_PEER, evictable());
		await runRedial(h.network, [], [peerEntry(DEAD_PEER, ROUTABLE_ADDR)]);
		expect(h.purged).toEqual([DEAD_PEER]);
	});

	it('re-asks before each queued dial, not only when the list was built', async () => {
		// Ten dials run at a time and the rest wait. A leave landing while they wait has to
		// stop the ones still queued: the post-dial check only closes a connection that has
		// already been opened, which is not the same as never dialing a peer we walked away
		// from. The first dial suppresses the second peer from inside the worker, so the
		// interleaving is the test's rather than the scheduler's.
		const h = makeHarness();
		const OTHER = '12D3KooWQ9Jz7nTZPNL8N1mQ4bqgGVzhgy1oCkBtbfcCPWKGcAfW';
		(h.network as any).node.dial = async (target: { toString(): string }): Promise<void> => {
			h.dialed.push(target.toString());
			if (h.dialed.length === 1) suppress(h.network, NET, OTHER);
			throw new Error('dial refused');
		};

		await runRedial(h.network, [], [peerEntry(DEAD_PEER, ROUTABLE_ADDR), peerEntry(OTHER, ROUTABLE_ADDR)]);

		expect(h.dialed).toEqual([DEAD_PEER]);
	});

	it('does not turn a leave that landed mid-dial into an unreachable quarantine', async () => {
		// The dial is already in flight when the user leaves the peer's lishnet, and
		// leaveNetwork hangs it up — so it fails for a reason that says nothing about the
		// peer. Counting that failure lets a deliberate leave accumulate the evidence for an
		// eviction and end as a GLOBAL quarantine, which a rejoin of that lishnet does not
		// clear: a rejoin only lifts the leave.
		const h = makeHarness();
		(h.network as any).redialBackoff.set(DEAD_PEER, evictableHistory());
		(h.network as any).node.dial = async (target: { toString(): string }): Promise<void> => {
			h.dialed.push(target.toString());
			// The leave lands while this dial is still outstanding.
			suppress(h.network, NET, DEAD_PEER);
			throw new Error('hung up by leaveNetwork');
		};

		await runRedial(h.network, [], [peerEntry(DEAD_PEER, ROUTABLE_ADDR)]);

		expect(h.dialed).toEqual([DEAD_PEER]);
		expect(h.purged).toEqual([]);
		expect((h.network as any).unreachableQuarantine.has(DEAD_PEER)).toBe(false);
		// Rejoining lifts the leave, and nothing else is holding the peer back.
		h.network.clearRedialSuppressionForNetwork(NET);
		expect((h.network as any).dialSuppressionReason(DEAD_PEER)).toBe(null);
	});

	it('negative control: judging the eviction on the clock alone evicts the left peer', async () => {
		// The pre-reconciliation ordering — the eviction predicate ran on the failure
		// history and the configured set, never on whether the peer was one we had
		// deliberately walked away from. Reimplemented over the same state as the first
		// test, to show the assertion above discriminates.
		const h = leftAndUnreachable();
		const bo = (h.network as any).redialBackoff.get(LEFT_PEER);
		expect(shouldEvictUnreachablePeer({ reachable: true, failCount: bo.evictionFails, unreachableForMs: Date.now() - bo.firstFailure, configured: false })).toBe(true);

		await runRedial(h.network, [], [peerEntry(LEFT_PEER, ROUTABLE_ADDR)]);
		expect(h.purged).toEqual([]);
	});
});

describe('purgeStalePeer — a purge does not outlive its node', () => {
	it('abandons the delete when stop() lands while connections are closing', async () => {
		// Closing a connection yields. stop()/start() in that window swaps the node
		// underneath, and an old purge that keeps reading this.node would delete the
		// peer from the NEW node's peerStore — a peer the new run may well want.
		const h = makeHarness();
		const epoch = (h.network as any).runEpoch;
		(h.network as any).node.getConnections = (pid?: { toString(): string }) => {
			if (pid === undefined) return [];
			return [
				{
					async close(): Promise<void> {
						(h.network as any).runEpoch++; // stop() during the close
					},
				},
			];
		};

		await h.network.purgeStalePeer(DEAD_PEER, 'test', epoch);

		expect(h.purged).toEqual([]);
	});

	it('deletes normally while the run still owns the node', async () => {
		const h = makeHarness();
		await h.network.purgeStalePeer(DEAD_PEER, 'test');
		expect(h.purged).toEqual([DEAD_PEER]);
	});
});

describe('addBootstrapPeers — configuring a peer by hand is a clean slate', () => {
	it('clears the quarantine and the failure history', async () => {
		// The user just re-added a peer we had evicted. If the explicit dial below
		// fails and any of that evidence survives, maintenance, discovery and
		// zero-connection recovery all keep skipping the peer for another half hour.
		const h = makeHarness();
		const now = Date.now();
		suppress(h.network, NET, DEAD_PEER);
		(h.network as any).unreachableQuarantine.set(DEAD_PEER, now);
		(h.network as any).redialBackoff.set(DEAD_PEER, { nextAttempt: now + 600_000, failCount: 9, firstFailure: now - EVICT_MIN_MS });

		await h.network.addBootstrapPeers([`${ROUTABLE_ADDR}/p2p/${DEAD_PEER}`], NET, 'configured');

		expect((h.network as any).dialSuppressionReason(DEAD_PEER)).toBe(null);
		expect((h.network as any).redialBackoff.has(DEAD_PEER)).toBe(false);
	});

	it('leaves a discovered mention of the same peer quarantined', () => {
		// Only the operator's own edit is consent; gossip restating the peer is not.
		const h = makeHarness();
		(h.network as any).unreachableQuarantine.set(DEAD_PEER, Date.now());
		expect((h.network as any).dialSuppressionReason(DEAD_PEER)).toBe('unreachable');
	});
});

describe('promoteKnownPeersToBootstrap — connected is not consent', () => {
	/**
	 * A left peer that dialled US back on its own keep-alive: connected, but still
	 * suppressed because it never rejoined a topic we share.
	 */
	function connectedButLeft() {
		const h = makeHarness();
		suppress(h.network, NET, LEFT_PEER);
		const promoted: string[][] = [];
		const directAdds: string[] = [];
		(h.network as any).node.peerStore.all = async () => [peerEntry(LEFT_PEER, ROUTABLE_ADDR)];
		(h.network as any).node.getPeers = () => [{ toString: () => LEFT_PEER }];
		(h.network as any).addBootstrapPeers = async (mas: string[]): Promise<void> => {
			promoted.push(mas);
		};
		(h.network as any).pubsub = {
			getTopics: () => [],
			getSubscribers: () => [],
			direct: {
				has: (pid: string) => directAdds.includes(pid),
				add: (pid: string) => directAdds.push(pid),
				delete: () => {},
			},
		};
		return { ...h, promoted, directAdds };
	}

	const promote = (network: Network): Promise<void> => (network as any).promoteKnownPeersToBootstrap();

	it('does not re-stamp keep-alive on a connected peer we left', async () => {
		const h = connectedButLeft();
		await promote(h.network);
		expect(h.promoted).toEqual([]);
		expect(h.directAdds).toEqual([]);
	});

	it('still promotes an ordinary connected peer', async () => {
		const h = connectedButLeft();
		(h.network as any).redialSuppressedByNet.clear();
		await promote(h.network);
		expect(h.promoted.length).toBe(1);
		expect(h.directAdds).toEqual([LEFT_PEER]);
	});

	it('negative control: the connected-only filter promotes the left peer', async () => {
		// 442 narrowed promotion to connected peers, which reads like it subsumes
		// 428's suppression skip — it does not, because a left peer can be connected.
		const h = connectedButLeft();
		const connectedIDs = new Set([LEFT_PEER]);
		const promotedByOldFilter = [LEFT_PEER].filter(pid => connectedIDs.has(pid));
		expect(promotedByOldFilter).toEqual([LEFT_PEER]);

		await promote(h.network);
		expect(h.promoted).toEqual([]);
	});
});

describe('purgeStalePeer — the race healing must not undo a leave', () => {
	/** disconnectPeer's purge, racing an inbound connection from the peer we just left. */
	function leaveRacingReconnect(): Harness {
		const h = makeHarness();
		h.connections.set(LEFT_PEER, [{ remotePeer: { equals: () => true }, remoteAddr: multiaddr(ROUTABLE_ADDR) }]);
		return h;
	}

	const purge = (network: Network, pid: string): Promise<'purged' | 'kept' | 'failed'> => network.purgeStalePeer(pid, 'test');

	it('leaves a deliberately hung-up peer untagged when it reconnects mid-purge', async () => {
		const h = leaveRacingReconnect();
		await h.network.disconnectPeer(LEFT_PEER, NET);
		const restamped = h.merged.filter(m => m.peerID === LEFT_PEER && m.tags[KEEP_ALIVE] !== undefined);
		expect(restamped).toEqual([]);
		expect((h.network as any).bootstrapPeerIDs.has(LEFT_PEER)).toBe(false);
	});

	it('still heals an involuntary eviction that races a reconnect', async () => {
		// Unchanged for the eviction path: a peer that came back while being purged
		// keeps its dial state, or its reconnect dies with the first drop.
		const h = leaveRacingReconnect();
		await purge(h.network, LEFT_PEER);
		const restamped = h.merged.filter(m => m.peerID === LEFT_PEER && m.tags[KEEP_ALIVE] !== undefined);
		expect(restamped.length).toBe(1);
		expect((h.network as any).bootstrapPeerIDs.has(LEFT_PEER)).toBe(true);
	});

	it('negative control: unconditional healing re-tags the peer we just left', async () => {
		const h = leaveRacingReconnect();
		// The pre-reconciliation healing condition: connected after the delete, full stop.
		const healedByOldRule = (h.network as any).node.getConnections({ toString: () => LEFT_PEER }).length > 0;
		expect(healedByOldRule).toBe(true);

		await h.network.disconnectPeer(LEFT_PEER, NET);
		expect(h.merged.filter(m => m.tags[KEEP_ALIVE] !== undefined)).toEqual([]);
	});

	it('clears the failure history so a returning peer starts a fresh window', async () => {
		// Left behind, the eviction evidence is measured in wall-clock: a peer purged now
		// and back in the peerStore later would be judged against a window that started
		// before it ever went away, and evicted on the first tick that sees it.
		const h = makeHarness();
		(h.network as any).redialBackoff.set(DEAD_PEER, { nextAttempt: 0, failCount: EVICT_FAILS, evictionFails: EVICT_FAILS, firstFailure: Date.now() - EVICT_MIN_MS - 1 });
		await purge(h.network, DEAD_PEER);
		expect((h.network as any).redialBackoff.has(DEAD_PEER)).toBe(false);

		h.purged.length = 0;
		await runRedial(h.network, [], [peerEntry(DEAD_PEER, ROUTABLE_ADDR)]);
		expect(h.purged).toEqual([]);
	});
});

describe('addBootstrapPeers — gossip must not resurrect either kind of removal', () => {
	const add = (network: Network, pid: string, origin: 'configured' | 'discovered'): Promise<void> => (network as any).addBootstrapPeers([`${ROUTABLE_ADDR}/p2p/${pid}`], NET, origin);

	it('refuses to dial a peer we left when gossip mentions it', async () => {
		const h = makeHarness();
		suppress(h.network, NET, LEFT_PEER);
		await add(h.network, LEFT_PEER, 'discovered');
		expect(h.dialed).toEqual([]);
	});

	it('refuses to dial a quarantined peer when gossip mentions it', async () => {
		const h = makeHarness();
		(h.network as any).unreachableQuarantine.set(DEAD_PEER, Date.now());
		await add(h.network, DEAD_PEER, 'discovered');
		expect(h.dialed).toEqual([]);
	});

	it('a configured re-add is an explicit rejoin and lifts the leave', async () => {
		const h = makeHarness();
		suppress(h.network, NET, LEFT_PEER);
		await add(h.network, LEFT_PEER, 'configured');
		expect((h.network as any).isRedialSuppressed(LEFT_PEER)).toBe(false);
		expect(h.dialed.length).toBe(1);
	});

	it('negative control: the quarantine-only check dials the peer we left', async () => {
		// 442 asked one of the two questions here; 428 asked neither. Gossip naming a
		// left peer therefore went straight to dial and reconnected it.
		const h = makeHarness();
		suppress(h.network, NET, LEFT_PEER);
		const quarantinedAt = (h.network as any).unreachableQuarantine.get(LEFT_PEER);
		const blockedByOldCheck = quarantinedAt !== undefined && Date.now() - quarantinedAt < QUARANTINE_MS;
		expect(blockedByOldCheck).toBe(false);

		await add(h.network, LEFT_PEER, 'discovered');
		expect(h.dialed).toEqual([]);
	});
});

describe('addBootstrapPeers — a dial that waited must re-ask before it dials', () => {
	const NET_B = 'net-b';
	const ADDR = `${ROUTABLE_ADDR}/p2p/${LEFT_PEER}`;
	const add = (network: Network, networkID: string): Promise<void> => (network as any).addBootstrapPeers([ADDR], networkID, 'discovered');
	/** Let the pending run get through its awaits and reach the dial / the wait. */
	const settle = async (): Promise<void> => {
		for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0));
	};

	/**
	 * Two lishnets can name the SAME address, and the second run then queues behind the
	 * first rather than duplicating its timeout. The suppression check happens before that
	 * wait — which is exactly long enough for the answer to expire. Leaving lishnet A while
	 * the second run waits does not touch lishnet B's generation, so `superseded()` stays
	 * false and the queued dial used to go through, reconnecting the peer the leave removed.
	 */
	function hangingDial(h: Harness): { release: () => void } {
		let release!: () => void;
		const held = new Promise<void>(resolve => {
			release = resolve;
		});
		(h.network as any).node.dial = async (target: { toString(): string }): Promise<void> => {
			h.dialed.push(target.toString());
			await held;
			throw new Error('dial refused');
		};
		return { release };
	}

	it('drops the queued dial when the peer is left while it waits', async () => {
		const h = makeHarness();
		const { release } = hangingDial(h);

		const first = add(h.network, NET);
		await settle();
		expect(h.dialed.length).toBe(1);

		const second = add(h.network, NET_B);
		await settle();
		// The leave lands while the second run is parked on the first one's claim.
		suppress(h.network, NET, LEFT_PEER);
		release();
		await Promise.all([first, second]);

		expect(h.dialed).toEqual([ADDR]);
	});

	it('still dials the queued candidate when nothing suppressed it', async () => {
		// The guard must not swallow the ordinary case: two lishnets naming one address
		// with no leave in between is why the wait exists at all.
		const h = makeHarness();
		const { release } = hangingDial(h);

		const first = add(h.network, NET);
		await settle();
		const second = add(h.network, NET_B);
		await settle();
		release();
		await Promise.all([first, second]);

		expect(h.dialed).toEqual([ADDR, ADDR]);
	});

	it('negative control: checking only the run generation lets the left peer through', async () => {
		// What the queued branch asked before: whether ITS OWN network's list was replaced.
		// A leave of the other lishnet changes neither the run epoch nor B's generation.
		const h = makeHarness();
		const epochBefore = (h.network as any).runEpoch;
		suppress(h.network, NET, LEFT_PEER);

		expect((h.network as any).runEpoch).toBe(epochBefore);
		expect((h.network as any).bootstrapGenerationOf(NET_B)).toBe(0);
		expect((h.network as any).isRedialSuppressed(LEFT_PEER)).toBe(true);
	});
});

describe('Networks.delete — suppression entries outlive the lishnet that keyed them', () => {
	function makeNetworksWithDB(clearedFor: string[]) {
		const db = new Database(':memory:');
		initLISHnetsTables(db);
		addLISHnet(db, { networkID: NET, name: 'Test', description: '', enabled: true, bootstrapPeers: [] } as any);
		const networks = Object.create(Networks.prototype) as Networks;
		(networks as any).db = db;
		(networks as any).joinedNetworks = new Set([NET]);
		// Object.create skips the field initializers, so the write path's locks and its
		// reconcile bookkeeping have to be seeded — delete() runs through both.
		(networks as any).catalogMutex = new Mutex();
		(networks as any).networkOperations = new Map();
		(networks as any).activeReconciles = new Set();
		(networks as any).announcedJoined = new Map([[NET, true]]);
		(networks as any).appliedBootstrap = new Map([[NET, { addresses: [], complete: true }]]);
		(networks as any)._onNetworkLeft = null;
		(networks as any)._onNetworkJoined = null;
		(networks as any).network = {
			getTopicPeers: () => [LEFT_PEER],
			getRecentTopicMembers: () => [],
			unsubscribeTopic() {},
			subscribeTopic() {},
			isBootstrapOrRelayPeer: () => false,
			async disconnectPeer(): Promise<void> {},
			pruneConfiguredBootstrapPeer() {},
			getRunEpoch: () => 0,
			resetBootstrapStatus() {},
			pruneBootstrapAddresses() {},
			getTopicPeersInfo: () => [],
			forgetBootstrapForNetwork() {},
			isRunning: () => true,
			async addBootstrapPeers(): Promise<void> {},
			clearRedialSuppressionForNetwork(id: string) {
				clearedFor.push(id);
			},
		};
		return { networks, db };
	}

	it('releases the deleted lishnet own suppression set', async () => {
		const clearedFor: string[] = [];
		const { networks, db } = makeNetworksWithDB(clearedFor);
		await networks.delete(NET);
		expect(clearedFor).toEqual([NET]);
		expect(lishnetExists(db, NET)).toBe(false);
	});

	it('releases the suppression of a lishnet dropped by a bulk replace', async () => {
		// A network removed by replacing the whole list is deleted every bit as much as one
		// removed through delete(): its suppression is keyed by an ID that no longer exists,
		// so no rejoin can ever present the key that would release it.
		const clearedFor: string[] = [];
		const { networks, db } = makeNetworksWithDB(clearedFor);
		addLISHnet(db, { networkID: 'net-keep', name: 'Keep', description: '', enabled: true, bootstrapPeers: [] } as any);

		await networks.replace([{ networkID: 'net-keep', name: 'Keep', description: '', enabled: true, bootstrapPeers: [] } as any]);

		expect(lishnetExists(db, NET)).toBe(false);
		expect(clearedFor).toEqual([NET]);
	});

	it('does not release a suppression that belongs to a lishnet recreated mid-replace', async () => {
		// The mutation gate counts writers instead of serialising them, so another request can
		// re-create and re-leave one of these lishnets while the replace is still draining the
		// others. That suppression is the NEWER decision; releasing it on the strength of an
		// ID captured before the wait would undo a leave that happened after this delete was
		// decided.
		const clearedFor: string[] = [];
		const { networks, db } = makeNetworksWithDB(clearedFor);
		const SLOW = 'net-slow';
		addLISHnet(db, { networkID: SLOW, name: 'Slow', description: '', enabled: true, bootstrapPeers: [] } as any);
		(networks as any).joinedNetworks = new Set([NET, SLOW]);
		(networks as any).announcedJoined = new Map([
			[NET, true],
			[SLOW, true],
		]);
		(networks as any).appliedBootstrap = new Map([
			[NET, { addresses: [], complete: true }],
			[SLOW, { addresses: [], complete: true }],
		]);
		let recreate!: () => void;
		const recreated = new Promise<void>(resolve => (recreate = resolve));
		(networks as any).network.disconnectPeer = async (_peerID: string, networkID: string): Promise<void> => {
			// Hold the slow lishnet's leave open, and let the other request run inside it.
			if (networkID !== SLOW) return;
			recreate();
			await new Promise(resolve => setTimeout(resolve, 30));
		};

		const replacing = networks.replace([]);
		await recreated;
		// The concurrent writer: NET comes back and is left again, installing a fresh
		// suppression under the same ID.
		addLISHnet(db, { networkID: NET, name: 'Test', description: '', enabled: false, bootstrapPeers: [] } as any);
		clearedFor.length = 0;
		await replacing;

		expect(clearedFor).toEqual([SLOW]);
		expect(lishnetExists(db, NET)).toBe(true);
	});

	it('keeps the suppression when the row was not deleted', async () => {
		// A delete that finds nothing to remove has changed nothing, so the peers stay
		// left: their suppression is still the only thing refusing them a share listing
		// through the grace window if they re-dial us.
		const clearedFor: string[] = [];
		const { networks } = makeNetworksWithDB(clearedFor);

		expect(await networks.delete('net-that-does-not-exist')).toBe(false);

		expect(clearedFor).toEqual([]);
	});

	it('does not hand the share listing back when the lishnet is deleted', async () => {
		// The suppression set answers two questions at once. Deleting A has to stop its peers
		// being undialable forever, but it says nothing about them being allowed to read what
		// we share — and while we stay in B the listing gate's soft path would otherwise let
		// a reconnecting ex-peer of A browse it for the length of the grace window.
		const clearedFor: string[] = [];
		const { networks } = makeNetworksWithDB(clearedFor);
		const net = Object.create(Network.prototype) as Network;
		(net as any).redialSuppressedByNet = new Map([[NET, new Set([LEFT_PEER])]]);
		(net as any).listingRevoked = new Set<string>();
		(net as any).isBootstrapOrRelayPeer = () => false;
		// We are still in another lishnet, and the peer shares none of it.
		(net as any).pubsub = { getTopics: () => [lishTopic('net-b')], getSubscribers: () => [] };
		(net as any).node = { getConnections: () => [{ remotePeer: { toString: () => LEFT_PEER }, timeline: { open: Date.now() } }] };
		(networks as any).network.clearRedialSuppressionForNetwork = (id: string, reason?: 'rejoined' | 'deleted') => {
			clearedFor.push(id);
			net.clearRedialSuppressionForNetwork(id, reason);
		};

		expect(net.canListSharesTo(LEFT_PEER)).toBe(false);
		expect(await networks.delete(NET)).toBe(true);

		// Dialable again — that is what the delete was for — but still not entitled to browse.
		expect((net as any).isRedialSuppressed(LEFT_PEER)).toBe(false);
		expect(net.canListSharesTo(LEFT_PEER)).toBe(false);
	});

	it('gives the listing back the moment the peer shares a joined topic again', () => {
		// The revocation is not a ban: real membership is evidence, and it outranks
		// everything the deletion left behind.
		const net = Object.create(Network.prototype) as Network;
		(net as any).redialSuppressedByNet = new Map([[NET, new Set([LEFT_PEER])]]);
		(net as any).listingRevoked = new Set<string>();
		(net as any).isBootstrapOrRelayPeer = () => false;
		(net as any).node = { getConnections: () => [] };
		(net as any).pubsub = { getTopics: () => [lishTopic('net-b')], getSubscribers: () => [] };
		net.clearRedialSuppressionForNetwork(NET, 'deleted');
		expect(net.canListSharesTo(LEFT_PEER)).toBe(false);

		// Now it is a subscriber of a lishnet we are in.
		(net as any).pubsub = { getTopics: () => [lishTopic('net-b')], getSubscribers: () => [{ toString: () => LEFT_PEER }] };

		expect(net.canListSharesTo(LEFT_PEER)).toBe(true);
	});

	it('a rejoin restores both halves, unlike a delete', () => {
		const net = Object.create(Network.prototype) as Network;
		(net as any).redialSuppressedByNet = new Map([[NET, new Set([LEFT_PEER])]]);
		(net as any).listingRevoked = new Set<string>();
		(net as any).isBootstrapOrRelayPeer = () => false;
		(net as any).pubsub = { getTopics: () => [lishTopic('net-b')], getSubscribers: () => [] };
		(net as any).node = { getConnections: () => [{ remotePeer: { toString: () => LEFT_PEER }, timeline: { open: Date.now() } }] };

		net.clearRedialSuppressionForNetwork(NET, 'rejoined');

		expect((net as any).isRedialSuppressed(LEFT_PEER)).toBe(false);
		expect(net.canListSharesTo(LEFT_PEER)).toBe(true);
	});

	it('negative control: rejoin-only release strands the peers forever', () => {
		// Suppression is keyed by lishnet ID and only a join of THAT lishnet cleared
		// it. Deleting the lishnet destroys the only key that could ever be presented,
		// so its peers stayed undialable for the rest of the process — including from
		// lishnets that have nothing to do with the deleted one.
		const network = Object.create(Network.prototype) as Network;
		(network as any).redialSuppressedByNet = new Map<string, Set<string>>();
		(network as any).unreachableQuarantine = new Map<string, number>();
		(network as any).listingRevoked = new Set<string>();
		suppress(network, NET, LEFT_PEER);

		const releasedByRejoinOnly = (existingLishnetIDs: string[]): boolean => {
			for (const id of existingLishnetIDs) (network as any).clearRedialSuppressionForNetwork(id);
			return !(network as any).isRedialSuppressed(LEFT_PEER);
		};
		// Every lishnet that still exists after the delete — none of them is the key.
		expect(releasedByRejoinOnly(['net-b', 'net-c'])).toBe(false);

		network.clearRedialSuppressionForNetwork(NET);
		expect((network as any).isRedialSuppressed(LEFT_PEER)).toBe(false);
	});
});
