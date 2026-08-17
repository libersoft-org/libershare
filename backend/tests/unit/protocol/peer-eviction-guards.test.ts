import { describe, it, expect } from 'bun:test';
import { multiaddr } from '@multiformats/multiaddr';
import { Network, isRecoveryDialDue, isSameDialEndpoint, normalizeMultiaddrForCompare, type IBootstrapEntry } from '../../../src/protocol/network.ts';
import { installBootstrapRegistry, registryAddresses, type IRegistrySeed } from '../helpers/bootstrap-registry.ts';
import { createEmptyPeerStore, createRealPeerStore, storedAddresses, FaultyDatastore, SnapshotBarrierDatastore } from '../helpers/real-peer-store.ts';
import { peerIdFromString } from '@libp2p/peer-id';
import { KEEP_ALIVE } from '@libp2p/interface';
import { createLibp2p } from 'libp2p';
import { MemoryDatastore } from 'datastore-core';

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
		installBootstrapRegistry(network, []);
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
 * An inbound connection can land between the caller's liveness check and the delete.
 * Healing used to restore only the dedup entry, the quarantine and the keep-alive tag —
 * not the registry entry nor the gossipsub direct entry. Since promotion SKIPS any peer
 * already in `bootstrapPeerIDs`, nothing repaired the rest: the peer stayed connected
 * with no recovery address at all, and the next drop had nothing to dial.
 */
