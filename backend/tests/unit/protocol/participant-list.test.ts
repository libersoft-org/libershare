import { describe, it, expect } from 'bun:test';
import { Network } from '../../../src/protocol/network.ts';
import { BootstrapStatusTracker } from '../../../src/protocol/bootstrap-status.ts';
import { installBootstrapRegistry } from '../helpers/bootstrap-registry.ts';

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
	/**
	 * Whether the connection libp2p hands back is on the address we asked for.
	 *
	 * A discovered dial does not force, so libp2p may answer it with a connection it
	 * already holds to that peer over some other address. That proves the peer is alive
	 * somewhere — it proves nothing about this endpoint, and nothing about the peer still
	 * taking part in THIS network.
	 */
	let answersOnTheAddress = true;
	const network = Object.create(Network.prototype) as Network;
	const tracker = new BootstrapStatusTracker();
	(network as any).runEpoch = 1;
	(network as any).bootstrapTracker = tracker;
	(network as any).bootstrapPeerIDs = new Set<string>();
	(network as any).bootstrapGeneration = new Map();
	(network as any).inFlightBootstrapDials = new Map();
	(network as any).dialAbort = new AbortController();
	(network as any).redialBackoff = new Map();
	(network as any).unreachableQuarantine = new Map();
	(network as any).redialSuppressedByNet = new Map();
	(network as any).configuredBootstrapPeerIDs = new Set<string>();
	(network as any).configuredBootstrapAddresses = new Set<string>();
	(network as any).configuredBootstrapAddressesByNet = new Map();
	installBootstrapRegistry(network, []);
	(network as any).isTopicSubscribed = () => true;
	(network as any).isPeerNeededByJoinedNetwork = () => true;
	// Nobody is subscribed to the topic to begin with, so the sweep's membership exemption
	// never fires and the row is judged purely on its staleness clock.
	let members: string[] = [];
	(network as any).getTopicPeers = () => members;
	tracker.setMembersProvider(() => new Set(members));
	(network as any).node = {
		peerId: { toString: () => 'selfID' },
		getConnections: () => [],
		async dial(ma: { toString(): string }): Promise<unknown> {
			if (!peerIsUp) throw new Error('connection refused');
			const answeredOn = answersOnTheAddress ? ma.toString() : `/ip4/203.0.113.250/tcp/9090/p2p/${PEER}`;
			return { remoteAddr: { toString: () => answeredOn }, remotePeer: peerIdLike(PEER) };
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
		/**
		 * The peer is reachable again, but only over some other route — the case where a
		 * mention produces a connection this address did nothing to earn.
		 */
		reachableOverAnotherAddress: (): void => {
			peerIsUp = true;
			answersOnTheAddress = false;
		},
		/**
		 * Let the next mention through without saying anything about the peer: production
		 * paces failed dials, and the point of these steps is what happens when a mention
		 * is actually acted on again.
		 */
		pacingExpires: (): void => {
			(network as any).redialBackoff.clear();
			(network as any).recoveryBackoff.clear();
			(network as any).unreachableQuarantine.clear();
		},
		/**
		 * Let unreachable eviction actually run and reach its verdict on this peer.
		 *
		 * The decision and everything it does to the participant list are the real thing;
		 * only the libp2p teardown behind `purgeStalePeer` is stubbed, since closing sockets
		 * is not what this story is about. The backoff is armed one failure short of the
		 * threshold and dated past the window, so the dial this tick makes is the one that
		 * decides — the same shape the eviction guards tests use.
		 */
		evictAsUnreachable: async (): Promise<void> => {
			(network as any).redialBackoff = new Map([[PEER, { nextAttempt: Date.now() - 1, failCount: 5, firstFailure: Date.now() - 45 * 60_000, evictionFails: 5 }]]);
			(network as any).hasConnectionOtherThan = () => true;
			(network as any).purgeStalePeer = async (): Promise<void> => {};
			const dead = { id: peerIdLike(PEER), addresses: [{ multiaddr: { toString: () => '/ip4/203.0.113.7/tcp/9090' } }] };
			await (network as any).runRedialMaintenance([], [dead], 1);
		},
		/** The peer takes part in the network again — it is back on the topic. */
		rejoinsTheTopic: (): void => {
			members = [PEER];
		},
		leavesTheTopic: (): void => {
			members = [];
		},
		/** The user saves this very address as a bootstrap of THIS lishnet. */
		configureHere: (): Promise<unknown> => (network as any).addBootstrapPeers([ADDRESS], NETWORK, 'configured'),
		/** The user saves this same address as a bootstrap of a DIFFERENT lishnet. */
		configureInAnotherNetwork: (): Promise<unknown> => (network as any).addBootstrapPeers([ADDRESS], 'net-somewhere-else', 'configured'),
		bringPeerBack: (): void => {
			peerIsUp = true;
			answersOnTheAddress = true;
			// A returning peer is dialable again: clear the pacing its failures earned, the
			// way an inbound connection or an expired backoff would in production.
			(network as any).redialBackoff.clear();
			(network as any).recoveryBackoff.clear();
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

	/** The story so far, up to the moment the peer has expired out of the list. */
	async function upToExpiry() {
		const net = testNetwork();
		await net.gossip();
		const answeredAt = Date.now();
		net.takePeerDown();
		await sleep(AFTER_THE_ANSWER_MS);
		net.sweepAt(answeredAt + STALE_TTL_MS + JUST_PAST_THE_WINDOW_MS);
		expect(net.listed()).toEqual([]);
		return net;
	}

	it('stays gone when the network keeps naming it after it expired', async () => {
		// The dangerous step: the row is gone, so there is nothing left holding the old
		// staleness clock. A mention that created a fresh row would put a peer nobody has
		// reached for half an hour back in the list for another full window.
		const net = await upToExpiry();
		net.pacingExpires();
		for (let cycle = 0; cycle < 3; cycle++) await net.gossip();
		expect(net.listed()).toEqual([]);
	});

	it('stays gone when it answers only over some other address', async () => {
		// Alive somewhere is not the same as taking part here. The connection came back on
		// an address this network never asked about, so it says nothing about this row.
		const net = await upToExpiry();
		net.pacingExpires();
		net.reachableOverAnotherAddress();
		await net.gossip();
		expect(net.listed()).toEqual([]);
	});

	it('comes back only when it answers on the address itself', async () => {
		const net = await upToExpiry();
		net.pacingExpires();
		net.reachableOverAnotherAddress();
		await net.gossip();
		expect(net.listed()).toEqual([]);
		net.bringPeerBack();
		await net.gossip();
		expect(net.listed()).toEqual([ADDRESS]);
	});

	it('stays gone after unreachable eviction, too', async () => {
		// Eviction is the other way a row leaves the list, and it used to leave it by
		// deleting — so the memory that kept the peer out died with it and the next
		// announce, once the quarantine expired, put the peer straight back.
		const net = testNetwork();
		await net.gossip();
		const answeredAt = Date.now();
		net.takePeerDown();
		await sleep(AFTER_THE_ANSWER_MS);
		await net.evictAsUnreachable();
		expect(net.listed()).toEqual([]);
		// The quarantine runs out and the network still remembers the address.
		net.pacingExpires();
		for (let cycle = 0; cycle < 3; cycle++) await net.gossip();
		expect(net.listed()).toEqual([]);
		// Only a real answer on the endpoint brings it back.
		net.bringPeerBack();
		await net.gossip();
		expect(net.listed()).toEqual([ADDRESS]);
		net.sweepAt(answeredAt + STALE_TTL_MS + JUST_PAST_THE_WINDOW_MS);
		expect(net.listed()).toEqual([ADDRESS]);
	});

	it('lists a member again even when our dial keeps landing on an existing connection', async () => {
		// The mirror of the bug above, and the one hiding the row can cause: the peer comes
		// back and connects to US, so every dial we make to its address is answered with the
		// connection we already hold — over some other address, so nothing ever verifies this
		// endpoint. Taking part in the network is the evidence that settles it.
		const net = await upToExpiry();
		net.pacingExpires();
		net.rejoinsTheTopic();
		net.reachableOverAnotherAddress();
		await net.gossip();
		expect(net.listed()).toEqual([ADDRESS]);
		const returnedAt = Date.now();
		net.leavesTheTopic();
		net.sweepAt(returnedAt + STALE_TTL_MS - 60_000);
		expect(net.listed()).toEqual([ADDRESS]);
	});

	it('shows an expired peer again the moment the user configures its address', async () => {
		// Configured rows are the user's own data and are never hidden: they have to be on
		// the screen, red if that is what they are, or there is nothing to fix.
		const net = await upToExpiry();
		net.pacingExpires();
		await net.configureHere();
		expect(net.listed()).toEqual([ADDRESS]);
	});

	it('lists a member that came back even when nothing announces it', async () => {
		// A small network may never send a peer announce at all, so waiting for one to carry
		// the good news leaves a live member off the list for as long as that lasts. The
		// sweep runs on its own and can see the membership.
		const net = await upToExpiry();
		net.rejoinsTheTopic();
		net.sweepAt(Date.now() + 60 * 60_000);
		expect(net.listed()).toEqual([ADDRESS]);
	});

	it('gives a genuinely returned member a full quiet window after it leaves again', async () => {
		// The row is still visible when the peer returns. Production observes that return
		// through this network's topic membership even when libp2p reuses an inbound
		// connection and never verifies the advertised listening endpoint again.
		const net = testNetwork();
		await net.gossip();
		const returnedAt = Date.now() + 20 * 60_000;
		net.rejoinsTheTopic();
		net.sweepAt(returnedAt);

		// Once the peer leaves again, it must get a fresh 30-minute quiet window measured
		// from the real return, not inherit the endpoint timestamp from before it returned.
		net.leavesTheTopic();
		net.sweepAt(returnedAt + STALE_TTL_MS - 60_000);
		expect(net.listed()).toEqual([ADDRESS]);
		net.sweepAt(returnedAt + STALE_TTL_MS + JUST_PAST_THE_WINDOW_MS);
		expect(net.listed()).toEqual([]);
	});

	it('never lists an address gossip invented, however often it is named', async () => {
		// The rule the rest of the expiry rests on. Nothing here ever answers, so nothing
		// here belongs on a list of participants — and because the row is never published,
		// losing it to the cap costs nothing either.
		const net = testNetwork();
		net.takePeerDown();
		for (let cycle = 0; cycle < 5; cycle++) {
			net.pacingExpires();
			await net.gossip();
		}
		expect(net.listed()).toEqual([]);
	});

	it('recognises the member it once verified, even after failed dials in between', async () => {
		// A failed dial says nothing about who is behind the address, so it must not erase
		// the identity an earlier dial proved — that identity is the only thing the sweep
		// will accept as "this is the member that came back".
		const net = testNetwork();
		await net.gossip();
		const answeredAt = Date.now();
		net.takePeerDown();
		await sleep(AFTER_THE_ANSWER_MS);
		net.pacingExpires();
		await net.gossip(); // fails — in production this used to null the proven identity
		net.sweepAt(answeredAt + STALE_TTL_MS + JUST_PAST_THE_WINDOW_MS);
		expect(net.listed()).toEqual([]);
		net.rejoinsTheTopic();
		net.sweepAt(answeredAt + STALE_TTL_MS + 60_000);
		expect(net.listed()).toEqual([ADDRESS]);
	});

	it('does not become immortal here just because the user configured it elsewhere', async () => {
		// A configured row is exempt from the sweep — but only in the network it was
		// configured for. Reading that exemption from a node-wide set made the same address
		// unsweepable in every network that had ever heard of it.
		const net = testNetwork();
		await net.gossip();
		const answeredAt = Date.now();
		await net.configureInAnotherNetwork();
		net.takePeerDown();
		await sleep(AFTER_THE_ANSWER_MS);
		// The mention AFTER the address became configured somewhere else is the one that
		// matters: it is where the row is classified again, and where a node-wide reading
		// of "configured" would stamp this network's row exempt.
		await net.gossip();
		net.sweepAt(answeredAt + STALE_TTL_MS + JUST_PAST_THE_WINDOW_MS);
		expect(net.listed()).toEqual([]);
	});
});
