import { describe, expect, it } from 'bun:test';
import { restrictNetworkCapabilities, runAndPublishNetworkMutation } from '../../../src/api/system.ts';
import type { NetworkStateInfo } from '@shared';

function state(): NetworkStateInfo {
	return {
		known: true,
		detail: 'full',
		primaryID: null,
		capabilities: { ipv4: true, wifi: true, staticGatewayRequired: false },
		interfaces: [],
	};
}

describe('network mutation publishing', () => {
	it('publishes the fresh state before rethrowing the original mutation error', async () => {
		const original = new Error('join failed');
		const published: NetworkStateInfo[] = [];
		const fresh = state();

		await expect(
			runAndPublishNetworkMutation(
				async () => Promise.reject(original),
				async () => fresh,
				value => published.push(value)
			)
		).rejects.toBe(original);
		expect(published).toEqual([fresh]);
	});

	it('hides write capabilities when the API has no authentication token', () => {
		const current = state();
		expect(restrictNetworkCapabilities(current, false).capabilities).toEqual({ ipv4: false, ipv4Elevation: false, wifi: false, staticGatewayRequired: false });
		expect(restrictNetworkCapabilities(current, true)).toBe(current);
	});
});
