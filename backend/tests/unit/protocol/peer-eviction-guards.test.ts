import { describe, it, expect } from 'bun:test';
import { multiaddr } from '@multiformats/multiaddr';
import { Mutex } from 'async-mutex';
import { Network, isRecoveryDialDue, isSameDialEndpoint, normalizeMultiaddrForCompare } from '../../../src/protocol/network.ts';
import { BootstrapStatusTracker } from '../../../src/protocol/bootstrap-status.ts';

/**
 * Guards on the DESTRUCTIVE peer-eviction paths. The pure decision helpers are covered
 * in peer-eviction.test.ts; what is exercised here is the part that actually closes
 * connections and deletes peerStore entries, where the damage from getting it wrong is
 * not a wrong boolean but a live peer evicted from the wrong libp2p node.
 */

const PEER_ID = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
/**
 * A peerStore entry with no addresses at all is the deterministic form of "nothing the
 * dial gater will let us try" — using a real address would make the test depend on
 * which subnets this host happens to be on.
 */
const NO_ADDRESSES: Array<{ multiaddr: { toString(): string } }> = [];

function peerIdLike(id: string) {
	return { toString: () => id, equals: (o: any) => String(o) === id };
}

describe('purgeStalePeer — epoch guard', () => {
	function bareNetwork(onClose?: () => void) {
		const deleted: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).redialBackoff = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).node = {
			getConnections: () => [
				{
					async close(): Promise<void> {
						onClose?.();
					},
				},
			],
			peerStore: {
				async delete(pid: { toString(): string }): Promise<void> {
					deleted.push(pid.toString());
				},
				async merge(): Promise<void> {},
			},
		};
		return { network, deleted };
	}

	it('deletes the peerStore entry while the run still owns the node', async () => {
		const { network, deleted } = bareNetwork();
		await (network as any).purgeStalePeer(PEER_ID, 'test', 1);
		expect(deleted).toEqual([PEER_ID]);
	});

	it('does not touch the peerStore when stop() lands while connections are closing', async () => {
		// The exact race the epoch counter exists for: stop()/start() swaps in a new
		// node during the close await, and the old run must not delete a peer from it.
		const { network, deleted } = bareNetwork();
		const net = network as any;
		net.node.getConnections = () => [
			{
				async close(): Promise<void> {
					net.runEpoch++; // stop() during the await
				},
			},
		];
		await net.purgeStalePeer(PEER_ID, 'test', 1);
		expect(deleted).toEqual([]);
	});

	it('refuses to start at all for a stale epoch', async () => {
		const { network, deleted } = bareNetwork();
		(network as any).runEpoch = 2;
		await (network as any).purgeStalePeer(PEER_ID, 'test', 1);
		expect(deleted).toEqual([]);
	});
});

/**
 * A peer whose every stored address is rejected by the dial gater is NEVER evicted, no
 * matter how long it stays that way.
 *
 * "Unreachable" on this path is a statement about our own routing table: a peer reachable
 * only over a LAN or VPN subnet looks exactly like this the moment that interface drops,
 * and no dial is attempted here, so there is nothing to weigh against it. Holding another
 * connection is not the missing evidence either — the Ethernet link stays up while the
 * VPN dies, which is precisely the case that used to purge a live peer. The peer is
 * parked: not dialled, rows expiring on their own clock, peerStore entry left to libp2p's
 * maxPeerAge.
 */
describe('runRedialMaintenance — a peer with no reachable address', () => {
	function bareNetwork(opts: { weAreOnline: boolean; configured?: boolean }) {
		const purged: string[] = [];
		const dropped: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialBackoff = new Map();
		(network as any).redialSuppressedByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set(opts.configured ? [PEER_ID] : []);
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			deleteDiscoveredByPeerID(pid: string) {
				dropped.push(pid);
			},
		};
		(network as any).pubsub = { getTopics: () => [], getSubscribers: () => [] };
		(network as any).node = { getConnections: () => [] };
		// Only the peer itself is ever asked about; "online" means we hold a connection
		// to somebody else.
		(network as any).hasConnectionOtherThan = () => opts.weAreOnline;
		(network as any).purgeStalePeer = async (pid: string): Promise<void> => {
			purged.push(pid);
		};
		return { network, purged, dropped };
	}

	const undialablePeer = { id: peerIdLike(PEER_ID), addresses: NO_ADDRESSES };
	/** Half a day of ticks: whatever window a future writer reaches for, this outlasts it. */
	async function runForHours(network: Network): Promise<void> {
		for (let tick = 0; tick < 12 * 60 * 2; tick++) await (network as any).runRedialMaintenance([], [undialablePeer], 1);
	}

	it('does not evict it however long it stays unreachable, even while we are online', async () => {
		const { network, purged } = bareNetwork({ weAreOnline: true });
		await runForHours(network);
		expect(purged).toEqual([]);
	});

	it('does not evict it when the outage is ours either', async () => {
		const { network, purged } = bareNetwork({ weAreOnline: false });
		await runForHours(network);
		expect(purged).toEqual([]);
	});

	it('leaves its discovered rows to expire on their own staleness clock', async () => {
		// Dropping them here would hide a live VPN peer from the participant list the
		// moment our own route to it went; sweepStale removes the row of a peer that has
		// actually stopped answering.
		const { network, dropped } = bareNetwork({ weAreOnline: true });
		await runForHours(network);
		expect(dropped).toEqual([]);
	});

	it('does not quarantine it, so a routable address is dialled the moment one appears', async () => {
		const { network } = bareNetwork({ weAreOnline: true });
		await runForHours(network);
		expect((network as any).unreachableQuarantine.size).toBe(0);
	});

	it('never evicts a configured peer', async () => {
		const { network, purged } = bareNetwork({ weAreOnline: true, configured: true });
		await runForHours(network);
		expect(purged).toEqual([]);
	});
});

/**
 * A stretch with no route to the peer breaks the CONTINUITY the eviction window claims,
 * so the failures recorded before it must not count towards the one after it.
 *
 * The dangerous shape: a peer fails a few genuine dials, our LAN/VPN route to it then
 * disappears for longer than the window, and the first transient failure once the route
 * is back completes a count that started before the outage — purging a live peer.
 */
describe('runRedialMaintenance — failures either side of a no-route stretch', () => {
	function bareNetwork() {
		const purged: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialBackoff = new Map();
		(network as any).redialSuppressedByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			deleteDiscoveredByPeerID() {},
		};
		(network as any).pubsub = { getTopics: () => [], getSubscribers: () => [] };
		(network as any).node = {
			getConnections: () => [],
			async dial(): Promise<void> {
				throw new Error('connection refused');
			},
		};
		// We hold connections to others throughout: the outage is in the route to THIS
		// peer, which is exactly the case "are we online at all" cannot see.
		(network as any).hasConnectionOtherThan = () => true;
		(network as any).purgeStalePeer = async (pid: string): Promise<void> => {
			purged.push(pid);
		};
		return { network, purged };
	}

	/** Documentation-range address: the gater lets it through, so the dial runs and fails. */
	const ROUTABLE = [{ multiaddr: multiaddr('/ip4/203.0.113.9/tcp/9090') }];
	/** Same peer with nothing the gater will try — the deterministic form of "no route". */
	const peerWith = (addresses: unknown[]) => ({ id: peerIdLike(PEER_ID), addresses });

	/** Five genuine failures already banked, the window older than the 30-min minimum. */
	function seedOneFailureShortOfEviction(network: Network): void {
		(network as any).redialBackoff.set(PEER_ID, { nextAttempt: Date.now() - 1, failCount: 5, firstFailure: Date.now() - 45 * 60_000, evictionFails: 5 });
	}

	const run = (network: Network, addresses: unknown[]): Promise<void> => (network as any).runRedialMaintenance([], [peerWith(addresses)], 1);

	it('purges a peer whose whole run of failures had a route', async () => {
		// The control: without an outage in between, the sixth failure still evicts.
		const { network, purged } = bareNetwork();
		seedOneFailureShortOfEviction(network);
		await run(network, ROUTABLE);
		expect(purged).toEqual([PEER_ID]);
	});

	it('does not purge one whose failures straddle a period with no route', async () => {
		const { network, purged } = bareNetwork();
		seedOneFailureShortOfEviction(network);
		for (let tick = 0; tick < 5; tick++) await run(network, []); // the route is gone
		await run(network, ROUTABLE); // back, and the live peer blips once
		expect(purged).toEqual([]);
	});

	it('starts a brand new window after the route returns', async () => {
		const { network } = bareNetwork();
		seedOneFailureShortOfEviction(network);
		await run(network, []);
		await run(network, ROUTABLE);
		expect((network as any).redialBackoff.get(PEER_ID).evictionFails).toBe(1);
	});

	it('does not purge one that sat in a backoff for the whole no-route stretch', async () => {
		// The realistic shape, and the one an early `continue` on the backoff gate hides:
		// by the seventh failure the backoff is already at its 10-min cap, so EVERY tick
		// of the outage falls inside it. Reach the no-route reset only after that gate and
		// the outage leaves no trace, and the first blip once the route is back evicts.
		const { network, purged } = bareNetwork();
		(network as any).redialBackoff.set(PEER_ID, { nextAttempt: Date.now() + 10 * 60_000, failCount: 7, firstFailure: Date.now() - 45 * 60_000, evictionFails: 7 });
		for (let tick = 0; tick < 5; tick++) await run(network, []); // route gone, peer parked in backoff
		// The backoff comes due while the route is still down; only then does it return.
		const parked = (network as any).redialBackoff.get(PEER_ID);
		(network as any).redialBackoff.set(PEER_ID, { ...parked, nextAttempt: Date.now() - 1 });
		await run(network, ROUTABLE); // back, and the live peer blips once
		expect(purged).toEqual([]);
		expect((network as any).redialBackoff.get(PEER_ID).evictionFails).toBe(1);
	});

	it('keeps the backoff pacing across the no-route stretch', async () => {
		// Forgetting failCount here would re-dial every parked peer from a 30 s backoff
		// the moment a route came back.
		const { network } = bareNetwork();
		seedOneFailureShortOfEviction(network);
		await run(network, []);
		expect((network as any).redialBackoff.get(PEER_ID).failCount).toBe(5);
	});
});

/**
 * An address may enter the address book only once libp2p has actually connected over
 * it. Deciding that up-front from "do we have any connection to this peer" was too
 * coarse — it skipped relay→direct upgrades and left bad addresses untested — so the
 * answer is now read off the connection libp2p returns.
 */