describe('purgeStalePeer — healing a purge that raced a connection', () => {
	const LIVE = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork(opts: { suppressed?: boolean } = {}) {
		const network = Object.create(Network.prototype) as Network;
		const direct = new Set<string>();
		(network as any).runEpoch = 1;
		(network as any).bootstrapPeerIDs = new Set<string>();
		installBootstrapRegistry(network, []);
		(network as any).redialBackoff = new Map();
		(network as any).unreachableQuarantine = new Map([[PEER_ID, Date.now()]]);
		(network as any).redialSuppressedByNet = new Map(opts.suppressed ? [['net-a', new Set([PEER_ID])]] : []);
		(network as any).pubsub = { direct };
		(network as any).node = {
			// A connection exists throughout — the purge finds it again after the delete.
			getConnections: () => [{ remoteAddr: multiaddr(LIVE), async close(): Promise<void> {} }],
			peerStore: {
				async delete(): Promise<void> {},
				async merge(): Promise<void> {},
			},
		};
		return { network, direct };
	}

	it('puts the address back in the registry, verified', async () => {
		const { network } = bareNetwork();
		await (network as any).purgeStalePeer(PEER_ID, 'test', 1);
		expect(registryAddresses(network)).toEqual([normalizeMultiaddrForCompare(LIVE)]);
		expect(((network as any).bootstrapByAddress.get(normalizeMultiaddrForCompare(LIVE)) as IBootstrapEntry).lastVerifiedAt).not.toBe(null);
	});

	it('puts the gossipsub direct entry back', async () => {
		const { network, direct } = bareNetwork();
		await (network as any).purgeStalePeer(PEER_ID, 'test', 1);
		expect([...direct]).toEqual([PEER_ID]);
	});

	it('re-admits the identity and lifts the quarantine', async () => {
		const { network } = bareNetwork();
		await (network as any).purgeStalePeer(PEER_ID, 'test', 1);
		expect([...((network as any).bootstrapPeerIDs as Set<string>)]).toEqual([PEER_ID]);
		expect((network as any).unreachableQuarantine.has(PEER_ID)).toBe(false);
	});

	it('heals nothing for a peer leave-network deliberately hung up', async () => {
		const { network, direct } = bareNetwork({ suppressed: true });
		await (network as any).purgeStalePeer(PEER_ID, 'test', 1);
		expect(registryAddresses(network)).toEqual([]);
		expect([...direct]).toEqual([]);
		expect((network as any).bootstrapPeerIDs.size).toBe(0);
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
		installBootstrapRegistry(network, []);
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
			getPeers: () => [],
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
		installBootstrapRegistry(network, []);
		(network as any).bootstrapGeneration = new Map();
		(network as any).bootstrapTracker = { markPending() {}, recordOutcome() {} };
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getPeers: () => [],
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
	const CONFIGURED_ADDR = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork() {
		const purged: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialBackoff = new Map();
		(network as any).redialSuppressedByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).noReachableSince = new Map([[PEER_ID, Date.now() - 45 * 60_000]]);
		(network as any).configuredBootstrapPeerIDs = new Set([PEER_ID]);
		(network as any).bootstrapPeerIDs = new Set([PEER_ID]);
		installBootstrapRegistry(network, [{ address: CONFIGURED_ADDR, configuredBy: ['net-a'] }]);
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
		network.pruneConfiguredBootstrapPeer(PEER_ID, 'net-a');
		await run(network);
		expect(purged).toEqual([PEER_ID]);
	});

	it('drops the infrastructure status in the same step', async () => {
		// The two used to be able to disagree; pruning must settle both at once.
		const { network } = bareNetwork();
		expect(network.isBootstrapOrRelayPeer(PEER_ID)).toBe(true);
		network.pruneConfiguredBootstrapPeer(PEER_ID, 'net-a');
		expect(network.isBootstrapOrRelayPeer(PEER_ID)).toBe(false);
	});
	/**
	 * The registry is what zero-connection recovery walks. A bootstrap the user has
	 * deleted must leave it too, or the node keeps dialing that address every time it
	 * runs out of connections — the churn this work is supposed to end.
	 */
	it('forgets the deleted bootstrap address, so recovery stops dialing it', () => {
		const { network } = bareNetwork();
		expect(registryAddresses(network)).toEqual([normalizeMultiaddrForCompare(CONFIGURED_ADDR)]);
		network.pruneConfiguredBootstrapPeer(PEER_ID, 'net-a');
		expect(registryAddresses(network)).toEqual([]);
	});

	it('also forgets it in the dedup set, so a later re-add can restore the address', () => {
		const { network } = bareNetwork();
		network.pruneConfiguredBootstrapPeer(PEER_ID, 'net-a');
		expect((network as any).bootstrapPeerIDs.has(PEER_ID)).toBe(false);
	});

	it('leaves the addresses of other peers alone', () => {
		const other = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fp';
		const otherAddr = `/ip4/203.0.113.10/tcp/9090/p2p/${other}`;
		const { network } = bareNetwork();
		installBootstrapRegistry(network, [
			{ address: CONFIGURED_ADDR, configuredBy: ['net-a'] },
			{ address: otherAddr, configuredBy: ['net-a'] },
		]);
		network.pruneConfiguredBootstrapPeer(PEER_ID, 'net-a');
		expect(registryAddresses(network)).toEqual([normalizeMultiaddrForCompare(otherAddr)]);
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

	async function bareNetwork(onFirstDial?: (network: Network) => void, stored: string[] = []) {
		const dialled: string[] = [];
		const deleted: string[] = [];
		const real = await createRealPeerStore(PEER_ID, stored);
		const dropRecord = real.store.delete.bind(real.store);
		real.store.delete = async (id: { toString(): string }): Promise<void> => {
			deleted.push(id.toString());
			await dropRecord(id);
		};
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).unreachableQuarantine = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		installBootstrapRegistry(network, []);
		(network as any).bootstrapGeneration = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).bootstrapTracker = { markPending() {}, recordOutcome() {}, deleteDiscoveredByPeerID() {} };
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getPeers: () => [],
			getConnections: () => [],
			async hangUp(): Promise<void> {},
			async dial(ma: { toString(): string }): Promise<unknown> {
				dialled.push(ma.toString());
				// Model the edit landing while the FIRST dial is still in flight.
				if (dialled.length === 1) onFirstDial?.(network);
				return { remoteAddr: { toString: () => ma.toString() } };
			},
			peerStore: real.store,
		};
		return { network, dialled, deleted, real };
	}

	it('abandons the rest of the list when the network configuration is superseded', async () => {
		const { network, dialled } = await bareNetwork(n => n.bumpBootstrapGeneration('net-a'));
		await (network as any).addBootstrapPeers([ADDR_A, ADDR_B], 'net-a', 'configured');
		expect(dialled).toEqual([ADDR_A]);
	});

	it('does not re-mark the abandoned entry as configured', async () => {
		const { network } = await bareNetwork(n => n.bumpBootstrapGeneration('net-a'));
		await (network as any).addBootstrapPeers([ADDR_A, ADDR_B], 'net-a', 'configured');
		expect((network as any).configuredBootstrapPeerIDs.has(PEER_B)).toBe(false);
	});

	/** Every other dial path has a deadline; without one a stalled address hangs the walk. */
	it('gives the dial an explicit deadline', async () => {
		const signals: Array<AbortSignal | undefined> = [];
		const { network } = await bareNetwork();
		(network as any).node.dial = async (ma: { toString(): string }, opts?: { signal?: AbortSignal }): Promise<unknown> => {
			signals.push(opts?.signal);
			return { remoteAddr: { toString: () => ma.toString() } };
		};
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		expect(signals[0]).toBeInstanceOf(AbortSignal);
	});

	it('walks the whole list when nothing supersedes it', async () => {
		const { network, dialled } = await bareNetwork();
		await (network as any).addBootstrapPeers([ADDR_A, ADDR_B], 'net-a', 'configured');
		expect(dialled).toEqual([ADDR_A, ADDR_B]);
	});

	it('is not disturbed by an edit to a DIFFERENT network', async () => {
		const { network, dialled } = await bareNetwork(n => n.bumpBootstrapGeneration('net-other'));
		await (network as any).addBootstrapPeers([ADDR_A, ADDR_B], 'net-a', 'configured');
		expect(dialled).toEqual([ADDR_A, ADDR_B]);
	});

	/**
	 * Abandoning the loop is not enough. The dial that was already in flight when the
	 * edit landed returns a live connection, and nothing else closes one nobody asked
	 * for — the address may not even be configured any more.
	 */
	it('closes the connection the superseded dial had already opened', async () => {
		const closed: string[] = [];
		const { network } = await bareNetwork();
		(network as any).node.dial = async (ma: { toString(): string }): Promise<unknown> => {
			(network as any).bumpBootstrapGeneration('net-a');
			return { remoteAddr: { toString: () => ma.toString() }, close: async (): Promise<void> => void closed.push(ma.toString()) };
		};
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'discovered');
		expect(closed).toEqual([ADDR_A]);
	});

	/**
	 * The configured half of the same race, and the harder one: a configured entry
	 * claims `configuredBootstrapPeerIDs` BEFORE its dial, so a check that trusts that
	 * set finds the peer "needed" purely because this very dial said so. The registry
	 * claim, which the config change releases, is the honest witness.
	 */
	it('closes a superseded configured dial whose address left the config', async () => {
		const closed: string[] = [];
		const { network } = await bareNetwork();
		(network as any).node.dial = async (ma: { toString(): string }): Promise<unknown> => {
			// The edit lands mid-dial: the address is gone from the list, so its claim is
			// released and the network's bootstrap job is invalidated.
			(network as any).pruneBootstrapAddresses([ADDR_A], 'net-a');
			(network as any).bumpBootstrapGeneration('net-a');
			return { remoteAddr: { toString: () => ma.toString() }, close: async (): Promise<void> => void closed.push(ma.toString()) };
		};
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		expect(closed).toEqual([ADDR_A]);
		expect((network as any).configuredBootstrapPeerIDs.has(PEER_ID)).toBe(false);
	});

	it('keeps a superseded configured dial whose address is still configured', async () => {
		const closed: string[] = [];
		const { network } = await bareNetwork();
		(network as any).node.dial = async (ma: { toString(): string }): Promise<unknown> => {
			// Only the generation moves — some OTHER entry of the list changed, this one
			// is still the user's configuration and its connection is wanted.
			(network as any).bumpBootstrapGeneration('net-a');
			return { remoteAddr: { toString: () => ma.toString() }, close: async (): Promise<void> => void closed.push(ma.toString()) };
		};
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		expect(closed).toEqual([]);
		expect((network as any).configuredBootstrapPeerIDs.has(PEER_ID)).toBe(true);
	});

	/**
	 * The write is what outlives the cleanup here: the edit lands while the peerStore
	 * merge is still pending, so the address and the keep-alive tag are stamped ON TOP
	 * of a teardown that has already finished. Returning at that point is not enough —
	 * redial maintenance takes its candidates from the peerStore, so the entry alone
	 * brings the peer back on the next tick.
	 */
	it('takes back a peerStore write the edit overtook', async () => {
		const closed: string[] = [];
		const { network, deleted, real } = await bareNetwork(undefined, [ADDR_A]);
		const write = real.store.merge.bind(real.store);
		real.store.merge = async (id: unknown, data: unknown): Promise<unknown> => {
			(network as any).pruneBootstrapAddresses([ADDR_A], 'net-a');
			(network as any).bumpBootstrapGeneration('net-a');
			return write(id, data);
		};
		(network as any).node.dial = async (ma: { toString(): string }): Promise<unknown> => ({
			remoteAddr: { toString: () => ma.toString() },
			close: async (): Promise<void> => void closed.push(ma.toString()),
		});
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		expect(deleted).toEqual([PEER_ID]);
		expect(closed).toEqual([ADDR_A]);
		expect((network as any).configuredBootstrapPeerIDs.has(PEER_ID)).toBe(false);
	});

	/**
	 * A peer that survives the edit still wrote a STALE ADDRESS: the merge that landed
	 * after the cleanup put the superseded address in the peerStore, and redial
	 * maintenance dials from the peerStore without consulting the registry. The
	 * connection is the part the "still needed" answer governs — the address is not.
	 */
	it('removes the stale address even from a peer that stays', async () => {
		const closed: string[] = [];
		// The store holds it in its own shape — without the trailing /p2p/<id>.
		const { network, real } = await bareNetwork(undefined, [ADDR_A]);
		(network as any).isPeerNeededByJoinedNetwork = (): boolean => true;
		(network as any).node.dial = async (ma: { toString(): string }): Promise<unknown> => {
			(network as any).pruneBootstrapAddresses([ADDR_A], 'net-a');
			(network as any).bumpBootstrapGeneration('net-a');
			return { remoteAddr: { toString: () => ma.toString() }, close: async (): Promise<void> => void closed.push(ma.toString()) };
		};
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		expect(await storedAddresses(real)).toEqual([]);
		expect(closed).toEqual([]);
	});

	it('keeps a superseded connection a joined network still needs', async () => {
		const closed: string[] = [];
		const { network } = await bareNetwork(n => n.bumpBootstrapGeneration('net-a'));
		(network as any).isPeerNeededByJoinedNetwork = (): boolean => true;
		(network as any).node.dial = async (ma: { toString(): string }): Promise<unknown> => {
			(network as any).bumpBootstrapGeneration('net-a');
			return { remoteAddr: { toString: () => ma.toString() }, close: async (): Promise<void> => void closed.push(ma.toString()) };
		};
		await (network as any).addBootstrapPeers([ADDR_A], 'net-a', 'configured');
		expect(closed).toEqual([]);
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
		installBootstrapRegistry(network, []);
		(network as any).bootstrapGeneration = new Map();
		(network as any).bootstrapTracker = { markPending() {}, recordOutcome() {} };
		(network as any).disconnectPeer = async (peerID: string): Promise<void> => {
			disconnected.push(peerID);
		};
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getPeers: () => [],
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
		(network as any).unreachableQuarantine = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		installBootstrapRegistry(network, []);
		(network as any).bootstrapGeneration = new Map();
		(network as any).bootstrapTracker = { markPending() {}, recordOutcome() {} };
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getPeers: () => [],
			getConnections: () => [],
			async dial(ma: { toString(): string }): Promise<unknown> {
				if (opts.fail) throw new Error('dial timeout');
				return { remoteAddr: { toString: () => opts.remoteAddr ?? ma.toString() } };
			},
			peerStore: { async merge(): Promise<void> {} },
		};
		return network;
	}

	const addresses = registryAddresses;

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
		(network as any).unreachableQuarantine = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		installBootstrapRegistry(network, []);
		(network as any).bootstrapGeneration = new Map();
		(network as any).bootstrapTracker = {
			markPending() {},
			recordOutcome(_n: unknown, _a: unknown, _p: unknown, status: string, message: string | null) {
				outcomes.push({ status, message });
			},
		};
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getPeers: () => [],
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
		expect(registryAddresses(network)).toEqual([OFF_VPN]);
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
		(network as any).unreachableQuarantine = new Map([[PEER_ID, quarantinedAt]]);
		(network as any).bootstrapPeerIDs = new Set<string>();
		installBootstrapRegistry(network, []);
		(network as any).bootstrapGeneration = new Map();
		(network as any).bootstrapTracker = { markPending() {}, recordOutcome() {} };
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getPeers: () => [],
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
	const KEY = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;
	const SIBLING = `/ip4/198.51.100.7/tcp/9090/p2p/${PEER_ID}`;
	const none = new Map<string, number>();
	const noBackoff = new Map<string, { nextAttempt: number }>();

	it('allows an address with no backoff and no quarantine', () => {
		expect(isRecoveryDialDue(KEY, PEER_ID, now, noBackoff, none)).toBe(true);
	});

	it('holds an address back inside its backoff window and releases it after', () => {
		expect(isRecoveryDialDue(KEY, PEER_ID, now, new Map([[KEY, { nextAttempt: now + 1 }]]), none)).toBe(false);
		expect(isRecoveryDialDue(KEY, PEER_ID, now, new Map([[KEY, { nextAttempt: now }]]), none)).toBe(true);
	});

	it('paces the failing address only, not a sibling address of the same peer', () => {
		const backoff = new Map([[KEY, { nextAttempt: now + 60_000 }]]);
		expect(isRecoveryDialDue(KEY, PEER_ID, now, backoff, none)).toBe(false);
		expect(isRecoveryDialDue(SIBLING, PEER_ID, now, backoff, none)).toBe(true);
	});

	it('holds a quarantined peer back until the window passes', () => {
		expect(isRecoveryDialDue(KEY, PEER_ID, now, noBackoff, new Map([[PEER_ID, now - 60_000]]))).toBe(false);
		expect(isRecoveryDialDue(KEY, PEER_ID, now, noBackoff, new Map([[PEER_ID, now - 10 * 60 * 60_000]]))).toBe(true);
	});

	it('cannot quarantine an address that carries no peer id', () => {
		expect(isRecoveryDialDue('/ip4/203.0.113.9/tcp/9090', null, now, noBackoff, new Map([[PEER_ID, now]]))).toBe(true);
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

	async function bareNetwork(stored: string[], datastore?: any) {
		const purged: string[] = [];
		const real = await createRealPeerStore(PEER_ID, stored, datastore ?? new MemoryDatastore());
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).unreachableQuarantine = new Map();
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).recoveryBackoff = new Map();
		installBootstrapRegistry(network, [{ address: BAD, configuredBy: ['net-a'] }]);
		(network as any).bootstrapGeneration = new Map();
		(network as any).bootstrapTracker = { markPending() {}, recordOutcome() {}, deletePeer() {} };
		(network as any).purgeStalePeer = async (id: string): Promise<void> => {
			purged.push(id);
		};
		(network as any).node = {
			peerId: { toString: () => 'selfID' },
			getPeers: () => [],
			getConnections: () => [],
			async dial(): Promise<unknown> {
				throw new Error(`Payload identity key 12D3KooWSomeoneElseSomeoneElseSomeoneElseSomeoneEls does not match expected remote identity key ${PEER_ID}`);
			},
			peerStore: real.store,
		};
		return { network, purged, real };
	}

	it('keeps a disconnected peer that still has an undisproved address', async () => {
		const { network, purged, real } = await bareNetwork([BAD, GOOD]);
		await (network as any).addBootstrapPeers([BAD], 'net-a', 'configured');
		expect(purged).toEqual([]);
		expect(await storedAddresses(real)).toEqual(['/ip4/198.51.100.7/tcp/9090']);
	});

	it('purges only once nothing usable is left', async () => {
		const { network, purged } = await bareNetwork([BAD]);
		await (network as any).addBootstrapPeers([BAD], 'net-a', 'configured');
		expect(purged).toEqual([PEER_ID]);
	});

	it('drops the disproved address from the registry either way', async () => {
		const { network } = await bareNetwork([BAD, GOOD]);
		await (network as any).addBootstrapPeers([BAD], 'net-a', 'configured');
		expect(registryAddresses(network)).toEqual([]);
	});

	/**
	 * A peerStore that cannot answer is not a peer without addresses. Reading every
	 * failure as "nothing left" let a datastore hiccup during the trim of ONE disproved
	 * address end in the deletion of the whole peer record — the opposite of what a
	 * cleanup under uncertainty may do.
	 */
	it('does not purge when the peerStore read fails', async () => {
		const { network, purged, real } = await bareNetwork([BAD]);
		real.store.store.load = async (): Promise<unknown> => {
			throw new Error('database is locked');
		};
		await (network as any).addBootstrapPeers([BAD], 'net-a', 'configured');
		expect(purged).toEqual([]);
	});

	it('does not purge when the peerStore write fails', async () => {
		const { network, purged, real } = await bareNetwork([BAD]);
		real.store.store.patchExisting = async (): Promise<unknown> => {
			throw new Error('datastore closed');
		};
		await (network as any).addBootstrapPeers([BAD], 'net-a', 'configured');
		expect(purged).toEqual([]);
	});

	/**
	 * The record disappearing between the trim's read and its write leaves the peer's
	 * real address set unknown, exactly like a read error does — and "unknown" is the
	 * one answer this path may not turn into a purge of the whole record.
	 */
	it('does not purge when the record vanishes mid-trim', async () => {
		const datastore = new FaultyDatastore();
		const { network, purged } = await bareNetwork([BAD], datastore);
		const writes = datastore.writes;
		// Nothing between arming and the trim reads the datastore, so the removal's own
		// load() is the first read and the one inside the write is the second.
		datastore.vanishReadAfter(1);
		await (network as any).addBootstrapPeers([BAD], 'net-a', 'configured');
		expect(purged).toEqual([]);
		expect(datastore.writes).toBe(writes);
	});

	/** A peer genuinely absent from the store is still an answer, and still purgeable. */
	it('still purges when the peer really is not stored', async () => {
		const { network, purged } = await bareNetwork([]);
		await (network as any).addBootstrapPeers([BAD], 'net-a', 'configured');
		expect(purged).toEqual([PEER_ID]);
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

	function bareNetwork(opts: { configured?: boolean; connections?: number; answerWith?: string; duringDial?: (network: any) => void } = {}) {
		const dialed: string[] = [];
		const closed: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set(opts.configured === false ? [] : [PEER_ID]);
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).recoveryBackoff = new Map();
		installBootstrapRegistry(network, [{ address: PARKED, configuredBy: opts.configured === false ? [] : ['net-a'] }]);
		(network as any).node = {
			getConnections: () => Array.from({ length: opts.connections ?? 0 }, () => ({})),
			// `answerWith` models libp2p coalescing this dial into a job another address of
			// the same peer already had in flight: the call resolves, but with a connection
			// that proves nothing about the address we asked about.
			// `duringDial` is what makes this a race test rather than a state test: it runs
			// while the dial is still pending, exactly where a leave or a config edit lands.
			async dial(ma: { toString(): string }): Promise<unknown> {
				dialed.push(ma.toString());
				opts.duringDial?.(network);
				return {
					remoteAddr: multiaddr(opts.answerWith ?? ma.toString()),
					close: async (): Promise<void> => {
						closed.push(ma.toString());
					},
				};
			},
		};
		return { network, dialed, closed };
	}

	const run = (network: Network): Promise<void> => (network as any).probeParkedConfiguredBootstraps(1);

	it('probes a configured address even though we hold other connections', async () => {
		const { network, dialed } = bareNetwork();
		await run(network);
		expect(dialed).toEqual([multiaddr(PARKED).toString()]);
	});

	it('leaves a discovered address to the loops that own it', async () => {
		const { network, dialed } = bareNetwork({ configured: false });
		await run(network);
		expect(dialed).toEqual([]);
	});

	it('does not re-probe a peer that is already connected', async () => {
		const { network, dialed } = bareNetwork({ connections: 1 });
		await run(network);
		expect(dialed).toEqual([]);
	});

	it('respects the backoff so a broken entry costs one dial per window', async () => {
		const { network, dialed } = bareNetwork();
		(network as any).recoveryBackoff = new Map([[normalizeMultiaddrForCompare(PARKED), { nextAttempt: Date.now() + 60_000, failCount: 1 }]]);
		await run(network);
		expect(dialed).toEqual([]);
	});

	it('skips a peer the user left', async () => {
		const { network, dialed } = bareNetwork();
		(network as any).redialSuppressedByNet = new Map([['net-a', new Set([PEER_ID])]]);
		await run(network);
		expect(dialed).toEqual([]);
	});

	it('marks the address verified when the connection is on that endpoint', async () => {
		const { network } = bareNetwork();
		await run(network);
		const entry = (network as any).bootstrapByAddress.get(normalizeMultiaddrForCompare(PARKED)) as IBootstrapEntry;
		expect(entry.lastVerifiedAt).not.toBe(null);
	});

	it('closes the connection when the address lost its last owner mid-dial', async () => {
		// A config edit during a ten-second dial bumps neither the epoch nor the
		// generation, so the epoch fence is blind to it: the probe kept the connection
		// to a bootstrap the user had just deleted.
		const { network, closed } = bareNetwork({ duringDial: net => net.pruneBootstrapAddresses([PARKED], 'net-a') });
		await run(network);
		expect(closed).toEqual([multiaddr(PARKED).toString()]);
	});

	it('closes the connection when the peer was left mid-dial', async () => {
		const { network, closed } = bareNetwork({
			duringDial: net => {
				net.redialSuppressedByNet = new Map([['net-a', new Set([PEER_ID])]]);
			},
		});
		await run(network);
		expect(closed).toEqual([multiaddr(PARKED).toString()]);
		expect(((network as any).bootstrapByAddress.get(normalizeMultiaddrForCompare(PARKED)) as IBootstrapEntry).lastVerifiedAt).toBe(null);
	});

	it('does not mark it verified when a sibling address answered instead', async () => {
		// libp2p coalesces dials by peer ID. Taking any resolved dial as proof turned a
		// dead configured address green and cleared the backoff that paces it.
		const { network } = bareNetwork({ answerWith: `/ip4/198.51.100.7/tcp/9090/p2p/${PEER_ID}` });
		await run(network);
		const key = normalizeMultiaddrForCompare(PARKED);
		expect(((network as any).bootstrapByAddress.get(key) as IBootstrapEntry).lastVerifiedAt).toBe(null);
		expect((network as any).recoveryBackoff.get(key).failCount).toBe(1);
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
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).recoveryBackoff = new Map();
		(network as any).bootstrapPeerIDs = new Set([PEER_ID]);
		installBootstrapRegistry(network, [{ address: CONFIGURED, configuredBy: ['net-a'] }, { address: DISCOVERED }]);
		(network as any).recentDisconnects = [];
		(network as any).bootstrapTracker = { entries: () => [] };
		(network as any).node = {
			getPeers: () => [],
			getConnections: () => [],
			async dial(ma: { toString(): string }): Promise<void> {
				dialed.push(ma.toString());
			},
		};
		return { network, dialed };
	}

	it('paces a discovered address whose peer is configured under a DIFFERENT address', async () => {
		// Only the discovered address is in the registry, so nothing else can satisfy the
		// loop: if it gets dialed while inside its backoff window, it was wrongly given
		// the configured exemption its sibling address owns.
		const { network, dialed } = bareNetwork();
		installBootstrapRegistry(network, [{ address: DISCOVERED }]);
		(network as any).recoveryBackoff = new Map([[normalizeMultiaddrForCompare(DISCOVERED), { nextAttempt: Date.now() + 60_000, failCount: 1 }]]);
		await (network as any).runZeroConnectionRecovery([]);
		expect(dialed).toEqual([]);
	});

	it('does not let a dead address pace out its working sibling', async () => {
		// The peer's discovered address failed and is backed off; the configured one has
		// never failed. Keying the pacing per peer would silence both.
		const { network, dialed } = bareNetwork();
		(network as any).recoveryBackoff = new Map([[normalizeMultiaddrForCompare(DISCOVERED), { nextAttempt: Date.now() + 60_000, failCount: 1 }]]);
		await (network as any).runZeroConnectionRecovery([]);
		expect(dialed).toEqual([multiaddr(CONFIGURED).toString()]);
	});

	it('keeps the discovered address when the configured one is deleted', () => {
		const { network } = bareNetwork();
		network.pruneConfiguredBootstrapPeer(PEER_ID, 'net-a');
		expect(registryAddresses(network)).toEqual([normalizeMultiaddrForCompare(DISCOVERED)]);
	});
});

