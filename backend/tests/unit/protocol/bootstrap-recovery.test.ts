import { describe, it, expect } from 'bun:test';
import { multiaddr } from '@multiformats/multiaddr';
import { Network, extractDestinationPeerID, isRecoveryDialEligible, nextRedialBackoff, orderBootstrapEntriesForRecovery, pruneBootstrapEntries } from '../../../src/protocol/network.ts';

/**
 * Zero-connection recovery walks the bootstrap entry list whenever the node
 * holds no connections. Three properties keep that loop from degenerating into
 * a permanent orphan sweep, and are covered here:
 *
 *  - it paces entries through the same redialBackoff map re-dial maintenance
 *    uses (a peer aged out of the peerStore never becomes a maintenance
 *    candidate, so recovery is the only loop left that can pace it);
 *  - configured entries — user data — are dialed before gossip-discovered ones;
 *  - discovered entries age out and are capped, so an address whose peer is
 *    long dead eventually leaves the list entirely.
 *
 * Peer IDs are fake placeholders and addresses use RFC5737 documentation ranges.
 */

const PEER_A = '12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const ADDR_A = `/ip4/192.0.2.1/tcp/9090/p2p/${PEER_A}`;
const ADDR_B = `/ip4/198.51.100.7/tcp/9090/p2p/${PEER_B}`;

interface IEntrySpec {
	addr: string;
	configured: boolean;
	addedAt?: number;
}

function entry(spec: IEntrySpec) {
	const ma = multiaddr(spec.addr);
	return { ma, peerID: extractDestinationPeerID(ma), configured: spec.configured, addedAt: spec.addedAt ?? Date.now() };
}

/**
 * A Network with only the fields zero-connection recovery touches, plus a fake
 * node recording dials. `livePeers` models what `node.getPeers()` reports at
 * the moment recovery runs — deliberately independent of any snapshot the
 * status tick may have taken earlier.
 */
function bareNetwork(opts: { entries: IEntrySpec[]; suppressed?: string[]; livePeers?: string[]; failDial?: boolean }) {
	const dialed: string[] = [];
	const network = Object.create(Network.prototype) as Network;
	(network as any).bootstrapEntries = opts.entries.map(entry);
	(network as any).bootstrapPeerIDs = new Set((network as any).bootstrapEntries.map((e: { peerID: string | null }) => e.peerID));
	(network as any).redialBackoff = new Map<string, { nextAttempt: number; failCount: number }>();
	(network as any).redialSuppressedByNet = new Map([['net-x', new Set<string>(opts.suppressed ?? [])]]);
	(network as any).recentDisconnects = [];
	(network as any).bootstrapTracker = { entries: () => [] };
	(network as any).node = {
		getPeers: () => (opts.livePeers ?? []).map(p => ({ toString: () => p })),
		async dial(ma: { toString(): string }): Promise<void> {
			dialed.push(ma.toString());
			if (opts.failDial) throw new Error('dial failed');
		},
	};
	const run = (): Promise<void> => (network as any).runZeroConnectionRecovery();
	return { network, dialed, run };
}

