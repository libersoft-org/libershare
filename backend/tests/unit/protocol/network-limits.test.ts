import { describe, it, expect, afterAll } from 'bun:test';
import { applyNetworkLimits } from '../../../src/protocol/network-limits.ts';
import { getMaxMessageSize, getMaxChunkSize } from '../../../src/protocol/lish-protocol.ts';
import { downloadLimiter, uploadLimiter } from '../../../src/protocol/speed-limiter.ts';
import { DEFAULT_MAX_MESSAGE_SIZE, DEFAULT_MAX_CHUNK_SIZE, type SettingsData } from '../../../src/settings.ts';

/** Minimal network settings slice — only the fields applyNetworkLimits reads. */
function netSlice(overrides: Partial<SettingsData['network']>): SettingsData['network'] {
	return {
		maxDownloadSpeed: 0,
		maxUploadSpeed: 0,
		maxDownloadPeersPerLISH: 30,
		maxUploadPeersPerLISH: 30,
		maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE,
		maxChunkSize: DEFAULT_MAX_CHUNK_SIZE,
		...overrides,
	} as SettingsData['network'];
}

describe('applyNetworkLimits', () => {
	afterAll(() => {
		// Restore module-state defaults so other test files see a clean slate.
		applyNetworkLimits(netSlice({}));
	});

	it('pushes every limit from the settings snapshot into protocol module state', () => {
		applyNetworkLimits(netSlice({ maxDownloadSpeed: 256, maxUploadSpeed: 128, maxMessageSize: 4 * 1024 * 1024, maxChunkSize: 2 * 1024 * 1024 }));
		expect(downloadLimiter.getLimit()).toBe(256 * 1024);
		expect(uploadLimiter.getLimit()).toBe(128 * 1024);
		expect(getMaxMessageSize()).toBe(4 * 1024 * 1024);
		expect(getMaxChunkSize()).toBe(2 * 1024 * 1024);
	});

	it('is idempotent — re-applying the same snapshot keeps the same values', () => {
		const net = netSlice({ maxDownloadSpeed: 64 });
		applyNetworkLimits(net);
		applyNetworkLimits(net);
		expect(downloadLimiter.getLimit()).toBe(64 * 1024);
	});

	it('preserves the throttle cursor when the rate is unchanged, resets it on change', async () => {
		const net = netSlice({ maxDownloadSpeed: 1 }); // 1 KB/s
		applyNetworkLimits(net);
		// Claim a far-future slot: 10 KB at 1 KB/s advances the cursor ~10s ahead.
		await downloadLimiter.throttle(10 * 1024);
		const cursor = (downloadLimiter as any).nextAllowedTime as number;
		expect(cursor).toBeGreaterThan(Date.now() + 5_000);
		// Unchanged rate (any network.* settings write re-pushes all limits) must not
		// reset the cursor — that would grant a throttled transfer a burst.
		applyNetworkLimits(net);
		expect((downloadLimiter as any).nextAllowedTime).toBe(cursor);
		// Changed rate resets the cursor to now so the new rate applies immediately.
		applyNetworkLimits(netSlice({ maxDownloadSpeed: 2 }));
		expect((downloadLimiter as any).nextAllowedTime).toBeLessThan(cursor);
	});
});