/**
 * Removing a bootstrap entry only released the registry claim. The address stayed in
 * the peerStore carrying its keep-alive tags, and redial maintenance builds its
 * candidate list FROM the peerStore — so the next tick re-dialed and re-tagged the
 * bootstrap the user had just deleted. This is the shared teardown that closes that
 * hole without punishing a peer that is still wanted for some other reason.
 */
describe('reconcilePeerAfterBootstrapRemoval', () => {
	const OLD = `/ip4/203.0.113.7/tcp/9090/p2p/${PEER_ID}`;
	const OTHER = `/ip4/203.0.113.8/tcp/9090/p2p/${PEER_ID}`;

	/** The shape the store keeps an address in: canonical, without the peer's own /p2p suffix. */
	const bare = (address: string): string =>
		address
			.replace(`/p2p/${PEER_ID}`, '')
			.toLowerCase()
			.replace(/\.\/tcp/, '/tcp');

	async function bareNetwork(needed: boolean, stored: string[] = [OLD, OTHER], seeds: IRegistrySeed[] = []) {
		const disconnected: string[] = [];
		const real = await createRealPeerStore(PEER_ID, stored);
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		// What the registry still holds of this peer AFTER the removal — the addresses
		// the edit did not touch.
		installBootstrapRegistry(network, seeds);
		(network as any).node = { peerStore: real.store };
		(network as any).isPeerNeededByJoinedNetwork = (): boolean => needed;
		(network as any).disconnectPeer = async (pid: string): Promise<void> => void disconnected.push(pid);
		return { network, real, disconnected };
	}

	it('trims only the removed address from the peerStore', async () => {
		const { network, real } = await bareNetwork(true);
		await network.reconcilePeerAfterBootstrapRemoval(PEER_ID, [OLD], 'net-a');
		expect(await storedAddresses(real)).toEqual([bare(OTHER)]);
	});

	it('keeps a peer another joined network still needs', async () => {
		const { network, disconnected } = await bareNetwork(true);
		await network.reconcilePeerAfterBootstrapRemoval(PEER_ID, [OLD], 'net-a');
		expect(disconnected).toEqual([]);
	});

	it('tears down a peer nothing needs any more', async () => {
		const { network, disconnected } = await bareNetwork(false, [OLD]);
		await network.reconcilePeerAfterBootstrapRemoval(PEER_ID, [OLD], 'net-a');
		expect(disconnected).toEqual([PEER_ID]);
	});

	/**
	 * The removal list is what the EDITING network let go of. An address of it that
	 * another network still claims, or that gossip announced and a dial verified,
	 * stayed in the registry and is still dialed from there — so taking it out of the
	 * peerStore, which has no notion of owners, disarms an address nobody dropped.
	 */
	it('leaves an address another network still claims in the peerStore', async () => {
		const { network, real } = await bareNetwork(true, [OLD, OTHER], [{ address: OLD, configuredBy: ['net-b'] }]);
		await network.reconcilePeerAfterBootstrapRemoval(PEER_ID, [OLD], 'net-a');
		expect(await storedAddresses(real)).toEqual([bare(OLD), bare(OTHER)]);
	});

	it('leaves an address gossip still vouches for in the peerStore', async () => {
		const { network, real } = await bareNetwork(true, [OLD, OTHER], [{ address: OLD, discovered: true, lastVerifiedAt: Date.now() }]);
		await network.reconcilePeerAfterBootstrapRemoval(PEER_ID, [OLD], 'net-a');
		expect(await storedAddresses(real)).toEqual([bare(OLD), bare(OTHER)]);
	});

	/**
	 * The edit removed ONE address; whatever else the registry holds of this peer —
	 * another network's claim, or a discovered address a dial verified — is untouched by
	 * it, and the open connection is as likely to be running over one of those. Tearing
	 * the peer down is not soft: it suppresses re-dials and deletes the peerStore entry.
	 */
	it('keeps the connection when another network still claims a sibling address', async () => {
		const { network, disconnected } = await bareNetwork(false, [OLD, OTHER], [{ address: OTHER, configuredBy: ['net-b'] }]);
		await network.reconcilePeerAfterBootstrapRemoval(PEER_ID, [OLD], 'net-a');
		expect(disconnected).toEqual([]);
	});

	it('keeps the connection when the surviving sibling is a discovered address', async () => {
		const { network, disconnected } = await bareNetwork(false, [OLD, OTHER], [{ address: OTHER, discovered: true, lastVerifiedAt: Date.now() }]);
		await network.reconcilePeerAfterBootstrapRemoval(PEER_ID, [OLD], 'net-a');
		expect(disconnected).toEqual([]);
	});

	/** Canonically, so one spelling of an address is not left behind as another. */
	it('matches the removed address canonically', async () => {
		const upper = `/dns4/BOOTSTRAP.EXAMPLE.ORG./tcp/9090/p2p/${PEER_ID}`;
		const lower = `/dns4/bootstrap.example.org/tcp/9090/p2p/${PEER_ID}`;
		const { network, real } = await bareNetwork(true, [lower, OTHER]);
		await network.reconcilePeerAfterBootstrapRemoval(PEER_ID, [upper], 'net-a');
		expect(await storedAddresses(real)).toEqual([bare(OTHER)]);
	});
});