describe('addBootstrapPeers — only a verified address enters the peerStore', () => {
	function bareNetwork(remoteAddrOfReturnedConn: string) {
		const merges: Array<Record<string, unknown>> = [];
		const forced: boolean[] = [];
		const dialled: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
		const outcomes: string[] = [];
		const actualPeerIDs: Array<string | null> = [];
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			markPending() {},
			recordOutcome(_net: unknown, _addr: unknown, _pid: unknown, status: string, _msg: unknown, actualPeerID: string | null) {
				outcomes.push(status);
				actualPeerIDs.push(actualPeerID);
			},
		};
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getConnections: () => [],
			async dial(ma: { toString(): string }, opts?: { force?: boolean }): Promise<unknown> {
				dialled.push(ma.toString());
				forced.push(opts?.force === true);
				return { remoteAddr: { toString: () => remoteAddrOfReturnedConn }, remotePeer: peerIdLike(PEER_ID) };
			},
			peerStore: {
				async merge(_pid: unknown, patch: Record<string, unknown>): Promise<void> {
					merges.push(patch);
				},
			},
		};
		return { network, merges, dialled, forced, outcomes, actualPeerIDs };
	}

	const ADDR = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;

	it('dials the address even when the peer is already connected', async () => {
		// libp2p reuses a suitable connection by itself and dials when the new address
		// would upgrade a relayed one; pre-empting that lost the upgrade.
		const { network, dialled } = bareNetwork(`/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`);
		(network as any).node.getConnections = () => [{}];
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');
		expect(dialled).toEqual([ADDR]);
	});

	it('stores the address when the connection is actually on it', async () => {
		const { network, merges } = bareNetwork(`/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`);
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');
		expect(merges).toHaveLength(1);
		expect(merges[0]).toHaveProperty('multiaddrs');
	});

	/**
	 * `force: true` defeats connection reuse but not a dial to the same peer id already
	 * in libp2p's queue — this call joins that job and can be handed the connection its
	 * OTHER address won. A configured row means "this address works", so it must not go
	 * green on a connection that never touched it.
	 */
	it('leaves a configured row pending when the connection came back on another address', async () => {
		const { network, outcomes } = bareNetwork(`/ip4/198.51.100.1/tcp/4001/p2p/${PEER_ID}`);
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');
		expect(outcomes).toEqual([]);
	});

	it('still records a discovered row, whose status only claims the peer answered', async () => {
		const { network, outcomes } = bareNetwork(`/ip4/198.51.100.1/tcp/4001/p2p/${PEER_ID}`);
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect(outcomes).toEqual(['connected']);
	});

	it('records the configured row once the connection is on the address itself', async () => {
		const { network, outcomes } = bareNetwork(ADDR);
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');
		expect(outcomes).toEqual(['connected']);
	});

	/**
	 * The row-cap ranking only protects a peer whose identity we have actually PROVEN, and
	 * the successful dial is the only place that proof exists. Recording null there meant
	 * the production path never produced a protected row at all — the protection was real
	 * only in tests that wrote the field by hand.
	 */
	it('records the identity Noise proved on the connection as the verified peer ID', async () => {
		const { network, actualPeerIDs } = bareNetwork(ADDR);
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');
		expect(actualPeerIDs).toEqual([PEER_ID]);
	});

	it('withholds the address when libp2p answered over a different one', async () => {
		// Reused/relayed connection: this address was never contacted, so it is not
		// Noise-verified and must not be poisonable into the address book.
		const { network, merges } = bareNetwork(`/ip4/198.51.100.1/tcp/4001/p2p-circuit/p2p/${PEER_ID}`);
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');
		expect(merges).toHaveLength(1);
		expect(merges[0]).not.toHaveProperty('multiaddrs');
	});
});

/**
 * The address-equality test behind "was THIS address verified". It decides whether an
 * unverified address may enter the peerStore, so a false positive is a security bug,
 * not a cosmetic one.
 */
describe('isSameDialEndpoint', () => {
	const PEER_A = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';

	it('accepts the same endpoint with and without the peer id suffix', () => {
		expect(isSameDialEndpoint('/ip4/203.0.113.4/tcp/9090', `/ip4/203.0.113.4/tcp/9090/p2p/${PEER_A}`)).toBe(true);
	});

	it('rejects a different port that merely shares a prefix', () => {
		// /tcp/80 is a string prefix of /tcp/8080 — prefix matching would call a
		// connection on 8080 proof that the claimed port 80 works.
		expect(isSameDialEndpoint(`/ip4/203.0.113.4/tcp/8080/p2p/${PEER_A}`, `/ip4/203.0.113.4/tcp/80/p2p/${PEER_A}`)).toBe(false);
	});

	it('rejects a different host', () => {
		expect(isSameDialEndpoint(`/ip4/203.0.113.5/tcp/9090/p2p/${PEER_A}`, `/ip4/203.0.113.4/tcp/9090/p2p/${PEER_A}`)).toBe(false);
	});

	it('rejects a relayed connection as proof of a direct address', () => {
		expect(isSameDialEndpoint(`/ip4/198.51.100.1/tcp/4001/p2p/${PEER_A}/p2p-circuit/p2p/${PEER_A}`, `/ip4/203.0.113.4/tcp/9090/p2p/${PEER_A}`)).toBe(false);
	});

	it('ignores DNS case and a trailing dot', () => {
		expect(isSameDialEndpoint('/dns4/EXAMPLE.COM./tcp/443', '/dns4/example.com/tcp/443')).toBe(true);
	});

	it('treats a missing connection address as no proof', () => {
		expect(isSameDialEndpoint('', `/ip4/203.0.113.4/tcp/9090/p2p/${PEER_A}`)).toBe(false);
	});

	it('rejects a relay whose identity differs only in case', () => {
		// Only the trailing /p2p/<id> is stripped, so a circuit address is compared with
		// the RELAY's peer id still in the middle. Folding the whole string would make two
		// distinct relays look like one endpoint.
		const relay = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
		const otherRelay = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrnGS17fo';
		expect(isSameDialEndpoint(`/ip4/198.51.100.1/tcp/4001/p2p/${relay}/p2p-circuit/p2p/${PEER_A}`, `/ip4/198.51.100.1/tcp/4001/p2p/${otherRelay}/p2p-circuit/p2p/${PEER_A}`)).toBe(false);
	});
});

/**
 * Case folding is a hostname question, not an identifier question. DNS is defined as
 * case-insensitive; a base58 peer id is not, and the two live in the same string.
 */
describe('normalizeMultiaddrForCompare', () => {
	it('folds DNS host case and drops the FQDN root dot', () => {
		expect(normalizeMultiaddrForCompare('/dns4/EXAMPLE.COM./tcp/443')).toBe('/dns4/example.com/tcp/443');
	});

	it('folds every DNS protocol variant', () => {
		expect(normalizeMultiaddrForCompare('/dnsaddr/Bootstrap.Example.COM/tcp/443')).toBe('/dnsaddr/bootstrap.example.com/tcp/443');
		expect(normalizeMultiaddrForCompare('/dns6/Example.COM/tcp/443')).toBe('/dns6/example.com/tcp/443');
	});

	it('leaves a peer id untouched', () => {
		const peer = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
		expect(normalizeMultiaddrForCompare(`/dns4/EXAMPLE.COM/tcp/443/p2p/${peer}`)).toBe(`/dns4/example.com/tcp/443/p2p/${peer}`);
	});

	it('leaves an address with no DNS component completely alone', () => {
		const addr = '/ip4/203.0.113.4/tcp/9090/p2p/12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
		expect(normalizeMultiaddrForCompare(addr)).toBe(addr);
	});
});

/**
 * A configured bootstrap address is the user's own claim and its status row is how they
 * debug it, so it must be probed for real rather than satisfied by any connection that
 * happens to exist to the same peer. Gossiped addresses must not force: a peer naming
 * many of them could otherwise make us open a connection per address.
 */
describe('addBootstrapPeers — forced probe only for configured addresses', () => {
	function bareNetwork() {
		const forced: boolean[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			markPending() {},
			recordOutcome() {},
		};
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getConnections: () => [{}], // already connected to this peer some other way
			async dial(ma: { toString(): string }, opts?: { force?: boolean }): Promise<unknown> {
				forced.push(opts?.force === true);
				return { remoteAddr: { toString: () => ma.toString() } };
			},
			peerStore: { async merge(): Promise<void> {} },
		};
		return { network, forced };
	}

	const ADDR = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;

	it('forces the dial for a configured address', async () => {
		const { network, forced } = bareNetwork();
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');
		expect(forced).toEqual([true]);
	});

	it('does not force the dial for a discovered address', async () => {
		const { network, forced } = bareNetwork();
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect(forced).toEqual([false]);
	});
});

/**
 * "Is this configured infrastructure?" and "may we auto-evict it?" are the same
 * question about the same fact. They used to be answered from two separate sets and
 * only one of them was ever pruned, so a peer the user had already deleted from the
 * bootstrap config kept its eviction exemption until the process restarted.
 */