describe('Network.runZeroConnectionRecovery — backoff pacing', () => {
	it('skips an address whose peer is inside its backoff window', async () => {
		const { network, dialed, run } = bareNetwork({ entries: [{ addr: ADDR_A, configured: false }] });
		(network as any).redialBackoff.set(PEER_A, { nextAttempt: Date.now() + 60_000, failCount: 1 });
		await run();
		expect(dialed).toEqual([]);
	});

	it('dials the same address again once the backoff window expires', async () => {
		const { network, dialed, run } = bareNetwork({ entries: [{ addr: ADDR_A, configured: false }] });
		(network as any).redialBackoff.set(PEER_A, { nextAttempt: Date.now() - 1, failCount: 1 });
		await run();
		expect(dialed).toEqual([multiaddr(ADDR_A).toString()]);
	});

	it('records a backoff after a failed recovery dial so the next tick paces it', async () => {
		const { network, dialed, run } = bareNetwork({ entries: [{ addr: ADDR_A, configured: false }], failDial: true });
		await run();
		expect(dialed.length).toBe(1);
		const bo = (network as any).redialBackoff.get(PEER_A);
		expect(bo.failCount).toBe(1);
		expect(bo.nextAttempt).toBeGreaterThan(Date.now());
		// Second tick with the fresh backoff in place must not re-dial.
		dialed.length = 0;
		await run();
		expect(dialed).toEqual([]);
	});

	it('clears the backoff after a successful recovery dial', async () => {
		const { network, run } = bareNetwork({ entries: [{ addr: ADDR_A, configured: false }] });
		(network as any).redialBackoff.set(PEER_A, { nextAttempt: Date.now() - 1, failCount: 3 });
		await run();
		expect((network as any).redialBackoff.has(PEER_A)).toBe(false);
	});

	it('still skips a peer suppressed by leave-network even with no backoff', async () => {
		const { dialed, run } = bareNetwork({ entries: [{ addr: ADDR_A, configured: true }], suppressed: [PEER_A] });
		await run();
		expect(dialed).toEqual([]);
	});
});

describe('Network.runZeroConnectionRecovery — ordering and liveness', () => {
	it('dials a configured entry before a gossip-discovered one', async () => {
		// Discovered entry is appended first, so plain array order would dial it first.
		const { dialed, run } = bareNetwork({
			entries: [
				{ addr: ADDR_B, configured: false },
				{ addr: ADDR_A, configured: true },
			],
			failDial: true,
		});
		await run();
		expect(dialed).toEqual([multiaddr(ADDR_A).toString(), multiaddr(ADDR_B).toString()]);
	});

	it('does not run when a live connection exists, even though the tick snapshot said zero', async () => {
		// The status tick snapshots connected peers BEFORE re-dial maintenance runs;
		// that pass can connect a peer, making the snapshot a stale zero.
		const { dialed, run } = bareNetwork({ entries: [{ addr: ADDR_A, configured: true }], livePeers: [PEER_B] });
		await run();
		expect(dialed).toEqual([]);
	});
});

describe('Network.pruneBootstrapEntries — orphan expiry', () => {
	const TTL_MS = 7_200_000;

	it('drops an expired discovered entry and forgets its peer ID', async () => {
		const { network, dialed, run } = bareNetwork({
			entries: [
				{ addr: ADDR_A, configured: true },
				{ addr: ADDR_B, configured: false, addedAt: Date.now() - TTL_MS - 1 },
			],
			failDial: true,
		});
		await run();
		expect((network as any).bootstrapEntries.length).toBe(1);
		expect(dialed).toEqual([multiaddr(ADDR_A).toString()]);
		// Forgetting the ID is what lets a later announce of the same address back in.
		expect((network as any).bootstrapPeerIDs.has(PEER_B)).toBe(false);
		expect((network as any).bootstrapPeerIDs.has(PEER_A)).toBe(true);
	});

	it('never expires a configured entry, however old', async () => {
		const { network, dialed, run } = bareNetwork({ entries: [{ addr: ADDR_A, configured: true, addedAt: Date.now() - TTL_MS * 100 }], failDial: true });
		await run();
		expect((network as any).bootstrapEntries.length).toBe(1);
		expect(dialed).toEqual([multiaddr(ADDR_A).toString()]);
	});
});

/**
 * Re-dial maintenance prunes backoff entries for peers that left the peerStore.
 * That prune must spare peers still reachable through a bootstrap entry: those
 * are exactly the orphans zero-connection recovery keeps dialing, and wiping
 * their backoff every tick would hand the recovery loop a clean slate forever.
 */
