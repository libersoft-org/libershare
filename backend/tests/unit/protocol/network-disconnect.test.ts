import { describe, it, expect } from 'bun:test';
import { KEEP_ALIVE } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import { Network, normalizeMultiaddrForCompare } from '../../../src/protocol/network.ts';
import { installBootstrapRegistry, type IRegistrySeed } from '../helpers/bootstrap-registry.ts';
import { createEmptyPeerStore } from '../helpers/real-peer-store.ts';
import { peerIdFromString } from '@libp2p/peer-id';
import { MemoryDatastore } from 'datastore-core';

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
	// A real peerStore: the purge that ends the disconnect decides and deletes under the
	// store's own per-peer write lock, through its unlocked inner load/delete. Only the
	// real store has either, and the durable delete is the whole point of this teardown.
	const peerStore = createEmptyPeerStore();
	const inner = (peerStore as any).store;
	const dropRecord = inner.delete.bind(inner);
	inner.delete = async (id: { toString(): string }): Promise<void> => {
		deleted.push(id.toString());
		await dropRecord(id);
	};
	// The tag removal is asserted from the patch it was handed, so it stays a spy.
	peerStore.merge = async (_pid: unknown, patch: { tags: Record<string, unknown> }): Promise<void> => {
		merges.push(patch);
	};
	const network = Object.create(Network.prototype) as Network;
	(network as any).redialSuppressedByNet = new Map<string, Set<string>>();
	(network as any).configuredBootstrapPeerIDs = new Set<string>();
	(network as any).pubsub = null;
	(network as any).bootstrapGeneration = new Map();
	(network as any).inFlightBootstrapDials = new Map();
	(network as any).dialAbort = new AbortController();
	(network as any).bootstrapPeerIDs = new Set<string>();
	installBootstrapRegistry(network, []);
	(network as any).redialBackoff = new Map();
	(network as any).node = {
		getConnections: () => [],
		peerStore,
		async hangUp(pid: { toString(): string }): Promise<void> {
			hungUp.push(pid.toString());
		},
	};
	const suppressed = (pid: string): boolean => (network as any).isRedialSuppressed(pid);
	return { network, merges, hungUp, deleted, suppressed, peerStore, pid: peerIdFromString(PEER_ID) };
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
 * The peerStore delete is the only part of a leave that outlives the process: suppression,
 * the registry, the dedup set and the gossipsub direct entry are all in memory, and redial
 * maintenance walks EVERY stored record — not just keep-alive-tagged ones — so a row that
 * survived a leave dials the peer the user just left straight back after a restart.
 * Swallowing that failure is fine for periodic eviction, where another cycle is coming; on
 * an explicit leave it reports a disconnect the disk disagrees with.
 */
describe('Network.disconnectPeer — a failed durable delete must not report success', () => {
	const ADDR = `/ip4/203.0.113.71/tcp/9090/p2p/${PEER_ID}`;

	async function leavingNetwork(onDelete: (removeTheRow: () => Promise<void>) => Promise<never>) {
		// One datastore, two stores: the second one stands in for the next process start,
		// which is where a surviving row does its damage.
		const datastore = new MemoryDatastore();
		const peerStore = createEmptyPeerStore(datastore);
		const pid = peerIdFromString(PEER_ID);
		await peerStore.patch(pid, { multiaddrs: [multiaddr(ADDR)], tags: { [KEEP_ALIVE]: { value: 1 } } });
		// The removal goes through a SECOND store over the same datastore — the shape of
		// something outside this call having got there first, rather than of this delete
		// half-succeeding. Through that store's inner, unlocked delete: mortice locks are
		// keyed by peer id across every store in the process, and the public wrapper would
		// queue behind the write lock this very call is holding.
		(peerStore as any).store.delete = async (): Promise<never> => onDelete(async () => (createEmptyPeerStore(datastore) as any).store.delete(pid));
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map<string, Set<string>>();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).redialBackoff = new Map();
		installBootstrapRegistry(network, []);
		(network as any).node = {
			getConnections: () => [],
			peerStore,
			async hangUp(): Promise<void> {},
		};
		return { network, datastore, pid };
	}

	it('rejects, and the row is still there for the next start to find', async () => {
		const { network, datastore, pid } = await leavingNetwork(async () => {
			throw Object.assign(new Error('database is locked'), { name: 'SqliteError' });
		});
		await expect(network.disconnectPeer(PEER_ID, NET)).rejects.toThrow('database is locked');
		// Reopened over the same datastore, the way a restart would see it.
		expect(await createEmptyPeerStore(datastore).has(pid)).toBe(true);
	});

	it('reports success when the record turns out to be gone already', async () => {
		const { network, datastore, pid } = await leavingNetwork(async removeTheRow => {
			await removeTheRow();
			throw Object.assign(new Error('not found'), { name: 'NotFoundError', code: 'ERR_NOT_FOUND' });
		});
		await network.disconnectPeer(PEER_ID, NET);
		// The row really is gone — which is the outcome the leave asked for, so the delete
		// that found nothing left to remove must not be reported as a failure.
		expect(await createEmptyPeerStore(datastore).has(pid)).toBe(false);
	});
});

