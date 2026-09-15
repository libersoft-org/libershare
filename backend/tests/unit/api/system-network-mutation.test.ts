import { describe, expect, it } from 'bun:test';
import { restrictNetworkCapabilities, runAndPublishNetworkMutation } from '../../../src/api/system.ts';
import { runNetworkMutation } from '../../../src/system-network.ts';
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

	it('reads the failed result before a queued change may begin', async () => {
		// The read-back of a failed change and the next change both want the host
		// lock. If the lock were released between the failure and the read, the
		// queued change would run first and the "result" published for the failed
		// one would really be the second change's outcome.
		const order: string[] = [];
		let releaseRead: () => void = () => {};
		const readBlocked = new Promise<void>(resolve => (releaseRead = resolve));
		const failing = runAndPublishNetworkMutation(
			async () => {
				order.push('mutation');
				throw new Error('apply failed');
			},
			async () => {
				order.push('read-back:start');
				await readBlocked;
				order.push('read-back:end');
				return state();
			},
			() => order.push('publish')
		).catch(() => {});
		const queued = runNetworkMutation(async () => {
			order.push('queued');
		});
		await Promise.resolve();
		releaseRead();
		await Promise.all([failing, queued]);
		expect(order).toEqual(['mutation', 'read-back:start', 'read-back:end', 'publish', 'queued']);
	});

	it('hides write capabilities when the API has no authentication token', () => {
		const current = state();
		expect(restrictNetworkCapabilities(current, false).capabilities).toEqual({ ipv4: false, ipv4Elevation: false, wifi: false, staticGatewayRequired: false });
		expect(restrictNetworkCapabilities(current, true)).toBe(current);
	});
});