describe('Network.runRedialMaintenance — backoff prune exemption', () => {
	function bareNetwork(entries: IEntrySpec[]) {
		const network = Object.create(Network.prototype) as Network;
		(network as any).bootstrapEntries = entries.map(entry);
		(network as any).redialBackoff = new Map<string, { nextAttempt: number; failCount: number }>();
		(network as any).redialSuppressedByNet = new Map<string, Set<string>>();
		(network as any).pubsub = { getTopics: () => [], getSubscribers: () => [] };
		(network as any).node = { async dial(): Promise<void> {}, getConnections: () => [] };
		return network;
	}

	// Empty peerStore models a peer that aged out past maxPeerAge.
	const run = (network: Network): Promise<void> => (network as any).runRedialMaintenance([], []);

	it('keeps the backoff of a peer that aged out of the peerStore but still has a bootstrap entry', async () => {
		const network = bareNetwork([{ addr: ADDR_A, configured: false }]);
		(network as any).redialBackoff.set(PEER_A, { nextAttempt: Date.now() + 60_000, failCount: 2 });
		await run(network);
		expect((network as any).redialBackoff.has(PEER_A)).toBe(true);
	});

	it('still prunes the backoff of a peer with neither a peerStore entry nor a bootstrap entry', async () => {
		const network = bareNetwork([]);
		(network as any).redialBackoff.set(PEER_B, { nextAttempt: Date.now() + 60_000, failCount: 2 });
		await run(network);
		expect((network as any).redialBackoff.has(PEER_B)).toBe(false);
	});
});

describe('pruneBootstrapEntries', () => {
	const now = 1_000_000_000;

	const discovered = (addedAt: number, peerID: string | null = null): { configured: boolean; addedAt: number; peerID: string | null } => ({ configured: false, addedAt, peerID });

	it('keeps discovered entries inside the TTL', () => {
		const entries = [discovered(now - 10)];
		expect(pruneBootstrapEntries(entries, now, 100, 10)).toEqual(entries);
	});

	it('drops discovered entries past the TTL', () => {
		expect(pruneBootstrapEntries([discovered(now - 101)], now, 100, 10)).toEqual([]);
	});

	it('keeps configured entries past the TTL', () => {
		const entries = [{ configured: true, addedAt: now - 10_000, peerID: null }];
		expect(pruneBootstrapEntries(entries, now, 100, 10)).toEqual(entries);
	});

	it('caps discovered entries at the bound, keeping the newest', () => {
		const entries = [
			{ ...discovered(now - 3), tag: 'oldest' },
			{ ...discovered(now - 2), tag: 'mid' },
			{ ...discovered(now - 1), tag: 'newest' },
		];
		expect(pruneBootstrapEntries(entries, now, 100, 2).map(e => e.tag)).toEqual(['mid', 'newest']);
	});

	it('does not count configured entries against the bound nor drop them', () => {
		const entries = [
			{ configured: true, addedAt: now - 9, peerID: null, tag: 'cfg1' },
			{ configured: true, addedAt: now - 8, peerID: null, tag: 'cfg2' },
			{ ...discovered(now - 2), tag: 'disc1' },
			{ ...discovered(now - 1), tag: 'disc2' },
		];
		expect(pruneBootstrapEntries(entries, now, 100, 2).map(e => e.tag)).toEqual(['cfg1', 'cfg2', 'disc1', 'disc2']);
	});

	/**
	 * Membership of the entry list also decides whether a peer is re-tagged
	 * KEEP_ALIVE when it connects, and that tag is what drives libp2p's reconnect
	 * queue. Ageing out a peer purely because the connection has been up longer
	 * than the TTL would silently demote the healthiest peers we have.
	 */
	it('never expires a discovered entry whose peer is connected right now', () => {
		const entries = [discovered(now - 10_000, PEER_A)];
		expect(pruneBootstrapEntries(entries, now, 100, 10, pid => pid === PEER_A)).toEqual(entries);
	});

	it('expires that same entry once the peer is no longer connected', () => {
		expect(pruneBootstrapEntries([discovered(now - 10_000, PEER_A)], now, 100, 10, () => false)).toEqual([]);
	});

	it('does not count a connected discovered peer against the bound nor drop it', () => {
		const entries = [
			{ ...discovered(now - 3, PEER_A), tag: 'connected' },
			{ ...discovered(now - 2), tag: 'disc1' },
			{ ...discovered(now - 1), tag: 'disc2' },
		];
		expect(pruneBootstrapEntries(entries, now, 100, 2, pid => pid === PEER_A).map(e => e.tag)).toEqual(['connected', 'disc1', 'disc2']);
	});
});