describe('configured exemption ends when the peer leaves the config', () => {
	function bareNetwork() {
		const purged: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialBackoff = new Map();
		(network as any).redialSuppressedByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		// One failure short of eviction, failing for longer than the window: the next
		// failed dial is the one that decides, so the exemption is all that stands
		// between this peer and the purge.
		(network as any).redialBackoff = new Map([[PEER_ID, { nextAttempt: Date.now() - 1, failCount: 5, firstFailure: Date.now() - 45 * 60_000, evictionFails: 5 }]]);
		(network as any).configuredBootstrapPeerIDs = new Set([PEER_ID]);
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).bootstrapPeerIDs = new Set([PEER_ID]);
		(network as any).bootstrapMultiaddrs = [multiaddr(`/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`)];
		(network as any).configuredBootstrapAddresses = new Set([normalizeMultiaddrForCompare(`/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`)]);
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).addressProbeBackoff = new Map();
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			deleteDiscoveredByPeerID() {},
		};
		(network as any).pubsub = { getTopics: () => [], getSubscribers: () => [] };
		(network as any).node = {
			getConnections: () => [],
			async dial(): Promise<void> {
				throw new Error('connection refused');
			},
		};
		(network as any).hasConnectionOtherThan = () => true;
		(network as any).purgeStalePeer = async (pid: string): Promise<void> => {
			purged.push(pid);
		};
		return { network, purged };
	}

	// A documentation-range address, so the dial gater lets the peer through to the dial
	// that then fails — the only evidence eviction is allowed to act on.
	const dead = { id: peerIdLike(PEER_ID), addresses: [{ multiaddr: multiaddr('/ip4/203.0.113.9/tcp/9090') }] };
	const run = (network: Network): Promise<void> => (network as any).runRedialMaintenance([], [dead], 1);

	it('protects the peer while it is still configured', async () => {
		const { network, purged } = bareNetwork();
		await run(network);
		expect(purged).toEqual([]);
	});

	it('does not purge a peer that connected while this pass was failing on it', async () => {
		// purgeStalePeer closes connections, so evicting a peer that has just come back —
		// over an inbound dial, or any other path this loop cannot see — would cut a live
		// connection on the strength of stale evidence. The check has to be made in the
		// moment of acting, not when the candidate list was built.
		const { network, purged } = bareNetwork();
		network.pruneConfiguredBootstrapPeer(PEER_ID); // remove the exemption, so only liveness is left
		(network as any).node.getConnections = (): unknown[] => [{ remotePeer: peerIdLike(PEER_ID) }];

		await run(network);

		expect(purged).toEqual([]);
		expect((network as any).redialBackoff.has(PEER_ID)).toBe(false); // and its failure history is dropped
	});

	it('stops protecting it once the config entry is gone', async () => {
		const { network, purged } = bareNetwork();
		network.pruneConfiguredBootstrapPeer(PEER_ID);
		await run(network);
		expect(purged).toEqual([PEER_ID]);
	});

	it('drops the infrastructure status in the same step', async () => {
		// The two used to be able to disagree; pruning must settle both at once.
		const { network } = bareNetwork();
		expect(network.isBootstrapOrRelayPeer(PEER_ID)).toBe(true);
		network.pruneConfiguredBootstrapPeer(PEER_ID);
		expect(network.isBootstrapOrRelayPeer(PEER_ID)).toBe(false);
	});
	/**
	 * The autodial list is what zero-connection recovery walks. A bootstrap the user
	 * has deleted must leave it too, or the node keeps dialing that address every time
	 * it runs out of connections — the churn this work is supposed to end.
	 */
	it('forgets the deleted bootstrap address, so recovery stops dialing it', () => {
		const { network } = bareNetwork();
		expect((network as any).bootstrapMultiaddrs).toHaveLength(1);
		network.pruneConfiguredBootstrapPeer(PEER_ID);
		expect((network as any).bootstrapMultiaddrs).toEqual([]);
	});

	it('also forgets it in the dedup set, so a later re-add can restore the address', () => {
		const { network } = bareNetwork();
		network.pruneConfiguredBootstrapPeer(PEER_ID);
		expect((network as any).bootstrapPeerIDs.has(PEER_ID)).toBe(false);
	});

	it('leaves the addresses of other peers alone', () => {
		const other = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fp';
		const { network } = bareNetwork();
		(network as any).bootstrapMultiaddrs.push(multiaddr(`/ip4/203.0.113.10/tcp/9090/p2p/${other}`));
		network.pruneConfiguredBootstrapPeer(PEER_ID);
		expect((network as any).bootstrapMultiaddrs.map((m: { toString(): string }) => m.toString())).toEqual([`/ip4/203.0.113.10/tcp/9090/p2p/${other}`]);
	});
});

/**
 * The bootstrap list is walked one peer at a time and a single dial can take seconds.
 * If the user edits that list — or leaves the network — mid-walk, the job started for
 * the OLD list must stop: carrying on would re-add entries that are no longer
 * configured AND re-mark them configured, which exempts them from the stale sweep for
 * the rest of the process's life. That is precisely the resurrection this work exists
 * to prevent, so the guard is checked here against a real second list entry.
 */
describe('addBootstrapPeers — superseded bootstrap configuration', () => {
	const PEER_B = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fp';
	const ADDR_A = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;
	const ADDR_B = `/ip4/203.0.113.10/tcp/9090/p2p/${PEER_B}`;

	function bareNetwork(onFirstDial?: (network: Network) => void) {
		const dialled: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			markPending() {},
			recordOutcome() {},
		};
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getConnections: () => [],
			async dial(ma: { toString(): string }): Promise<unknown> {
				dialled.push(ma.toString());
				// Model the edit landing while the FIRST dial is still in flight.
				if (dialled.length === 1) onFirstDial?.(network);
				return { remoteAddr: { toString: () => ma.toString() } };
			},
			peerStore: {
				async merge(): Promise<void> {},
			},
		};
		return { network, dialled };
	}

	it('abandons the rest of the list when the network configuration is superseded', async () => {
		const { network, dialled } = bareNetwork(n => n.bumpBootstrapGeneration('net-a'));
		await (network as any).addBootstrapPeers([ADDR_A, ADDR_B], 'net-a', 'configured');
		expect(dialled).toEqual([ADDR_A]);
	});

	it('does not re-mark the abandoned entry as configured', async () => {
		const { network } = bareNetwork(n => n.bumpBootstrapGeneration('net-a'));
		await (network as any).addBootstrapPeers([ADDR_A, ADDR_B], 'net-a', 'configured');
		expect((network as any).configuredBootstrapPeerIDs.has(PEER_B)).toBe(false);
	});

	it('walks the whole list when nothing supersedes it', async () => {
		const { network, dialled } = bareNetwork();
		await (network as any).addBootstrapPeers([ADDR_A, ADDR_B], 'net-a', 'configured');
		expect(dialled).toEqual([ADDR_A, ADDR_B]);
	});

	it('is not disturbed by an edit to a DIFFERENT network', async () => {
		const { network, dialled } = bareNetwork(n => n.bumpBootstrapGeneration('net-other'));
		await (network as any).addBootstrapPeers([ADDR_A, ADDR_B], 'net-a', 'configured');
		expect(dialled).toEqual([ADDR_A, ADDR_B]);
	});

	/**
	 * A shutdown that WAITS for the joins already under way needs a way to end this loop; a
	 * long list of unreachable addresses is otherwise one connection timeout each before the
	 * node can be stopped.
	 */
	it('abandons the rest of the list once the run’s dials are cancelled', async () => {
		const { network, dialled } = bareNetwork(n => n.cancelRunOperations());
		await (network as any).addBootstrapPeers([ADDR_A, ADDR_B], 'net-a', 'configured');
		expect(dialled).toEqual([ADDR_A]);
	});

	/** The signal reaches libp2p itself, so the dial in flight ends rather than timing out. */
	it('gives every dial a signal the run can cancel', async () => {
		// Asserted by behaviour rather than identity: the signal handed to the dial is a
		// composite — the run's abort AND a timeout, so a black-holed address cannot hold
		// the entry open either. What matters is that cancelling the run still aborts it.
		const signals: Array<AbortSignal | undefined> = [];
		const { network } = bareNetwork();
		(network as any).node.dial = async (_ma: unknown, opts?: { signal?: AbortSignal }): Promise<unknown> => {
			signals.push(opts?.signal);
			return { remoteAddr: { toString: () => ADDR_A } };
		};

		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');

		expect(signals[0]).toBeDefined();
		// Not the run's own signal: a black-holed address is never refused, so the dial also
		// needs something that fires on its own — see BOOTSTRAP_DIAL_TIMEOUT_MS. Handing the
		// raw run signal down left such an entry 'pending' for the OS connect timeout.
		expect(signals[0]).not.toBe((network as any).dialAbort.signal);
		expect(signals[0]!.aborted).toBe(false);
		(network as any).dialAbort.abort();
		expect(signals[0]!.aborted).toBe(true);
	});

	/** An abort belongs to the run it was raised for — the next start must dial again. */
	it('dials again after a restart replaces the cancelled controller', async () => {
		const { network, dialled } = bareNetwork();
		network.cancelRunOperations();
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		expect(dialled).toEqual([]);

		(network as any).dialAbort = new AbortController();
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		expect(dialled).toEqual([ADDR_A]);
	});
});

/**
 * A dial already handed to libp2p cannot be recalled: hangUp closes connections that
 * already exist, so a leave-network landing mid-dial finds nothing to close and the
 * connection appears a moment after the cleanup finished. Abandoning the loop is not
 * enough — the connection has to be closed too.
 */
describe('addBootstrapPeers — a dial that lands after leave-network', () => {
	const ADDR = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork(suppressed: string[]) {
		const disconnected: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map([['net-a', new Set(suppressed)]]);
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			markPending() {},
			recordOutcome() {},
		};
		(network as any).disconnectPeer = async (peerID: string): Promise<void> => {
			disconnected.push(peerID);
		};
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getConnections: () => [],
			async dial(ma: { toString(): string }): Promise<unknown> {
				// The leave happens while this dial is in flight.
				(network as any).redialSuppressedByNet.get('net-a').add(PEER_ID);
				return { remoteAddr: { toString: () => ma.toString() } };
			},
			peerStore: { async merge(): Promise<void> {} },
		};
		return { network, disconnected };
	}

	it('closes a connection that arrived after the peer was left', async () => {
		const { network, disconnected } = bareNetwork([]);
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect(disconnected).toEqual([PEER_ID]);
	});

	/**
	 * Tearing the peer down is destructive — disconnectPeer suppresses re-dials and
	 * drops the peerStore entry — so leaving ONE network must not do it to a peer
	 * another joined network still has a claim on. Here the peer is configured
	 * infrastructure, which is claim enough.
	 */
	it('keeps a connection to a peer another joined network still needs', async () => {
		const { network, disconnected } = bareNetwork([]);
		(network as any).configuredBootstrapPeerIDs = new Set([PEER_ID]);
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect(disconnected).toEqual([]);
	});

	it('keeps a connection to a peer that still subscribes another joined topic', async () => {
		const { network, disconnected } = bareNetwork([]);
		(network as any).pubsub = { getTopics: () => ['lish/net-b'], getSubscribers: () => [{ toString: () => PEER_ID }] };
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect(disconnected).toEqual([]);
	});

	/**
	 * The peer we were dialing may never have been seen as a member of the network, so
	 * leave-network had nothing to hang up and never put it in the suppression set.
	 * Leaving the topic is the fact that decides it, not the suppression bookkeeping.
	 */
	it('closes a connection to a peer we never saw as a member of the network we left', async () => {
		const { network, disconnected } = bareNetwork([]);
		(network as any).node.dial = async (ma: { toString(): string }): Promise<unknown> => ({ remoteAddr: { toString: () => ma.toString() } });
		(network as any).pubsub = { getTopics: () => [] };
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect(disconnected).toEqual([PEER_ID]);
	});

	it('keeps the connection while the network is still joined', async () => {
		const { network, disconnected } = bareNetwork([]);
		(network as any).node.dial = async (ma: { toString(): string }): Promise<unknown> => ({ remoteAddr: { toString: () => ma.toString() } });
		(network as any).pubsub = { getTopics: () => ['lish/net-a'] };
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect(disconnected).toEqual([]);
	});

	it('leaves an ordinary dial connected', async () => {
		const { network, disconnected } = bareNetwork([]);
		// No leave lands this time: the dial does not add the peer to the suppression set.
		(network as any).node.dial = async (ma: { toString(): string }): Promise<unknown> => ({ remoteAddr: { toString: () => ma.toString() } });
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');
		expect(disconnected).toEqual([]);
	});
});

