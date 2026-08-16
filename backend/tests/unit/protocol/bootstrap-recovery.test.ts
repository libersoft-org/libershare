import { describe, it, expect } from 'bun:test';
import { multiaddr } from '@multiformats/multiaddr';
import { Network, bootstrapEntryLastActivity, nextRecoveryBackoff, normalizeMultiaddrForCompare, orderBootstrapEntriesForRecovery, pruneBootstrapEntries, type IBootstrapEntry } from '../../../src/protocol/network.ts';
import { installBootstrapRegistry, registryAddresses, type IRegistrySeed } from '../helpers/bootstrap-registry.ts';

/**
 * The bootstrap registry is what zero-connection recovery walks. It is keyed by the
 * canonical ADDRESS rather than by the peer behind it, because one peer legitimately
 * has several addresses and a user can move a bootstrap to a new host while its
 * identity stays the same — an identity-keyed registry collapsed the first case and
 * treated the second as "already known", so the replaced address went on being dialed.
 *
 * Peer IDs are fake placeholders and addresses use RFC5737 documentation ranges.
 */

const PEER_A = '12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const ADDR_A = `/ip4/192.0.2.1/tcp/9090/p2p/${PEER_A}`;
const ADDR_A2 = `/ip4/192.0.2.2/tcp/9090/p2p/${PEER_A}`;
const ADDR_B = `/ip4/198.51.100.7/tcp/9090/p2p/${PEER_B}`;

const key = (address: string): string => normalizeMultiaddrForCompare(multiaddr(address).toString());

/**
 * A Network carrying only the fields the bootstrap paths touch, plus a fake node
 * recording dials. `livePeers` models what `node.getPeers()` reports at the moment the
 * loop runs — deliberately independent of the snapshot the status tick took earlier —
 * and is re-read on every call, so a test can make a connection appear mid-pass.
 */
function bareNetwork(opts: { seeds?: IRegistrySeed[]; suppressed?: string[]; livePeers?: string[]; failDial?: boolean; onDial?: (address: string) => void } = {}) {
	const dialed: string[] = [];
	const livePeers = [...(opts.livePeers ?? [])];
	const network = Object.create(Network.prototype) as Network;
	(network as any).runEpoch = 1;
	(network as any).redialBackoff = new Map();
	(network as any).recoveryBackoff = new Map();
	(network as any).unreachableQuarantine = new Map();
	(network as any).configuredBootstrapPeerIDs = new Set<string>();
	(network as any).bootstrapGeneration = new Map();
	(network as any).redialSuppressedByNet = new Map([['net-x', new Set<string>(opts.suppressed ?? [])]]);
	installBootstrapRegistry(network, opts.seeds ?? []);
	(network as any).bootstrapPeerIDs = new Set([...(network as any).addressesByPeer.keys()]);
	(network as any).recentDisconnects = [];
	(network as any).bootstrapTracker = { entries: () => [], markPending() {}, recordOutcome() {}, deletePeer() {} };
	(network as any).node = {
		peerId: { toString: () => 'selfID' },
		getPeers: () => livePeers.map(p => ({ toString: () => p })),
		getConnections: () => [],
		peerStore: {
			async merge(): Promise<void> {},
			async get(): Promise<unknown> {
				return { addresses: [] };
			},
			async patch(): Promise<void> {},
		},
		async dial(ma: { toString(): string }): Promise<unknown> {
			dialed.push(ma.toString());
			opts.onDial?.(ma.toString());
			if (opts.failDial) throw new Error('dial failed');
			return { remoteAddr: ma };
		},
	};
	const run = (): Promise<void> => (network as any).runZeroConnectionRecovery([]);
	return { network, dialed, livePeers, run };
}

