import { describe, it, expect } from 'bun:test';
import { multiaddr as Multiaddr } from '@multiformats/multiaddr';
import { classifyBootstrapError, extractActualPeerID, extractDestinationPeerID } from '../../../src/protocol/network.ts';
import { BootstrapStatusTracker } from '../../../src/protocol/bootstrap-status.ts';

// Deterministic unit tests for the bootstrap-peer dial classification — the pure
// logic that decides whether a failed bootstrap dial is an identity-mismatch (stale
// /p2p/<id>), a timeout (unreachable), or a generic error. This replaces the old
// scripts/simulate-stale-bootstrap.mjs manual helper, which exercised the same three
// outcomes against a live backend (flaky, needed a real reachable peer for "connected").
//
// PeerIDs below are deliberate fake placeholders — never real production nodes.

const ACTUAL_ID = '12D3KooWActuaLActuaLActuaLActuaLActuaLActuaLActuaLAA';
const EXPECTED_ID = '12D3KooWExpecTExpecTExpecTExpecTExpecTExpecTExpecTEE';
// libp2p Noise plaintext shape: "Payload identity key <ACTUAL> does not match expected remote identity key <EXPECTED>"
const MISMATCH_MSG = `Payload identity key ${ACTUAL_ID} does not match expected remote identity key ${EXPECTED_ID}`;

describe('classifyBootstrapError', () => {
	it('classifies a Noise identity-key mismatch as identity-mismatch', () => {
		expect(classifyBootstrapError(MISMATCH_MSG)).toBe('identity-mismatch');
	});

	it('classifies every libp2p timeout phrasing as timeout', () => {
		expect(classifyBootstrapError('The operation timed out')).toBe('timeout');
		expect(classifyBootstrapError('The operation was aborted')).toBe('timeout');
		expect(classifyBootstrapError('TimeoutError: dial aborted after 30000ms')).toBe('timeout');
	});

	it('classifies any other failure as a generic error', () => {
		expect(classifyBootstrapError('connection refused')).toBe('error');
		expect(classifyBootstrapError('no transport available for address')).toBe('error');
		expect(classifyBootstrapError('protocol negotiation failed')).toBe('error');
	});

	it('treats an empty message as error', () => {
		expect(classifyBootstrapError('')).toBe('error');
	});

	it('prefers identity-mismatch over timeout when both phrases co-occur', () => {
		// Precedence guard: an identity-mismatch that also mentions a timeout must stay
		// a mismatch — the configured peerID is stale regardless of the slow dial.
		expect(classifyBootstrapError(`${MISMATCH_MSG} (the dial timed out once first)`)).toBe('identity-mismatch');
	});
});

describe('extractActualPeerID', () => {
	it('pulls the actual peerID out of a mismatch message', () => {
		expect(extractActualPeerID(MISMATCH_MSG)).toBe(ACTUAL_ID);
	});

	it('returns null when the message is not a Noise identity mismatch', () => {
		expect(extractActualPeerID('connection refused')).toBe(null);
		expect(extractActualPeerID('')).toBe(null);
	});

	it('returns null when the mismatch message lacks the Payload-identity-key prefix', () => {
		// Shape guard: a different phrasing must not yield a confident (wrong) replacement peerID.
		expect(extractActualPeerID('does not match expected remote identity key only')).toBe(null);
	});
});

describe('extractDestinationPeerID', () => {
	// Real base58 ed25519 peer IDs are required — the multiaddr parser validates them.
	const RELAY_ID = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
	const DST_ID = '12D3KooWAnfqA6Wap96ixVfxhHeGUDMriBG4Nncp5tqu8q71EVv2';

	it('returns the terminal peer ID of a plain address', () => {
		expect(extractDestinationPeerID(Multiaddr(`/ip4/192.0.2.1/tcp/9090/p2p/${DST_ID}`))).toBe(DST_ID);
	});

	it('returns the DESTINATION (not the relay) for a circuit address', () => {
		expect(extractDestinationPeerID(Multiaddr(`/ip4/192.0.2.1/tcp/9090/p2p/${RELAY_ID}/p2p-circuit/p2p/${DST_ID}`))).toBe(DST_ID);
	});

	it('returns the relay ID when a circuit address has no destination component', () => {
		expect(extractDestinationPeerID(Multiaddr(`/ip4/192.0.2.1/tcp/9090/p2p/${RELAY_ID}/p2p-circuit`))).toBe(RELAY_ID);
	});

	it('returns null for an address without any peer ID and for garbage input', () => {
		expect(extractDestinationPeerID(Multiaddr('/ip4/192.0.2.1/tcp/9090'))).toBe(null);
		expect(extractDestinationPeerID(null)).toBe(null);
	});
});

