import { describe, expect, it } from 'bun:test';
import { initLISHnetsHandlers, toSetEnabledResponse } from '../../../src/api/lishnets.ts';

describe('lishnets.setEnabled response', () => {
	it('does not report success when the row was saved but runtime convergence was deferred', () => {
		expect(toSetEnabledResponse({ found: true, transitioned: false, joined: true, applied: false })).toEqual({
			success: false,
			applied: false,
			transitioned: false,
			joined: true,
		});
	});

	it('reports success when storage and runtime agree', () => {
		expect(toSetEnabledResponse({ found: true, transitioned: true, joined: false, applied: true })).toEqual({
			success: true,
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
			runMutation
		);

		const result = await handlers.addPeerLish({ lishID: 'lish-a', peerID: 'peer-a', networkID: 'net-a' });

		expect(gateEntered).toBe(true);
		expect(networkTouched).toBe(false);
		expect(result).toEqual({ lishID: 'held-by-reset' });
	});
});
