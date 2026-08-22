import { describe, it, expect } from 'bun:test';
import { multiaddr } from '@multiformats/multiaddr';
import { Network, normalizeMultiaddrForCompare } from '../../../src/protocol/network.ts';
import { BootstrapStatusTracker } from '../../../src/protocol/bootstrap-status.ts';
import { installBootstrapRegistry } from '../helpers/bootstrap-registry.ts';

const PEER_ID = '12D3KooWAnfqA6Wap96ixVfxhHeGUDMriBG4Nncp5tqu8q71EVv2';
const SELF_ID = '12D3KooWMztFaEQCMchucczv2c7D1PY8LRWVVJLU9MWkdfU4zg9C';
const SHARED = `/ip4/203.0.113.9/tcp/9090/p2p/${PEER_ID}`;
const RETAINED = `/ip4/203.0.113.10/tcp/9090/p2p/${PEER_ID}`;
const NET_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const NET_B = 'bbbbbbbb-0000-0000-0000-000000000002';

function harness() {
	const tracker = new BootstrapStatusTracker();
	const network = Object.create(Network.prototype) as Network;
	installBootstrapRegistry(network, []);
	(network as any).runEpoch = 1;
	(network as any).bootstrapTracker = tracker;
	(network as any).configuredBootstrapPeerIDs = new Set<string>();
	(network as any).bootstrapPeerIDs = new Set<string>();
	(network as any).redialBackoff = new Map();
	(network as any).unreachableQuarantine = new Map();
	(network as any).redialSuppressedByNet = new Map();
	(network as any).bootstrapGeneration = new Map();
	(network as any).inFlightBootstrapDials = new Map();
	(network as any).recentDisconnects = [];
	(network as any).dialAbort = new AbortController();
	(network as any).node = {
		peerId: { toString: () => SELF_ID },
		getPeers: () => [],
		getConnections: () => [],
		async dial(ma: any) {
			return { remotePeer: { toString: () => PEER_ID }, remoteAddr: multiaddr(ma.toString()), close: async () => {} };
		},
		peerStore: { merge: async () => {}, get: async () => ({ addresses: [] }) },
	};
	return { network, tracker };
}

const rowFor = (tracker: BootstrapStatusTracker, net: string, address: string) => (tracker.getStatus(net)?.peers ?? []).find(p => normalizeMultiaddrForCompare(p.multiaddr) === normalizeMultiaddrForCompare(address));
const rowIn = (tracker: BootstrapStatusTracker, net: string) => rowFor(tracker, net, SHARED);

describe('configured origin must not leak between LISH networks', () => {
	it('keeps a gossip-learned address discovered in B while it is configured in A', async () => {
		const { network, tracker } = harness();
		await network.addBootstrapPeers([SHARED], NET_A, 'configured');
		await network.addBootstrapPeers([SHARED], NET_B, 'discovered');
		expect(rowIn(tracker, NET_A)?.origin).toBe('configured');
		expect(rowIn(tracker, NET_B)?.origin).toBe('discovered');
	});

	it('lets the sweep drop the B row while the A row survives', async () => {
		const { network, tracker } = harness();
		await network.addBootstrapPeers([SHARED], NET_A, 'configured');
		await network.addBootstrapPeers([SHARED], NET_B, 'discovered');
		tracker.sweepStale(30 * 60_000, () => false, Date.now() + 45 * 60_000);
		expect(rowIn(tracker, NET_A)).toBeDefined();
		expect(rowIn(tracker, NET_B)).toBeUndefined();
	});

	it('forgets A origin when a shared address is removed only from A', async () => {
		const { network, tracker } = harness();
		await network.addBootstrapPeers([SHARED, RETAINED], NET_A, 'configured');
		await network.addBootstrapPeers([SHARED], NET_B, 'configured');

		network.pruneBootstrapStatus(NET_A, [RETAINED]);
		await network.addBootstrapPeers([SHARED], NET_A, 'discovered');

		expect(rowIn(tracker, NET_A)?.origin).toBe('discovered');
		expect(rowFor(tracker, NET_A, RETAINED)?.origin).toBe('configured');
		expect(rowIn(tracker, NET_B)?.origin).toBe('configured');
	});

	it('forgets A origin after A is left', async () => {
		const { network, tracker } = harness();
		await network.addBootstrapPeers([SHARED], NET_A, 'configured');
		await network.addBootstrapPeers([SHARED], NET_B, 'configured');

		network.resetBootstrapStatus(NET_A);
		await network.addBootstrapPeers([SHARED], NET_A, 'discovered');

		expect(rowIn(tracker, NET_A)?.origin).toBe('discovered');
		expect(rowIn(tracker, NET_B)?.origin).toBe('configured');
	});

	it('does not let a probe in A restart the staleness clock of a dead B row', async () => {
		const { network, tracker } = harness();
		// B never answers, so its row is left in a failed state — exactly the row the
		// sweep exists to remove.
		(network as any).node.dial = async (): Promise<never> => {
			throw new Error('connection refused');
		};
		await network.addBootstrapPeers([SHARED], NET_B, 'discovered');
		const row = rowIn(tracker, NET_B);
		expect(row?.status).not.toBe('connected');
		// Age the row to just inside the TTL, so the only thing that can save it from the
		// sweep below is the probe restarting its clock.
		const key = [...(tracker as any).stats.get(NET_B).keys()][0];
		const stored = (tracker as any).stats.get(NET_B).get(key);
		(tracker as any).stats.get(NET_B).set(key, { ...stored, staleSince: Date.now() - 29 * 60_000 });
		// A's configured recovery probe proves only that the endpoint answers A.
		tracker.recordAddressReachable(SHARED);
		tracker.sweepStale(30 * 60_000, () => false, Date.now() + 5 * 60_000);
		expect(rowIn(tracker, NET_B)).toBeUndefined();
	});
});