/**
 * The other three dial paths, driven with a DEFERRED dial so a leave / config edit
 * lands while the connection genuinely does not exist yet — the window in which
 * `hangUp` finds nothing to close and the late result is the only thing that can.
 */
describe('post-dial validation of the remaining dial paths', () => {
	const ADDR = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;

	/** Resolves the dial only once the caller has interleaved its own change. */
	function deferred() {
		let release!: () => void;
		const gate = new Promise<void>(r => (release = r));
		return { gate, release };
	}

	function bareNetwork(seeds: Array<{ address: string; configuredBy?: string[] }> = []) {
		const closed: string[] = [];
		const tagged: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).recoveryBackoff = new Map();
		(network as any).noReachableSince = new Map();
		(network as any).recentDisconnects = [];
		(network as any).bootstrapTracker = { entries: () => [], deleteDiscoveredByPeerID() {} };
		(network as any).pubsub = { getTopics: () => [], getSubscribers: () => [] };
		installBootstrapRegistry(network, seeds);
		(network as any).node = {
			getPeers: () => [],
			getConnections: () => [],
			peerStore: {
				async merge(pid: { toString(): string }): Promise<void> {
					tagged.push(pid.toString());
				},
			},
		};
		const connection = {
			remoteAddr: multiaddr(ADDR),
			close: async (): Promise<void> => void closed.push(ADDR),
		};
		return { network, closed, tagged, connection };
	}

	/** A late re-dial success used to re-stamp keep-alive-fleet on a peer leave hung up. */
	it('closes a re-dial that a leave-network overtook, and does not re-tag', async () => {
		const { network, closed, tagged, connection } = bareNetwork();
		const { gate, release } = deferred();
		(network as any).node.dial = async (): Promise<unknown> => {
			await gate;
			return connection;
		};
		const peer = { id: peerIdLike(PEER_ID), addresses: [{ multiaddr: multiaddr(ADDR) }] };
		const run = (network as any).runRedialMaintenance([], [peer], 1);
		(network as any).redialSuppressedByNet = new Map([['net-a', new Set([PEER_ID])]]);
		release();
		await run;
		expect(closed).toEqual([ADDR]);
		expect(tagged).toEqual([]);
	});

	it('keeps a re-dial nothing interfered with', async () => {
		const { network, closed, tagged, connection } = bareNetwork();
		(network as any).node.dial = async (): Promise<unknown> => connection;
		const peer = { id: peerIdLike(PEER_ID), addresses: [{ multiaddr: multiaddr(ADDR) }] };
		await (network as any).runRedialMaintenance([], [peer], 1);
		expect(closed).toEqual([]);
		expect(tagged).toEqual([PEER_ID]);
	});

	it('closes a zero-connection recovery dial whose address left the config', async () => {
		const { network, closed, connection } = bareNetwork([{ address: ADDR, configuredBy: ['net-a'] }]);
		const { gate, release } = deferred();
		(network as any).node.dial = async (): Promise<unknown> => {
			await gate;
			return connection;
		};
		const run = (network as any).runZeroConnectionRecovery([], 1);
		(network as any).pruneBootstrapAddresses([ADDR], 'net-a');
		release();
		await run;
		expect(closed).toEqual([ADDR]);
	});

	it('keeps a recovery dial of an address that is still configured', async () => {
		const { network, closed, connection } = bareNetwork([{ address: ADDR, configuredBy: ['net-a'] }]);
		(network as any).node.dial = async (): Promise<unknown> => connection;
		await (network as any).runZeroConnectionRecovery([], 1);
		expect(closed).toEqual([]);
		expect(((network as any).bootstrapByAddress.get(normalizeMultiaddrForCompare(ADDR)) as IBootstrapEntry).lastVerifiedAt).not.toBe(null);
	});

	it('closes a startup dial that a stop overtook', async () => {
		const { network, closed, connection } = bareNetwork([{ address: ADDR, configuredBy: ['net-a'] }]);
		const { gate, release } = deferred();
		const node = (network as any).node;
		node.dial = async (): Promise<unknown> => {
			await gate;
			return connection;
		};
		const run = (network as any).runBootstrapWorkaround(node, 1);
		(network as any).runEpoch = 2; // stop()/start() while the dial was in flight
		release();
		await run;
		expect(closed).toEqual([ADDR]);
	});

	it('keeps a startup dial nothing interfered with', async () => {
		const { network, closed, connection } = bareNetwork([{ address: ADDR, configuredBy: ['net-a'] }]);
		const node = (network as any).node;
		node.dial = async (): Promise<unknown> => connection;
		await (network as any).runBootstrapWorkaround(node, 1);
		expect(closed).toEqual([]);
	});
});

