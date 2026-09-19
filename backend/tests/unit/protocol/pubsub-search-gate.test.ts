import { afterEach, describe, expect, it } from 'bun:test';
import { LISHServingHandlers, type SeenSearch } from '../../../src/protocol/lish-handlers.ts';
import { Network } from '../../../src/protocol/network.ts';
import { initUploadState, resetUploadState } from '../../../src/protocol/lish-protocol.ts';
import { lishTopic } from '../../../src/protocol/constants.ts';

/**
 * The pubsub `searchLishs` path returns the same catalog rows as the unicast `getLishs`
 * path, so it has to be behind the same lishnet-membership gate. gossipsub delivers a
 * topic message purely because WE are subscribed and pushes our subscription list down
 * every new stream, so a peer that only opened a transport connection can discover the
 * topic and publish on it.
 *
 * These tests drive the REAL handler and the REAL Network gate — only the libp2p
 * primitives underneath (getPeers / getTopics / getSubscribers) are stubbed. A test that
 * stubbed the gate itself would pass no matter how the two paths diverge.
 */

const NETWORK_ID = 'net-a';
const TOPIC = lishTopic(NETWORK_ID);
const SELF_ID = 'self-peer';
const SHARED_LISH_ID = 'aaaaaaaa-1111-4222-8333-444444444444';

/** A Network whose only real behaviour is the gate under test. */
function gateNetwork(opts: { connected: string[]; subscribers?: string[] }): Network {
	const network = Object.create(Network.prototype) as Network;
	(network as any).redialSuppressedByNet = new Map<string, Set<string>>();
	(network as any).listingRevoked = new Set<string>();
	(network as any).pubsub = {
		getTopics: () => [TOPIC],
		getSubscribers: () => (opts.subscribers ?? []).map(p => ({ toString: () => p })),
	};
	(network as any).peerAnnounce = { getRecentMembers: () => [] };
	(network as any).isBootstrapOrRelayPeer = () => false;
	(network as any).node = {
		peerId: { toString: () => SELF_ID },
		getPeers: () => opts.connected.map(p => ({ toString: () => p })),
	};
	return network;
}

/** Handlers wired to the real gate; `dialed` records every attempt to answer. */
function handlersFor(network: Network) {
	const dialed: string[] = [];
	const dataServer = {
		list: () => [{ id: SHARED_LISH_ID, name: 'Shared', files: [{ size: 10 }] }],
	};
	const handlers = new LISHServingHandlers({
		dataServer: dataServer as any,
		lastWantResponseTime: new Map(),
		seenSearchIDs: new Map(),
		wantResponseCooldownMs: 60_000,
		getNode: () => (network as any).node,
		dialByPeerId: async (peerID: string) => {
			dialed.push(peerID);
			// The gate decides before we get here; failing the dial keeps the test
			// free of a fake stream while still proving the handler tried to answer.
			throw new Error('dial not available in test');
		},
		canServePubsubRequestTo: (peerID: string, treatAsDirect?: boolean) => network.canServePubsubRequestTo(peerID, treatAsDirect),
		isDirectPeer: (peerID: string) => network.isDirectPeer(peerID),
		isJoinedToLishnet: (networkID: string) => network.isJoinedToLishnet(networkID),
	});
	return { handlers, dialed };
}

const search = { type: 'searchLishs' as const, searchID: 'search-1', query: '-' };