/**
 * The autodial list is what zero-connection recovery dials. A gossip mention is only
 * a claim, so an address that never answered must not end up on it — otherwise a peer
 * naming many unreachable addresses parks them all there permanently, since an
 * ordinary timeout has no cleanup path (only identity-mismatch does).
 */
describe('addBootstrapPeers — only a working discovered address joins the autodial list', () => {
	const ADDR = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork(opts: { fail?: boolean; remoteAddr?: string }) {
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			markPending() {},
			recordOutcome() {},
		};
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getConnections: () => [],
			async dial(ma: { toString(): string }): Promise<unknown> {
				if (opts.fail) throw new Error('dial timeout');
				return { remoteAddr: { toString: () => opts.remoteAddr ?? ma.toString() } };
			},
			peerStore: { async merge(): Promise<void> {} },
		};
		return network;
	}

	const addresses = (network: Network): string[] => (network as any).bootstrapMultiaddrs.map((m: { toString(): string }) => m.toString());

	it('keeps a failed discovered address off the list', async () => {
		const network = bareNetwork({ fail: true });
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect(addresses(network)).toEqual([]);
	});

	it('adds a discovered address that answered on the endpoint it claimed', async () => {
		const network = bareNetwork({});
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect(addresses(network)).toEqual([ADDR]);
	});

	it('keeps a discovered address off the list when the connection came back on another one', async () => {
		const network = bareNetwork({ remoteAddr: `/ip4/198.51.100.1/tcp/4001/p2p/${PEER_ID}` });
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect(addresses(network)).toEqual([]);
	});

	/**
	 * A configured entry is user data: recovery has to keep trying it precisely while
	 * it is down, so it joins the list before the dial and stays even when that fails.
	 */
	it('keeps a failed configured address on the list', async () => {
		const network = bareNetwork({ fail: true });
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');
		expect(addresses(network)).toEqual([ADDR]);
	});

	it('does not add the same address twice', async () => {
		const network = bareNetwork({});
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');
		expect(addresses(network)).toEqual([ADDR]);
	});

	/**
	 * The dedup used to be keyed on the peer id, so a bootstrap whose host the user
	 * edited was treated as already known and its new address never reached the list.
	 */
	it('adds a new address of a peer it already knows', async () => {
		const moved = `/ip4/203.0.113.99/tcp/9090/p2p/${PEER_ID}`;
		const network = bareNetwork({});
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');
		await (network as any).addBootstrapPeers([moved], 'net-a', 'configured');
		expect(addresses(network)).toEqual([ADDR, moved]);
	});
});

/**
 * Whether an address is dialable is a fact about THIS HOST right now — a LAN or VPN
 * bootstrap stops passing the routability filter the moment that interface drops.
 * Whether the user configured a peer is a fact about the saved config. Deriving the
 * second from the first left a VPN bootstrap unregistered whenever the tunnel was
 * down at startup, and an unregistered configured peer loses the exemption that is
 * supposed to make it un-evictable.
 */
describe('addBootstrapPeers — a non-routable configured entry is still configured', () => {
	// A private address in a subnet this host is not on: the filter rejects it.
	const OFF_VPN = `/ip4/10.201.0.5/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork() {
		const outcomes: Array<{ status: string; message: string | null }> = [];
		const dialled: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			markPending() {},
			recordOutcome(_n: unknown, _a: unknown, _p: unknown, status: string, message: string | null) {
				outcomes.push({ status, message });
			},
		};
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getConnections: () => [],
			async dial(ma: { toString(): string }): Promise<unknown> {
				dialled.push(ma.toString());
				return { remoteAddr: { toString: () => ma.toString() } };
			},
			peerStore: { async merge(): Promise<void> {} },
		};
		return { network, outcomes, dialled };
	}

	it('registers the peer as configured even though the address is not routable', async () => {
		const { network } = bareNetwork();
		await (network as any).addBootstrapPeers([OFF_VPN], 'net-a', 'configured');
		expect((network as any).configuredBootstrapPeerIDs.has(PEER_ID)).toBe(true);
	});

	it('still does not dial an address the filter rejected', async () => {
		const { network, dialled } = bareNetwork();
		await (network as any).addBootstrapPeers([OFF_VPN], 'net-a', 'configured');
		expect(dialled).toEqual([]);
	});

	it('tells the user why the configured entry is doing nothing', async () => {
		const { network, outcomes } = bareNetwork();
		await (network as any).addBootstrapPeers([OFF_VPN], 'net-a', 'configured');
		expect(outcomes).toEqual([{ status: 'error', message: 'address is not routable from this host' }]);
	});

	/**
	 * It has to be on the recovery list even while unroutable, or nothing retries it
	 * when the interface comes back. Recovery re-checks routability before dialing.
	 */
	it('still puts the unroutable configured address on the recovery list', async () => {
		const { network } = bareNetwork();
		await (network as any).addBootstrapPeers([OFF_VPN], 'net-a', 'configured');
		expect((network as any).bootstrapMultiaddrs.map((m: { toString(): string }) => m.toString())).toEqual([OFF_VPN]);
	});

	it('says nothing about a discovered address the filter rejected', async () => {
		const { network, outcomes } = bareNetwork();
		await (network as any).addBootstrapPeers([OFF_VPN], 'net-a', 'discovered');
		expect(outcomes).toEqual([]);
		expect((network as any).configuredBootstrapPeerIDs.has(PEER_ID)).toBe(false);
	});
});

/**
 * An expired quarantine buys exactly one probe. Letting a failed probe pass without
 * closing the window again means every later gossip mention spends another dial and
 * refreshes the status row — the churn the quarantine exists to stop.
 */
describe('addBootstrapPeers — quarantine after the probe it allowed', () => {
	const ADDR = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork(fail: boolean, quarantinedAt: number) {
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).unreachableQuarantine = new Map([[PEER_ID, quarantinedAt]]);
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			markPending() {},
			recordOutcome() {},
		};
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getConnections: () => [],
			async dial(ma: { toString(): string }): Promise<unknown> {
				if (fail) throw new Error('dial timeout');
				return { remoteAddr: { toString: () => ma.toString() } };
			},
			peerStore: { async merge(): Promise<void> {} },
		};
		return network;
	}

	const LONG_AGO = Date.now() - 10 * 60 * 60_000;

	it('re-arms the quarantine when the allowed probe fails', async () => {
		const network = bareNetwork(true, LONG_AGO);
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		const at = (network as any).unreachableQuarantine.get(PEER_ID);
		expect(at).toBeGreaterThan(LONG_AGO);
	});

	it('leaves the quarantine lifted when the probe succeeds', async () => {
		const network = bareNetwork(false, LONG_AGO);
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect((network as any).unreachableQuarantine.has(PEER_ID)).toBe(false);
	});

	it('does not quarantine a plain failure that was never in one', async () => {
		const network = bareNetwork(true, LONG_AGO);
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect((network as any).unreachableQuarantine.has(PEER_ID)).toBe(false);
	});
});

/**
 * Zero-connection recovery used to dial every address it held, ignoring the pacing
 * re-dial maintenance had just applied. On an isolated node that meant a dead
 * discovered peer was re-dialed every tick forever, because maintenance stops
 * counting failures the moment there is no other connection to prove we are online.
 */
describe('isRecoveryDialDue', () => {
	const now = 1_000_000;
	const none = new Map<string, number>();
	const noBackoff = new Map<string, { nextAttempt: number }>();

	it('allows a peer with no backoff and no quarantine', () => {
		expect(isRecoveryDialDue(PEER_ID, now, noBackoff, none)).toBe(true);
	});

	it('holds a peer back inside its backoff window and releases it after', () => {
		expect(isRecoveryDialDue(PEER_ID, now, new Map([[PEER_ID, { nextAttempt: now + 1 }]]), none)).toBe(false);
		expect(isRecoveryDialDue(PEER_ID, now, new Map([[PEER_ID, { nextAttempt: now }]]), none)).toBe(true);
	});

	it('holds a quarantined peer back until the window passes', () => {
		expect(isRecoveryDialDue(PEER_ID, now, noBackoff, new Map([[PEER_ID, now - 60_000]]))).toBe(false);
		expect(isRecoveryDialDue(PEER_ID, now, noBackoff, new Map([[PEER_ID, now - 10 * 60 * 60_000]]))).toBe(true);
	});
});

/**
 * Noise proves one thing only: THIS address no longer leads to the peer we expected.
 * Purging the whole peer because it happened to be disconnected threw away addresses
 * that were never disproved — a peer reachable tomorrow on its other address was
 * forgotten because one stale entry answered with the wrong identity today.
 */
describe('addBootstrapPeers — identity mismatch trims the address, not the peer', () => {
	const BAD = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;
	const GOOD = `/ip4/198.51.100.7/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork(storedAddresses: string[]) {
		const purged: string[] = [];
		const patched: string[][] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [multiaddr(BAD)];
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			markPending() {},
			recordOutcome() {},
			deletePeer() {},
		};
		(network as any).purgeStalePeer = async (id: string): Promise<void> => {
			purged.push(id);
		};
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getConnections: () => [],
			async dial(): Promise<unknown> {
				throw new Error(`Payload identity key 12D3KooWSomeoneElseSomeoneElseSomeoneElseSomeoneEls does not match expected remote identity key ${PEER_ID}`);
			},
			peerStore: {
				async get(): Promise<unknown> {
					return { addresses: storedAddresses.map(a => ({ multiaddr: multiaddr(a) })) };
				},
				async patch(_pid: unknown, data: { multiaddrs: Array<{ toString(): string }> }): Promise<void> {
					patched.push(data.multiaddrs.map(m => m.toString()));
				},
				async merge(): Promise<void> {},
			},
		};
		return { network, purged, patched };
	}

	it('keeps a disconnected peer that still has an undisproved address', async () => {
		const { network, purged, patched } = bareNetwork([BAD, GOOD]);
		await (network as any).addBootstrapPeers([BAD], 'net-a', 'configured');
		expect(purged).toEqual([]);
		expect(patched).toEqual([[GOOD]]);
	});

	it('purges only once nothing usable is left', async () => {
		const { network, purged } = bareNetwork([BAD]);
		await (network as any).addBootstrapPeers([BAD], 'net-a', 'configured');
		expect(purged).toEqual([PEER_ID]);
	});

	it('drops the disproved address from the autodial list either way', async () => {
		const { network } = bareNetwork([BAD, GOOD]);
		await (network as any).addBootstrapPeers([BAD], 'net-a', 'configured');
		expect((network as any).bootstrapMultiaddrs).toEqual([]);
	});
});

