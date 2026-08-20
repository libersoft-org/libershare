import { describe, expect, it } from 'bun:test';
import { toSetEnabledResponse } from '../../../src/api/lishnets.ts';

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