describe('pubsub searchLishs membership gate', () => {
	afterEach(() => {
		resetUploadState();
	});

	it('refuses a connected peer that is not on any lishnet we are in', async () => {
		// The bypass: the peer never subscribes, it just publishes on the topic it
		// learned from our own subscription broadcast.
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const network = gateNetwork({ connected: ['peer-bare'], subscribers: [] });
		const { handlers, dialed } = handlersFor(network);

		await handlers.handleSearchLishs(search, NETWORK_ID, 'peer-bare');

		expect(dialed).toEqual([]);
	});

	it('answers a connected peer subscribed to a lishnet we are in', async () => {
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const network = gateNetwork({ connected: ['peer-member'], subscribers: ['peer-member'] });
		const { handlers, dialed } = handlersFor(network);

		await handlers.handleSearchLishs(search, NETWORK_ID, 'peer-member');

		expect(dialed).toEqual(['peer-member']);
	});

	it('answers a publisher we have no direct connection to', async () => {
		// gossipsub never relays subscription lists, so a member two hops away is absent
		// from getSubscribers through no fault of its own. Refusing it would break
		// multi-hop search; this is the documented ceiling of a subscriber-view gate.
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const network = gateNetwork({ connected: [], subscribers: [] });
		const { handlers, dialed } = handlersFor(network);

		await handlers.handleSearchLishs(search, NETWORK_ID, 'peer-far');

		expect(dialed).toEqual(['peer-far']);
	});

	it('refuses a peer we deliberately left, even with no direct connection', async () => {
		// A left peer is hung up on and redial-suppressed, so it is no longer a direct
		// neighbour — the very state that made the multi-hop allowance apply to it. One
		// extra hop must not hand back the catalog rows the leave took away.
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const network = gateNetwork({ connected: [], subscribers: [] });
		(network as any).redialSuppressedByNet.set(NETWORK_ID, new Set(['peer-left']));
		const { handlers, dialed } = handlersFor(network);

		await handlers.handleSearchLishs(search, NETWORK_ID, 'peer-left');

		expect(dialed).toEqual([]);
	});

	it('drops a query whose searchID is longer than the bound', async () => {
		// A pubsub payload may be a quarter of a megabyte; every byte of the searchID
		// would be retained as a dedup key for the whole dedup window, and a fresh ID per
		// request is exactly what makes deduplication no defence at all.
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const seenSearchIDs = new Map<string, SeenSearch>();
		const network = gateNetwork({ connected: ['peer-member'], subscribers: ['peer-member'] });
		const dialed: string[] = [];
		const handlers = new LISHServingHandlers({
			dataServer: { list: () => [{ id: SHARED_LISH_ID, name: 'Shared', files: [{ size: 10 }] }] } as any,
			lastWantResponseTime: new Map(),
			seenSearchIDs,
			wantResponseCooldownMs: 60_000,
			getNode: () => (network as any).node,
			dialByPeerId: async (peerID: string) => {
				dialed.push(peerID);
				throw new Error('dial not available in test');
			},
			canServePubsubRequestTo: (peerID: string, treatAsDirect?: boolean) => network.canServePubsubRequestTo(peerID, treatAsDirect),
			isDirectPeer: (peerID: string) => network.isDirectPeer(peerID),
			isJoinedToLishnet: (networkID: string) => network.isJoinedToLishnet(networkID),
		});

		await handlers.handleSearchLishs({ ...search, searchID: 'x'.repeat(4096) }, NETWORK_ID, 'peer-member');

		expect(dialed).toEqual([]);
		expect(seenSearchIDs.size).toBe(0);
	});

	it('does not burn the searchID dedup slot on a refused query', async () => {
		// Recording a refused searchID would let a bare peer poison the dedup map so the
		// same query from a legitimate member is silently dropped.
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const seenSearchIDs = new Map<string, SeenSearch>();
		const network = gateNetwork({ connected: ['peer-bare'], subscribers: [] });
		const handlers = new LISHServingHandlers({
			dataServer: { list: () => [] } as any,
			lastWantResponseTime: new Map(),
			seenSearchIDs,
			wantResponseCooldownMs: 60_000,
			getNode: () => (network as any).node,
			dialByPeerId: async () => {
				throw new Error('dial not available in test');
			},
			canServePubsubRequestTo: (peerID: string, treatAsDirect?: boolean) => network.canServePubsubRequestTo(peerID, treatAsDirect),
			isDirectPeer: (peerID: string) => network.isDirectPeer(peerID),
			isJoinedToLishnet: (networkID: string) => network.isJoinedToLishnet(networkID),
		});

		await handlers.handleSearchLishs(search, NETWORK_ID, 'peer-bare');

		expect(seenSearchIDs.size).toBe(0);
	});
});

/**
 * A lishnet DELETE releases the redial suppression on purpose — the peer has to stay
 * dialable, its lishnet is gone — and records the listing revocation separately, because
 * being dialable again says nothing about being allowed to read what we share.
 *
 * The indirect branch answers before anything consults that record, so the rows the direct
 * gate refuses used to come straight back through one more hop. The revocation has to be
 * asked about first, on both paths.
 */
describe('pubsub searchLishs gate — a revoked listing is revoked through every hop', () => {
	const REVOKED = 'peer-revoked';

	it('refuses an indirect request from a peer whose listing right was revoked', () => {
		const net = gateNetwork({ connected: [] }); // not a direct neighbour: the indirect path
		(net as any).listingRevoked = new Set([REVOKED]);

		expect(net.canServePubsubRequestTo(REVOKED)).toBe(false);
	});

	it('still serves an indirect request from a peer with nothing against it', () => {
		// The guard must not close the multi-hop path in general — remote members carry no
		// local membership evidence and refusing them would break honest search.
		const net = gateNetwork({ connected: [] });

		expect(net.canServePubsubRequestTo('peer-stranger')).toBe(true);
	});

	// The two paths have to agree on when a rejoin gives the right back. The unicast gate
	// accepts a live shared subscription before it looks at the revocation, so a pubsub gate
	// that refused on the record first left the same peer served on one path and refused on
	// the other — for as long as the record sat there, which a rejoin does not clear.
	it('serves a revoked peer again once it shares a joined lishnet with us', () => {
		const net = gateNetwork({ connected: [REVOKED], subscribers: [REVOKED] });
		(net as any).listingRevoked = new Set([REVOKED]);

		expect(net.canServePubsubRequestTo(REVOKED)).toBe(true);
		expect(net.canListSharesTo(REVOKED)).toBe(true);
	});
});

