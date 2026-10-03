import { describe, expect, it } from 'bun:test';
import { initLISHnetsHandlers, toSetEnabledResponse } from '../../../src/api/lishnets.ts';
import { encode as lpEncode } from 'it-length-prefixed';
import { encode as codecEncode } from '../../../src/protocol/codec.ts';
import { ErrorCodes } from '@shared';

describe('lishnets.setEnabled response', () => {
	it('does not report success when the row was saved but runtime convergence was deferred', () => {
		expect(toSetEnabledResponse({ found: true, stored: true, transitioned: false, joined: true, applied: false })).toEqual({
			success: false,
			stored: true,
			applied: false,
			transitioned: false,
			joined: true,
		});
	});

	it('reports success when storage and runtime agree', () => {
		expect(toSetEnabledResponse({ found: true, stored: true, transitioned: true, joined: false, applied: true })).toEqual({
			success: true,
			stored: true,
			applied: true,
			transitioned: true,
			joined: false,
		});
	});
});

describe('lishnets.addPeerLish reset admission', () => {
	it('enters the LISH mutation gate before starting peer I/O', async () => {
		let networkTouched = false;
		let gateEntered = false;
		const networks = {
			getRunningNetwork: () => {
				networkTouched = true;
				throw new Error('peer I/O must stay behind the gate');
			},
		};
		const runMutation = async <T>(_operation: () => Promise<T>): Promise<T> => {
			gateEntered = true;
			return { lishID: 'held-by-reset' } as T;
		};
		const handlers = initLISHnetsHandlers(
			networks as never,
			{} as never,
			() => {},
			{} as never,
			async () => ({ lishID: 'unused' }) as never,
			runMutation,
			new AbortController().signal
		);

		const result = await handlers.addPeerLish({ lishID: 'lish-a', peerID: 'peer-a', networkID: 'net-a' });

		expect(gateEntered).toBe(true);
		expect(networkTouched).toBe(false);
		expect(result).toEqual({ lishID: 'held-by-reset' });
	});
});

/**
 * Opening a peer's detail right after connecting hits the same race the search retry exists
 * for: we already know the peer is a member, but it has not yet processed our own
 * subscription, so its listing gate refuses. The refusal is transient — both sides converge
 * within a moment — so a detail screen that reported it as a final error left the user
 * looking at a stale failure until they pressed Refresh.
 */
describe('lishnets.getPeerLishs listing refusal', () => {
	function handlersOverPeer(answers: Array<'refuse' | 'serve'>) {
		const attempts: string[] = [];
		const network = {
			dialProtocolByPeerId: async (peerID: string) => {
				const answer = answers[attempts.length] ?? 'serve';
				attempts.push(peerID);
				return {
					stream: {
						id: 'peer-detail',
						status: 'open',
						send(): void {},
						async close(): Promise<void> {},
						abort(): void {},
						async *[Symbol.asyncIterator]() {
							yield lpEncode.single(codecEncode(answer === 'refuse' ? { type: 'getLishs-result', error: ErrorCodes.PEER_LISTING_NOT_AUTHORIZED } : { type: 'getLishs-result', lishs: [{ id: PEER_LISH_ID, name: 'Shared', totalSize: 7 }] }));
						},
					} as any,
					connectionType: 'DIRECT' as const,
				};
			},
		};
		const handlers = initLISHnetsHandlers(
			{ getRunningNetwork: () => network } as never,
			{} as never,
			() => {},
			{} as never,
			async () => ({ lishID: 'unused' }) as never,
			async op => op(),
			new AbortController().signal
		);
		return { handlers, attempts };
	}

	const PEER_LISH_ID = 'dddddddd-4444-4555-8666-777777777777';

	it('recovers on its own when the membership lands a moment later', async () => {
		const { handlers, attempts } = handlersOverPeer(['refuse', 'serve']);

		const result = await handlers.getPeerLishs({ peerID: 'peer-new', networkID: 'net-a' });

		expect(attempts.length).toBe(2);
		expect(result.lishs.map(l => l.id)).toEqual([PEER_LISH_ID]);
	});

	it('gives up and reports the refusal when the peer keeps refusing', async () => {
		const { handlers, attempts } = handlersOverPeer(['refuse', 'refuse', 'refuse', 'refuse']);

		await expect(handlers.getPeerLishs({ peerID: 'peer-stranger', networkID: 'net-a' })).rejects.toThrow(ErrorCodes.PEER_LISTING_NOT_AUTHORIZED);

		// Bounded: the screen is waiting on this call, so it must fail visibly rather than hang.
		expect(attempts.length).toBe(3);
	});
});