describe('a configured install must not be swallowed by an in-flight discovered dial', () => {
	it('records the address as configured even when gossip is already dialling it', async () => {
		const { network, tracker } = harness();
		let release: () => void = () => {};
		const held = new Promise<void>(r => (release = r));
		let first = true;
		(network as any).node.dial = async (ma: any): Promise<any> => {
			if (first) {
				first = false;
				await held;
			}
			return { remotePeer: { toString: () => PEER_ID }, remoteAddr: multiaddr(ma.toString()), close: async () => {} };
		};
		// Gossip gets there first and holds the single-flight claim on the endpoint.
		const gossip = network.addBootstrapPeers([SHARED], NET_A, 'discovered');
		await Bun.sleep(20);
		// The user's configured install lands while that dial is still open.
		const install = await network.addBootstrapPeers([SHARED], NET_A, 'configured');
		release();
		await gossip;
		expect(install).toBe('completed');
		expect(rowIn(tracker, NET_A)?.origin).toBe('configured');
	});
});

describe('an unverified endpoint must not refresh a discovered row', () => {
	/** Age the row so only a refresh of its clock can save it from the sweep below. */
	function age(tracker: BootstrapStatusTracker, net: string, byMs: number): void {
		const rows = (tracker as any).stats.get(net);
		const key = [...rows.keys()][0];
		rows.set(key, { ...rows.get(key), staleSince: Date.now() - byMs });
	}

	it('does not restart the staleness clock when the connection came back on another address', async () => {
		const { network, tracker } = harness();
		// libp2p hands back the connection it already holds to this peer, over a DIFFERENT
		// address — the peer is reachable, but nothing was proved about this endpoint or
		// about the peer still taking part in this network.
		(network as any).node.dial = async (): Promise<any> => ({ remotePeer: { toString: () => PEER_ID }, remoteAddr: multiaddr(`/ip4/198.51.100.4/tcp/9090/p2p/${PEER_ID}`), close: async () => {} });
		await network.addBootstrapPeers([SHARED], NET_B, 'discovered');
		age(tracker, NET_B, 29 * 60_000);
		// Gossip mentions the departed peer again, as it does on every announce cycle.
		await network.addBootstrapPeers([SHARED], NET_B, 'discovered');
		tracker.sweepStale(30 * 60_000, () => false, Date.now() + 5 * 60_000);
		expect(rowIn(tracker, NET_B)).toBeUndefined();
	});

	it('still restarts it when the connection really is on the address', async () => {
		const { network, tracker } = harness();
		await network.addBootstrapPeers([SHARED], NET_B, 'discovered');
		age(tracker, NET_B, 29 * 60_000);
		await network.addBootstrapPeers([SHARED], NET_B, 'discovered');
		tracker.sweepStale(30 * 60_000, () => false, Date.now() + 5 * 60_000);
		expect(rowIn(tracker, NET_B)?.status).toBe('connected');
	});
});

describe('a configured install must not be swallowed by another network dial', () => {
	it('gives network A its configured row while gossip in B holds the claim', async () => {
		const { network, tracker } = harness();
		let release: () => void = () => {};
		const held = new Promise<void>(r => (release = r));
		let first = true;
		(network as any).node.dial = async (ma: any): Promise<any> => {
			if (first) {
				first = false;
				await held;
			}
			return { remotePeer: { toString: () => PEER_ID }, remoteAddr: multiaddr(ma.toString()), close: async () => {} };
		};
		const gossipInB = network.addBootstrapPeers([SHARED], NET_B, 'discovered');
		await Bun.sleep(20);
		const installInA = network.addBootstrapPeers([SHARED], NET_A, 'configured');
		release();
		const [, installResult] = await Promise.all([gossipInB, installInA]);
		expect(installResult).toBe('completed');
		expect(rowIn(tracker, NET_A)?.origin).toBe('configured');
	});
});

describe('bootstrap intake — our own address', () => {
	it('never dials an entry that targets this node', async () => {
		const { network, tracker } = harness();
		const dialed: string[] = [];
		(network as any).node.dial = async (ma: any): Promise<any> => {
			dialed.push(ma.toString());
			throw new Error('should not be dialled');
		};
		await network.addBootstrapPeers([`/ip4/203.0.113.9/tcp/9090/p2p/${SELF_ID}`], NET_A, 'configured');
		expect(dialed).toEqual([]);
		expect(tracker.getStatus(NET_A)).toBe(null);
	});

	it('still dials an entry that merely passes through us on the way to somebody else', async () => {
		// A relayed address names us as the HOP. Reading "the string mentions us" as "this is
		// our own address" threw away every peer reachable only through this node.
		const { network } = harness();
		const dialed: string[] = [];
		(network as any).node.dial = async (ma: any): Promise<any> => {
			dialed.push(ma.toString());
			return { remotePeer: { toString: () => PEER_ID }, remoteAddr: multiaddr(ma.toString()), close: async () => {} };
		};
		await network.addBootstrapPeers([`/ip4/203.0.113.9/tcp/9090/p2p/${SELF_ID}/p2p-circuit/p2p/${PEER_ID}`], NET_A, 'configured');
		expect(dialed).toHaveLength(1);
	});
});
