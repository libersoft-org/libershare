import { describe, expect, it } from 'bun:test';
import { Uint8ArrayList } from 'uint8arraylist';
import { encode as lpEncode } from 'it-length-prefixed';
import { initSearchManager, LISTING_REFUSAL_RETRY_JITTER_MS, UNICAST_FALLBACK_PARALLEL, LISTING_REFUSAL_RETRY_MS, MAX_LISTING_REFUSAL_RETRIES } from '../../../src/api/search.ts';
import { getSearchResultHandler } from '../../../src/protocol/lish-protocol.ts';
import { encode as codecEncode } from '../../../src/protocol/codec.ts';
import { lishTopic, MAX_SEARCH_QUERY_LENGTH } from '../../../src/protocol/constants.ts';
import { ErrorCodes } from '@shared';

/**
 * A peer we meet for the first time during a search is asked before it can serve us: our
 * own SUBSCRIBE has not reached it, so its membership gate refuses. That refusal is a
 * state both sides are still converging out of, and it is answered with
 * PEER_LISTING_NOT_AUTHORIZED rather than an empty list precisely so the caller can tell
 * it apart from "nothing matched" and ask again.
 *
 * The earlier design instead guessed from the order of two unrelated events — our empty
 * answer and the peer's SUBSCRIBE — which cannot work: seeing its subscription tells us
 * only that WE now know it is a member, never that it has processed OUR membership. These
 * drive the real SearchManager over stubbed libp2p plumbing.
 */

const NETWORK_ID = 'net-a';
const SELF_ID = 'self-peer';
const NEW_PEER = 'peer-new';
const LISH_ID = 'cccccccc-3333-4444-8555-666666666666';

/**
 * A stream that answers each request with the next scripted response, optionally holding
 * the first answer until the test lets go so another event can overtake it.
 */
function scriptedStream(script: unknown[], gate: Promise<void> | null = null) {
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
			if (gate) await gate;
			for (;;) {
				while (queue.length > 0) yield queue.shift()!;
				if (closed) return;
				await new Promise<void>(resolve => (notify = resolve));
			}
		},
	};
}

/**
 * Wires a SearchManager whose only live peer answers `answers[n]` to its n-th query.
 * `holdFirst` keeps the first answer in flight until `release()` is called.
 */
function buildManager(answers: unknown[][], holdFirst = false) {
	const dials: string[] = [];
	const events: Array<{ event: string; data: any }> = [];
	let onSubscribe: ((peerID: string, topic: string) => void) | undefined;
	let release: () => void = () => {};
	const held = new Promise<void>(resolve => (release = resolve));

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
			const first = dials.length === 1;
			const script = answers[dials.length - 1] ?? answers[answers.length - 1] ?? [];
			return { stream: scriptedStream([...script], holdFirst && first ? held : null) as any, connectionType: 'DIRECT' as const };
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
	const startSearch = async (query: string): Promise<string> => (await manager.startSearch({ query })).searchID;
	let searchID = '';
	return {
		manager,
		dials,
		events,
		release,
		start: async (query: string): Promise<void> => {
			searchID = await startSearch(query);
		},
		fireSubscribe: (): void => onSubscribe?.(NEW_PEER, lishTopic(NETWORK_ID)),
		/** Feed a result in through the pubsub reply path, the way a real `searchResult` lands. */
		deliverPubsubResult: (): void => getSearchResultHandler(searchID)?.({ searchID, peerID: NEW_PEER, lishs: [{ id: LISH_ID, name: 'Shared', totalSize: 10 }] }),
	};
}

const refused = { type: 'getLishs-result', error: ErrorCodes.PEER_LISTING_NOT_AUTHORIZED };
const emptyResult = { type: 'getLishs-result', lishs: [] };
const oneResult = { type: 'getLishs-result', lishs: [{ id: LISH_ID, name: 'Shared', totalSize: 10 }] };

/** The unicast fan-out runs detached from startSearch; let its microtasks drain. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));
/** Longer than the refusal retry delay, so a timed re-ask has fired. */
const afterRetryDelay = (): Promise<void> => new Promise(resolve => setTimeout(resolve, LISTING_REFUSAL_RETRY_MS + LISTING_REFUSAL_RETRY_JITTER_MS + 200));

