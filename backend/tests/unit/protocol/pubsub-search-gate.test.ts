import { afterEach, describe, expect, it } from 'bun:test';
import { LISHServingHandlers } from '../../../src/protocol/lish-handlers.ts';
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
		canServePubsubRequestTo: (peerID: string) => network.canServePubsubRequestTo(peerID),
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

	it('does not burn the searchID dedup slot on a refused query', async () => {
		// Recording a refused searchID would let a bare peer poison the dedup map so the
		// same query from a legitimate member is silently dropped.
		initUploadState(new Set([SHARED_LISH_ID]), () => {});
		const seenSearchIDs = new Map<string, number>();
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
			canServePubsubRequestTo: (peerID: string) => network.canServePubsubRequestTo(peerID),
		});

		await handlers.handleSearchLishs(search, NETWORK_ID, 'peer-bare');

		expect(seenSearchIDs.size).toBe(0);
	});
});