/**
 * The write, not the read, is what outlives the cleanup on these two paths: both decide
 * to restore keep-alive state, and a leave-network finishes inside the peerStore merge
 * they are awaiting. The suppression marker is claimed before the leave's own awaits so
 * that a late writer can see it — these are the two writers that were not looking.
 */
describe('peerStore writes that race a leave-network', () => {
	const LIVE = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork() {
		const deleted: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).bootstrapPeerIDs = new Set([PEER_ID]);
		(network as any).redialSuppressedByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).pubsub = { direct: new Set<string>() };
		installBootstrapRegistry(network, []);
		(network as any).node = {
			getConnections: () => [{ remoteAddr: multiaddr(LIVE), async close(): Promise<void> {} }],
			peerStore: {
				// The leave lands while this write is pending — the exact window.
				async merge(): Promise<void> {
					(network as any).redialSuppressedByNet = new Map([['net-a', new Set([PEER_ID])]]);
				},
				async delete(pid: { toString(): string }): Promise<void> {
					deleted.push(pid.toString());
				},
			},
		};
		return { network, deleted };
	}

	it('drops the entry a purge-healing restore put back', async () => {
		const { network, deleted } = bareNetwork();
		const pid = peerIdLike(PEER_ID);
		await (network as any).restorePurgedPeerState((network as any).node, pid, [{ remoteAddr: multiaddr(LIVE) }], 1);
		expect(deleted).toEqual([PEER_ID]);
		// And nothing of the bootstrap state was rebuilt on top of the leave.
		expect(registryAddresses(network)).toEqual([]);
	});

	it('keeps the restore when no leave interfered', async () => {
		const { network, deleted } = bareNetwork();
		(network as any).node.peerStore.merge = async (): Promise<void> => {};
		const pid = peerIdLike(PEER_ID);
		await (network as any).restorePurgedPeerState((network as any).node, pid, [{ remoteAddr: multiaddr(LIVE) }], 1);
		expect(deleted).toEqual([]);
		expect(registryAddresses(network)).toEqual([normalizeMultiaddrForCompare(LIVE)]);
	});
});

/**
 * An address can be BOTH gossip-discovered and user-configured. Collapsing the two into
 * "has an owner or does not" meant removing the configured claim deleted an entry
 * discovery had learned and verified on its own — a loss the user never asked for by
 * editing an unrelated bootstrap row.
 */
describe('bootstrap registry — provenance is not exclusive', () => {
	const ADDR = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;

	function bareNetwork(seeds: Array<{ address: string; configuredBy?: string[]; discovered?: boolean }>) {
		const network = Object.create(Network.prototype) as Network;
		installBootstrapRegistry(network, seeds);
		return network;
	}

	it('keeps a discovered address after its configured claim is dropped', () => {
		const network = bareNetwork([{ address: ADDR, configuredBy: ['net-a'], discovered: true }]);
		network.pruneBootstrapAddresses([ADDR], 'net-a');
		expect(registryAddresses(network)).toEqual([normalizeMultiaddrForCompare(ADDR)]);
	});

	it('still removes an address only ever configured', () => {
		const network = bareNetwork([{ address: ADDR, configuredBy: ['net-a'], discovered: false }]);
		network.pruneBootstrapAddresses([ADDR], 'net-a');
		expect(registryAddresses(network)).toEqual([]);
	});

	it('records the discovered provenance when gossip announces a configured address', () => {
		const network = bareNetwork([{ address: ADDR, configuredBy: ['net-a'], discovered: false }]);
		(network as any).rememberBootstrapAddress(multiaddr(ADDR), null);
		network.pruneBootstrapAddresses([ADDR], 'net-a');
		expect(registryAddresses(network)).toEqual([normalizeMultiaddrForCompare(ADDR)]);
	});
});

/**
 * The teardown after a bootstrap address is removed from the configuration, exercised
 * against a REAL `@libp2p/peer-store` rather than a hand-written stand-in.
 *
 * The store decapsulates its own peer's ID before writing an address, so a stub built
 * in the shape the CODE expected would have passed while the production trim matched
 * nothing at all. Only the real store settles what is actually held.
 */