/**
 * An address the routability filter rejected never reaches the peerStore, so re-dial
 * maintenance has no candidate for it, and zero-connection recovery only runs with NO
 * connections at all. Without this slow pass a node talking to someone else would
 * never notice a VPN bootstrap became reachable again.
 */
describe('probeParkedConfiguredBootstraps', () => {
	const PARKED = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;

	/** A second configured address of the SAME peer — the sibling finding 4 is about. */
	const SIBLING = `/ip4/198.51.100.7/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork(opts: { configured?: boolean; addresses?: string[]; connectionAddrs?: string[]; failAddresses?: string[] } = {}) {
		const dialed: string[] = [];
		const addresses = opts.addresses ?? [PARKED];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set(opts.configured === false ? [] : [PEER_ID]);
		(network as any).configuredBootstrapAddresses = new Set(opts.configured === false ? [] : addresses.map(a => normalizeMultiaddrForCompare(a)));
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).addressProbeBackoff = new Map();
		(network as any).bootstrapMultiaddrs = addresses.map(a => multiaddr(a));
		const repaired: string[] = [];
		(network as any).bootstrapTracker = {
			recordAddressUnreachable(): void {},
			recordAddressReachable(address: string) {
				repaired.push(address);
			},
		};
		(network as any).node = {
			getConnections: () => (opts.connectionAddrs ?? []).map(a => ({ remoteAddr: { toString: () => a } })),
			async dial(ma: { toString(): string }): Promise<void> {
				dialed.push(ma.toString());
				if (opts.failAddresses?.includes(ma.toString())) throw new Error('dial timeout');
			},
		};
		return { network, dialed, repaired };
	}

	const run = (network: Network): Promise<void> => (network as any).probeParkedConfiguredBootstraps(1);

	it('probes a configured address even though we hold other connections', async () => {
		const { network, dialed } = bareNetwork({ connectionAddrs: [`/ip4/198.51.100.200/tcp/9090/p2p/${PEER_ID}`] });
		await run(network);
		expect(dialed).toEqual([multiaddr(PARKED).toString()]);
	});

	/**
	 * This probe is the only thing that ever retries an address the routability filter
	 * rejected at configure time — a LAN or VPN bootstrap whose interface was down. The
	 * `error` row written back then had no other way to go green again.
	 */
	it('repairs the status row when a parked address answers', async () => {
		const { network, repaired } = bareNetwork();
		await run(network);
		expect(repaired).toEqual([multiaddr(PARKED).toString()]);
	});

	it('leaves the row alone while the address is still failing', async () => {
		const { network, repaired } = bareNetwork({ failAddresses: [multiaddr(PARKED).toString()] });
		await run(network);
		expect(repaired).toEqual([]);
	});

	it('leaves a discovered address to the loops that own it', async () => {
		const { network, dialed } = bareNetwork({ configured: false });
		await run(network);
		expect(dialed).toEqual([]);
	});

	/**
	 * Only a connection ON THIS ENDPOINT answers what the probe asks. A connection to the
	 * same peer over another address used to skip it — which is how a broken configured
	 * entry kept looking fine for as long as the peer was reachable some other way.
	 */
	it('skips only when the existing connection is on this very address', async () => {
		const { network, dialed } = bareNetwork({ connectionAddrs: [PARKED] });
		await run(network);
		expect(dialed).toEqual([]);
	});

	it('respects the backoff so a broken entry costs one dial per window', async () => {
		const { network, dialed } = bareNetwork();
		(network as any).addressProbeBackoff = new Map([[normalizeMultiaddrForCompare(PARKED), { nextAttempt: Date.now() + 60_000, failCount: 1 }]]);
		await run(network);
		expect(dialed).toEqual([]);
	});

	it('skips a peer the user left', async () => {
		const { network, dialed } = bareNetwork();
		(network as any).redialSuppressedByNet = new Map([['net-a', new Set([PEER_ID])]]);
		await run(network);
		expect(dialed).toEqual([]);
	});

	/**
	 * The backoff used to be keyed by PEER while the loop iterates by ADDRESS: the dead
	 * address failed, the whole peer went into backoff, its working sibling was skipped
	 * for the rest of the pass — and the next pass started at the dead one again, so the
	 * sibling could go untried indefinitely.
	 */
	it('tries the sibling address of a peer whose other address just failed', async () => {
		const { network, dialed } = bareNetwork({ addresses: [PARKED, SIBLING], failAddresses: [multiaddr(PARKED).toString()] });
		await run(network);
		expect(dialed).toEqual([multiaddr(PARKED).toString(), multiaddr(SIBLING).toString()]);
	});

	it('paces each address on its own record', async () => {
		const { network } = bareNetwork({ addresses: [PARKED, SIBLING], failAddresses: [multiaddr(PARKED).toString()] });
		await run(network);
		const backoff = (network as any).addressProbeBackoff as Map<string, { failCount: number }>;
		expect(backoff.has(normalizeMultiaddrForCompare(PARKED))).toBe(true);
		expect(backoff.has(normalizeMultiaddrForCompare(SIBLING))).toBe(false);
	});

	/**
	 * Without `force` libp2p hands back whatever connection it already holds to the peer,
	 * so the probe would resolve without ever touching the address it is asking about.
	 */
	it('forces the dial so the address itself is contacted', async () => {
		const forced: boolean[] = [];
		const { network } = bareNetwork();
		(network as any).node.dial = async (_ma: unknown, opts?: { force?: boolean }): Promise<void> => {
			forced.push(opts?.force === true);
		};
		await run(network);
		expect(forced).toEqual([true]);
	});
});

/**
 * One peer can hold a configured address AND a gossip-learned one at the same time.
 * Deciding "is this configured" from the peer id let the gossip-learned sibling
 * inherit the configured exemption — no backoff, no quarantine, and it survived the
 * user deleting the configured entry it had nothing to do with.
 */
describe('configured origin is a property of the address, not the peer', () => {
	const CONFIGURED = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;
	const DISCOVERED = `/ip4/198.51.100.7/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork() {
		const dialed: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set([PEER_ID]);
		(network as any).configuredBootstrapAddresses = new Set([normalizeMultiaddrForCompare(CONFIGURED)]);
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).addressProbeBackoff = new Map();
		(network as any).bootstrapPeerIDs = new Set([PEER_ID]);
		(network as any).bootstrapMultiaddrs = [multiaddr(CONFIGURED), multiaddr(DISCOVERED)];
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
			getConnections: () => [],
			async dial(ma: { toString(): string }): Promise<void> {
				dialed.push(ma.toString());
			},
		};
		return { network, dialed };
	}

	const addresses = (network: Network): string[] => (network as any).bootstrapMultiaddrs.map((m: { toString(): string }) => m.toString());

	it('paces a discovered address whose peer is configured under a DIFFERENT address', async () => {
		// Only the discovered address is on the list, so nothing else can satisfy the
		// loop: if it gets dialed while inside its backoff window, it was wrongly given
		// the configured exemption its sibling address owns.
		const { network, dialed } = bareNetwork();
		(network as any).bootstrapMultiaddrs = [multiaddr(DISCOVERED)];
		(network as any).redialBackoff = new Map([[PEER_ID, { nextAttempt: Date.now() + 60_000, failCount: 1, firstFailure: Date.now(), evictionFails: 0 }]]);
		await (network as any).runZeroConnectionRecovery();
		expect(dialed).toEqual([]);
	});

	it('still lets the configured address through the same backoff', async () => {
		const { network, dialed } = bareNetwork();
		(network as any).bootstrapMultiaddrs = [multiaddr(CONFIGURED)];
		(network as any).redialBackoff = new Map([[PEER_ID, { nextAttempt: Date.now() + 60_000, failCount: 1, firstFailure: Date.now(), evictionFails: 0 }]]);
		await (network as any).runZeroConnectionRecovery();
		expect(dialed).toEqual([multiaddr(CONFIGURED).toString()]);
	});

	it('keeps the discovered address when the configured one is deleted', () => {
		const { network } = bareNetwork();
		network.pruneConfiguredBootstrapPeer(PEER_ID);
		expect(addresses(network)).toEqual([multiaddr(DISCOVERED).toString()]);
	});
});

/**
 * stop() clears the per-run state so a restart starts clean. The slow-cadence counter
 * was left out, so a fresh node could inherit a count that made its very first tick the
 * slow one — the opposite of the ownership the epoch guards enforce everywhere else.
 * The delayed peer-count probes were likewise untracked and kept firing at a node the
 * run no longer owned.
 */
describe('Network.stop — per-run state really is per run', () => {
	function bareNetwork() {
		const network = Object.create(Network.prototype) as Network;
		for (const field of ['lastWantResponseTime', 'seenSearchIDs', 'topicHandlers', 'dcutrPeers', 'bootstrapPeerIDs', 'bootstrapGeneration', '_lastPeerCounts', '_lastScores', 'redialBackoff', 'unreachableQuarantine', 'addressProbeBackoff', 'configuredBootstrapPeerIDs', 'configuredBootstrapAddresses', 'configuredBootstrapAddressesByNet', 'redialSuppressedByNet', 'pxIngressLogKeys', 'inFlightBootstrapDials']) {
			(network as any)[field] = field === 'seenSearchIDs' || field === 'dcutrPeers' || field === 'bootstrapPeerIDs' || field === 'configuredBootstrapPeerIDs' || field === 'configuredBootstrapAddresses' ? new Set() : new Map();
		}
		(network as any).runEpoch = 1;
		(network as any).statusInterval = null;
		(network as any).wantResponseCleanupInterval = null;
		(network as any)._peerCountDebounceTimer = null;
		(network as any).listeners = [];
		(network as any).bootstrapMultiaddrs = [];
		(network as any).delayedPeerCountTimers = new Set();
		(network as any).peerAnnounce = { stop() {} };
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			clear() {},
		};
		(network as any).node = null;
		(network as any).datastore = null;
		// stop() runs under the lifecycle mutex; a prototype-only instance has no field
		// initializers, so it has to be supplied here.
		(network as any).lifecycle = 'running';
		(network as any).lifecycleMutex = new Mutex();
		return network;
	}

	it('resets the slow-cadence tick counter', async () => {
		const network = bareNetwork();
		(network as any).statusTickCount = 4; // one short of the slow tick
		await network.stop();
		expect((network as any).statusTickCount).toBe(0);
	});

	/**
	 * The epoch guard already stops a late probe from DOING anything, so observing the
	 * callback proves nothing about cancellation. What has to be asserted is that the
	 * handle is actually released — otherwise a pending timer keeps a closure on the old
	 * instance alive until it fires.
	 */
	it('cancels the delayed peer-count probes it armed', async () => {
		const network = bareNetwork();
		(network as any).armDelayedPeerCountCheck(60_000);
		(network as any).armDelayedPeerCountCheck(60_000);
		const armed = [...(network as any).delayedPeerCountTimers];
		expect(armed).toHaveLength(2);

		const realClearTimeout = globalThis.clearTimeout;
		const cleared: unknown[] = [];
		globalThis.clearTimeout = ((timer: unknown) => {
			cleared.push(timer);
			return realClearTimeout(timer as Parameters<typeof realClearTimeout>[0]);
		}) as typeof globalThis.clearTimeout;
		try {
			await network.stop();
		} finally {
			globalThis.clearTimeout = realClearTimeout;
		}

		for (const timer of armed) expect(cleared).toContain(timer);
		expect((network as any).delayedPeerCountTimers.size).toBe(0);
	});
});