describe('bootstrap registry — address identity', () => {
	it('stores a second address of a peer it already knows', async () => {
		// Peer-id dedup used to swallow this: the peer was "already a bootstrap peer",
		// so its other endpoint never entered the list and could never be recovered on.
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }] });
		await (network as any).addBootstrapPeers([ADDR_A2], 'net-a', 'configured');
		expect(registryAddresses(network)).toEqual([key(ADDR_A), key(ADDR_A2)]);
	});

	it('upgrades a discovered entry in place when the user configures that address', async () => {
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, lastVerifiedAt: 1_000 }] });
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		const entry = (network as any).bootstrapByAddress.get(key(ADDR_A)) as IBootstrapEntry;
		expect([...entry.configuredBy]).toEqual(['net-a']);
		// Upgraded, not replaced: the verification it already earned must survive, or the
		// TTL clock silently restarts every time the config is re-applied.
		expect(entry.lastVerifiedAt).not.toBe(null);
		expect(registryAddresses(network)).toEqual([key(ADDR_A)]);
	});
});

describe('bootstrap registry — per-network ownership', () => {
	it('keeps an address one network drops while another still configures it', () => {
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a', 'net-b'] }] });
		network.pruneBootstrapAddresses([ADDR_A], 'net-a');
		expect(registryAddresses(network)).toEqual([key(ADDR_A)]);
		expect([...((network as any).bootstrapByAddress.get(key(ADDR_A)) as IBootstrapEntry).configuredBy]).toEqual(['net-b']);
	});

	it('removes it once the last network drops it', () => {
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a', 'net-b'] }] });
		network.pruneBootstrapAddresses([ADDR_A], 'net-a');
		network.pruneBootstrapAddresses([ADDR_A], 'net-b');
		expect(registryAddresses(network)).toEqual([]);
	});

	it('never recovery-dials a removed configured address again', async () => {
		const { network, dialed, run } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }] });
		network.pruneBootstrapAddresses([ADDR_A], 'net-a');
		await run();
		expect(dialed).toEqual([]);
	});

	it('leaves a purely discovered entry alone when an unrelated config edit lands', () => {
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }, { address: ADDR_B }] });
		network.pruneConfiguredBootstrapPeer(PEER_A, 'net-a');
		expect(registryAddresses(network)).toEqual([key(ADDR_B)]);
	});
});

describe('bootstrap registry — identity mismatch', () => {
	const MISMATCH = `Payload identity key ${PEER_B} does not match expected remote identity key ${PEER_A}`;

	it('removes the disproved address from the registry', async () => {
		const { network } = bareNetwork({
			seeds: [
				{ address: ADDR_A, configuredBy: ['net-a'] },
				{ address: ADDR_A2, configuredBy: ['net-a'] },
			],
		});
		(network as any).purgeStalePeer = async (): Promise<void> => {};
		(network as any).node.dial = async (): Promise<never> => {
			throw new Error(MISMATCH);
		};
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		// Only the address Noise disproved goes; the sibling was never tested.
		expect(registryAddresses(network)).toEqual([key(ADDR_A2)]);
	});

	it('keeps a configured address that lives only in the registry', async () => {
		// The configured entry models a LAN or VPN bootstrap parked while its interface
		// is down: it is in the registry and NOT in the peerStore. A topic subscriber
		// announces a second address of the same peer, which Noise disproves. Counting
		// survivors from the peerStore alone read zero and purged the whole peer —
		// taking the configured address nothing had disproved with it.
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }, { address: ADDR_A2 }] });
		const purged: string[] = [];
		(network as any).purgeStalePeer = async (peerID: string): Promise<void> => {
			purged.push(peerID);
		};
		(network as any).node.dial = async (): Promise<never> => {
			throw new Error(MISMATCH);
		};
		await (network as any).addBootstrapPeers([ADDR_A2], 'net-a', 'discovered');
		expect(purged).toEqual([]);
		expect(registryAddresses(network)).toEqual([key(ADDR_A)]);
	});

	it('still purges once nothing undisproved is left anywhere', async () => {
		const { network } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }] });
		const purged: string[] = [];
		(network as any).purgeStalePeer = async (peerID: string): Promise<void> => {
			purged.push(peerID);
		};
		(network as any).node.dial = async (): Promise<never> => {
			throw new Error(MISMATCH);
		};
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		expect(purged).toEqual([PEER_A]);
	});

	it('stops recovery dialing a disproved CONFIGURED address', async () => {
		const { network, dialed } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }] });
		(network as any).purgeStalePeer = async (): Promise<void> => {};
		(network as any).node.dial = async (): Promise<never> => {
			throw new Error(MISMATCH);
		};
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		dialed.length = 0;
		await (network as any).runZeroConnectionRecovery([]);
		expect(dialed).toEqual([]);
	});
});