describe('reconcilePeerAfterBootstrapRemoval — peerStore address shape', () => {
	const ADDR = `/ip4/203.0.113.21/tcp/9090/p2p/${PEER_ID}`;

	const realPeerStore = (): Promise<{ store: any; pid: any }> => createRealPeerStore(PEER_ID, [ADDR]);

	function networkOver(store: unknown) {
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		// Still configured elsewhere ⇒ the peer itself survives and only the removed
		// address is trimmed, which is the case the shape bug hid.
		(network as any).configuredBootstrapPeerIDs = new Set([PEER_ID]);
		installBootstrapRegistry(network, []);
		(network as any).node = { peerStore: store, getConnections: () => [] };
		return network;
	}

	it('stores an address without the trailing /p2p/<id>', async () => {
		const real = await realPeerStore();
		expect(await storedAddresses(real)).toEqual(['/ip4/203.0.113.21/tcp/9090']);
	});

	it('removes the address the configuration dropped', async () => {
		const real = await realPeerStore();
		const network = networkOver(real.store);
		await network.reconcilePeerAfterBootstrapRemoval(PEER_ID, [ADDR], 'net-a');
		expect(await storedAddresses(real)).toEqual([]);
	});

	/**
	 * A signed peer record is what marks an address certified, and the removal of an
	 * UNRELATED address must not quietly demote it. Rebuilding the record from a bare
	 * multiaddr list did exactly that — every survivor came back as hearsay.
	 */
	it('keeps the certification of the addresses it does not remove', async () => {
		const { store, pid } = await realPeerStore();
		const other = `/ip4/203.0.113.22/tcp/9090/p2p/${PEER_ID}`;
		await store.patch(pid, {
			addresses: [
				{ multiaddr: multiaddr(ADDR), isCertified: true },
				{ multiaddr: multiaddr(other), isCertified: false },
			],
		});
		const network = networkOver(store);
		await network.reconcilePeerAfterBootstrapRemoval(PEER_ID, [other], 'net-a');
		expect((await store.get(pid)).addresses).toEqual([{ multiaddr: multiaddr('/ip4/203.0.113.21/tcp/9090'), isCertified: true }]);
	});

	it('leaves an address the configuration kept', async () => {
		const real = await realPeerStore();
		const network = networkOver(real.store);
		await network.reconcilePeerAfterBootstrapRemoval(PEER_ID, [`/ip4/203.0.113.99/tcp/9090/p2p/${PEER_ID}`], 'net-a');
		expect(await storedAddresses(real)).toEqual(['/ip4/203.0.113.21/tcp/9090']);
	});

	/**
	 * disconnectPeer is the destructive half of this teardown — it hangs up, suppresses
	 * re-dials and deletes the peerStore entry. Reaching it after the trim failed would
	 * remove everything precisely because we could not remove one thing.
	 */
	/**
	 * The removal borrows the store's own per-peer lock, which is not part of the public
	 * PeerStore interface. If a libp2p upgrade reshapes it, that has to fail here rather
	 * than silently reopen the window in production.
	 */
	it('finds the per-peer lock the removal borrows', async () => {
		const { store } = await realPeerStore();
		expect(typeof (store as any).store?.getWriteLock).toBe('function');
		expect(typeof (store as any).store?.load).toBe('function');
		expect(typeof (store as any).store?.patchExisting).toBe('function');
		expect(typeof (store as any).events?.safeDispatchEvent).toBe('function');
	});

	/**
	 * `store.patch()` reads the record a SECOND time, after the read this code makes
	 * itself. Upstream swallowed every error from that hidden read and carried on as if
	 * the peer had never existed, so removing one address rebuilt the record with empty
	 * protocols, empty metadata, empty tags and no signed peer record. The reconnect
	 * queue runs off the KEEP_ALIVE tags, so that is a behaviour change, not cosmetics —
	 * and the failure direction this path must survive is "wrote nothing".
	 */
	it('writes nothing when the read inside the patch fails', async () => {
		const datastore = new FaultyDatastore();
		const store = createEmptyPeerStore(datastore);
		const pid = peerIdFromString(PEER_ID);
		const other = `/ip4/203.0.113.22/tcp/9090/p2p/${PEER_ID}`;
		await store.patch(pid, {
			addresses: [
				{ multiaddr: multiaddr(ADDR), isCertified: true },
				{ multiaddr: multiaddr(other), isCertified: false },
			],
			protocols: ['/lish/1.0.0'],
			metadata: { AgentVersion: Uint8Array.from([9, 9]) },
			tags: { [KEEP_ALIVE]: { value: 1 }, 'keep-alive-fleet': { value: 50 } },
			peerRecordEnvelope: Uint8Array.from([1, 2, 3, 4]),
		});
		const before = await store.get(pid);
		// Guard against a vacuous pass: the fields the swallowed error used to wipe have
		// to actually be there before anything is asserted about them surviving.
		expect([...before.tags.keys()].sort()).toEqual([KEEP_ALIVE, 'keep-alive-fleet'].sort());
		expect(before.protocols).toEqual(['/lish/1.0.0']);
		expect(before.peerRecordEnvelope).toBeDefined();

		const network = networkOver(store);
		// The removal's own load() is the first read; the one inside patch() is the second.
		datastore.failReadAfter(1);
		await expect((network as any).removePeerStoreAddresses(pid, (a: string) => a.includes('203.0.113.22'))).rejects.toThrow('datastore read failed');
		expect(await store.get(pid)).toEqual(before);
	});

	/**
	 * A genuine NotFound from that hidden second read is not "this peer is new" either.
	 * The first read found the record, so its disappearance means a path this lock does
	 * not cover removed it — the `all()` cleanup, or the record crossing its TTL boundary
	 * mid-call. Upserting there rebuilds the peer out of the addresses this call happens
	 * to hold and nothing else, so the survivors come back without protocols, tags,
	 * public key or signed peer record.
	 */
	it('writes nothing when the record vanishes inside the write', async () => {
		const datastore = new FaultyDatastore();
		const store = createEmptyPeerStore(datastore);
		const pid = peerIdFromString(PEER_ID);
		const other = `/ip4/203.0.113.22/tcp/9090/p2p/${PEER_ID}`;
		await store.patch(pid, {
			addresses: [
				{ multiaddr: multiaddr(ADDR), isCertified: true },
				{ multiaddr: multiaddr(other), isCertified: false },
			],
			tags: { [KEEP_ALIVE]: { value: 1 } },
		});
		const network = networkOver(store);
		const writes = datastore.writes;
		// The removal's own load() is the first read; the one inside the write is the
		// second, and it finds the record really gone rather than a synthetic error.
		datastore.vanishReadAfter(1);
		await expect((network as any).removePeerStoreAddresses(pid, (a: string) => a.includes('203.0.113.22'))).rejects.toThrow('was removed while its record was being updated');
		expect(datastore.writes).toBe(writes);
	});

	/** No lock, no removal: the callers act destructively on the result. */
	it('refuses to remove an address from a store with no lock', async () => {
		const network = networkOver({
			async get(): Promise<unknown> {
				return { addresses: [] };
			},
			async patch(): Promise<void> {},
		});
		const disconnected: string[] = [];
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).disconnectPeer = async (id: string): Promise<void> => void disconnected.push(id);
		await network.reconcilePeerAfterBootstrapRemoval(PEER_ID, [ADDR], 'net-a');
		expect(disconnected).toEqual([]);
	});

	/**
	 * Going around the public wrapper must not go around its `peer:update` — libp2p's
	 * registrar listens for it. A store that still has the lock but has moved or renamed
	 * its emitter would otherwise write in silence, with nothing anywhere to fail on.
	 */
	it('refuses to remove an address from a store with no update emitter', async () => {
		const real = await realPeerStore();
		delete (real.store as any).events;
		const network = networkOver(real.store);
		await expect((network as any).removePeerStoreAddresses(real.pid, () => true)).rejects.toThrow('update emitter');
		expect(await storedAddresses(real)).toEqual(['/ip4/203.0.113.21/tcp/9090']);
	});

	/**
	 * Read-filter-write is only safe if nothing writes in between, and libp2p writes to
	 * the peerStore constantly — identify, a signed peer record, an inbound connection.
	 * An address that landed inside the window used to be overwritten by the older
	 * snapshot, and it can be the only address the peer is currently reachable on.
	 */
	it('keeps an address libp2p adds while the removal is in flight', async () => {
		const real = await realPeerStore();
		const network = networkOver(real.store);
		const arrival = `/ip4/198.51.100.4/tcp/9090/p2p/${PEER_ID}`;
		let concurrent: Promise<unknown> | null = null;
		const read = (real.store as any).store.load.bind((real.store as any).store);
		(real.store as any).store.load = async (id: unknown): Promise<unknown> => {
			const rec = await read(id);
			// A verified address arrives right after the read — the window the old
			// read-modify-write could not see. Not awaited: the point is that it lands
			// on its own schedule, and the removal must not be able to overtake it.
			concurrent ??= real.store.merge(real.pid, { addresses: [{ multiaddr: multiaddr(arrival), isCertified: true }] });
			await new Promise(resolve => setTimeout(resolve, 10));
			return rec;
		};
		await network.reconcilePeerAfterBootstrapRemoval(PEER_ID, [ADDR], 'net-a');
		await concurrent;
		expect(await storedAddresses(real)).toEqual(['/ip4/198.51.100.4/tcp/9090']);
	});

	/**
	 * The helper awaits twice, and a restart can land between them. Re-reading the node
	 * after the read would take the OLD run's address snapshot and write it into the NEW
	 * node's peerStore — the next run losing addresses it just learned, because a call
	 * belonging to the previous one finished late.
	 */
	it('writes nothing into the node that replaced it mid-read', async () => {
		const old = await realPeerStore();
		const next = await realPeerStore();
		const network = networkOver(old.store);
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		const disconnected: string[] = [];
		(network as any).disconnectPeer = async (id: string): Promise<void> => void disconnected.push(id);
		const read = (old.store as any).store.load.bind((old.store as any).store);
		(old.store as any).store.load = async (id: unknown): Promise<unknown> => {
			const rec = await read(id);
			// stop() then start(): a new node, a new epoch, and this call belongs to neither.
			(network as any).node = { peerStore: next.store, getConnections: () => [] };
			(network as any).runEpoch = 2;
			return rec;
		};
		await network.reconcilePeerAfterBootstrapRemoval(PEER_ID, [ADDR], 'net-a');
		// The new run keeps every address it holds, and the old run's teardown stops.
		expect(await storedAddresses(next)).toEqual(['/ip4/203.0.113.21/tcp/9090']);
		expect(disconnected).toEqual([]);
	});

	it('does not tear the peer down when the trim fails', async () => {
		const { store } = await realPeerStore();
		const network = networkOver(store);
		// No configured claim left, so the teardown WOULD proceed if the trim had worked.
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).pubsub = { getTopics: () => [], getSubscribers: () => [] };
		const disconnected: string[] = [];
		(network as any).disconnectPeer = async (id: string): Promise<void> => void disconnected.push(id);
		(store as any).store.load = async (): Promise<unknown> => {
			throw new Error('database is locked');
		};
		await network.reconcilePeerAfterBootstrapRemoval(PEER_ID, [ADDR], 'net-a');
		expect(disconnected).toEqual([]);
	});
});