/**
 * Zero-connection recovery used to work off the peer list the status tick snapshotted at
 * its start — BEFORE re-dial maintenance ran. Maintenance reconnecting a peer in the
 * meantime left recovery still believing it was isolated, so it dialed anyway.
 */
describe('runZeroConnectionRecovery — connectivity is read, not remembered', () => {
	const ADDR_A = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;
	const PEER_B = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fp';
	const ADDR_B = `/ip4/203.0.113.10/tcp/9090/p2p/${PEER_B}`;

	function bareNetwork(opts: { addresses?: string[]; peers?: () => unknown[]; onDial?: (address: string) => void } = {}) {
		const dialed: string[] = [];
		// The churn dump is the first thing the loop does, so it witnesses whether the
		// isolation check at the top of the function ran at all — a later check inside the
		// loop would already have let the misleading "No connections" report out.
		let churnDumps = 0;
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).addressProbeBackoff = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).bootstrapMultiaddrs = (opts.addresses ?? [ADDR_A]).map(a => multiaddr(a));
		(network as any).recentDisconnects = [];
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			entries: () => {
				churnDumps++;
				return [];
			},
		};
		(network as any).node = {
			getPeers: opts.peers ?? ((): unknown[] => []),
			async dial(ma: { toString(): string }): Promise<void> {
				dialed.push(ma.toString());
				opts.onDial?.(ma.toString());
			},
		};
		return { network, dialed, churn: () => churnDumps };
	}

	const run = (network: Network): Promise<void> => (network as any).runZeroConnectionRecovery(1);

	it('does not dial at all when a peer connected since the tick began', async () => {
		const { network, dialed, churn } = bareNetwork({ peers: () => [{ toString: () => PEER_B }] });
		await run(network);
		expect(dialed).toEqual([]);
		expect(churn()).toBe(0);
	});

	it('stops the pass as soon as a connection exists', async () => {
		// The first dial fails, but an inbound connection lands during it; the second
		// address must not be tried, because the node is no longer isolated.
		let connected = false;
		const { network, dialed } = bareNetwork({
			addresses: [ADDR_A, ADDR_B],
			peers: (): unknown[] => (connected ? [{ toString: () => PEER_B }] : []),
			onDial: () => {
				connected = true;
				throw new Error('dial timeout');
			},
		});
		await run(network);
		expect(dialed).toEqual([multiaddr(ADDR_A).toString()]);
	});
});

/**
 * The recovery loop used to only LOG its failures. For an address whose peer is not in
 * the peerStore, re-dial maintenance never sees the peer either — so nothing anywhere
 * paced it and an isolated node re-dialed a dead entry on every 30 s tick, forever.
 */
describe('runZeroConnectionRecovery — a failed dial paces the next one', () => {
	const DISCOVERED = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;
	const CONFIGURED = `/ip4/198.51.100.7/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork(opts: { address: string; configured: boolean }) {
		const dialed: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).addressProbeBackoff = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set(opts.configured ? [PEER_ID] : []);
		(network as any).configuredBootstrapAddresses = new Set(opts.configured ? [normalizeMultiaddrForCompare(opts.address)] : []);
		(network as any).bootstrapMultiaddrs = [multiaddr(opts.address)];
		(network as any).recentDisconnects = [];
		const reportedUnreachable: string[] = [];
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(address: string): void {
				reportedUnreachable.push(address);
			},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			entries: () => [],
		};
		(network as any).node = {
			getPeers: (): unknown[] => [],
			async dial(ma: { toString(): string }): Promise<void> {
				dialed.push(ma.toString());
				throw new Error('dial timeout');
			},
		};
		return { network, dialed, reportedUnreachable };
	}

	const run = (network: Network): Promise<void> => (network as any).runZeroConnectionRecovery(1);

	it('tells the status row when a configured address refuses the recovery dial', async () => {
		// Found live: the node dialled its configured bootstrap every 30 s, was refused every
		// time, and the participant list went on showing the peer as connected. This loop
		// walks addresses rather than a network's list, so reporting is the only way the
		// screen ever hears about it.
		const { network, reportedUnreachable } = bareNetwork({ address: CONFIGURED, configured: true });
		await run(network);
		expect(reportedUnreachable).toEqual([multiaddr(CONFIGURED).toString()]);
	});

	it('says nothing about a discovered address, which other loops own', async () => {
		const { network, reportedUnreachable } = bareNetwork({ address: DISCOVERED, configured: false });
		await run(network);
		expect(reportedUnreachable).toEqual([]);
	});

	it('writes the full four-field backoff record for a discovered address', async () => {
		const { network } = bareNetwork({ address: DISCOVERED, configured: false });
		await run(network);
		const entry = (network as any).redialBackoff.get(PEER_ID) as { nextAttempt: number; failCount: number; firstFailure: number; evictionFails: number } | undefined;
		expect(entry).toBeDefined();
		expect(Object.keys(entry!).sort()).toEqual(['evictionFails', 'failCount', 'firstFailure', 'nextAttempt']);
		expect(entry!.failCount).toBe(1);
		expect(entry!.nextAttempt).toBeGreaterThan(Date.now());
	});

	it('skips the same address on the very next pass', async () => {
		const { network, dialed } = bareNetwork({ address: DISCOVERED, configured: false });
		await run(network);
		await run(network);
		expect(dialed).toEqual([multiaddr(DISCOVERED).toString()]);
	});

	/**
	 * At zero connections we cannot tell the remote apart from our own outage, which is
	 * the exact condition nextEvictionFailCount resets on — so a recovery failure must
	 * never become evidence against the peer.
	 */
	it('does not count the failure towards eviction', async () => {
		const { network } = bareNetwork({ address: DISCOVERED, configured: false });
		(network as any).redialBackoff = new Map([[PEER_ID, { nextAttempt: Date.now() - 1, failCount: 2, firstFailure: Date.now() - 60_000, evictionFails: 3 }]]);
		await run(network);
		expect(((network as any).redialBackoff.get(PEER_ID) as { evictionFails: number }).evictionFails).toBe(3);
	});

	it('re-arms an expired quarantine that let the dial through', async () => {
		const longAgo = Date.now() - 10 * 60 * 60_000;
		const { network } = bareNetwork({ address: DISCOVERED, configured: false });
		(network as any).unreachableQuarantine = new Map([[PEER_ID, longAgo]]);
		await run(network);
		expect((network as any).unreachableQuarantine.get(PEER_ID)).toBeGreaterThan(longAgo);
	});

	/**
	 * Configured entries stay exempt from eviction and from quarantine — but exempt is
	 * not unlimited: several dead ones at a 10 s timeout each turn every tick into
	 * minutes of back-to-back dialing.
	 */
	it('paces a configured address too, on its own record', async () => {
		const { network, dialed } = bareNetwork({ address: CONFIGURED, configured: true });
		await run(network);
		await run(network);
		expect(dialed).toEqual([multiaddr(CONFIGURED).toString()]);
	});

	it('keeps the configured wait well under the general re-dial ceiling', async () => {
		const { network } = bareNetwork({ address: CONFIGURED, configured: true });
		const key = normalizeMultiaddrForCompare(CONFIGURED);
		for (let failCount = 0; failCount < 12; failCount++) {
			(network as any).addressProbeBackoff.set(key, { nextAttempt: 0, failCount });
			await run(network);
		}
		const entry = (network as any).addressProbeBackoff.get(key) as { nextAttempt: number };
		expect(entry.nextAttempt - Date.now()).toBeLessThanOrEqual(5 * 60_000);
	});

	it('leaves the per-peer eviction record untouched for a configured address', async () => {
		const { network } = bareNetwork({ address: CONFIGURED, configured: true });
		await run(network);
		expect((network as any).redialBackoff.size).toBe(0);
	});
});

/**
 * An evicted peer is normally gone from the peerStore, so it cannot become a re-dial
 * candidate at all — but that delete is best-effort and mDNS, identify and peer-announce
 * can all put the entry straight back. Without a quarantine check here, the peer we just
 * wrote off is dialed again on the very next tick.
 */
describe('runRedialMaintenance — quarantined peers are not candidates', () => {
	function bareNetwork(quarantinedAt: number | null, configured = false) {
		const dialed: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialBackoff = new Map();
		(network as any).redialSuppressedByNet = new Map();
		(network as any).unreachableQuarantine = quarantinedAt === null ? new Map() : new Map([[PEER_ID, quarantinedAt]]);
		(network as any).configuredBootstrapPeerIDs = new Set(configured ? [PEER_ID] : []);
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			deleteDiscoveredByPeerID() {},
		};
		(network as any).pubsub = { getTopics: () => [], getSubscribers: () => [] };
		(network as any).node = {
			getConnections: () => [],
			async dial(id: { toString(): string }): Promise<void> {
				dialed.push(id.toString());
			},
			peerStore: { async merge(): Promise<void> {} },
		};
		return { network, dialed };
	}

	// A documentation-range public address, so the dial gater lets it through wherever
	// this test happens to run.
	const peer = { id: peerIdLike(PEER_ID), addresses: [{ multiaddr: multiaddr('/ip4/203.0.113.5/tcp/9090') }] };
	const run = (network: Network): Promise<void> => (network as any).runRedialMaintenance([], [peer], 1);

	it('skips a peer still inside its unreachable quarantine', async () => {
		const { network, dialed } = bareNetwork(Date.now() - 60_000);
		await run(network);
		expect(dialed).toEqual([]);
	});

	it('dials it again once the quarantine window has passed', async () => {
		const { network, dialed } = bareNetwork(Date.now() - 10 * 60 * 60_000);
		await run(network);
		expect(dialed).toEqual([PEER_ID]);
	});

	it('never holds a configured peer back', async () => {
		const { network, dialed } = bareNetwork(Date.now() - 60_000, true);
		await run(network);
		expect(dialed).toEqual([PEER_ID]);
	});

	it('dials a peer that was never quarantined', async () => {
		const { network, dialed } = bareNetwork(null);
		await run(network);
		expect(dialed).toEqual([PEER_ID]);
	});
});

/**
 * The status tracker keeps the STRONGER origin when a row is overwritten, so a gossip
 * re-announcement of an address the user configured lands on a configured row. The dial
 * followed the caller's origin instead: it went unforced, libp2p handed back the
 * connection the peer held on a DIFFERENT address, and the discovered branch recorded
 * 'connected' — a green light on a configured address that was never contacted.
 */
describe('addBootstrapPeers — a gossip announce of a configured address', () => {
	const CONFIGURED_A = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;
	const WORKING_B = `/ip4/198.51.100.7/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork(knownConfigured: string[]) {
		const outcomes: string[] = [];
		const forced: boolean[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set(knownConfigured.length > 0 ? [PEER_ID] : []);
		(network as any).configuredBootstrapAddresses = new Set(knownConfigured.map(a => normalizeMultiaddrForCompare(a)));
		(network as any).configuredBootstrapAddressesByNet = new Map([['net-a', new Set(knownConfigured.map(a => normalizeMultiaddrForCompare(a)))]]);
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			markPending() {},
			recordOutcome(_net: unknown, _addr: unknown, _pid: unknown, status: string) {
				outcomes.push(status);
			},
		};
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getConnections: () => [{}], // the peer was reachable via WORKING_B all along
			async dial(_ma: unknown, opts?: { force?: boolean }): Promise<unknown> {
				forced.push(opts?.force === true);
				// libp2p answers with the connection its OTHER address won.
				return { remoteAddr: { toString: () => WORKING_B } };
			},
			peerStore: { async merge(): Promise<void> {} },
		};
		return { network, outcomes, forced };
	}

	it('does not turn the configured row green off an unverified dial', async () => {
		const { network, outcomes } = bareNetwork([CONFIGURED_A]);
		await (network as any).addBootstrapPeers([CONFIGURED_A], 'net-a', 'discovered');
		expect(outcomes).toEqual([]);
	});

	it('probes the address for real, as the configured branch would', async () => {
		const { network, forced } = bareNetwork([CONFIGURED_A]);
		await (network as any).addBootstrapPeers([CONFIGURED_A], 'net-a', 'discovered');
		expect(forced).toEqual([true]);
	});

	it('still treats a genuinely unknown address as discovered', async () => {
		const { network, outcomes, forced } = bareNetwork([]);
		await (network as any).addBootstrapPeers([CONFIGURED_A], 'net-a', 'discovered');
		expect(forced).toEqual([false]);
		expect(outcomes).toEqual(['connected']);
	});
});