describe('BootstrapStatusTracker.deleteDiscoveredByPeerID', () => {
	const NET_A = 'netAAAA';
	const NET_B = 'netBBBB';
	const DEAD_ID = '12D3KooWDeadDeadDeadDeadDeadDeadDeadDeadDeadDeadDD';
	const LIVE_ID = '12D3KooWLiveLiveLiveLiveLiveLiveLiveLiveLiveLiveLL';
	const DEAD_ADDR_1 = `/ip4/192.0.2.10/tcp/9090/p2p/${DEAD_ID}`;
	const DEAD_ADDR_2 = `/ip4/192.0.2.11/tcp/9090/p2p/${DEAD_ID}`;
	const LIVE_ADDR = `/ip4/192.0.2.20/tcp/9090/p2p/${LIVE_ID}`;

	it('removes discovered rows for the peer across all networks, keeps other peers', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET_A, DEAD_ADDR_1, DEAD_ID, 'timeout', 'The operation timed out', null, 'discovered');
		tracker.recordOutcome(NET_A, LIVE_ADDR, LIVE_ID, 'connected', null, null, 'discovered');
		tracker.recordOutcome(NET_B, DEAD_ADDR_2, DEAD_ID, 'timeout', 'The operation timed out', null, 'discovered');

		tracker.deleteDiscoveredByPeerID(DEAD_ID);

		expect(tracker.getStatus(NET_A)?.peers.map(p => p.multiaddr)).toEqual([LIVE_ADDR]);
		expect(tracker.getStatus(NET_B)).toBe(null); // network map emptied entirely
	});

	it('keeps configured rows for the same peer identity', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET_A, DEAD_ADDR_1, DEAD_ID, 'timeout', 'The operation timed out', null, 'configured');
		tracker.recordOutcome(NET_A, DEAD_ADDR_2, DEAD_ID, 'timeout', 'The operation timed out', null, 'discovered');

		tracker.deleteDiscoveredByPeerID(DEAD_ID);

		expect(tracker.getStatus(NET_A)?.peers.map(p => p.multiaddr)).toEqual([DEAD_ADDR_1]);
	});

	it('matches rows by actualPeerID as well and fires onStatusChange per changed network', () => {
		const tracker = new BootstrapStatusTracker();
		const events: string[] = [];
		tracker.setOnChange(networkID => events.push(networkID));
		// Row whose expectedPeerID is null but whose dial revealed the dead identity.
		tracker.recordOutcome(NET_A, '/ip4/192.0.2.30/tcp/9090', null, 'identity-mismatch', 'mismatch', DEAD_ID, 'discovered');
		tracker.recordOutcome(NET_B, LIVE_ADDR, LIVE_ID, 'connected', null, null, 'discovered');
		events.length = 0;

		tracker.deleteDiscoveredByPeerID(DEAD_ID);

		expect(tracker.getStatus(NET_A)).toBe(null);
		expect(events).toEqual([NET_A]); // untouched NET_B emits nothing
	});
});