/**
 * The gate runs, the rows are gathered, and only then is a stream opened to send them. That
 * opening takes time, and the peer can leave inside it — so the permission the rows were
 * gathered under is not necessarily the permission they go out under.
 */
describe('pubsub searchLishs — access withdrawn while the reply connects', () => {
	afterEach(() => {
		resetUploadState();
	});

	/** Handlers whose reply dial hangs until the test lets go. */
	function slowReplyHandlers(network: Network) {
		let openDial: () => void = () => {};
		const dialing = new Promise<void>(resolve => (openDial = resolve));
		const sent: string[] = [];
		let aborted = 0;
		const handlers = new LISHServingHandlers({
			dataServer: { list: () => [{ id: SHARED_LISH_ID, name: 'Shared', files: [{ size: 10 }] }] } as any,
			lastWantResponseTime: new Map(),
			seenSearchIDs: new Map(),
			wantResponseCooldownMs: 60_000,
			getNode: () => (network as any).node,
			dialByPeerId: async (peerID: string) => {
				await dialing;
				return {
					stream: {
						id: 'reply',
						status: 'open',
						send(): void {
							sent.push(peerID);
						},
						async close(): Promise<void> {},
						abort(): void {
							aborted++;
						},
						async *[Symbol.asyncIterator]() {},
					} as any,
					connectionType: 'DIRECT' as const,
				};
			},
			canServePubsubRequestTo: (peerID: string, treatAsDirect?: boolean) => network.canServePubsubRequestTo(peerID, treatAsDirect),
			isDirectPeer: (peerID: string) => network.isDirectPeer(peerID),
			isJoinedToLishnet: (networkID: string) => network.isJoinedToLishnet(networkID),
		});
		return { handlers, openDial, sent: (): string[] => sent, aborted: (): number => aborted };
	}

	it('does not send rows to a peer that left while the reply was connecting', async () => {
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const network = gateNetwork({ connected: ['peer-member'], subscribers: ['peer-member'] });
		const { handlers, openDial, sent, aborted } = slowReplyHandlers(network);

		const answering = handlers.handleSearchLishs(search, NETWORK_ID, 'peer-member');
		// Admitted, rows gathered — then the peer is hung up on, exactly as leaving does.
		(network as any).redialSuppressedByNet.set(NETWORK_ID, new Set(['peer-member']));
		openDial();
		await answering;

		expect(sent()).toEqual([]);
		expect(aborted()).toBe(1);
	});

	// Leaving marks the peers we knew about, and an indirect publisher need not be among
	// them — so "no record against it" is not the same as "we may still answer it". Out of
	// every lishnet there is nothing to list to anyone, whatever route the request took.
	it('does not answer an indirect peer once we have left every lishnet', async () => {
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const network = gateNetwork({ connected: [], subscribers: [] });
		const { handlers, openDial, sent, aborted } = slowReplyHandlers(network);

		const answering = handlers.handleSearchLishs(search, NETWORK_ID, 'peer-far');
		(network as any).pubsub.getTopics = () => []; // the user left the last lishnet
		openDial();
		await answering;

		expect(sent()).toEqual([]);
		expect(aborted()).toBe(1);
	});

	// Being in SOME lishnet is not enough: the request arrived over one particular lishnet, and
	// leaving that one ends it. An indirect publisher proved membership of none of the others,
	// so our standing in them says nothing about this conversation.
	it('does not answer once we leave the lishnet the request came in over', async () => {
		const OTHER = lishTopic('net-b');
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const network = gateNetwork({ connected: [], subscribers: [] });
		(network as any).pubsub.getTopics = () => [TOPIC, OTHER]; // in both A and B
		const { handlers, openDial, sent, aborted } = slowReplyHandlers(network);

		const answering = handlers.handleSearchLishs(search, NETWORK_ID, 'peer-far');
		(network as any).pubsub.getTopics = () => [OTHER]; // left A, still in B
		openDial();
		await answering;

		expect(sent()).toEqual([]);
		expect(aborted()).toBe(1);
	});

	// One search is broadcast on every joined topic, so the same searchID legitimately reaches
	// us once per shared lishnet. Recording only the first meant leaving THAT lishnet buried a
	// request that had also arrived over one we are still in — the copy was dropped as a
	// duplicate and never got an answer of its own.
	it('answers from a second lishnet the same query also arrived over', async () => {
		const OTHER_ID = 'net-b';
		const OTHER = lishTopic(OTHER_ID);
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const network = gateNetwork({ connected: [], subscribers: [] });
		(network as any).pubsub.getTopics = () => [TOPIC, OTHER];
		const { handlers, openDial, sent } = slowReplyHandlers(network);

		// Arrives over A first, then over B while the reply to A is still connecting.
		const answering = handlers.handleSearchLishs(search, NETWORK_ID, 'peer-far');
		await handlers.handleSearchLishs(search, OTHER_ID, 'peer-far');
		(network as any).pubsub.getTopics = () => [OTHER]; // left A, still in B
		openDial();
		await answering;

		expect(sent()).toEqual(['peer-far']);
	});

	// The search id is whatever the sender put in the message, so it cannot be the whole key
	// to state we act on. Sharing one entry across senders let any peer widen the set of
	// lishnets another peer's request counts as having arrived over — reopening the very
	// window the leave-check exists to close.
	it('does not let one peer widen the request of another', async () => {
		const OTHER_ID = 'net-b';
		const OTHER = lishTopic(OTHER_ID);
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const network = gateNetwork({ connected: [], subscribers: [] });
		(network as any).pubsub.getTopics = () => [TOPIC, OTHER];
		const { handlers, openDial, sent } = slowReplyHandlers(network);

		// The real request comes over A; a different peer sends the same id over B.
		const answering = handlers.handleSearchLishs(search, NETWORK_ID, 'peer-far');
		// Not awaited: with the fix this is a request of its own and blocks on the same gate.
		const other = handlers.handleSearchLishs(search, OTHER_ID, 'peer-other');
		(network as any).pubsub.getTopics = () => [OTHER]; // left A, still in B
		openDial();
		await Promise.all([answering, other]);

		// The A request is dead with A; the other peer's message cannot keep it alive.
		expect(sent()).not.toContain('peer-far');
	});

	// The dedup entry means "already answered". A query whose answer was cancelled was not,
	// so a later copy arriving over a lishnet we are still in must be able to earn one — the
	// opposite order from the test above, where the copy lands while the first is still alive.
	it('answers a copy that arrives after the first attempt was cancelled', async () => {
		const OTHER_ID = 'net-b';
		const OTHER = lishTopic(OTHER_ID);
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const network = gateNetwork({ connected: [], subscribers: [] });
		(network as any).pubsub.getTopics = () => [TOPIC, OTHER];
		const { handlers, openDial, sent } = slowReplyHandlers(network);

		const answering = handlers.handleSearchLishs(search, NETWORK_ID, 'peer-far');
		(network as any).pubsub.getTopics = () => [OTHER]; // left A, still in B
		openDial();
		await answering;
		expect(sent()).toEqual([]); // the A attempt was cancelled, as it should be

		// The same peer's copy over B now arrives. B is still ours, so it deserves an answer.
		await handlers.handleSearchLishs(search, OTHER_ID, 'peer-far');

		expect(sent()).toEqual(['peer-far']);
	});

	// Our own reply dial turns an indirect publisher into a direct neighbour. A later copy of
	// the SAME query, judged fresh, would then be held to the direct branch — refused for a
	// membership its branch never required, and refused before its lishnet was recorded. That
	// lost the one still-valid route to the sender.
	it('records a second lishnet even after our reply dial made the sender direct', async () => {
		const OTHER_ID = 'net-b';
		const OTHER = lishTopic(OTHER_ID);
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const network = gateNetwork({ connected: [], subscribers: [] });
		(network as any).pubsub.getTopics = () => [TOPIC, OTHER];
		const { handlers, openDial, sent } = slowReplyHandlers(network);

		const answering = handlers.handleSearchLishs(search, NETWORK_ID, 'peer-far');
		// The reply connection is up, so the sender now looks direct — but it is still not a
		// visible member, exactly the state the indirect branch exists for.
		(network as any).node.getPeers = () => [{ toString: () => 'peer-far' }];
		await handlers.handleSearchLishs(search, OTHER_ID, 'peer-far');

		(network as any).pubsub.getTopics = () => [OTHER]; // left A, still in B
		openDial();
		await answering;

		expect(sent()).toEqual(['peer-far']);
	});

	it('still answers a peer that only became a direct neighbour meanwhile', async () => {
		// The reply stream itself turns an indirect publisher into a direct one. Re-judging it
		// as direct would demand the membership its branch never asked for and drop an answer
		// nothing had been withdrawn from.
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const network = gateNetwork({ connected: [], subscribers: [] });
		const { handlers, openDial, sent } = slowReplyHandlers(network);

		const answering = handlers.handleSearchLishs(search, NETWORK_ID, 'peer-far');
		(network as any).node.getPeers = () => [{ toString: () => 'peer-far' }]; // now connected
		openDial();
		await answering;

		expect(sent()).toEqual(['peer-far']);
	});
});