/**
 * purgeStalePeer takes four things away — the bootstrap dedup entry, the peer's
 * addresses on the autodial list, its gossipsub direct entry and its keep-alive tag.
 * The TOCTOU healing branch put only some of them back, and periodic promotion then
 * skipped the peer precisely BECAUSE it was in bootstrapPeerIDs again, so the missing
 * pieces were never filled in.
 */
describe('purgeStalePeer — healing an inbound race restores the whole dial state', () => {
	const REMOTE = '/ip4/203.0.113.9/tcp/9090';

	function bareNetwork(suppressed: string[] = []) {
		const flagDuringDirectAdd: boolean[] = [];
		const merges: Array<Record<string, unknown>> = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).redialBackoff = new Map();
		(network as any).unreachableQuarantine = new Map([[PEER_ID, Date.now()]]);
		(network as any).redialSuppressedByNet = new Map(suppressed.length > 0 ? [['net-a', new Set(suppressed)]] : []);
		const direct = new Set<string>();
		(network as any).pubsub = {
			direct: {
				add(id: string) {
					// Ordering probe: bootstrapPeerIDs is the flag other paths read as
					// "this peer is handled", so it must still be unset here.
					flagDuringDirectAdd.push((network as any).bootstrapPeerIDs.has(PEER_ID));
					direct.add(id);
				},
				delete: (id: string): boolean => direct.delete(id),
				has: (id: string): boolean => direct.has(id),
			},
		};
		(network as any).node = {
			// The inbound connection that raced the purge is present throughout.
			getConnections: () => [{ remoteAddr: multiaddr(REMOTE), async close(): Promise<void> {} }],
			peerStore: {
				async delete(): Promise<void> {},
				async merge(_pid: unknown, patch: Record<string, unknown>): Promise<void> {
					merges.push(patch);
				},
			},
		};
		return { network, direct, merges, flagDuringDirectAdd };
	}

	const run = (network: Network): Promise<void> => (network as any).purgeStalePeer(PEER_ID, 'test', 1);

	it('puts the peer back in the bootstrap dedup set', async () => {
		const { network } = bareNetwork();
		await run(network);
		expect((network as any).bootstrapPeerIDs.has(PEER_ID)).toBe(true);
	});

	it('puts its address back on the autodial list, carrying the peer identity', async () => {
		const { network } = bareNetwork();
		await run(network);
		expect((network as any).bootstrapMultiaddrs.map((m: { toString(): string }) => m.toString())).toEqual([`${REMOTE}/p2p/${PEER_ID}`]);
	});

	it('puts it back in the gossipsub fast-reconnect set', async () => {
		const { network, direct } = bareNetwork();
		await run(network);
		expect(direct.has(PEER_ID)).toBe(true);
	});

	it('re-stamps the keep-alive tag', async () => {
		const { network, merges } = bareNetwork();
		await run(network);
		expect(merges).toHaveLength(1);
		expect(merges[0]).toHaveProperty('tags');
	});

	it('sets the bootstrap dedup flag last, so nothing can observe a half-healed peer', async () => {
		const { network, flagDuringDirectAdd } = bareNetwork();
		await run(network);
		expect(flagDuringDirectAdd).toEqual([false]);
	});

	it('lifts the unreachable quarantine', async () => {
		const { network } = bareNetwork();
		await run(network);
		expect((network as any).unreachableQuarantine.has(PEER_ID)).toBe(false);
	});

	/**
	 * A peer hung up by leave-network is meant to be forgotten. A connection racing the
	 * purge is not a reason to rebuild the dial state the leave deliberately tore down.
	 */
	it('does not heal a peer the user left', async () => {
		const { network, direct } = bareNetwork([PEER_ID]);
		await run(network);
		expect((network as any).bootstrapPeerIDs.has(PEER_ID)).toBe(false);
		expect((network as any).bootstrapMultiaddrs).toEqual([]);
		expect(direct.has(PEER_ID)).toBe(false);
	});
});

/**
 * Gossip re-announces a dead peer on every cycle. The intake path used to answer each
 * mention with a fresh dial because it consulted the unreachable quarantine and nothing
 * else — the per-peer backoff that paces every other dial path was never read, and never
 * written either, so it could not have bitten even if it had been.
 */
describe('addBootstrapPeers — discovered dials are paced by the per-peer backoff', () => {
	const ADDR = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork(dialOutcome: 'ok' | 'fail') {
		const dialled: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			markPending() {},
			recordOutcome() {},
			deletePeer() {},
		};
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getConnections: () => [],
			async dial(ma: { toString(): string }): Promise<unknown> {
				dialled.push(ma.toString());
				if (dialOutcome === 'fail') throw new Error('dial timed out');
				return { remoteAddr: { toString: () => ADDR } };
			},
			peerStore: { async merge(): Promise<void> {} },
		};
		return { network, dialled };
	}

	it('records a failed discovered dial into the shared backoff', async () => {
		const { network } = bareNetwork('fail');
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect((network as any).redialBackoff.get(PEER_ID)?.nextAttempt).toBeGreaterThan(Date.now());
	});

	it('refuses a second mention of the same peer while the backoff is running', async () => {
		const { network, dialled } = bareNetwork('fail');
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect(dialled).toEqual([ADDR]);
	});

	it('dials again once the backoff window has passed', async () => {
		const { network, dialled } = bareNetwork('fail');
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		(network as any).redialBackoff.set(PEER_ID, { nextAttempt: Date.now() - 1, failCount: 1, firstFailure: Date.now(), evictionFails: 0 });
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect(dialled).toEqual([ADDR, ADDR]);
	});

	/** A configured entry is user data and the way back in — the backoff must not hold it. */
	it('never holds a configured address back on the peer backoff', async () => {
		const { network, dialled } = bareNetwork('fail');
		(network as any).redialBackoff.set(PEER_ID, { nextAttempt: Date.now() + 600_000, failCount: 9, firstFailure: Date.now(), evictionFails: 0 });
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');
		expect(dialled).toEqual([ADDR]);
	});

	/** A dial that worked clears the record, so a returning peer is not paced. */
	it('leaves no backoff behind after a successful discovered dial', async () => {
		const { network } = bareNetwork('ok');
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect((network as any).redialBackoff.has(PEER_ID)).toBe(false);
	});
});

/**
 * The pubsub dispatcher does not await the announce handler, so two announces naming the
 * same address run their intake concurrently. Each used to spend its own 10 s dial
 * timeout on one endpoint, and the peer backoff cannot help — it is only written once a
 * dial has already failed.
 */
