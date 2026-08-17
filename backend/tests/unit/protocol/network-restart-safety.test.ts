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
		(network as any).redialSuppressedByNet = new Map<string, Set<string>>();
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
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Set<string>();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapTracker = {
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