describe('Network.runZeroConnectionRecovery — per-address pacing', () => {
	it('paces the address that failed, not its working sibling', async () => {
		const { network, dialed, run } = bareNetwork({ seeds: [{ address: ADDR_A }, { address: ADDR_A2 }], failDial: true });
		(network as any).recoveryBackoff.set(key(ADDR_A), { nextAttempt: Date.now() + 60_000, failCount: 1 });
		await run();
		expect(dialed).toEqual([multiaddr(ADDR_A2).toString()]);
	});

	it('records an address backoff after a failed dial so the next pass skips it', async () => {
		const { network, dialed, run } = bareNetwork({ seeds: [{ address: ADDR_A }], failDial: true });
		await run();
		expect(dialed.length).toBe(1);
		const backoff = (network as any).recoveryBackoff.get(key(ADDR_A));
		expect(backoff.failCount).toBe(1);
		expect(backoff.nextAttempt).toBeGreaterThan(Date.now());
		dialed.length = 0;
		await run();
		expect(dialed).toEqual([]);
	});

	it('writes nothing when a stop lands while the successful dial is in flight', async () => {
		// The failure branch was fenced, the success branch was not. Canonical keys are
		// stable across runs, so the old run's result landed on the new run's entry.
		let net: any;
		const { network, run } = bareNetwork({
			seeds: [{ address: ADDR_A }],
			onDial: () => {
				net.runEpoch = 2;
			},
		});
		net = network;
		await run();
		expect(((network as any).bootstrapByAddress.get(key(ADDR_A)) as IBootstrapEntry).lastVerifiedAt).toBe(null);
	});

	it('does not mark an address verified when a sibling endpoint answered', async () => {
		// libp2p coalesces dials of one peer ID, so a resolved dial is not proof about
		// the address it was asked for — addBootstrapPeers reads the result for exactly
		// that reason, recovery did not and turned a dead endpoint green.
		const { network, run } = bareNetwork({ seeds: [{ address: ADDR_A }] });
		(network as any).node.dial = async (): Promise<unknown> => ({ remoteAddr: multiaddr(ADDR_A2) });
		await run();
		expect(((network as any).bootstrapByAddress.get(key(ADDR_A)) as IBootstrapEntry).lastVerifiedAt).toBe(null);
	});

	it('clears the address backoff after a successful dial', async () => {
		const { network, run } = bareNetwork({ seeds: [{ address: ADDR_A }] });
		(network as any).recoveryBackoff.set(key(ADDR_A), { nextAttempt: Date.now() - 1, failCount: 3 });
		await run();
		expect((network as any).recoveryBackoff.has(key(ADDR_A))).toBe(false);
	});
});

describe('Network.runZeroConnectionRecovery — registry walk', () => {
	it('dials configured entries before gossip-discovered ones', async () => {
		// The discovered entry is seeded first, so plain insertion order would dial it first.
		const { dialed, run } = bareNetwork({ seeds: [{ address: ADDR_B }, { address: ADDR_A, configuredBy: ['net-a'] }], failDial: true });
		await run();
		expect(dialed).toEqual([multiaddr(ADDR_A).toString(), multiaddr(ADDR_B).toString()]);
	});

	it('still skips a peer suppressed by leave-network', async () => {
		const { dialed, run } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }], suppressed: [PEER_A] });
		await run();
		expect(dialed).toEqual([]);
	});
});