describe('search unicast retry after a listing refusal', () => {
	it('asks again on its own once the peer has refused', async () => {
		const { manager, dials, events } = buildManager([[refused], [oneResult]]);

		await manager.startSearch({ query: LISH_ID.slice(0, 8) });
		await settle();
		expect(dials).toEqual([NEW_PEER]);
		expect(events.filter(e => e.event === 'search:lishs:update')).toEqual([]);

		// No event of any kind in between: the refusal alone is what owes us the retry.
		await afterRetryDelay();

		expect(dials).toEqual([NEW_PEER, NEW_PEER]);
		const updates = events.filter(e => e.event === 'search:lishs:update');
		expect(updates).toHaveLength(1);
		expect(updates[0]!.data.lishs[0].id).toBe(LISH_ID);
		manager.stopAll();
	});

	// A peer's SUBSCRIBE says only that WE now know it is a member — never that it has
	// processed OUR subscription, which is what the refusal was about. Letting it bring the
	// retry forward meant a burst of these events spent the whole budget within a second,
	// before the peer could possibly have been ready, and nothing asked again afterwards.
	it('a subscription does not spend the retry budget', async () => {
		const { manager, dials, events, fireSubscribe } = buildManager([[refused], [refused], [oneResult]]);

		await manager.startSearch({ query: LISH_ID.slice(0, 8) });
		await settle();
		expect(dials).toEqual([NEW_PEER]);

		// Three events in quick succession used to burn all three attempts here.
		fireSubscribe();
		fireSubscribe();
		fireSubscribe();
		await settle();
		expect(dials).toEqual([NEW_PEER]);

		// The timed retries still run, and the peer is still asked when it becomes ready.
		await afterRetryDelay();
		await afterRetryDelay();

		expect(dials.length).toBeGreaterThanOrEqual(3);
		expect(events.filter(e => e.event === 'search:lishs:update')).toHaveLength(1);
		manager.stopAll();
	});

	// Runs the budget all the way down and then waits past one more interval. Stopping at the
	// first delay, as this once did, proved only "not more than four yet" — a leak that kept
	// arming further timers would have passed it.
	it('spends exactly its budget and then stops asking', async () => {
		const { manager, dials, fireSubscribe } = buildManager([[refused]]);

		await manager.startSearch({ query: LISH_ID.slice(0, 8) });
		await settle();
		for (let i = 0; i < 10; i++) {
			fireSubscribe();
			await settle();
		}
		// One interval per retry, so every one of them comes due.
		for (let i = 0; i < MAX_LISTING_REFUSAL_RETRIES; i++) await afterRetryDelay();

		// The first query plus exactly MAX_LISTING_REFUSAL_RETRIES re-asks.
		expect(dials).toHaveLength(1 + MAX_LISTING_REFUSAL_RETRIES);
		expect(dials.every(p => p === NEW_PEER)).toBe(true);

		// And nothing more: a further interval passes with the peer still refusing.
		await afterRetryDelay();

		expect(dials).toHaveLength(1 + MAX_LISTING_REFUSAL_RETRIES);
		manager.stopAll();
		// Four full retry intervals of real time; the default 5 s cap is not enough.
	}, 20_000);

	// Events arriving back to back, with no chance for an answer in between: each one used
	// to pass a budget check that only counted the refusals that had come back, so all of
	// them dispatched and the bound meant nothing.
	it('a burst of subscriptions cannot outrun the budget', async () => {
		const { manager, dials, fireSubscribe } = buildManager([[refused]]);

		await manager.startSearch({ query: LISH_ID.slice(0, 8) });
		await settle();
		for (let i = 0; i < 10; i++) fireSubscribe(); // no await: nothing can answer in between
		await settle();
		await afterRetryDelay();

		// The bound, not an exact count: how many timed retries fit in the window is a matter
		// of timing, but exceeding the budget never is. Ten events used to buy ten dials.
		expect(dials.length).toBeLessThanOrEqual(1 + MAX_LISTING_REFUSAL_RETRIES);
		expect(dials.every(p => p === NEW_PEER)).toBe(true);
		manager.stopAll();
	});

	// The same peer can answer over pubsub instead, which lands in the shared aggregation
	// path rather than in queryOnePeer. A re-ask armed by its earlier refusal is moot either
	// way — the peer has served us.
	it('an answer arriving over pubsub also cancels the pending retry', async () => {
		const { manager, dials, start, deliverPubsubResult } = buildManager([[refused], [oneResult]]);

		await start(LISH_ID.slice(0, 8));
		await settle();
		expect(dials).toEqual([NEW_PEER]);

		deliverPubsubResult();
		await afterRetryDelay();

		expect(dials).toEqual([NEW_PEER]);
		manager.stopAll();
	});

	// Nothing armed by a session may outlive it: the timer holds the session and would dial
	// a peer for a search the user has already cancelled.
	it('ending the search cancels a pending retry', async () => {
		const { manager, dials } = buildManager([[refused], [oneResult]]);

		await manager.startSearch({ query: LISH_ID.slice(0, 8) });
		await settle();
		expect(dials).toEqual([NEW_PEER]);

		manager.stopAll();
		await afterRetryDelay();

		expect(dials).toEqual([NEW_PEER]);
	});

	// A re-ask that cannot reach the peer at all leaves it in exactly the unsettled state the
	// cycle exists for. Dropping it there left the peer holding spent state nothing would arm.
	it('keeps going when a retry fails to reach the peer', async () => {
		const { manager, dials, events } = buildManager([[refused], [], [oneResult]]);

		await manager.startSearch({ query: LISH_ID.slice(0, 8) });
		await settle();
		await afterRetryDelay(); // second dial: the stream closes without answering
		expect(dials).toEqual([NEW_PEER, NEW_PEER]);
		expect(events.filter(e => e.event === 'search:lishs:update')).toEqual([]);

		await afterRetryDelay(); // third dial, on the remaining budget

		expect(dials).toEqual([NEW_PEER, NEW_PEER, NEW_PEER]);
		expect(events.filter(e => e.event === 'search:lishs:update')).toHaveLength(1);
		manager.stopAll();
	});

	it('treats an empty list as a final answer', async () => {
		const { manager, dials, fireSubscribe } = buildManager([[emptyResult], [oneResult]]);

		await manager.startSearch({ query: LISH_ID.slice(0, 8) });
		await settle();
		fireSubscribe();
		await afterRetryDelay();

		expect(dials).toEqual([NEW_PEER]);
		manager.stopAll();
	});

	// The peer can answer over pubsub while our direct query to it is still out; that query
	// then comes back refused. Opening a retry cycle on it would re-ask a peer whose results
	// are already on screen.
	// A re-ask can sit in the permit queue behind other peers. If its peer answers over the
	// other channel while it waits, sending it once a slot frees is pure waste — and the slot
	// is exactly what the peers we are still waiting on need. The cap has to be saturated for
	// the retry to queue at all, which is why this builds a fleet rather than one peer.
	it('a queued retry is dropped when its peer answers while it waits', async () => {
		const TARGET = 'peer-target';
		const blockers = Array.from({ length: UNICAST_FALLBACK_PARALLEL }, (_, i) => `blocker-${i}`);
		const dials: string[] = [];
		let releaseBlockers: () => void = () => {};
		const blocked = new Promise<void>(resolve => (releaseBlockers = resolve));
		let searchID = '';
		let handler: ((ann: { searchID: string; peerID: string; lishs: any[] }) => void) | undefined;

		const network = {
			isRunning: () => true,
			getNodeInfo: () => ({ peerID: SELF_ID }),
			// Target first, so it is queried and refused before the blockers take every permit.
			getPeers: () => [TARGET, ...blockers],
			getTopicPeers: () => [TARGET],
			onPeerConnect: () => () => {},
			broadcast: async (): Promise<void> => {},
			dialProtocolByPeerId: async (peerID: string) => {
				dials.push(peerID);
				const answerOnce = peerID === TARGET && dials.filter(p => p === TARGET).length === 1;
				return {
					stream: {
						id: 'queue',
						status: 'open',
						send(): void {},
						async close(): Promise<void> {},
						abort(): void {},
						async *[Symbol.asyncIterator]() {
							// The target refuses at once; the blockers hold their permits until released.
							if (!answerOnce) await blocked;
							yield lpEncode.single(codecEncode(refused));
						},
					} as any,
					connectionType: 'DIRECT' as const,
				};
			},
		};
		const networks = { getNetwork: () => network, getRunningNetwork: () => network, list: () => [{ networkID: NETWORK_ID, enabled: true }], isJoined: () => true };
		const manager = initSearchManager(networks as any, { get: () => 30_000 } as any, () => {});

		searchID = (await manager.startSearch({ query: LISH_ID.slice(0, 8) })).searchID;
		handler = getSearchResultHandler(searchID);
		await settle();
		expect(dials.filter(p => p === TARGET)).toHaveLength(1); // refused once

		// The re-ask comes due while every permit is held, so it goes into the queue.
		await afterRetryDelay();
		expect(dials.filter(p => p === TARGET)).toHaveLength(1);

		// Answer over pubsub, then free the permits so the queued re-ask gets its turn.
		handler?.({ searchID, peerID: TARGET, lishs: [{ id: LISH_ID, name: 'Shared', totalSize: 10 }] });
		releaseBlockers();
		await settle();
		await settle();

		expect(dials.filter(p => p === TARGET)).toHaveLength(1);
		manager.stopAll();
	});

	it('a refusal arriving after the peer answered starts nothing', async () => {
		const { manager, dials, start, deliverPubsubResult, release } = buildManager([[refused], [oneResult]], true);

		await start(LISH_ID.slice(0, 8));
		await settle();
		expect(dials).toEqual([NEW_PEER]); // direct query still waiting

		deliverPubsubResult(); // answered over the other channel
		await settle();
		release(); // now the direct query comes back refused
		await afterRetryDelay();

		expect(dials).toEqual([NEW_PEER]);
		manager.stopAll();
	});

	// Every responder drops a query over the bound and answers with an empty list, so sending
	// it would tell the user nothing was found — which is not what happened.
	it('refuses a query longer than the bound instead of searching with it', async () => {
		const { manager, dials } = buildManager([[oneResult]]);

		await expect(manager.startSearch({ query: 'x'.repeat(MAX_SEARCH_QUERY_LENGTH + 1) })).rejects.toThrow(ErrorCodes.SEARCH_QUERY_TOO_LONG);

		expect(dials).toEqual([]);
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

/**
 * The refusal, not the ordering of events, is what owes the retry — so a subscription that
 * overtakes the first answer must change nothing. The earlier design read that ordering
 * and could spend both of its attempts before the peer had processed our membership at
 * all, after which nothing asked again and the results of a peer we were entitled to see
 * never arrived.
 */
describe('search unicast retry — the order of events must not matter', () => {
	it('retries when the subscription arrives before the refusal does', async () => {
		const { manager, dials, events, release, fireSubscribe } = buildManager([[refused], [oneResult]], true);

		await manager.startSearch({ query: LISH_ID.slice(0, 8) });
		await settle();
		expect(dials).toEqual([NEW_PEER]); // first query still waiting for its answer

		fireSubscribe(); // lands while the answer is in flight, so it finds nothing to speed up
		await settle();
		release(); // now the refusal arrives
		await afterRetryDelay();

		expect(dials).toEqual([NEW_PEER, NEW_PEER]);
		const updates = events.filter(e => e.event === 'search:lishs:update');
		expect(updates).toHaveLength(1);
		expect(updates[0]!.data.lishs[0].id).toBe(LISH_ID);
		manager.stopAll();
	});
});

/**
 * The opening fan-out queues its dials behind a cap so a large fleet is not hit with dozens
 * of streams at once. A retry is the same kind of dial, and retries are the case most likely
 * to come due together — every peer refuses a freshly joined node, so their re-asks land in
 * the same tick. Dispatching them outside the queue made the cap meaningless exactly when
 * connections were still settling.
 */
describe('search dial concurrency', () => {
	const PEER_COUNT = 40;
	const peers = Array.from({ length: PEER_COUNT }, (_, i) => `peer-${i}`);

	/**
	 * Every peer refuses at once. The FIRST answer to each peer is immediate, so the opening
	 * fan-out drains through its pool and all forty retries end up armed together; the RETRY
	 * answers are the ones held, so the re-asks pile up and the peak is actually observable.
	 */
	function fleetManager(holdFirst = false) {
		const events: Array<{ event: string; data: any }> = [];
		const dialsPerPeer = new Map<string, number>();
		let live = 0;
		let peak = 0;
		let release: () => void = () => {};
		const held = new Promise<void>(resolve => (release = resolve));
		/** Per-dial gates, so a single in-flight query can be finished on its own. */
		const gates: Array<() => void> = [];
		let onConnect: ((peerID: string) => void) | undefined;

		const network = {
			isRunning: () => true,
			getNodeInfo: () => ({ peerID: SELF_ID }),
			getPeers: () => peers,
			getTopicPeers: () => peers,
			onPeerConnect: (h: (peerID: string) => void) => {
				onConnect = h;
				return () => {
					onConnect = undefined;
				};
			},
			broadcast: async (): Promise<void> => {},
			dialProtocolByPeerId: async (peerID: string) => {
				const nth = (dialsPerPeer.get(peerID) ?? 0) + 1;
				dialsPerPeer.set(peerID, nth);
				live++;
				peak = Math.max(peak, live);
				let counted = true;
				const done = (): void => {
					if (counted) live--;
					counted = false;
				};
				let openGate: () => void = () => {};
				const gate = new Promise<void>(resolve => (openGate = resolve));
				gates.push(openGate);
				return {
					stream: {
						id: 'fleet',
						status: 'open',
						send(): void {},
						close: async (): Promise<void> => done(),
						abort: (): void => done(),
						async *[Symbol.asyncIterator]() {
							// Held until the test says so: either everything (holdFirst), or just the
							// re-asks, so the opening fan-out can drain and arm them all together.
							if (nth > 1 || holdFirst) await Promise.race([held, gate]);
							yield lpEncode.single(codecEncode(refused));
						},
					} as any,
					connectionType: 'DIRECT' as const,
				};
			},
		};
		const networks = { getNetwork: () => network, getRunningNetwork: () => network, list: () => [{ networkID: NETWORK_ID, enabled: true }], isJoined: () => true };
		const manager = initSearchManager(networks as any, { get: () => 30_000 } as any, (event, data) => events.push({ event, data }));
		const retryDials = (): number => [...dialsPerPeer.values()].filter(n => n > 1).length;
		return {
			manager,
			release,
			peakDials: (): number => peak,
			liveDials: (): number => live,
			retryDials,
			/** Let exactly one in-flight query finish, freeing exactly one permit. */
			releaseOne: (): void => gates.shift()?.(),
			/** Fire the live peer:connect listener, which dials without going through the pool. */
			connectPeer: (peerID: string): void => onConnect?.(peerID),
		};
	}

	// A permit freed and then handed on is briefly visible as free: in the microtask between
	// the two, a newly arriving dial takes the slot, and the woken waiter then takes it too.
	// Eleven streams open against a cap of ten. The window is one microtask wide, so the test
	// finishes one query and then offers a new peer at each microtask boundary until it lands
	// inside it.
	it('does not let a new dial overtake a waiting one into the same slot', async () => {
		const { manager, release, peakDials, connectPeer, releaseOne } = fleetManager(true);

		await manager.startSearch({ query: 'anything' });
		await settle();
		expect(peakDials()).toBe(UNICAST_FALLBACK_PARALLEL); // cap reached, the rest queued

		for (let i = 0; i < 12; i++) {
			releaseOne();
			for (let tick = 0; tick < 6; tick++) {
				await Promise.resolve();
				connectPeer(`peer-late-${i}-${tick}`);
			}
		}
		await settle();

		expect(peakDials()).toBeLessThanOrEqual(UNICAST_FALLBACK_PARALLEL);
		release();
		manager.stopAll();
	});

	// The permits are what a cancelled search must stop occupying. Tearing down its clients
	// cannot reach a dial that is still being established — it has no stream yet — so the
	// cancellation has to reach the dial itself, or the next search waits for work nobody wants.
	it('a cancelled search frees the slots its unfinished dials were holding', async () => {
		let dialsStarted = 0;
		const network = {
			isRunning: () => true,
			getNodeInfo: () => ({ peerID: SELF_ID }),
			getPeers: () => Array.from({ length: 40 }, (_, i) => `peer-${i}`),
			getTopicPeers: () => [],
			onPeerConnect: () => () => {},
			broadcast: async (): Promise<void> => {},
			// Never completes on its own; only the caller's signal ends it, as a real dial would.
			dialProtocolByPeerId: async (_peerID: string, _protocol: string, signal?: AbortSignal) => {
				dialsStarted++;
				return new Promise((_resolve, reject) => {
					signal?.addEventListener('abort', () => reject(new Error('dial aborted')), { once: true });
				});
			},
		};
		const networks = { getNetwork: () => network, getRunningNetwork: () => network, list: () => [{ networkID: NETWORK_ID, enabled: true }], isJoined: () => true };
		const manager = initSearchManager(networks as any, { get: () => 30_000 } as any, () => {});

		const { searchID } = await manager.startSearch({ query: 'first' });
		await settle();
		expect(dialsStarted).toBe(UNICAST_FALLBACK_PARALLEL); // every permit held by a stuck dial

		manager.cancelSearch({ searchID });
		await settle();

		// The second search gets its dials straight away rather than queueing behind the first.
		const before = dialsStarted;
		await manager.startSearch({ query: 'second' });
		await settle();
		expect(dialsStarted).toBeGreaterThan(before);
		manager.stopAll();
	});

	// Cancelling tears down the clients it can see, but a dial still being established has no
	// client yet. Completing after the cancel, it used to send the query anyway and hold its
	// shared permit for the full read timeout — slowing the search the user started instead.
	it('a dial that completes after the cancel is thrown away, not sent', async () => {
		let finishDial: () => void = () => {};
		const pendingDial = new Promise<void>(resolve => (finishDial = resolve));
		const sent: string[] = [];
		let aborted = 0;

		const network = {
			isRunning: () => true,
			getNodeInfo: () => ({ peerID: SELF_ID }),
			getPeers: () => [NEW_PEER],
			getTopicPeers: () => [NEW_PEER],
			onPeerConnect: () => () => {},
			broadcast: async (): Promise<void> => {},
			dialProtocolByPeerId: async () => {
				await pendingDial; // still connecting when the search is cancelled
				return {
					stream: {
						id: 'slow-dial',
						status: 'open',
						send(): void {
							sent.push(NEW_PEER);
						},
						async close(): Promise<void> {},
						abort(): void {
							aborted++;
						},
						async *[Symbol.asyncIterator]() {
							yield lpEncode.single(codecEncode(oneResult));
						},
					} as any,
					connectionType: 'DIRECT' as const,
				};
			},
		};
		const networks = { getNetwork: () => network, getRunningNetwork: () => network, list: () => [{ networkID: NETWORK_ID, enabled: true }], isJoined: () => true };
		const manager = initSearchManager(networks as any, { get: () => 30_000 } as any, () => {});

		await manager.startSearch({ query: LISH_ID.slice(0, 8) });
		await settle();
		manager.stopAll();

		finishDial();
		await settle();

		expect(sent).toEqual([]);
		expect(aborted).toBe(1);
	});

	it('a cancelled search stops holding dial permits', async () => {
		// The permits are shared with every other search, so a cancelled one whose peers never
		// answer would otherwise keep the next search queued behind it for the full read timeout.
		const { manager, release, peakDials, liveDials } = fleetManager(true);

		await manager.startSearch({ query: 'anything' });
		await settle();
		expect(liveDials()).toBe(UNICAST_FALLBACK_PARALLEL); // ten peers hold the permits, none answering

		manager.stopAll();
		await settle();

		expect(liveDials()).toBe(0);
		expect(peakDials()).toBeLessThanOrEqual(UNICAST_FALLBACK_PARALLEL);
		release();
	});

	it('holds retries to the same cap as the opening fan-out', async () => {
		const { manager, release, peakDials, retryDials } = fleetManager();

		await manager.startSearch({ query: 'anything' });
		await settle();
		expect(peakDials()).toBeLessThanOrEqual(UNICAST_FALLBACK_PARALLEL);

		// Every peer has now refused, so forty re-asks come due within the jitter window. Their
		// answers are held, so any that the cap did not queue would still be on the wire here.
		await afterRetryDelay();
		await settle();
		expect(peakDials()).toBeLessThanOrEqual(UNICAST_FALLBACK_PARALLEL);

		// Queued, not dropped: once the held answers land, the rest take their turn.
		release();
		await new Promise<void>(resolve => setTimeout(resolve, 500));
		expect(retryDials()).toBeGreaterThan(UNICAST_FALLBACK_PARALLEL);
		expect(peakDials()).toBeLessThanOrEqual(UNICAST_FALLBACK_PARALLEL);
		manager.stopAll();
	});
});
