import { describe, it, expect } from 'bun:test';
import { Network } from '../../../src/protocol/network.ts';

/**
 * A destructive operation started on one libp2p node must never finish against the
 * next one. Both paths below await in the middle, and both used to re-read
 * `this.node` (or re-evaluate the run epoch) afterwards — so a stop()/start()
 * landing in that window handed them the NEW node to hang up, purge and evict on.
 */

const PEER_ID = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
const ADDR = `/ip4/192.0.2.10/tcp/9090/p2p/${PEER_ID}`;

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>(res => {
		resolve = res;
	});
	return { promise, resolve };
}

describe('Network.disconnectPeer — bound to the node it started on', () => {
	function harness() {
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		// A prototype-only instance has no field initializers: disconnectPeer binds itself to
		// this run's cancellation and needs a controller to read.
		(network as any).dialAbort = new AbortController();
		(network as any).redialSuppressedByNet = new Map<string, Set<string>>();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).pubsub = null;
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).redialBackoff = new Map();
		(network as any).unreachableQuarantine = new Map();

		const gate = deferred();
		const touchedByOld: string[] = [];
		const nodeA = {
			getConnections: (): unknown[] => [],
			async hangUp(): Promise<void> {
				touchedByOld.push('A.hangUp');
			},
			peerStore: {
				async merge(): Promise<void> {
					await gate.promise;
				},
				async delete(): Promise<void> {
					touchedByOld.push('A.delete');
				},
			},
		};
		const touchedByNew: string[] = [];
		const nodeB = {
			getConnections: (): unknown[] => [],
			async hangUp(): Promise<void> {
				touchedByNew.push('B.hangUp');
			},
			peerStore: {
				async merge(): Promise<void> {},
				async delete(): Promise<void> {
					touchedByNew.push('B.delete');
				},
			},
		};
		(network as any).node = nodeA;
		return { network, nodeB, gate, touchedByOld, touchedByNew };
	}

	it('does not hang up or purge on the node that replaced it mid-flight', async () => {
		const { network, nodeB, gate, touchedByNew } = harness();

		const leaving = network.disconnectPeer(PEER_ID, 'net-a');
		await Promise.resolve();
		// stop() + start(): a new epoch and a new node, exactly as a restart leaves them.
		(network as any).runEpoch = 2;
		(network as any).node = nodeB;
		gate.resolve();
		await leaving;

		expect(touchedByNew).toEqual([]);
	});

	it('does not purge on the new node when the restart lands during the hangUp', async () => {
		const { network, nodeB, gate, touchedByNew } = harness();
		const hangUpGate = deferred();
		(network as any).node.hangUp = async (): Promise<void> => {
			await hangUpGate.promise;
		};

		const leaving = network.disconnectPeer(PEER_ID, 'net-a');
		await Promise.resolve();
		gate.resolve();
		await Promise.resolve();
		await Promise.resolve();
		(network as any).runEpoch = 2;
		(network as any).node = nodeB;
		hangUpGate.resolve();
		await leaving;

		expect(touchedByNew).toEqual([]);
	});

	it('still completes normally when no restart happens', async () => {
		const { network, gate, touchedByOld } = harness();

		const leaving = network.disconnectPeer(PEER_ID, 'net-a');
		await Promise.resolve();
		gate.resolve();
		await leaving;

		expect(touchedByOld).toEqual(['A.hangUp', 'A.delete']);
	});
});