describe('BootstrapStatusTracker.sweepStale', () => {
	const NET = 'netAAAA';
	const TTL = 30 * 60_000;
	const DEAD_ID = '12D3KooWDeadDeadDeadDeadDeadDeadDeadDeadDeadDeadDD';
	const LIVE_ID = '12D3KooWLiveLiveLiveLiveLiveLiveLiveLiveLiveLiveLL';
	const DEAD_ADDR = `/ip4/192.0.2.10/tcp/9090/p2p/${DEAD_ID}`;
	const LIVE_ADDR = `/ip4/192.0.2.20/tcp/9090/p2p/${LIVE_ID}`;
	const CONF_ADDR = `/ip4/192.0.2.30/tcp/9090/p2p/${DEAD_ID}`;

	it('drops stale discovered rows, keeps fresh, connected and configured ones', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, DEAD_ADDR, DEAD_ID, 'timeout', 'The operation timed out', null, 'discovered');
		tracker.recordOutcome(NET, LIVE_ADDR, LIVE_ID, 'connected', null, null, 'discovered');
		tracker.recordOutcome(NET, CONF_ADDR, DEAD_ID, 'timeout', 'The operation timed out', null, 'configured');
		const past = Date.now() + TTL + 60_000; // both rows are then older than TTL

		tracker.sweepStale(TTL, (_net, pid) => pid === LIVE_ID, past);

		const addrs = tracker
			.getStatus(NET)
			?.peers.map(p => p.multiaddr)
			.sort();
		// DEAD discovered row expired; LIVE row survives via membership; configured row untouchable.
		expect(addrs).toEqual([CONF_ADDR, LIVE_ADDR].sort());
	});

	it('drops a row frozen at connected once the peer is no longer a network member', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, DEAD_ADDR, DEAD_ID, 'connected', null, null, 'discovered');

		tracker.sweepStale(TTL, () => false, Date.now() + TTL + 60_000);

		expect(tracker.getStatus(NET)).toBe(null);
	});

	it('expires a row whose peer stays globally connected but left THIS network', () => {
		// Membership predicate returns false for NET even though the peer is up
		// elsewhere — the stale NET row must still expire past its TTL.
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, DEAD_ADDR, DEAD_ID, 'connected', null, null, 'discovered');

		tracker.sweepStale(TTL, networkID => networkID !== NET, Date.now() + TTL + 60_000);

		expect(tracker.getStatus(NET)).toBe(null);
	});

	it('keeps rows within the TTL even for a non-member', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, DEAD_ADDR, DEAD_ID, 'timeout', 'The operation timed out', null, 'discovered');

		tracker.sweepStale(TTL, () => false); // real clock — row was written moments ago

		expect(tracker.getStatus(NET)?.peers.length).toBe(1);
	});

	/**
	 * markPending fires whenever gossip names an address again, which happens on every
	 * announce cycle — far more often than the sweep TTL. Treating that as activity kept
	 * a dead peer's row alive forever. Only a dial that produced an outcome counts.
	 */
	// Rows are stamped with `new Date()`, which no Date.now stub can steer, so these
	// read the real timestamp the tracker wrote and drive sweepStale relative to it.
	// The short sleep only guarantees a measurable gap between the two writes.
	const clockOf = (tracker: BootstrapStatusTracker): string => tracker.getStatus(NET)!.peers[0]!.updatedAt;

	it('does not let a re-mention refresh the staleness clock', async () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, DEAD_ADDR, DEAD_ID, 'timeout', 'The operation timed out', null, 'discovered');
		const outcomeAt = clockOf(tracker);
		await Bun.sleep(5);

		tracker.markPending(NET, DEAD_ADDR, DEAD_ID, 'discovered'); // gossip mentions it again

		expect(clockOf(tracker)).toBe(outcomeAt); // clock untouched by the mention
		tracker.sweepStale(TTL, () => false, Date.parse(outcomeAt) + TTL + 2);
		expect(tracker.getStatus(NET)).toBe(null); // ages out from the last real outcome
	});

	/**
	 * The failure is this node's own reaction to somebody else's mention of a dead peer.
	 * Counting it as activity was the same immortality bug as the mention itself: gossip
	 * names the peer, the dial fails, the row is refreshed, and the TTL never arrives.
	 */
	it('does not let a failed dial outcome refresh the staleness clock', async () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, DEAD_ADDR, DEAD_ID, 'timeout', 'The operation timed out', null, 'discovered');
		const firstAt = clockOf(tracker);
		await Bun.sleep(5);

		tracker.recordOutcome(NET, DEAD_ADDR, DEAD_ID, 'timeout', 'The operation timed out', null, 'discovered');

		expect(Date.parse(clockOf(tracker))).toBeGreaterThan(Date.parse(firstAt)); // display clock moves
		tracker.sweepStale(TTL, () => false, Date.parse(firstAt) + TTL + 2);
		expect(tracker.getStatus(NET)).toBe(null); // staleness clock did not
	});

	it('lets a successful dial refresh the staleness clock', async () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, DEAD_ADDR, DEAD_ID, 'timeout', 'The operation timed out', null, 'discovered');
		const firstAt = clockOf(tracker);
		await Bun.sleep(5);

		tracker.recordOutcome(NET, DEAD_ADDR, DEAD_ID, 'connected', null, null, 'discovered');

		tracker.sweepStale(TTL, () => false, Date.parse(firstAt) + TTL + 2);
		expect(tracker.getStatus(NET)?.peers.length).toBe(1); // survives — the address answered
	});

	/** The clock is bookkeeping, not part of what the API hands out. */
	it('keeps the staleness clock out of the published snapshot', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, DEAD_ADDR, DEAD_ID, 'connected', null, null, 'discovered');

		expect(tracker.getStatus(NET)!.peers[0]!).not.toHaveProperty('staleSince');
	});

	it('starts the clock on a first mention that has no prior row', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.markPending(NET, DEAD_ADDR, DEAD_ID, 'discovered');
		const mentionAt = clockOf(tracker);

		tracker.sweepStale(TTL, () => false, Date.parse(mentionAt) + TTL - 60_000);
		expect(tracker.getStatus(NET)?.peers.length).toBe(1); // inside the TTL

		tracker.sweepStale(TTL, () => false, Date.parse(mentionAt) + TTL + 2);
		expect(tracker.getStatus(NET)).toBe(null); // and expires once past it
	});
});