/**
 * The peer:discovery handler is fire-and-forget and awaits twice — a peerStore merge and
 * a dial. It used to check suppression only at entry and to re-read `this.node` after
 * every await, so a leave-network landing inside the window was simply overridden, and a
 * stop()/start() had the old run's listener drive the new node.
 */
describe('Network.handleDiscoveredPeer — post-await re-checks', () => {
	function makeNetwork() {
		const dialed: string[][] = [];
		const hungUp: string[] = [];
		const merges: Array<Record<string, unknown>> = [];
		const gates: Array<() => void> = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).redialSuppressedByNet = new Map<string, Set<string>>();
		(network as any).runEpoch = 1;
		(network as any).pubsub = { getTopics: () => [], getSubscribers: () => [] };
		// isPeerNeededByJoinedNetwork reaches for all three; leaving any undefined throws
		// inside the handler's try block, which then reads as "the dial failed".
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).peerAnnounce = { getRecentMembers: () => [] };
		const node = {
			peerId: { toString: () => 'selfID' },
			getConnections: () => [],
			peerStore: {
				async merge(_pid: unknown, patch: { tags: Record<string, unknown> }): Promise<void> {
					merges.push(patch.tags);
				},
			},
			async dial(addrs: Array<{ toString(): string }>): Promise<void> {
				dialed.push(addrs.map(a => a.toString()));
				// Park the dial so a test can act while it is still in flight. The timer is
				// a backstop: a test that reaches a dial it did not expect must fail on its
				// assertion, not hang the suite waiting for a release that never comes.
				await new Promise<void>(resolve => {
					gates.push(resolve);
					setTimeout(resolve, 250);
				});
			},
			async hangUp(pid: { toString(): string }): Promise<void> {
				hungUp.push(pid.toString());
			},
		};
		(network as any).node = node;
		const detail = { id: { toString: () => PEER_ID }, multiaddrs: [multiaddr('/ip4/203.0.113.5/tcp/9090')] };
		const run = (): Promise<void> => (network as any).handleDiscoveredPeer(detail, node, 1);
		const releaseDial = (): void => gates.forEach(g => g());
		return { network, node, dialed, hungUp, merges, run, releaseDial };
	}

	/** Let the handler run up to its parked dial — it awaits the tag merge before that. */
	const untilDialing = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

	it('dials a freshly discovered peer', async () => {
		const { dialed, run, releaseDial } = makeNetwork();
		const pending = run();
		await untilDialing();
		expect(dialed.length).toBe(1);
		releaseDial();
		await pending;
	});

	it('hangs up a dial that completed after leave-network', async () => {
		const { network, hungUp, run, releaseDial } = makeNetwork();
		const pending = run();
		await untilDialing();
		// The leave lands while the dial is still in flight — exactly the window in which
		// hangUp finds nothing to close and reports success.
		(network as any).addRedialSuppression('net-a', PEER_ID);
		releaseDial();
		await pending;
		expect(hungUp).toEqual([PEER_ID]);
	});

	it('keeps a late dial whose peer another joined lishnet still needs', async () => {
		const { network, hungUp, run, releaseDial } = makeNetwork();
		const pending = run();
		await untilDialing();
		(network as any).addRedialSuppression('net-a', PEER_ID);
		(network as any).isPeerNeededByJoinedNetwork = (): boolean => true;
		releaseDial();
		await pending;
		expect(hungUp).toEqual([]);
	});

	it('does not dial when a stop landed while the tag merge was in flight', async () => {
		const { network, node, dialed } = makeNetwork();
		node.peerStore.merge = async (): Promise<void> => {
			(network as any).runEpoch = 2;
		};
		await (network as any).handleDiscoveredPeer({ id: { toString: () => PEER_ID }, multiaddrs: [multiaddr('/ip4/203.0.113.5/tcp/9090')] }, node, 1);
		expect(dialed).toEqual([]);
	});

	it('does not dial when a restart swapped the node under the handler', async () => {
		const { network, node, dialed } = makeNetwork();
		node.peerStore.merge = async (): Promise<void> => {
			(network as any).node = { ...node };
		};
		await (network as any).handleDiscoveredPeer({ id: { toString: () => PEER_ID }, multiaddrs: [multiaddr('/ip4/203.0.113.5/tcp/9090')] }, node, 1);
		expect(dialed).toEqual([]);
	});

	it('takes back the keep-alive tag when a leave landed during the merge', async () => {
		// disconnectPeer strips the tags before this merge runs, so leaving ours behind
		// re-arms the ReconnectQueue re-dial the leave was there to prevent.
		const { network, node, merges, dialed } = makeNetwork();
		const realMerge = node.peerStore.merge.bind(node.peerStore);
		node.peerStore.merge = async (pid: unknown, patch: { tags: Record<string, unknown> }): Promise<void> => {
			await realMerge(pid, patch);
			(network as any).addRedialSuppression('net-a', PEER_ID);
		};
		await (network as any).handleDiscoveredPeer({ id: { toString: () => PEER_ID }, multiaddrs: [multiaddr('/ip4/203.0.113.5/tcp/9090')] }, node, 1);
		expect(dialed).toEqual([]);
		expect(merges.length).toBe(2);
		expect(merges[1]!['keep-alive-fleet']).toBeUndefined();
		expect(Object.keys(merges[1]!)).toContain('keep-alive-fleet');
	});
});