describe('Network.addBootstrapPeers — a dial that lands after a restart', () => {
	function harness() {
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		// The peer is suppressed, so a dial landing on THIS run would legitimately take
		// the destructive "landed after leave" branch. After a restart it must not.
		(network as any).redialSuppressedByNet = new Map([['net-a', new Set([PEER_ID])]]);
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapTracker = {
			noteMention(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			markPending(): void {},
			recordOutcome(): void {},
		};
		const gate = deferred<{ remoteAddr: string }>();
		(network as any).node = {
			peerId: { toString: (): string => 'selfID' },
			getConnections: (): unknown[] => [],
			dial: (): Promise<{ remoteAddr: string }> => gate.promise,
			peerStore: { async merge(): Promise<void> {} },
		};
		const disconnected: string[] = [];
		(network as any).disconnectPeer = async (pid: string): Promise<void> => {
			disconnected.push(pid);
		};
		return { network, gate, disconnected };
	}

	it('does not disconnect on the new node when the epoch moved on', async () => {
		const { network, gate, disconnected } = harness();

		const dialing = (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		await Promise.resolve();
		(network as any).runEpoch = 2;
		gate.resolve({ remoteAddr: ADDR });
		await dialing;

		expect(disconnected).toEqual([]);
	});

	it('a dial settling after a restart does not release the claim of the new run', async () => {
		const { network } = harness();
		let dials = 0;
		const gates: Array<{ promise: Promise<{ remoteAddr: string }>; resolve: (v: { remoteAddr: string }) => void }> = [];
		(network as any).node.dial = (): Promise<{ remoteAddr: string }> => {
			dials++;
			let resolve!: (v: { remoteAddr: string }) => void;
			const promise = new Promise<{ remoteAddr: string }>(res => {
				resolve = res;
			});
			gates.push({ promise, resolve });
			return promise;
		};

		// Run A claims the address on the old node.
		const runA = (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		await Promise.resolve();
		expect(dials).toBe(1);

		// Teardown hands the next run a fresh claim table; run B takes the address in it.
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
		(network as any).runEpoch = 2;
		const runB = (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		await Promise.resolve();
		expect(dials).toBe(2);

		// Run A finally settles. Its release must land in the table it claimed from.
		gates[0]!.resolve({ remoteAddr: ADDR });
		await runA;

		// A third request for the same address must still find run B's claim in place.
		const runC = (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		await Promise.resolve();
		expect(dials).toBe(2);

		gates[1]!.resolve({ remoteAddr: ADDR });
		await Promise.all([runB, runC]);
	});

	it('still disconnects when the dial lands on the same run after a leave', async () => {
		const { network, gate, disconnected } = harness();
		// A leave bumps the generation; that must NOT short-circuit ahead of the
		// disconnect — the connection this dial just opened is the thing to close.
		(network as any).bootstrapGeneration = new Map([['net-a', 1]]);

		const dialing = (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		await Promise.resolve();
		(network as any).bootstrapGeneration.set('net-a', 2);
		gate.resolve({ remoteAddr: ADDR });
		await dialing;

		expect(disconnected).toEqual([PEER_ID]);
	});
});

/**
 * Production starts the node with an empty bootstrap list, so the config-time
 * `directPeers` seed never applies. A configured bootstrap therefore has to enter the
 * gossipsub direct set on acceptance — waiting for the periodic promotion left the peer
 * the whole mesh depends on PRUNE-able and without a fast reconnect for ~150 s.
 */
describe('Network.addBootstrapPeers — configured bootstraps become direct peers at once', () => {
	function harness(suppressed: string[] = []) {
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map([['net-a', new Set(suppressed)]]);
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapTracker = {
			noteMention(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			markPending(): void {},
			recordOutcome(): void {},
		};
		const direct = new Set<string>();
		(network as any).pubsub = { direct };
		(network as any).node = {
			peerId: { toString: (): string => 'selfID' },
			getConnections: (): unknown[] => [],
			dial: async (): Promise<{ remoteAddr: string }> => ({ remoteAddr: ADDR }),
			peerStore: { async merge(): Promise<void> {} },
		};
		(network as any).isPeerNeededByJoinedNetwork = (): boolean => false;
		(network as any).isTopicSubscribed = (): boolean => true;
		(network as any).rememberBootstrapAddress = (): void => {};
		return { network, direct };
	}

	it('adds a configured bootstrap on the dial that accepts it', async () => {
		const { network, direct } = harness();

		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');

		expect([...direct]).toEqual([PEER_ID]);
	});

	it('leaves a merely discovered peer to the periodic promotion', async () => {
		const { network, direct } = harness();

		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');

		expect([...direct]).toEqual([]);
	});
});

/**
 * The configured-bootstrap lifecycle hands a peer two things when it answers a dial: a
 * gossipsub `direct` entry (never PRUNEd, redialed every directConnectTicks) and a
 * KEEP_ALIVE tag (libp2p redials it, the connection manager will not evict it). Removing
 * the entry from the configuration used to take back neither, so the peer the user
 * deleted went on being dialed for the rest of the run.
 */
describe('Network.pruneConfiguredBootstrapPeer — gives back what the entry was granted', () => {
	function harness(neededByJoined: boolean) {
		const network = Object.create(Network.prototype) as Network;
		const direct = new Set<string>();
		const merges: Array<Record<string, unknown>> = [];
		(network as any).pubsub = { direct };
		(network as any).node = {
			peerStore: {
				async merge(_pid: unknown, data: Record<string, unknown>): Promise<void> {
					merges.push(data);
				},
			},
		};
		(network as any).configuredBootstrapPeerIDs = new Set<string>([PEER_ID]);
		(network as any).bootstrapPeerIDs = new Set<string>([PEER_ID]);
		(network as any).bootstrapMultiaddrs = [];
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).addressProbeBackoff = new Map();
		(network as any).isPeerNeededByJoinedNetwork = (): boolean => neededByJoined;
		(network as any).isRedialSuppressed = (): boolean => false;
		(network as any).addGossipsubDirectPeer(PEER_ID);
		return { network, direct, merges };
	}

	it('takes the direct entry and the keep-alive tag back', async () => {
		const { network, direct, merges } = harness(false);
		expect(direct.has(PEER_ID)).toBe(true);

		network.pruneConfiguredBootstrapPeer(PEER_ID);
		// The tag removal is a fire-and-forget merge on the captured node.
		for (let i = 0; i < 6; i++) await Promise.resolve();

		expect(direct.has(PEER_ID)).toBe(false);
		expect(merges).toEqual([{ tags: { 'keep-alive': undefined } }]);
	});

	it('leaves the keep-alive tag alone while a joined network still wants the peer', async () => {
		const { network, direct, merges } = harness(true);

		network.pruneConfiguredBootstrapPeer(PEER_ID);
		for (let i = 0; i < 6; i++) await Promise.resolve();

		// The direct entry belongs to the bootstrap lifecycle and goes; the tag is now the
		// joined network's, and the periodic promotion re-adds the direct entry if wanted.
		expect(direct.has(PEER_ID)).toBe(false);
		expect(merges).toEqual([]);
	});
});