/**
 * Every mutation rebuilds and emits the whole peer list, and intake of one announce
 * performs two per address. batch() groups them so the UI receives one snapshot for
 * the run instead of one per row per address.
 */
describe('BootstrapStatusTracker.batch', () => {
	const NET = 'netAAAA';
	const PID = '12D3KooWBatchBatchBatchBatchBatchBatchBatchBatchBB';
	const addr = (i: number): string => `/ip4/192.0.2.${i}/tcp/9090/p2p/${PID}`;

	function tracked() {
		const tracker = new BootstrapStatusTracker();
		const seen: string[][] = [];
		tracker.setOnChange((_networkID, status) => seen.push(status.peers.map(p => p.multiaddr)));
		return { tracker, seen };
	}

	it('emits exactly one snapshot for many mutations', () => {
		const { tracker, seen } = tracked();

		tracker.batch(NET, () => {
			for (let i = 1; i <= 10; i++) {
				tracker.markPending(NET, addr(i), PID, 'discovered');
				tracker.recordOutcome(NET, addr(i), PID, 'connected', null, null, 'discovered');
			}
		});

		expect(seen.length).toBe(1);
		expect(seen[0]!.length).toBe(10); // the one snapshot holds every row
	});

	it('still emits when the body throws', () => {
		const { tracker, seen } = tracked();

		expect(() =>
			tracker.batch(NET, () => {
				tracker.recordOutcome(NET, addr(1), PID, 'connected', null, null, 'discovered');
				throw new Error('dial loop blew up');
			})
		).toThrow('dial loop blew up');

		expect(seen).toEqual([[addr(1)]]);
	});

	it('holds the frame open across awaits and emits once the promise settles', async () => {
		const { tracker, seen } = tracked();

		const done = tracker.batch(NET, async () => {
			tracker.recordOutcome(NET, addr(1), PID, 'connected', null, null, 'discovered');
			await Promise.resolve();
			tracker.recordOutcome(NET, addr(2), PID, 'connected', null, null, 'discovered');
		});
		expect(seen).toEqual([]); // nothing emitted while the body is still running
		await done;

		expect(seen).toEqual([[addr(1), addr(2)]]);
	});

	it('emits once when a rejected async body settles', async () => {
		const { tracker, seen } = tracked();

		const done = tracker.batch(NET, async () => {
			tracker.recordOutcome(NET, addr(1), PID, 'connected', null, null, 'discovered');
			throw new Error('dial rejected');
		});

		await expect(done).rejects.toThrow('dial rejected');
		expect(seen).toEqual([[addr(1)]]);
	});

	it('emits nothing when the body changed nothing', () => {
		const { tracker, seen } = tracked();

		tracker.batch(NET, () => {});

		expect(seen).toEqual([]);
	});

	it('collapses nested batches of the same network into one snapshot', () => {
		const { tracker, seen } = tracked();

		tracker.batch(NET, () => {
			tracker.recordOutcome(NET, addr(1), PID, 'connected', null, null, 'discovered');
			tracker.batch(NET, () => {
				tracker.recordOutcome(NET, addr(2), PID, 'connected', null, null, 'discovered');
			});
			expect(seen).toEqual([]); // inner exit must not publish a half-built run
		});

		expect(seen).toEqual([[addr(1), addr(2)]]);
	});

	it('leaves single-mutation callers emitting per mutation', () => {
		const { tracker, seen } = tracked();

		tracker.recordOutcome(NET, addr(1), PID, 'connected', null, null, 'discovered');
		tracker.recordOutcome(NET, addr(2), PID, 'connected', null, null, 'discovered');

		expect(seen.length).toBe(2);
	});

	it('does not defer mutations of a different network', () => {
		const { tracker, seen } = tracked();
		const OTHER = 'netBBBB';

		tracker.batch(NET, () => {
			tracker.recordOutcome(OTHER, addr(1), PID, 'connected', null, null, 'discovered');
			expect(seen.length).toBe(1); // the other network is not part of this batch
		});

		expect(seen.length).toBe(1); // NET itself changed nothing → no second emit
	});

	it('returns the body value unchanged', () => {
		const { tracker } = tracked();
		expect(tracker.batch(NET, () => 42)).toBe(42);
	});
});

