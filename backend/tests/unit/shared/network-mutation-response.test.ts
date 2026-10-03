import { describe, expect, it } from 'bun:test';
import { combineNetworkMutations, toNetworkMutationResponse } from '@shared';

/**
 * A client asks for detailed outcomes; an older server answers with the plain value. That
 * answer must come back marked as legacy — a `true` from it means "accepted", never "applied".
 */
describe('network mutation responses', () => {
	it('keeps a detailed outcome as it is', () => {
		const outcome = { stored: true, applied: false, transitioned: false, value: true };
		expect(toNetworkMutationResponse<boolean>(outcome)).toEqual(outcome);
	});

	it('marks an older server plain answer as legacy instead of inventing applied', () => {
		expect(toNetworkMutationResponse<boolean>(true)).toEqual({ legacy: true, value: true });
		expect(toNetworkMutationResponse<boolean>(false)).toEqual({ legacy: true, value: false });
		const config = { networkID: 'n', name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '' };
		expect(toNetworkMutationResponse(config)).toEqual({ legacy: true, value: config });
	});

	it('combines a batch: applied only when every item is, transitioned when any is', () => {
		const item = (networkID: string, applied: boolean, transitioned: boolean) => ({ networkID, stored: true, applied, transitioned, value: null });
		expect(combineNetworkMutations(true, [item('a', true, false), item('b', false, true)])).toMatchObject({ stored: true, applied: false, transitioned: true });
		expect(combineNetworkMutations(true, [])).toMatchObject({ stored: true, applied: true, transitioned: false });
	});
});
