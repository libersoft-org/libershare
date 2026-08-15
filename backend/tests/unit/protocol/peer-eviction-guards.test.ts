import { describe, it, expect } from 'bun:test';
import { Network, isSameDialEndpoint, normalizeMultiaddrForCompare } from '../../../src/protocol/network.ts';

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
 * A peer whose every stored address is rejected by the dial gater is not proof the peer
 * is gone — a LAN/VPN-only peer looks exactly like this the moment our own interface
 * drops. This path must therefore take the same self-online evidence as the
 * dial-failure path, or a local outage evicts the whole non-configured peerStore.
 */
describe('runRedialMaintenance — eviction with no reachable address', () => {
	function bareNetwork(opts: { weAreOnline: boolean; sinceMsAgo: number; configured?: boolean }) {
		const purged: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialBackoff = new Map();
		(network as any).redialSuppressedByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).noReachableSince = new Map([[PEER_ID, Date.now() - opts.sinceMsAgo]]);
		(network as any).configuredBootstrapPeerIDs = new Set(opts.configured ? [PEER_ID] : []);
		(network as any).bootstrapTracker = { deleteDiscoveredByPeerID() {} };
		(network as any).pubsub = { getTopics: () => [], getSubscribers: () => [] };
		(network as any).node = { getConnections: () => [] };
		// Only the peer itself is ever asked about; "online" means we hold a connection
		// to somebody else.
		(network as any).hasConnectionOtherThan = () => opts.weAreOnline;
		(network as any).purgeStalePeer = async (pid: string): Promise<void> => {
			purged.push(pid);
		};
		return { network, purged };
	}

	const undialablePeer = { id: peerIdLike(PEER_ID), addresses: NO_ADDRESSES };
	const run = (network: Network): Promise<void> => (network as any).runRedialMaintenance([], [undialablePeer], 1);

	it('evicts once the window has passed and we are demonstrably online', async () => {
		const { network, purged } = bareNetwork({ weAreOnline: true, sinceMsAgo: 45 * 60_000 });
		await run(network);
		expect(purged).toEqual([PEER_ID]);
	});

	it('keeps the peer when the outage is ours', async () => {
		const { network, purged } = bareNetwork({ weAreOnline: false, sinceMsAgo: 45 * 60_000 });
		await run(network);
		expect(purged).toEqual([]);
	});

	it('slides the window forward during our outage instead of accumulating', async () => {
		// Otherwise the first tick after connectivity returns would evict everything
		// that went unreachable while we were down.
		const { network } = bareNetwork({ weAreOnline: false, sinceMsAgo: 45 * 60_000 });
		await run(network);
		const since = (network as any).noReachableSince.get(PEER_ID) as number;
		expect(Date.now() - since).toBeLessThan(60_000);
	});

	it('never evicts a configured peer', async () => {
		const { network, purged } = bareNetwork({ weAreOnline: true, sinceMsAgo: 45 * 60_000, configured: true });
		await run(network);
		expect(purged).toEqual([]);
	});

	it('keeps a peer that reconnected while the window was running', async () => {
		const { network, purged } = bareNetwork({ weAreOnline: true, sinceMsAgo: 45 * 60_000 });
		(network as any).node = { getConnections: () => [{}] }; // live again
		await run(network);
		expect(purged).toEqual([]);
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
		(network as any).unreachableQuarantine = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapGeneration = new Map();
		const outcomes: string[] = [];
		(network as any).bootstrapTracker = {
			markPending() {},
			recordOutcome(_net: unknown, _addr: unknown, _pid: unknown, status: string) {
				outcomes.push(status);
			},
		};
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getConnections: () => [],
			async dial(ma: { toString(): string }, opts?: { force?: boolean }): Promise<unknown> {
				dialled.push(ma.toString());
				forced.push(opts?.force === true);
				return { remoteAddr: { toString: () => remoteAddrOfReturnedConn } };
			},
			peerStore: {
				async merge(_pid: unknown, patch: Record<string, unknown>): Promise<void> {
					merges.push(patch);
				},
			},
		};
		return { network, merges, dialled, forced, outcomes };
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
		(network as any).unreachableQuarantine = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapGeneration = new Map();
		(network as any).bootstrapTracker = { markPending() {}, recordOutcome() {} };
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
		(network as any).noReachableSince = new Map([[PEER_ID, Date.now() - 45 * 60_000]]);
		(network as any).configuredBootstrapPeerIDs = new Set([PEER_ID]);
		(network as any).bootstrapTracker = { deleteDiscoveredByPeerID() {} };
		(network as any).pubsub = { getTopics: () => [], getSubscribers: () => [] };
		(network as any).node = { getConnections: () => [] };
		(network as any).hasConnectionOtherThan = () => true;
		(network as any).purgeStalePeer = async (pid: string): Promise<void> => {
			purged.push(pid);
		};
		return { network, purged };
	}

	const undialable = { id: peerIdLike(PEER_ID), addresses: NO_ADDRESSES };
	const run = (network: Network): Promise<void> => (network as any).runRedialMaintenance([], [undialable], 1);

	it('protects the peer while it is still configured', async () => {
		const { network, purged } = bareNetwork();
		await run(network);
		expect(purged).toEqual([]);
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
		(network as any).unreachableQuarantine = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapGeneration = new Map();
		(network as any).bootstrapTracker = { markPending() {}, recordOutcome() {} };
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
		(network as any).unreachableQuarantine = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).bootstrapMultiaddrs = [];
		(network as any).bootstrapGeneration = new Map();
		(network as any).bootstrapTracker = { markPending() {}, recordOutcome() {} };
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
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');
		expect(disconnected).toEqual([PEER_ID]);
	});

	it('leaves an ordinary dial connected', async () => {
		const { network, disconnected } = bareNetwork([]);
		// No leave lands this time: the dial does not add the peer to the suppression set.
		(network as any).node.dial = async (ma: { toString(): string }): Promise<unknown> => ({ remoteAddr: { toString: () => ma.toString() } });
		await (network as any).addBootstrapPeers([ADDR], 'net-a', 'configured');
		expect(disconnected).toEqual([]);
	});
});