describe('BootstrapStatusTracker discovered-row cap', () => {
	const NET = 'netAAAA';
	const PID = '12D3KooWCapCapCapCapCapCapCapCapCapCapCapCapCapCapCA';

	it('bounds discovered rows per network and keeps configured rows', () => {
		const tracker = new BootstrapStatusTracker();
		// One configured row that must always survive.
		tracker.recordOutcome(NET, `/ip4/198.51.100.1/tcp/9090/p2p/${PID}`, PID, 'connected', null, null, 'configured');
		// Flood well past the 256 cap with unique discovered addresses.
		for (let i = 0; i < 400; i++) tracker.recordOutcome(NET, `/ip4/203.0.113.${i % 254}/tcp/${9000 + i}/p2p/${PID}`, PID, 'connected', null, null, 'discovered');

		const peers = tracker.getStatus(NET)!.peers;
		const discovered = peers.filter(p => p.origin === 'discovered').length;
		const configured = peers.filter(p => p.origin === 'configured').length;
		expect(discovered).toBeLessThanOrEqual(256);
		expect(configured).toBe(1);
	});
});

/**
 * pruneEntries is fed the network's CONFIGURED bootstrap list after the user edits it.
 * Since this tracker also holds gossip-discovered rows, judging every row by that list
 * would empty the participant view on a bootstrap edit — including a "refresh from
 * public list" — leaving it blank until gossip mentions each peer again.
 */
describe('BootstrapStatusTracker.pruneEntries', () => {
	const NET = 'netAAAA';
	const CONF_KEPT = '/ip4/192.0.2.1/tcp/9090/p2p/12D3KooWConfKeptKeptKeptKeptKeptKeptKeptKeptKeptK';
	const CONF_DROPPED = '/ip4/192.0.2.2/tcp/9090/p2p/12D3KooWConfGoneGoneGoneGoneGoneGoneGoneGoneGone';
	const DISCOVERED = '/ip4/192.0.2.3/tcp/9090/p2p/12D3KooWDiscDiscDiscDiscDiscDiscDiscDiscDiscDis';

	function seeded(): BootstrapStatusTracker {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, CONF_KEPT, null, 'connected', null, null, 'configured');
		tracker.recordOutcome(NET, CONF_DROPPED, null, 'connected', null, null, 'configured');
		tracker.recordOutcome(NET, DISCOVERED, null, 'connected', null, null, 'discovered');
		return tracker;
	}

	const addresses = (tracker: BootstrapStatusTracker): string[] => (tracker.getStatus(NET)?.peers ?? []).map(p => p.multiaddr);

	it('drops a configured row that left the config', () => {
		const tracker = seeded();
		tracker.pruneEntries(NET, [CONF_KEPT]);
		expect(addresses(tracker)).not.toContain(CONF_DROPPED);
	});

	it('keeps a configured row that is still in the config', () => {
		const tracker = seeded();
		tracker.pruneEntries(NET, [CONF_KEPT]);
		expect(addresses(tracker)).toContain(CONF_KEPT);
	});

	it('keeps discovered rows, which the configured list never mentions', () => {
		const tracker = seeded();
		tracker.pruneEntries(NET, [CONF_KEPT]);
		expect(addresses(tracker)).toContain(DISCOVERED);
	});

	it('keeps discovered rows even when the whole config is cleared', () => {
		const tracker = seeded();
		tracker.pruneEntries(NET, []);
		expect(addresses(tracker)).toEqual([DISCOVERED]);
	});

	/**
	 * Removing the last row drops the whole network from the tracker, at which point
	 * buildStatus has nothing to return. Staying silent there would leave the UI
	 * rendering the very row that was just deleted, so the empty list is emitted
	 * explicitly — the same fallback the other removal paths use.
	 */
	it('emits an empty list when the last remaining row is removed', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, CONF_KEPT, null, 'connected', null, null, 'configured');
		const seen: Array<{ networkID: string; peers: unknown[] }> = [];
		tracker.setOnChange((networkID, status) => seen.push({ networkID, peers: status.peers }));
		tracker.pruneEntries(NET, []);
		expect(seen).toEqual([{ networkID: NET, peers: [] }]);
	});

	it('still emits the surviving rows when only some are removed', () => {
		const tracker = seeded();
		const seen: string[][] = [];
		tracker.setOnChange((_networkID, status) => seen.push(status.peers.map(p => p.multiaddr)));
		tracker.pruneEntries(NET, [CONF_KEPT]);
		expect(seen).toEqual([[CONF_KEPT, DISCOVERED]]);
	});
});