/**
 * A shutdown WAITS for the lishnet operations already under way, and a leave is a walk of
 * per-peer teardowns with no deadline of their own — one `hangUp` on a peer that never
 * acknowledges used to hold the whole stop, and the lishnet catalog behind it, indefinitely.
 * A deadline would be the wrong answer (the abandoned teardown would come back on a stopped
 * node); ending the work is the right one.
 */
describe('Network.disconnectPeer — bounded by the run it belongs to', () => {
	it('does nothing once this run has been cancelled', async () => {
		const { network, merges, hungUp, deleted } = makeNetwork();
		network.cancelRunOperations();

		await network.disconnectPeer(PEER_ID, NET);

		expect(merges).toEqual([]);
		expect(hungUp).toEqual([]);
		expect(deleted).toEqual([]);
	});

	it('hands the run signal to the awaits a cancellation has to reach', async () => {
		const { network } = makeNetwork();
		const signals: unknown[] = [];
		(network as any).node.peerStore.merge = async (_pid: unknown, _patch: unknown, opts?: { signal?: AbortSignal }): Promise<void> => {
			signals.push(opts?.signal);
		};
		(network as any).node.hangUp = async (_pid: unknown, opts?: { signal?: AbortSignal }): Promise<void> => {
			signals.push(opts?.signal);
		};

		await network.disconnectPeer(PEER_ID, NET);

		// The tag removal and the hangUp: the two awaits between the start of a teardown and
		// the point where it can no longer block anything.
		expect(signals.length).toBe(2);
		for (const signal of signals) expect(signal).toBe((network as any).dialAbort.signal);
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
		// A prototype-only instance has no field initializers: disconnectPeer binds itself to
		// this run's cancellation and needs a controller to read.
		(network as any).dialAbort = new AbortController();
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
		(network as any).redialBackoff = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapPeerIDs = new Set<string>();
		installBootstrapRegistry(network, seeds);
		(network as any).recentDisconnects = [];
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			entries: () => [],
		};
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
		await run(network);
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
		(network as any).redialBackoff = new Map();
		(network as any).addressProbeBackoff = new Map();
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
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