describe('addBootstrapPeers — one dial per address at a time', () => {
	const ADDR = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;
	const OTHER_ADDR = `/ip4/203.0.113.10/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork() {
		const dialled: string[] = [];
		// Every dial parks here until released, so a second intake run genuinely overlaps
		// the first instead of merely following it.
		const pending: Array<() => void> = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			markPending() {},
			recordOutcome() {},
			deletePeer() {},
		};
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getConnections: () => [],
			async dial(ma: { toString(): string }): Promise<unknown> {
				dialled.push(ma.toString());
				await new Promise<void>(resolve => pending.push(resolve));
				return { remoteAddr: { toString: () => ma.toString() } };
			},
			peerStore: { async merge(): Promise<void> {} },
		};
		return {
			network,
			dialled,
			releaseDials: (): void => {
				for (const resolve of pending.splice(0)) resolve();
			},
		};
	}

	it('drops a second intake run while the first is still dialing the address', async () => {
		const { network, dialled, releaseDials } = bareNetwork();
		const first = (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		await Bun.sleep(1); // let the first run reach its dial
		// Not awaited: without the claim the second run parks on its own dial, and awaiting
		// it here would hang the test instead of failing the assertion below.
		const second = (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		await Bun.sleep(1);

		expect(dialled).toEqual([ADDR]);
		releaseDials();
		await Promise.all([first, second]);
	});

	it('still dials a different address of the same peer concurrently', async () => {
		const { network, dialled, releaseDials } = bareNetwork();
		const first = (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		await Bun.sleep(1);
		const second = (network as any).addBootstrapPeers([OTHER_ADDR], 'net-a', 'discovered');
		await Bun.sleep(1);

		expect(dialled).toEqual([ADDR, OTHER_ADDR]);
		releaseDials();
		await Promise.all([first, second]);
	});

	it('releases the claim once the dial settles, so a later mention can dial again', async () => {
		const { network, dialled, releaseDials } = bareNetwork();
		const first = (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		await Bun.sleep(1);
		releaseDials();
		await first;
		const second = (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		await Bun.sleep(1);
		releaseDials();
		await second;

		expect(dialled).toEqual([ADDR, ADDR]);
	});
});

/**
 * `bootstrapPeerIDs` is a global, unbounded, never-TTL'd set that other code reads as
 * "this peer is handled" — and the libp2p config closure reads it too. Admitting an
 * identity the moment gossip named it meant any topic subscriber could put arbitrary peer
 * IDs into it, before anything had shown the identity even exists.
 */
describe('addBootstrapPeers — an identity joins the bootstrap set only once it answers', () => {
	const ADDR = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork(dialFails: boolean) {
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
		(network as any).bootstrapTracker = {
			recordAddressReachable(): void {},
			recordAddressUnreachable(): void {},
			batchDebounced<T>(_net: string, fn: () => Promise<T>): Promise<T> {
				return fn();
			},
			markPending() {},
			recordOutcome() {},
			deletePeer() {},
		};
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getConnections: () => [],
			async dial(ma: { toString(): string }): Promise<unknown> {
				if (dialFails) throw new Error('dial timed out');
				return { remoteAddr: { toString: () => ma.toString() } };
			},
			peerStore: { async merge(): Promise<void> {} },
		};
		return network;
	}

	it('leaves an announced identity out while its dial is failing', async () => {
		const network = bareNetwork(true);
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect((network as any).bootstrapPeerIDs.has(PEER_ID)).toBe(false);
	});

	it('admits the identity once the peer answers', async () => {
		const network = bareNetwork(false);
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'discovered');
		expect((network as any).bootstrapPeerIDs.has(PEER_ID)).toBe(true);
	});

	/** A configured identity is the user's own assertion and does not wait for a dial. */
	it('admits a configured identity even when its address is down', async () => {
		const network = bareNetwork(true);
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');
		expect((network as any).bootstrapPeerIDs.has(PEER_ID)).toBe(true);
	});
});

/**
 * The configured-address probe backoff is keyed by address, so it has to be released
 * with the address. Left behind it grows across every configuration change, and a
 * re-added address inherits the deleted entry's failCount and its multi-minute
 * nextAttempt — the user deletes an entry, adds it back, and nothing dials it.
 */
describe('configured bootstrap removal releases the address probe backoff', () => {
	const ADDR = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;
	const OTHER = `/ip4/203.0.113.10/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork() {
		const network = Object.create(Network.prototype) as Network;
		(network as any).configuredBootstrapPeerIDs = new Set<string>([PEER_ID]);
		(network as any).configuredBootstrapAddresses = new Set<string>([normalizeMultiaddrForCompare(ADDR), normalizeMultiaddrForCompare(OTHER)]);
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>([PEER_ID]);
		(network as any).bootstrapMultiaddrs = [multiaddr(ADDR), multiaddr(OTHER)];
		(network as any).addressProbeBackoff = new Map([
			[normalizeMultiaddrForCompare(ADDR), { nextAttempt: Date.now() + 300_000, failCount: 5 }],
			[normalizeMultiaddrForCompare(OTHER), { nextAttempt: Date.now() + 300_000, failCount: 5 }],
		]);
		return network;
	}

	it('forgets the backoff of an address removed from the configuration', () => {
		const network = bareNetwork();
		network.pruneBootstrapAddresses([ADDR]);
		expect((network as any).addressProbeBackoff.has(normalizeMultiaddrForCompare(ADDR))).toBe(false);
	});

	it('keeps the backoff of an address that stayed', () => {
		const network = bareNetwork();
		network.pruneBootstrapAddresses([ADDR]);
		expect((network as any).addressProbeBackoff.has(normalizeMultiaddrForCompare(OTHER))).toBe(true);
	});

	it('forgets the backoff of every configured address of a removed peer', () => {
		const network = bareNetwork();
		network.pruneConfiguredBootstrapPeer(PEER_ID);
		expect([...(network as any).addressProbeBackoff.keys()]).toEqual([]);
	});

	/** A gossip-learned address of the same peer is not the user's to lose — nor its pacing. */
	it('leaves a discovered address of the removed peer alone', () => {
		const network = bareNetwork();
		(network as any).configuredBootstrapAddresses.delete(normalizeMultiaddrForCompare(OTHER));
		network.pruneConfiguredBootstrapPeer(PEER_ID);
		expect((network as any).addressProbeBackoff.has(normalizeMultiaddrForCompare(OTHER))).toBe(true);
	});

	/** The user deletes an entry and puts it straight back: it must be dialed at once. */
	it('lets a re-added address be probed immediately', () => {
		const network = bareNetwork();
		network.pruneBootstrapAddresses([ADDR]);
		expect((network as any).isAddressProbeDue(normalizeMultiaddrForCompare(ADDR), Date.now())).toBe(true);
	});
});

/**
 * Intake writes two status rows per address — a pending mark and an outcome — and each
 * used to rebuild and publish the network's whole peer list. A 128-address announce cost
 * 256 snapshots and 256 pushes, all but the last thrown away by the UI.
 */
describe('addBootstrapPeers — status updates are grouped per run', () => {
	function bareNetwork(emissions: number[]) {
		const network = Object.create(Network.prototype) as Network;
		const tracker = new BootstrapStatusTracker();
		tracker.setOnChange((_networkID, status) => emissions.push(status.peers.length));
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).configuredBootstrapAddresses = new Set<string>();
		(network as any).configuredBootstrapAddressesByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapGeneration = new Map();
		(network as any).inFlightBootstrapDials = new Map();
		(network as any).dialAbort = new AbortController();
		(network as any).bootstrapTracker = tracker;
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getConnections: () => [],
			async dial(ma: { toString(): string }): Promise<unknown> {
				return { remoteAddr: { toString: () => ma.toString() } };
			},
			peerStore: { async merge(): Promise<void> {} },
		};
		return network;
	}

	const addrs = (count: number): string[] => Array.from({ length: count }, (_v, i) => `/ip4/203.0.113.${i + 1}/tcp/9090/p2p/${PEER_ID}`);

	it('publishes one snapshot for a whole announce instead of two per address', async () => {
		const emissions: number[] = [];
		const network = bareNetwork(emissions);

		await (network as any).addBootstrapPeers(addrs(20), 'net-a', 'discovered');

		expect(emissions).toEqual([20]);
	});

	it('still records every address', async () => {
		const emissions: number[] = [];
		const network = bareNetwork(emissions);

		await (network as any).addBootstrapPeers(addrs(20), 'net-a', 'discovered');

		expect((network as any).bootstrapTracker.getStatus('net-a').peers).toHaveLength(20);
	});

	/** No owning network means no status rows at all — the wrapper must not assume one. */
	it('runs unbatched when there is no network to group under', async () => {
		const emissions: number[] = [];
		const network = bareNetwork(emissions);

		await (network as any).addBootstrapPeers(addrs(3), null, 'discovered');

		expect(emissions).toEqual([]);
	});
});

/**
 * The autodial list grows with every discovered endpoint that has ever answered, and
 * nothing but an identity purge ever shortens it — so a network with churn of reachable
 * one-off peers inflates it for the lifetime of the process, and zero-connection recovery
 * walks the whole thing.
 */
describe('the autodial address list is bounded', () => {
	const discovered = (i: number): string => `/ip4/198.51.100.${i % 254}/tcp/${9000 + i}/p2p/${PEER_ID}`;
	const CONFIGURED = `/ip4/203.0.113.1/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork(configured: string[] = []) {
		const network = Object.create(Network.prototype) as Network;
		(network as any).bootstrapMultiaddrs = [];
		(network as any).configuredBootstrapAddresses = new Set(configured.map(a => normalizeMultiaddrForCompare(a)));
		for (const address of configured) (network as any).rememberBootstrapAddress(multiaddr(address));
		return network;
	}

	const remember = (network: Network, count: number): void => {
		for (let i = 0; i < count; i++) (network as any).rememberBootstrapAddress(multiaddr(discovered(i)));
	};
	const addresses = (network: Network): string[] => (network as any).bootstrapMultiaddrs.map((m: { toString(): string }) => m.toString());

	it('stops growing past the ceiling', () => {
		const network = bareNetwork();
		remember(network, 600);
		expect((network as any).bootstrapMultiaddrs).toHaveLength(512);
	});

	it('drops the oldest discovered entry, keeping the newest', () => {
		const network = bareNetwork();
		remember(network, 600);
		expect(addresses(network)).not.toContain(multiaddr(discovered(0)).toString());
		expect(addresses(network)).toContain(multiaddr(discovered(599)).toString());
	});

	/** Configured entries are the user's way back into a network and are never evicted. */
	it('never drops a configured address to make room', () => {
		const network = bareNetwork([CONFIGURED]);
		remember(network, 600);
		expect(addresses(network)).toContain(multiaddr(CONFIGURED).toString());
	});
});

/**
 * The keep-alive strip runs in its own turn, so the answer it was scheduled on can be stale.
 * A peer that joins a lishnet in that window is one somebody now needs connected.
 */
describe('clearBootstrapKeepAlive — re-checks in the write turn', () => {
	function bare(neededAfterSchedule: boolean) {
		const merged: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		let asked = 0;
		(network as any).node = {
			peerStore: {
				async merge(pid: any) {
					merged.push(pid.toString());
				},
			},
		};
		(network as any).isPeerNeededByJoinedNetwork = (): boolean => (asked++ === 0 ? false : neededAfterSchedule);
		return { network, merged };
	}

	it('strips the tag when nobody claimed the peer in between', async () => {
		const { network, merged } = bare(false);
		(network as any).clearBootstrapKeepAlive(PEER_ID);
		await Bun.sleep(5);
		expect(merged).toHaveLength(1);
	});

	it('leaves the tag alone when a lishnet claimed the peer in between', async () => {
		const { network, merged } = bare(true);
		(network as any).clearBootstrapKeepAlive(PEER_ID);
		await Bun.sleep(5);
		expect(merged).toEqual([]);
	});
});