/**
 * Bootstrap intake awaits a dial between each address's pending mark and its outcome, so
 * neither of the simple answers works: emitting per mutation costs a whole snapshot per
 * row per address, and holding everything to the end of the list leaves the UI blank for
 * as long as the dials take.
 */
describe('BootstrapStatusTracker.batchDebounced', () => {
	const NET = 'netAAAA';
	const PID = '12D3KooWBatchBatchBatchBatchBatchBatchBatchBatchBB';
	const addr = (i: number): string => `/ip4/192.0.2.${i}/tcp/9090/p2p/${PID}`;

	function tracked() {
		const tracker = new BootstrapStatusTracker();
		const seen: number[] = [];
		tracker.setOnChange((_networkID, status) => seen.push(status.peers.length));
		return { tracker, seen };
	}

	it('collapses a fast run of mutations into a single emission', async () => {
		const { tracker, seen } = tracked();

		await tracker.batchDebounced(NET, async () => {
			for (let i = 0; i < 20; i++) {
				tracker.markPending(NET, addr(i), PID, 'discovered');
				tracker.recordOutcome(NET, addr(i), PID, 'connected', null, null, 'discovered');
			}
		});

		expect(seen).toEqual([20]);
	});

	it('publishes progress while a slow run is still going', async () => {
		const { tracker, seen } = tracked();

		await tracker.batchDebounced(NET, async () => {
			tracker.recordOutcome(NET, addr(1), PID, 'connected', null, null, 'discovered');
			await Bun.sleep(200); // a dial's worth of waiting
			tracker.recordOutcome(NET, addr(2), PID, 'connected', null, null, 'discovered');
		});

		expect(seen.length).toBeGreaterThan(1); // not held back to the end
		expect(seen[seen.length - 1]).toBe(2);
	});

	it('emits nothing for a run that changed nothing', async () => {
		const { tracker, seen } = tracked();
		await tracker.batchDebounced(NET, async () => {});
		expect(seen).toEqual([]);
	});

	it('propagates the body result and still closes on a throw', async () => {
		const { tracker, seen } = tracked();

		await expect(
			tracker.batchDebounced(NET, async () => {
				tracker.recordOutcome(NET, addr(1), PID, 'connected', null, null, 'discovered');
				throw new Error('dial exploded');
			})
		).rejects.toThrow('dial exploded');

		expect(seen).toEqual([1]); // what it managed to change was still published
	});
});

/**
 * The address-level probes know an endpoint answered but not which networks were waiting
 * to hear it. The parked-bootstrap probe is the case that matters: it is the only thing
 * that retries an address the routability filter rejected at configure time, so the red
 * row it left behind had no other way back to green.
 */