describe('Network.runZeroConnectionRecovery — liveness and budget', () => {
	/** Distinct dead addresses of one peer, enough to overrun the per-pass budget. */
	const deadAddresses = (count: number): IRegistrySeed[] => Array.from({ length: count }, (_unused, i) => ({ address: `/ip4/192.0.2.${i + 10}/tcp/9090/p2p/${PEER_A}` }));

	it('does not run at all when a live connection exists despite a stale zero snapshot', async () => {
		// The status tick snapshots connected peers BEFORE re-dial maintenance; that pass
		// can connect a peer, making the snapshot a zero that is no longer true.
		const { dialed, run } = bareNetwork({ seeds: [{ address: ADDR_A, configuredBy: ['net-a'] }], livePeers: [PEER_B] });
		await run();
		expect(dialed).toEqual([]);
	});

	it('stops mid-pass as soon as a connection appears', async () => {
		// An inbound connection lands while the pass is between dials. Continuing would
		// keep hammering bootstrap addresses for a node that is no longer isolated.
		const holder: { livePeers: string[]; dialed: string[]; run: () => Promise<void> } = bareNetwork({
			seeds: deadAddresses(5),
			failDial: true,
			onDial: () => {
				holder.livePeers.push(PEER_B);
			},
		});
		await holder.run();
		expect(holder.dialed.length).toBe(1);
	});

	it('honours its per-pass attempt budget', async () => {
		// 20 dead addresses at 10 s apiece would occupy the status tick for minutes.
		const { dialed, run } = bareNetwork({ seeds: deadAddresses(20), failDial: true });
		await run();
		expect(dialed.length).toBe(8);
	});

	/**
	 * Eight timeouts take up to 80 s, by which time the 30 s backoff of the first eight
	 * has expired again. Rebuilding the same order every pass therefore replayed the
	 * same prefix indefinitely and never reached the tail at all.
	 */
	it('resumes the next pass where the previous one ran out of budget', async () => {
		const seeds = deadAddresses(16);
		const { network, dialed, run } = bareNetwork({ seeds, failDial: true });
		await run();
		const first = [...dialed];
		expect(first.length).toBe(8);
		// Clearing the backoff is the point of the test, not a shortcut around it: eight
		// timeouts take up to 80 s and the backoff starts at 30 s, so by the time a pass
		// ends its own pacing has expired. With the backoff gone, ONLY the cursor can
		// keep the second pass off the addresses the first one already tried.
		(network as any).recoveryBackoff.clear();
		dialed.length = 0;
		await run();
		expect(dialed.length).toBe(8);
		expect(dialed[0]).toBe(multiaddr(seeds[8]!.address).toString());
		// Between them the two passes covered every address exactly once.
		expect(new Set([...first, ...dialed]).size).toBe(16);
	});

	it('wraps back to the front once the tail has been covered', async () => {
		const seeds = deadAddresses(12);
		const { network, dialed, run } = bareNetwork({ seeds, failDial: true });
		await run();
		(network as any).recoveryBackoff.clear();
		dialed.length = 0;
		await run();
		// 12 entries, 8 per pass: the second pass takes the last four then wraps.
		expect(dialed[0]).toBe(multiaddr(seeds[8]!.address).toString());
		expect(dialed[4]).toBe(multiaddr(seeds[0]!.address).toString());
	});
});

describe('bootstrapEntryLastActivity', () => {
	const base = { firstSeenAt: 100, lastVerifiedAt: null, lastDisconnectedAt: null };

	it('falls back to the insertion time while nothing else has happened', () => {
		expect(bootstrapEntryLastActivity(base)).toBe(100);
	});

	it('prefers a later verification', () => {
		expect(bootstrapEntryLastActivity({ ...base, lastVerifiedAt: 500 })).toBe(500);
	});

	it('counts a disconnect as activity too', () => {
		expect(bootstrapEntryLastActivity({ ...base, lastVerifiedAt: 500, lastDisconnectedAt: 900 })).toBe(900);
	});
});

