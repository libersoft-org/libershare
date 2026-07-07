import { describe, it, expect, afterAll } from 'bun:test';
import { applyNetworkLimits } from '../../../src/protocol/network-limits.ts';
import { getMaxMessageSize } from '../../../src/protocol/lish-protocol.ts';
import { downloadLimiter, uploadLimiter } from '../../../src/protocol/speed-limiter.ts';
import { DEFAULT_MAX_MESSAGE_SIZE, type SettingsData } from '../../../src/settings.ts';

/** Minimal network settings slice — only the fields applyNetworkLimits reads. */
function netSlice(overrides: Partial<SettingsData['network']>): SettingsData['network'] {
	return {
		maxDownloadSpeed: 0,
		maxUploadSpeed: 0,
		maxDownloadPeersPerLISH: 30,
		maxUploadPeersPerLISH: 30,
		maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE,
		...overrides,
	} as SettingsData['network'];
}

describe('applyNetworkLimits', () => {
	afterAll(() => {
		// Restore module-state defaults so other test files see a clean slate.
		applyNetworkLimits(netSlice({}));
	});

	it('pushes every limit from the settings snapshot into protocol module state', () => {
		applyNetworkLimits(netSlice({ maxDownloadSpeed: 256, maxUploadSpeed: 128, maxMessageSize: 4 * 1024 * 1024 }));
		expect(downloadLimiter.getLimit()).toBe(256 * 1024);
		expect(uploadLimiter.getLimit()).toBe(128 * 1024);
		expect(getMaxMessageSize()).toBe(4 * 1024 * 1024);
	});

	it('is idempotent — re-applying the same snapshot keeps the same values', () => {
		const net = netSlice({ maxDownloadSpeed: 64 });
		applyNetworkLimits(net);
		applyNetworkLimits(net);
		expect(downloadLimiter.getLimit()).toBe(64 * 1024);
	});
});