describe('BootstrapStatusTracker.recordAddressReachable', () => {
	const NET_A = 'netAAAA';
	const NET_B = 'netBBBB';
	const PID = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
	const ADDR = `/dns4/bootstrap.example.org/tcp/9090/p2p/${PID}`;
	const OTHER = `/ip4/192.0.2.50/tcp/9090/p2p/${PID}`;

	function seeded() {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET_A, ADDR, PID, 'error', 'address is not routable from this host', null, 'configured');
		tracker.recordOutcome(NET_B, ADDR, PID, 'error', 'address is not routable from this host', null, 'configured');
		tracker.recordOutcome(NET_A, OTHER, PID, 'timeout', 'The operation timed out', null, 'configured');
		return tracker;
	}

	const statusOf = (tracker: BootstrapStatusTracker, networkID: string, addr: string): string | undefined => tracker.getStatus(networkID)?.peers.find(p => p.multiaddr === addr)?.status;

	it('repairs the row in every network that configured the address', () => {
		const tracker = seeded();
		tracker.recordAddressReachable(ADDR);
		expect(statusOf(tracker, NET_A, ADDR)).toBe('connected');
		expect(statusOf(tracker, NET_B, ADDR)).toBe('connected');
	});

	it('clears the error text it is replacing', () => {
		const tracker = seeded();
		tracker.recordAddressReachable(ADDR);
		expect(tracker.getStatus(NET_A)?.peers.find(p => p.multiaddr === ADDR)?.lastError).toBe(null);
	});

	it('leaves other addresses of the same peer alone', () => {
		const tracker = seeded();
		tracker.recordAddressReachable(ADDR);
		expect(statusOf(tracker, NET_A, OTHER)).toBe('timeout');
	});

	/** The probe walks parsed multiaddrs; the rows keep the spelling the user typed. */
	it('matches the row canonically, not by string identity', () => {
		const tracker = seeded();
		tracker.recordAddressReachable(`/dns4/BOOTSTRAP.EXAMPLE.ORG./tcp/9090/p2p/${PID}`);
		expect(statusOf(tracker, NET_A, ADDR)).toBe('connected');
	});

	it('emits nothing when no row is waiting for that address', () => {
		const tracker = seeded();
		const seen: string[] = [];
		tracker.setOnChange(networkID => seen.push(networkID));
		tracker.recordAddressReachable(`/ip4/198.51.100.77/tcp/9090/p2p/${PID}`);
		expect(seen).toEqual([]);
	});
});

/**
 * Rows are keyed by the canonical form of the endpoint. Keying by the raw string let two
 * spellings of one address — DNS case, a trailing dot, an expanded IPv6 literal — open
 * two contradictory rows, spend the discovered budget twice, and survive a delete aimed
 * at only one of them.
 */
describe('BootstrapStatusTracker — one row per endpoint, whatever the spelling', () => {
	const PID = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
	const UPPER = `/dns4/BOOTSTRAP.EXAMPLE.ORG./tcp/9090/p2p/${PID}`;
	const LOWER = `/dns4/bootstrap.example.org/tcp/9090/p2p/${PID}`;
	const NET = 'net-a';

	it('folds two spellings into a single row', () => {
		const tracker = new BootstrapStatusTracker();

		tracker.recordOutcome(NET, UPPER, PID, 'error', 'boom', null, 'discovered');
		tracker.recordOutcome(NET, LOWER, PID, 'connected', null, null, 'discovered');

		const peers = tracker.getStatus(NET)!.peers;
		expect(peers).toHaveLength(1);
		expect(peers[0]!.status).toBe('connected');
	});

	it('keeps the first spelling for display, and lets a configured one replace it', () => {
		const tracker = new BootstrapStatusTracker();

		tracker.recordOutcome(NET, LOWER, PID, 'error', 'boom', null, 'discovered');
		expect(tracker.getStatus(NET)!.peers[0]!.multiaddr).toBe(LOWER);

		tracker.markPending(NET, UPPER, PID, 'configured');
		expect(tracker.getStatus(NET)!.peers[0]!.multiaddr).toBe(UPPER);
	});

	it('deletes the row whichever spelling names it', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, LOWER, PID, 'error', 'boom', null, 'discovered');

		tracker.deletePeer(NET, UPPER);

		expect(tracker.getStatus(NET)).toBeNull();
	});

	it('keeps a configured row that was re-typed in another spelling', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, LOWER, PID, 'connected', null, null, 'configured');

		tracker.pruneEntries(NET, [UPPER]);

		expect(tracker.getStatus(NET)!.peers).toHaveLength(1);
	});

	it('marks the row reachable when the probe names another spelling', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.recordOutcome(NET, LOWER, PID, 'timeout', 'no answer', null, 'configured');

		tracker.recordAddressReachable(UPPER);

		expect(tracker.getStatus(NET)!.peers[0]!.status).toBe('connected');
	});
});