describe('pruneBootstrapEntries', () => {
	const now = 1_000_000_000;

	const discovered = (overrides: Partial<Pick<IBootstrapEntry, 'firstSeenAt' | 'lastVerifiedAt' | 'lastDisconnectedAt' | 'peerID'>> = {}) => ({
		firstSeenAt: now,
		lastVerifiedAt: null,
		lastDisconnectedAt: null,
		peerID: null,
		configuredBy: new Set<string>(),
		...overrides,
	});

	it('keeps discovered entries inside the TTL', () => {
		const entries = [discovered({ firstSeenAt: now - 10 })];
		expect(pruneBootstrapEntries(entries, now, 100, 10)).toEqual(entries);
	});

	it('drops discovered entries past the TTL', () => {
		expect(pruneBootstrapEntries([discovered({ firstSeenAt: now - 101 })], now, 100, 10)).toEqual([]);
	});

	/**
	 * The TTL used to run from insertion. A bootstrap that answered ten hours ago and
	 * has been serving us ever since would lose its registry entry while it was at its
	 * most useful, leaving nothing to dial the moment the connection dropped.
	 */
	it('measures the TTL from the last verification, not from first insert', () => {
		const verified = discovered({ firstSeenAt: now - 10_000, lastVerifiedAt: now - 10 });
		expect(pruneBootstrapEntries([verified], now, 100, 10)).toEqual([verified]);
	});

	it('measures it from the last disconnect too', () => {
		const dropped = discovered({ firstSeenAt: now - 10_000, lastVerifiedAt: now - 9_000, lastDisconnectedAt: now - 10 });
		expect(pruneBootstrapEntries([dropped], now, 100, 10)).toEqual([dropped]);
	});

	it('expires an entry whose last verification is itself past the TTL', () => {
		expect(pruneBootstrapEntries([discovered({ firstSeenAt: now - 10_000, lastVerifiedAt: now - 101 })], now, 100, 10)).toEqual([]);
	});

	it('keeps configured entries past the TTL', () => {
		const entries = [{ ...discovered({ firstSeenAt: now - 10_000 }), configuredBy: new Set(['net-a']) }];
		expect(pruneBootstrapEntries(entries, now, 100, 10)).toEqual(entries);
	});

	it('caps discovered entries at the bound, keeping the newest', () => {
		const entries = [
			{ ...discovered({ firstSeenAt: now - 3 }), tag: 'oldest' },
			{ ...discovered({ firstSeenAt: now - 2 }), tag: 'mid' },
			{ ...discovered({ firstSeenAt: now - 1 }), tag: 'newest' },
		];
		expect(pruneBootstrapEntries(entries, now, 100, 2).map(e => e.tag)).toEqual(['mid', 'newest']);
	});

	/**
	 * The cap used to drop in insertion order while the TTL measured from last activity.
	 * A peer known for hours that JUST disconnected — precisely when its recovery address
	 * is needed — was therefore evicted ahead of a newer entry nothing had touched.
	 */
	it('caps by last activity, not by when the entry was inserted', () => {
		const entries = [
			{ ...discovered({ firstSeenAt: now - 10, lastDisconnectedAt: now - 1 }), tag: 'old-but-just-dropped' },
			{ ...discovered({ firstSeenAt: now - 9, lastVerifiedAt: now - 2 }), tag: 'old-but-just-verified' },
			{ ...discovered({ firstSeenAt: now - 8 }), tag: 'newer-but-idle' },
		];
		expect(pruneBootstrapEntries(entries, now, 100, 2).map(e => e.tag)).toEqual(['old-but-just-dropped', 'old-but-just-verified']);
	});

	it('breaks ties on activity by position so the result is stable', () => {
		const entries = [
			{ ...discovered({ firstSeenAt: now - 5 }), tag: 'a' },
			{ ...discovered({ firstSeenAt: now - 5 }), tag: 'b' },
			{ ...discovered({ firstSeenAt: now - 5 }), tag: 'c' },
		];
		expect(pruneBootstrapEntries(entries, now, 100, 2).map(e => e.tag)).toEqual(['b', 'c']);
	});

	it('does not count configured entries against the bound nor drop them', () => {
		const entries = [
			{ ...discovered({ firstSeenAt: now - 9 }), configuredBy: new Set(['net-a']), tag: 'cfg1' },
			{ ...discovered({ firstSeenAt: now - 8 }), configuredBy: new Set(['net-a']), tag: 'cfg2' },
			{ ...discovered({ firstSeenAt: now - 2 }), tag: 'disc1' },
			{ ...discovered({ firstSeenAt: now - 1 }), tag: 'disc2' },
		];
		expect(pruneBootstrapEntries(entries, now, 100, 2).map(e => e.tag)).toEqual(['cfg1', 'cfg2', 'disc1', 'disc2']);
	});

	/**
	 * Registry membership also decides whether a peer is re-tagged KEEP_ALIVE when it
	 * connects, and that tag drives libp2p's reconnect queue. Ageing out a peer purely
	 * because the connection has been up longer than the TTL would silently demote the
	 * healthiest peers we have.
	 */
	it('never expires a discovered entry whose peer is connected right now', () => {
		const entries = [discovered({ firstSeenAt: now - 10_000, peerID: PEER_A })];
		expect(pruneBootstrapEntries(entries, now, 100, 10, pid => pid === PEER_A)).toEqual(entries);
	});

	it('expires that same entry once the peer is no longer connected', () => {
		expect(pruneBootstrapEntries([discovered({ firstSeenAt: now - 10_000, peerID: PEER_A })], now, 100, 10, () => false)).toEqual([]);
	});
});

