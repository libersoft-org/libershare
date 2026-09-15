import { describe, expect, it } from 'bun:test';
import { Uint8ArrayList } from 'uint8arraylist';
import { encode as lpEncode } from 'it-length-prefixed';
import { initSearchManager } from '../../../src/api/search.ts';
import { encode as codecEncode } from '../../../src/protocol/codec.ts';
import { lishTopic } from '../../../src/protocol/constants.ts';

/**
 * A peer we meet for the first time during a search is asked before it can be served:
 * on `peer:connect` its SUBSCRIBE has not reached us, so the responder's membership gate
 * refuses and answers with an empty list — indistinguishable from "nothing matched". The
 * peer is already in `queried`, so without a retry its results never arrive.
 *
 * This drives the real SearchManager over stubbed libp2p plumbing; the retry bookkeeping
 * under test is the real thing.
 */

const NETWORK_ID = 'net-a';
const SELF_ID = 'self-peer';
const NEW_PEER = 'peer-new';
const LISH_ID = 'cccccccc-3333-4444-8555-666666666666';

/**
 * A stream that answers each request with the next scripted response. Lets the real
 * LISHClient run instead of stubbing out the request itself.
 */
function scriptedStream(script: unknown[]) {
	const queue: Uint8ArrayList[] = [];
	let notify: (() => void) | null = null;
	let closed = false;
	const wake = (): void => {
		notify?.();
		notify = null;
	};
	return {
		id: 'scripted',
		status: 'open',
		send(): void {
			const next = script.shift();
			if (next === undefined) closed = true;
			else queue.push(lpEncode.single(codecEncode(next)));
			wake();
		},
		async close(): Promise<void> {
			closed = true;
			wake();
		},
		abort(): void {
			closed = true;
			wake();
		},
		async *[Symbol.asyncIterator]() {
			for (;;) {
				while (queue.length > 0) yield queue.shift()!;
				if (closed) return;
				await new Promise<void>(resolve => (notify = resolve));
			}
		},
	};
}

/** Wires a SearchManager whose only live peer answers `answers[n]` to its n-th query. */
function buildManager(answers: unknown[][]) {
	const dials: string[] = [];
	const events: Array<{ event: string; data: any }> = [];
	let onSubscribe: ((peerID: string, topic: string) => void) | undefined;

	const network = {
		isRunning: () => true,
		getNodeInfo: () => ({ peerID: SELF_ID }),
		getPeers: () => [NEW_PEER],
		getTopicPeers: () => [NEW_PEER],
		onPeerConnect: () => () => {},
		onPeerSubscribe: (h: (peerID: string, topic: string) => void) => {
			onSubscribe = h;
			return () => {
				onSubscribe = undefined;
			};
		},
		broadcast: async (): Promise<void> => {},
		dialProtocolByPeerId: async (peerID: string) => {
			dials.push(peerID);
			const script = answers[dials.length - 1] ?? [];
			return { stream: scriptedStream([...script]) as any, connectionType: 'DIRECT' as const };
		},
	};
	const networks = {
		getNetwork: () => network,
		getRunningNetwork: () => network,
		list: () => [{ networkID: NETWORK_ID, enabled: true }],
		isJoined: () => true,
	};
	const settings = { get: () => 30_000 };
	const manager = initSearchManager(networks as any, settings as any, (event, data) => events.push({ event, data }));
	return { manager, dials, events, fireSubscribe: (): void => onSubscribe?.(NEW_PEER, lishTopic(NETWORK_ID)) };
}

const emptyResult = { type: 'getLishs-result', lishs: [] };
const oneResult = { type: 'getLishs-result', lishs: [{ id: LISH_ID, name: 'Shared', totalSize: 10 }] };

/** The unicast fan-out runs detached from startSearch; let its microtasks drain. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));

describe('search unicast retry after a peer subscribes', () => {
	it('asks a peer again once its subscription arrives', async () => {
		const { manager, dials, events, fireSubscribe } = buildManager([[emptyResult], [oneResult]]);

		await manager.startSearch({ query: LISH_ID.slice(0, 8) });
		await settle();
		expect(dials).toEqual([NEW_PEER]);
		expect(events.filter(e => e.event === 'search:lishs:update')).toEqual([]);

		fireSubscribe();
		await settle();

		expect(dials).toEqual([NEW_PEER, NEW_PEER]);
		const updates = events.filter(e => e.event === 'search:lishs:update');
		expect(updates).toHaveLength(1);
		expect(updates[0]!.data.lishs[0].id).toBe(LISH_ID);
		manager.stopAll();
	});

	it('retries a peer at most once however often it resubscribes', async () => {
		const { manager, dials, fireSubscribe } = buildManager([[emptyResult], [emptyResult], [oneResult]]);

		await manager.startSearch({ query: LISH_ID.slice(0, 8) });
		await settle();
		fireSubscribe();
		await settle();
		fireSubscribe();
		fireSubscribe();
		await settle();

		expect(dials).toEqual([NEW_PEER, NEW_PEER]);
		manager.stopAll();
	});

	it('does not retry a peer that already answered', async () => {
		const { manager, dials, fireSubscribe } = buildManager([[oneResult], [oneResult]]);

		await manager.startSearch({ query: LISH_ID.slice(0, 8) });
		await settle();
		fireSubscribe();
		await settle();

		expect(dials).toEqual([NEW_PEER]);
		manager.stopAll();
	});
});
