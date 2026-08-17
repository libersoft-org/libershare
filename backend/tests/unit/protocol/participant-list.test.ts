import { describe, it, expect } from 'bun:test';
import { Network } from '../../../src/protocol/network.ts';
import { BootstrapStatusTracker } from '../../../src/protocol/bootstrap-status.ts';

/**
 * The whole user-visible story in one test: a peer shows up under the network's
 * participants, goes away, disappears from the list even though the rest of the network
 * keeps naming it, and comes back when it really is back.
 *
 * The pieces are covered elsewhere; what is asserted here is the sequence, through the
 * real intake (`addBootstrapPeers`), the real status tracker, the real staleness sweep
 * with the production TTL, and the real `getAllBootstrapStatuses` the UI reads.
 *
 * Simulated: libp2p (a stub node whose dial answers or refuses on command), the gossip
 * that mentions the peer (announce intake is called directly), and the passage of time
 * (the sweep's injectable `now`). Everything between those edges is production code.
 */

const NETWORK = 'net-participants';
const PEER = '12D3KooWPvH1oQjQZS8TtucG4NsW2PsnW87jwMAiRLKgrNGS17fo';
/** Documentation range, so the dial gater passes it wherever the suite happens to run. */
const ADDRESS = `/ip4/203.0.113.7/tcp/9090/p2p/${PEER}`;
const STALE_TTL_MS = 30 * 60_000;

function peerIdLike(id: string) {
	return { toString: () => id, equals: (o: any) => String(o) === id };
}

/** A node whose peer is up (dials succeed) or down (dials are refused). */
function testNetwork() {
	let peerIsUp = true;
	const network = Object.create(Network.prototype) as Network;
	const tracker = new BootstrapStatusTracker();
	(network as any).runEpoch = 1;
	(network as any).bootstrapTracker = tracker;
	(network as any).bootstrapPeerIDs = new Set<string>();
	(network as any).bootstrapMultiaddrs = [];
	(network as any).bootstrapGeneration = new Map();
	(network as any).inFlightBootstrapDials = new Set<string>();
	(network as any).dialAbort = new AbortController();
	(network as any).redialBackoff = new Map();
	(network as any).unreachableQuarantine = new Map();
	(network as any).redialSuppressedByNet = new Map();
	(network as any).configuredBootstrapPeerIDs = new Set<string>();
	(network as any).configuredBootstrapAddresses = new Set<string>();
	(network as any).isTopicSubscribed = () => true;
	(network as any).isPeerNeededByJoinedNetwork = () => true;
	// Nobody is subscribed to the topic in this test, so the sweep's membership exemption
	// never fires and the row is judged purely on its staleness clock.
	(network as any).getTopicPeers = () => [];
	(network as any).node = {
		peerId: { toString: () => 'selfID' },
		getConnections: () => [],
		async dial(ma: { toString(): string }): Promise<unknown> {
			if (!peerIsUp) throw new Error('connection refused');
			return { remoteAddr: { toString: () => ma.toString() }, remotePeer: peerIdLike(PEER) };
		},
		peerStore: { async merge(): Promise<void> {} },
	};
	return {
		network,
		/** What the UI would render for this network. */
		listed: (): string[] => (network.getAllBootstrapStatuses().find(s => s.networkID === NETWORK)?.peers ?? []).map(p => p.multiaddr),
		/** Somebody in the network announces the peer's address to us. */
		gossip: (): Promise<unknown> => (network as any).addBootstrapPeers([ADDRESS], NETWORK, 'discovered'),
		/** Run the staleness sweep as if the clock stood at `at`. */
		sweepAt: (at: number): void => (network as any).sweepStaleBootstrapRows(at),
		takePeerDown: (): void => {
			peerIsUp = false;
		},
		bringPeerBack: (): void => {
			peerIsUp = true;
			// A returning peer is dialable again: clear the pacing its failures earned, the
			// way an inbound connection or an expired backoff would in production.
			(network as any).redialBackoff.clear();
			(network as any).unreachableQuarantine.clear();
		},
	};
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The sweep is judged against the moment the peer LAST ANSWERED, so the test has to be
 * able to tell that moment from the moment the row was last touched. Everything after
 * the peer goes down is therefore pushed measurably later in real time, and the sweep
 * runs just past the window measured from the answer. A row expiring on "last touched"
 * instead — the bug the ticket is about — would still have this much life left.
 */
const AFTER_THE_ANSWER_MS = 50;
const JUST_PAST_THE_WINDOW_MS = 5;

describe('participant list — a peer that goes away stops being listed', () => {
	it('lists a peer that answered', async () => {
		const net = testNetwork();
		await net.gossip();
		expect(net.listed()).toEqual([ADDRESS]);
	});

	it('keeps listing it while it is merely quiet for less than the window', async () => {
		const net = testNetwork();
		await net.gossip();
		const answeredAt = Date.now();
		net.takePeerDown();
		net.sweepAt(answeredAt + STALE_TTL_MS - 60_000);
		expect(net.listed()).toEqual([ADDRESS]);
	});

	it('drops it after the window, however loudly the network keeps naming it', async () => {
		const net = testNetwork();
		await net.gossip();
		const answeredAt = Date.now();
		net.takePeerDown();
		// The rest of the network still remembers the address and keeps announcing it —
		// the case that used to make a dead peer's row immortal.
		await sleep(AFTER_THE_ANSWER_MS);
		for (let cycle = 0; cycle < 10; cycle++) await net.gossip();
		net.sweepAt(answeredAt + STALE_TTL_MS + JUST_PAST_THE_WINDOW_MS);
		expect(net.listed()).toEqual([]);
	});

	it('lists it again once it really is back', async () => {
		const net = testNetwork();
		await net.gossip();
		const answeredAt = Date.now();
		net.takePeerDown();
		await sleep(AFTER_THE_ANSWER_MS);
		for (let cycle = 0; cycle < 10; cycle++) await net.gossip();
		net.sweepAt(answeredAt + STALE_TTL_MS + JUST_PAST_THE_WINDOW_MS);
		net.bringPeerBack();
		await net.gossip();
		expect(net.listed()).toEqual([ADDRESS]);
	});

	it('and the returned peer survives the next sweep, its clock having restarted', async () => {
		// The row is only as good as its new timestamp: if the successful dial had not
		// restarted the clock, the peer would reappear and vanish again on the next tick.
		const net = testNetwork();
		await net.gossip();
		const answeredAt = Date.now();
		net.takePeerDown();
		net.sweepAt(answeredAt + STALE_TTL_MS + JUST_PAST_THE_WINDOW_MS);
		net.bringPeerBack();
		await net.gossip();
		net.sweepAt(Date.now() + STALE_TTL_MS - 60_000);
		expect(net.listed()).toEqual([ADDRESS]);
	});
});