describe('orderBootstrapEntriesForRecovery', () => {
	const entries = [
		{ key: 'd1', configuredBy: new Set<string>(), tag: 'd1' },
		{ key: 'c1', configuredBy: new Set(['net-a']), tag: 'c1' },
		{ key: 'd2', configuredBy: new Set<string>(), tag: 'd2' },
		{ key: 'c2', configuredBy: new Set(['net-b']), tag: 'c2' },
	];

	it('puts configured entries first and preserves order inside each group', () => {
		expect(orderBootstrapEntriesForRecovery(entries).map(e => e.tag)).toEqual(['c1', 'c2', 'd1', 'd2']);
	});

	it('resumes each group after the entry the last pass stopped on', () => {
		expect(orderBootstrapEntriesForRecovery(entries, { configured: 'c1', discovered: 'd1' }).map(e => e.tag)).toEqual(['c2', 'c1', 'd2', 'd1']);
	});

	it('keeps configured entries ahead even when only they were rotated', () => {
		// One cursor over the whole list would eventually start a pass among the
		// discovered claims and leave the user's own bootstrap queued behind them.
		expect(orderBootstrapEntriesForRecovery(entries, { configured: 'c2', discovered: null }).map(e => e.tag)).toEqual(['c1', 'c2', 'd1', 'd2']);
	});

	it('restarts a group whose cursor entry has gone', () => {
		expect(orderBootstrapEntriesForRecovery(entries, { configured: 'removed', discovered: 'removed' }).map(e => e.tag)).toEqual(['c1', 'c2', 'd1', 'd2']);
	});
});

describe('nextRecoveryBackoff', () => {
	it('doubles the delay per consecutive failure of the same address', () => {
		expect(nextRecoveryBackoff(0, 0, false)).toEqual({ nextAttempt: 30_000, failCount: 1 });
		expect(nextRecoveryBackoff(1, 0, false)).toEqual({ nextAttempt: 60_000, failCount: 2 });
		expect(nextRecoveryBackoff(2, 0, false)).toEqual({ nextAttempt: 120_000, failCount: 3 });
	});

	it('caps a discovered address at 10 minutes', () => {
		expect(nextRecoveryBackoff(20, 0, false).nextAttempt).toBe(600_000);
	});

	/**
	 * A configured address is the user's designated way back in, so it is retried far
	 * more briskly than a gossip claim — but it is still paced, or a handful of dead
	 * configured entries would eat every recovery pass at 10 s apiece.
	 */
	it('caps a configured address at 2 minutes instead', () => {
		expect(nextRecoveryBackoff(20, 0, true).nextAttempt).toBe(120_000);
	});
});
