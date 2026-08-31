import { describe, expect, it } from 'bun:test';
import { subscribeNetworkState } from '../../src/scripts/networkState.ts';

describe('network state subscription', () => {
	it('settles failed subscriptions so reconnect initialization can retry', async () => {
		const originalError = console.error;
		console.error = () => {};
		try {
			expect(await subscribeNetworkState(() => Promise.reject(new Error('temporary failure')))).toBe(false);
			expect(await subscribeNetworkState(() => Promise.resolve(true))).toBe(true);
		} finally {
			console.error = originalError;
		}
	});
});