/**
 * `peerStore.all()` judges each peer against a snapshot the datastore took before the
 * iteration started — the SQLite one materialises every matching row up front — and
 * upstream then DELETED any row it read as expired, straight through the datastore, under
 * no lock at all. An ordinary locked write landing after the snapshot loses its whole
 * record that way: the delete removes the NEW value on the strength of the OLD one. This
 * node walks `all()` on a timer, and the same interleaving is what makes a peer vanish
 * halfway through a locked read-modify-write elsewhere in this file.
 */
describe('peerStore.all — an expired snapshot must not delete a fresh record', () => {
	const ADDR = `/ip4/203.0.113.41/tcp/9090/p2p/${PEER_ID}`;

	it('keeps a record rewritten after the snapshot was taken', async () => {
		const datastore = new SnapshotBarrierDatastore();
		// Two stores over ONE datastore: the writer works with ordinary ages, the walker
		// stands in for the timer sweep and reads everything it snapshots as long expired.
		// Two stores rather than one precisely because `all()` takes no per-peer lock —
		// there is nothing for the writer to wait on, which is the whole bug.
		const writer = createEmptyPeerStore(datastore);
		const walker = createEmptyPeerStore(datastore, { maxPeerAge: 1, maxAddressAge: 1 });
		const pid = peerIdFromString(PEER_ID);
		await writer.patch(pid, { multiaddrs: [multiaddr(ADDR)] });
		// `#peerIsExpired` needs the record AND its addresses to be older than the walker's
		// ages, both of which are stamped at write time — so the snapshot has to be taken
		// after a real gap, or nothing in it reads as expired and the test proves nothing.
		await new Promise(resolve => setTimeout(resolve, 20));
		datastore.onSnapshot = async (): Promise<void> => {
			await writer.merge(pid, { multiaddrs: [multiaddr(ADDR)], tags: { [KEEP_ALIVE]: { value: 1 } } });
		};
		await walker.all();
		expect(await writer.has(pid)).toBe(true);
		// The reconnect queue runs off this tag, so losing the record is not cosmetic.
		expect([...(await writer.get(pid)).tags.keys()]).toEqual([KEEP_ALIVE]);
	});
});

/**
 * Every stored address carries its own observation time, and that time is what decides
 * when the address expires — which in turn feeds the record-expiry check behind the
 * deletions above. Peer-store 12.0.21 shadowed the loop variable while looking the
 * address up among the existing ones, so the lookup compared each existing address with
 * itself and always matched the first: every address inherited the first one's timestamp.
 */
describe('peerStore — an address keeps its own observation time', () => {
	// The reader's window. Long enough to survive scheduling jitter, short enough to keep
	// the test fast; the wait below has to clear it with room to spare.
	const MAX_ADDRESS_AGE = 100;
	const OLD = `/ip4/203.0.113.61/tcp/9090/p2p/${PEER_ID}`;
	const NEW = `/ip4/203.0.113.62/tcp/9090/p2p/${PEER_ID}`;

	it('does not age a new address into the timestamp of an old one', async () => {
		const store = createEmptyPeerStore(new MemoryDatastore(), { maxAddressAge: MAX_ADDRESS_AGE });
		const pid = peerIdFromString(PEER_ID);
		await store.patch(pid, { addresses: [{ multiaddr: multiaddr(OLD), isCertified: false }] });
		await new Promise(resolve => setTimeout(resolve, MAX_ADDRESS_AGE + 50));
		await store.patch(pid, {
			addresses: [
				{ multiaddr: multiaddr(OLD), isCertified: false },
				{ multiaddr: multiaddr(NEW), isCertified: false },
			],
		});
		// The old address has aged out; the one just added has not. Handing it the old
		// timestamp expired an address the peer is reachable on the moment it was learned.
		expect((await store.get(pid)).addresses.map((a: { multiaddr: { toString(): string } }) => a.multiaddr.toString())).toEqual(['/ip4/203.0.113.62/tcp/9090']);
		// Nor may the survivor inherit the timestamp of the address being removed.
		await store.patch(pid, { addresses: [{ multiaddr: multiaddr(NEW), isCertified: false }] });
		expect((await store.get(pid)).addresses.map((a: { multiaddr: { toString(): string } }) => a.multiaddr.toString())).toEqual(['/ip4/203.0.113.62/tcp/9090']);
	});
});

/**
 * Re-dial maintenance is the resurrection path the config-removal teardown has to
 * survive: it takes its candidates from the peerStore and re-stamps keep-alive on every
 * success, so a peer torn down while one of its dials was in flight comes back — entry,
 * tag and all — unless the write itself looks again afterwards.
 */
describe('runRedialMaintenance — cleanup landing inside the keep-alive write', () => {
	const LIVE_ADDR = '/ip4/203.0.113.31/tcp/9090';

	function bareNetwork(suppressDuringMerge: boolean) {
		const deleted: string[] = [];
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).bootstrapPeerIDs = new Set<string>();
		(network as any).redialSuppressedByNet = new Map();
		(network as any).redialBackoff = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).noReachableSince = new Map();
		(network as any).configuredBootstrapPeerIDs = new Set<string>();
		(network as any).pubsub = null;
		installBootstrapRegistry(network, []);
		(network as any).bootstrapTracker = { deleteDiscoveredByPeerID: (): void => {} };
		(network as any).node = {
			getPeers: () => [],
			getConnections: () => [],
			async dial(): Promise<unknown> {
				return {};
			},
			peerStore: {
				async merge(): Promise<void> {
					// The teardown finishes here: disconnectPeer records the suppression
					// before its own awaits, exactly so a late writer can see it.
					if (suppressDuringMerge) (network as any).redialSuppressedByNet = new Map([['net-a', new Set([PEER_ID])]]);
				},
				async delete(pid: { toString(): string }): Promise<void> {
					deleted.push(pid.toString());
				},
			},
		};
		const peer = { id: peerIdLike(PEER_ID), addresses: [{ multiaddr: multiaddr(LIVE_ADDR) }] };
		return { network, deleted, peer };
	}

	it('takes back the entry the re-tag recreated', async () => {
		const { network, deleted, peer } = bareNetwork(true);
		await (network as any).runRedialMaintenance([], [peer], 1);
		expect(deleted).toEqual([PEER_ID]);
	});

	it('keeps a re-dial no cleanup interfered with', async () => {
		const { network, deleted, peer } = bareNetwork(false);
		await (network as any).runRedialMaintenance([], [peer], 1);
		expect(deleted).toEqual([]);
	});
});

/**
 * The application's own bootstrap list, read from settings at startup, is an owner in
 * the registry like any lishnet — and no lishnet edit speaks for it. Releasing its
 * claim alongside the editing network's deleted the user's application-level bootstrap
 * configuration as a side effect of an unrelated change.
 */
