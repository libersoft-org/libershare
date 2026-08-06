import { describe, it, expect, afterAll } from 'bun:test';
import { applyNetworkLimits } from '../../../src/protocol/network-limits.ts';
import { getMaxMessageSize, getMaxChunkSize } from '../../../src/protocol/lish-protocol.ts';
import { PeerManager } from '../../../src/protocol/peer-manager.ts';
import { downloadLimiter, uploadLimiter } from '../../../src/protocol/speed-limiter.ts';
import { DEFAULT_MAX_MESSAGE_SIZE, DEFAULT_MAX_CHUNK_SIZE, useNetworkSettings, type SettingsData } from '../../../src/settings.ts';

/** Minimal network settings slice — only the fields these tests read. */
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

/** Stand-in for the running Settings instance; assign to `current` to simulate a settings write. */
let current = netSlice({});
useNetworkSettings(() => current);

describe('applyNetworkLimits', () => {
	afterAll(() => {
		current = netSlice({});
		applyNetworkLimits(current);
	});

	it('pushes both transfer rates into the token buckets', () => {
		applyNetworkLimits(netSlice({ maxDownloadSpeed: 256, maxUploadSpeed: 128 }));
		expect(downloadLimiter.getLimit()).toBe(256 * 1024);
		expect(uploadLimiter.getLimit()).toBe(128 * 1024);
	});

	it('reads both size limits live from settings', () => {
		current = netSlice({ maxMessageSize: 64 * 1024 * 1024, maxChunkSize: 2 * 1024 * 1024 });
		expect(getMaxMessageSize()).toBe(64 * 1024 * 1024);
		expect(getMaxChunkSize()).toBe(2 * 1024 * 1024);
	});

	it('lifts a message limit that would be too small to carry one chunk', () => {
		// A chunk is delivered as a single message: a message limit at or below the chunk
		// limit would reject every chunk on arrival, so the chunk limit must win. Both are
		// read live now, so the rule lives on the read rather than on a write path.
		current = netSlice({ maxChunkSize: 8 * 1024 * 1024, maxMessageSize: 1024 });
		expect(getMaxChunkSize()).toBe(8 * 1024 * 1024);
		expect(getMaxMessageSize()).toBeGreaterThan(8 * 1024 * 1024);
	});

	it('leaves a message limit that already clears the chunk limit alone', () => {
		current = netSlice({ maxChunkSize: 2 * 1024 * 1024, maxMessageSize: 64 * 1024 * 1024 });
		expect(getMaxMessageSize()).toBe(64 * 1024 * 1024);
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
		// Unchanged rate (any network.* settings write re-pushes the rates) must not
		// reset the cursor — that would grant a throttled transfer a burst.
		applyNetworkLimits(net);
		expect((downloadLimiter as any).nextAllowedTime).toBe(cursor);
		// Changed rate resets the cursor to now so the new rate applies immediately.
		applyNetworkLimits(netSlice({ maxDownloadSpeed: 2 }));
		expect((downloadLimiter as any).nextAllowedTime).toBeLessThan(cursor);
	});
});

describe('limits read live from settings', () => {
	afterAll(() => {
		current = netSlice({});
	});

	it('picks up a message-size change with no push at all', () => {
		// The chunk limit is lowered alongside it: a message limit below the chunk limit
		// is raised back over it, so a small message size only stands on its own once the
		// chunk it has to carry fits inside.
		current = netSlice({ maxMessageSize: 4 * 1024 * 1024, maxChunkSize: 1024 * 1024 });
		expect(getMaxMessageSize()).toBe(4 * 1024 * 1024);
		current = netSlice({ maxMessageSize: 8 * 1024 * 1024, maxChunkSize: 1024 * 1024 });
		expect(getMaxMessageSize()).toBe(8 * 1024 * 1024);
	});

	it('falls back to the default when the stored message size is unusable', () => {
		current = netSlice({ maxMessageSize: 0 });
		expect(getMaxMessageSize()).toBe(DEFAULT_MAX_MESSAGE_SIZE);
	});

	it('applies a tightened download peer cap to an existing PeerManager', () => {
		const pm = new PeerManager();
		pm.setLishID('test-live-cap');
		const client = { close: async () => {} } as never;
		current = netSlice({ maxDownloadPeersPerLISH: 1 });
		expect(pm.hasCapacity()).toBe(true);
		expect(pm.tryAdd('peer-one', client, 'DIRECT')).toBe(true);
		// Cap reached — the manager refuses without anyone re-pushing the limit.
		expect(pm.hasCapacity()).toBe(false);
		expect(pm.tryAdd('peer-two', client, 'DIRECT')).toBe(false);
		// Raising the cap in settings alone lets the next peer in.
		current = netSlice({ maxDownloadPeersPerLISH: 2 });
		expect(pm.hasCapacity()).toBe(true);
		expect(pm.tryAdd('peer-two', client, 'DIRECT')).toBe(true);
	});

	it('treats a zero peer cap as unlimited', () => {
		const pm = new PeerManager();
		pm.setLishID('test-unlimited-cap');
		const client = { close: async () => {} } as never;
		current = netSlice({ maxDownloadPeersPerLISH: 0 });
		for (let i = 0; i < 50; i++) expect(pm.tryAdd(`peer-${i}`, client, 'DIRECT')).toBe(true);
		expect(pm.hasCapacity()).toBe(true);
	});
});