describe('orderBootstrapEntriesForRecovery', () => {
	it('puts configured entries first and preserves order inside each group', () => {
		const entries = [
			{ configured: false, tag: 'd1' },
			{ configured: true, tag: 'c1' },
			{ configured: false, tag: 'd2' },
			{ configured: true, tag: 'c2' },
		];
		expect(orderBootstrapEntriesForRecovery(entries).map(e => e.tag)).toEqual(['c1', 'c2', 'd1', 'd2']);
	});
});

describe('isRecoveryDialEligible', () => {
	const never = (): boolean => false;
	const now = 1_000;

	const disc = (peerID: string | null): { peerID: string | null; configured: boolean } => ({ peerID, configured: false });
	const cfg = (peerID: string | null): { peerID: string | null; configured: boolean } => ({ peerID, configured: true });

	it('allows an address with no peer id — nothing to pace or suppress on', () => {
		expect(isRecoveryDialEligible(disc(null), now, never, new Map())).toBe(true);
	});

	it('blocks a suppressed peer', () => {
		expect(isRecoveryDialEligible(disc(PEER_A), now, pid => pid === PEER_A, new Map())).toBe(false);
	});

	it('blocks a discovered peer inside its backoff window and allows it once past', () => {
		expect(isRecoveryDialEligible(disc(PEER_A), now, never, new Map([[PEER_A, { nextAttempt: now + 1 }]]))).toBe(false);
		expect(isRecoveryDialEligible(disc(PEER_A), now, never, new Map([[PEER_A, { nextAttempt: now }]]))).toBe(true);
	});

	/**
	 * This loop is the last resort of a node with no connections at all. Pacing the
	 * user's own bootstrap list would turn a recovered uplink into a wait of up to
	 * the backoff ceiling, to save a handful of dials on a list that never grows on
	 * its own — the unbounded gossip-fed entries are the ones pacing is for.
	 */
	it('ignores the backoff window for a configured entry', () => {
		expect(isRecoveryDialEligible(cfg(PEER_A), now, never, new Map([[PEER_A, { nextAttempt: now + 600_000 }]]))).toBe(true);
	});

	it('still blocks a configured entry the user left via leave-network', () => {
		expect(isRecoveryDialEligible(cfg(PEER_A), now, pid => pid === PEER_A, new Map())).toBe(false);
	});
});

describe('nextRedialBackoff', () => {
	it('doubles the delay per consecutive failure', () => {
		expect(nextRedialBackoff(0, 0)).toEqual({ nextAttempt: 30_000, failCount: 1 });
		expect(nextRedialBackoff(1, 0)).toEqual({ nextAttempt: 60_000, failCount: 2 });
		expect(nextRedialBackoff(2, 0)).toEqual({ nextAttempt: 120_000, failCount: 3 });
	});

	it('caps the delay at 10 minutes', () => {
		expect(nextRedialBackoff(20, 0).nextAttempt).toBe(600_000);
	});
});

describe('extractDestinationPeerID', () => {
	it('returns the peer id of a plain address', () => {
		expect(extractDestinationPeerID(multiaddr(ADDR_A))).toBe(PEER_A);
	});

	it('returns the target, not the relay, for a circuit address', () => {
		expect(extractDestinationPeerID(multiaddr(`/ip4/203.0.113.9/tcp/9090/p2p/${PEER_A}/p2p-circuit/p2p/${PEER_B}`))).toBe(PEER_B);
	});

	it('returns null when the address carries no peer id', () => {
		expect(extractDestinationPeerID(multiaddr('/ip4/203.0.113.9/tcp/9090'))).toBe(null);
	});
});