describe('bootstrap ownership belongs to the network that claimed it', () => {
	const SHARED = `/ip4/203.0.113.51/tcp/9090/p2p/${PEER_ID}`;
	const CANON = normalizeMultiaddrForCompare(SHARED);

	function bareNetwork() {
		const network = Object.create(Network.prototype) as Network;
		(network as any).bootstrapPeerIDs = new Set([PEER_ID]);
		(network as any).configuredBootstrapPeerIDs = new Set([PEER_ID]);
		// Claimed by the startup list AND by one lishnet — the overlap a user creates by
		// listing the same bootstrap in both places.
		installBootstrapRegistry(network, [{ address: SHARED, configuredBy: ['@startup', 'net-a'], discovered: false }]);
		return network;
	}

	it('leaves the startup claim when a lishnet drops the address', () => {
		const network = bareNetwork();
		network.pruneBootstrapAddresses([SHARED], 'net-a');
		expect(registryAddresses(network)).toEqual([CANON]);
		expect([...((network as any).bootstrapByAddress.get(CANON) as IBootstrapEntry).configuredBy]).toEqual(['@startup']);
	});

	it('leaves the startup claim when a lishnet drops the whole peer', () => {
		const network = bareNetwork();
		network.pruneConfiguredBootstrapPeer(PEER_ID, 'net-a');
		expect(registryAddresses(network)).toEqual([CANON]);
	});

	/**
	 * The registry saying "still a startup bootstrap" and the exemption set saying "an
	 * ordinary peer" is not a cosmetic disagreement: the exemption set is what a leave or
	 * an unreachable sweep asks, so the peer the application still configures gets hung
	 * up and purged.
	 */
	it('keeps the infrastructure status the startup list still grants', () => {
		const network = bareNetwork();
		network.pruneConfiguredBootstrapPeer(PEER_ID, 'net-a');
		expect(network.isBootstrapOrRelayPeer(PEER_ID)).toBe(true);
	});

	it('gives the status up once the startup list drops it too', () => {
		const network = bareNetwork();
		network.pruneConfiguredBootstrapPeer(PEER_ID, 'net-a');
		network.pruneConfiguredBootstrapPeer(PEER_ID, '@startup');
		expect(network.isBootstrapOrRelayPeer(PEER_ID)).toBe(false);
	});

	/** And the sweep that reads it leaves the peer alone, end to end. */
	it('survives an unreachable sweep after the lishnet drops it', async () => {
		const purged: string[] = [];
		const network = bareNetwork();
		(network as any).runEpoch = 1;
		(network as any).redialBackoff = new Map();
		(network as any).redialSuppressedByNet = new Map();
		(network as any).unreachableQuarantine = new Map();
		(network as any).noReachableSince = new Map([[PEER_ID, Date.now() - 45 * 60_000]]);
		(network as any).bootstrapTracker = { deleteDiscoveredByPeerID() {} };
		(network as any).pubsub = { getTopics: () => [], getSubscribers: () => [] };
		(network as any).node = { getConnections: () => [] };
		(network as any).hasConnectionOtherThan = (): boolean => true;
		(network as any).purgeStalePeer = async (pid: string): Promise<void> => void purged.push(pid);
		network.pruneConfiguredBootstrapPeer(PEER_ID, 'net-a');
		await (network as any).runRedialMaintenance([], [{ id: peerIdLike(PEER_ID), addresses: NO_ADDRESSES }], 1);
		expect(purged).toEqual([]);
	});

	it('forgets the address once its last owner is gone', () => {
		const network = bareNetwork();
		network.pruneBootstrapAddresses([SHARED], 'net-a');
		network.pruneBootstrapAddresses([SHARED], '@startup');
		expect(registryAddresses(network)).toEqual([]);
	});
});

/**
 * The post-dial validator, at the point where a configured address loses its last
 * owner mid-dial. Ownership is not the only reason an address exists: gossip announces
 * addresses too, and a dial that answered on the endpoint it claimed verifies one
 * independently of anybody's configuration. The entry survives the drop for that
 * reason, and the result of the dial has to survive with it.
 */
describe('shouldKeepDialResult — provenance of an address that lost its owner', () => {
	const ADDR = `/ip4/203.0.113.61/tcp/9090/p2p/${PEER_ID}`;
	const CANON = normalizeMultiaddrForCompare(ADDR);

	function bareNetwork(seed: IRegistrySeed | null) {
		const network = Object.create(Network.prototype) as Network;
		(network as any).runEpoch = 1;
		(network as any).redialSuppressedByNet = new Map();
		(network as any).node = {};
		installBootstrapRegistry(network, seed ? [seed] : []);
		return network;
	}

	function keep(network: Network, entry: IBootstrapEntry | undefined): boolean {
		return (network as any).shouldKeepDialResult({ node: (network as any).node, epoch: 1, key: CANON, entry, requireConfigured: true });
	}

	it('keeps a result whose address gossip still vouches for', () => {
		const network = bareNetwork({ address: ADDR, discovered: true, lastVerifiedAt: Date.now() });
		expect(keep(network, (network as any).bootstrapByAddress.get(CANON))).toBe(true);
	});

	it('keeps a result whose address another network still configures', () => {
		const network = bareNetwork({ address: ADDR, configuredBy: ['net-b'], discovered: false });
		expect(keep(network, (network as any).bootstrapByAddress.get(CANON))).toBe(true);
	});

	it('drops a result whose address has no provenance left', () => {
		const withEntry = bareNetwork({ address: ADDR, configuredBy: ['net-a'], discovered: false });
		const entry = (withEntry as any).bootstrapByAddress.get(CANON) as IBootstrapEntry;
		entry.configuredBy.clear(); // the last owner released it and nothing else claims it
		expect(keep(withEntry, entry)).toBe(false);
	});

	it('drops a result whose address left the registry entirely', () => {
		const network = bareNetwork({ address: ADDR, configuredBy: ['net-a'], discovered: false });
		const entry = (network as any).bootstrapByAddress.get(CANON) as IBootstrapEntry;
		(network as any).bootstrapByAddress.delete(CANON);
		expect(keep(network, entry)).toBe(false);
	});
});

/**
 * The same removal, against the peerStore a real `createLibp2p()` builds rather than a
 * standalone `persistentPeerStore()`.
 *
 * Everything this path needs — the per-peer lock, the unlocked inner load/patch, the
 * emitter — is private to libp2p, so the only shape that settles the question is the one
 * a real node hands out. The node is never started and listens on nothing: what is under
 * test is the peerStore wiring, not the transports.
 */
describe('removePeerStoreAddresses — against a real libp2p peerStore', () => {
	const KEPT = `/ip4/203.0.113.21/tcp/9090/p2p/${PEER_ID}`;
	const DROPPED = `/ip4/203.0.113.22/tcp/9090/p2p/${PEER_ID}`;

	it('removes one address, keeps the rest of the record and raises peer:update', async () => {
		const node = await createLibp2p({
			start: false,
			addresses: { listen: [] },
			transports: [],
			connectionEncrypters: [],
			streamMuxers: [],
			// Cast: two copies of interface-datastore are installed and their Key classes
			// are structurally incompatible. Runtime is one class.
			datastore: new MemoryDatastore() as any,
		});
		try {
			const pid = peerIdFromString(PEER_ID);
			await node.peerStore.patch(pid, {
				addresses: [
					{ multiaddr: multiaddr(KEPT), isCertified: true },
					{ multiaddr: multiaddr(DROPPED), isCertified: false },
				],
				protocols: ['/lish/1.0.0'],
				tags: { [KEEP_ALIVE]: { value: 1 }, 'keep-alive-fleet': { value: 50 } },
			});
			// Going around the public wrapper must not go around its event — libp2p's own
			// registrar is on the other end of this listener.
			const updates: unknown[] = [];
			node.addEventListener('peer:update', evt => updates.push(evt));

			const network = Object.create(Network.prototype) as Network;
			(network as any).runEpoch = 1;
			(network as any).node = node;
			const result = await (network as any).removePeerStoreAddresses(pid, (a: string) => a.includes('203.0.113.22'));

			expect(result).toEqual({ kind: 'updated', remaining: 1 });
			const after = await node.peerStore.get(pid);
			expect(after.addresses).toEqual([{ multiaddr: multiaddr('/ip4/203.0.113.21/tcp/9090'), isCertified: true }]);
			// The tags drive the reconnect queue and the protocols drive the registrar —
			// neither is the removal's to lose.
			expect([...after.tags.keys()].sort()).toEqual([KEEP_ALIVE, 'keep-alive-fleet'].sort());
			expect(after.protocols).toEqual(['/lish/1.0.0']);
			expect(updates).toHaveLength(1);
		} finally {
			await node.stop();
		}
	});
});