/**
 * The discovered-row cap decides what survives a flood. Dropping simply the oldest row
 * let an attacker (or a broken emitter) push a live, connected participant out of the
 * list with a burst of freshly invented dead addresses — undoing the protection the
 * stale sweep gives an active member.
 */
describe('BootstrapStatusTracker — the cap evicts the least useful row', () => {
	const NET = 'net-a';
	const MEMBER = 'PeerMemberAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
	const GHOST = 'PeerGhostBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

	/** Fill the network to exactly the cap with fresh, failed, non-member rows. */
	function floodToCap(tracker: BootstrapStatusTracker, count: number): void {
		for (let i = 0; i < count; i++) tracker.recordOutcome(NET, `/ip4/198.51.100.${i % 254}/tcp/${9000 + i}/p2p/${GHOST}`, GHOST, 'timeout', 'no answer', null, 'discovered');
	}

	function survivors(tracker: BootstrapStatusTracker): string[] {
		return (tracker.getStatus(NET)?.peers ?? []).map(p => p.multiaddr);
	}

	it('drops a fresh dead address before an older connected one', () => {
		const tracker = new BootstrapStatusTracker();
		const live = `/ip4/203.0.113.7/tcp/9090/p2p/${MEMBER}`;
		tracker.recordOutcome(NET, live, MEMBER, 'connected', null, null, 'discovered');
		// 256 further rows put the network one over the cap.
		floodToCap(tracker, 256);

		expect(survivors(tracker)).toContain(live);
	});

	it('keeps an active member whose identity we have actually verified', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.setMembersProvider(() => new Set([MEMBER]));
		const verified = `/ip4/203.0.113.8/tcp/9090/p2p/${MEMBER}`;
		tracker.recordOutcome(NET, verified, MEMBER, 'connected', null, MEMBER, 'discovered');
		floodToCap(tracker, 256);

		expect(survivors(tracker)).toContain(verified);
	});

	it('a flood of invented addresses claiming a member cannot evict the member', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.setMembersProvider(() => new Set([MEMBER]));
		const verified = `/ip4/203.0.113.8/tcp/9090/p2p/${MEMBER}`;
		tracker.recordOutcome(NET, verified, MEMBER, 'connected', null, MEMBER, 'discovered');
		// Every one of these DECLARES the member's peer ID and none has ever answered.
		// Ranking on the declared identity gave them all top rank and evicted the genuine
		// row above, purely for being the oldest of the group.
		for (let i = 0; i < 300; i++) tracker.recordOutcome(NET, `/ip4/198.51.100.${i % 254}/tcp/${20000 + i}/p2p/${MEMBER}`, MEMBER, 'timeout', 'no answer', null, 'discovered');

		expect(survivors(tracker)).toContain(verified);
		expect(survivors(tracker)).toHaveLength(256);
	});

	/**
	 * markPending fires every time gossip names an address — far more often than anything
	 * dials it. Clearing the verified identity there demoted a proven member's row to an
	 * ordinary pending one within an announce cycle, and a flood of equally-pending
	 * invented addresses then evicted it for being the oldest of them.
	 */
	it('a gossip re-mention does not cost a verified member its protection', () => {
		const tracker = new BootstrapStatusTracker();
		tracker.setMembersProvider(() => new Set([MEMBER]));
		const verified = `/ip4/203.0.113.8/tcp/9090/p2p/${MEMBER}`;
		tracker.recordOutcome(NET, verified, MEMBER, 'connected', null, MEMBER, 'discovered');
		tracker.markPending(NET, verified, MEMBER, 'discovered');
		for (let i = 0; i < 300; i++) tracker.markPending(NET, `/ip4/198.51.100.${i % 254}/tcp/${30000 + i}/p2p/${MEMBER}`, MEMBER, 'discovered');

		expect(survivors(tracker)).toContain(verified);
		expect(survivors(tracker)).toHaveLength(256);
	});

	it('still enforces the cap', () => {
		const tracker = new BootstrapStatusTracker();
		floodToCap(tracker, 300);

		expect(survivors(tracker)).toHaveLength(256);
	});
});
