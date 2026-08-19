import { describe, it, expect } from 'bun:test';
import { handleLeftDownloader, type LeftDownloaderDeps } from '../../../src/api/transfer.ts';

const NET = 'net-left';
const OTHER = 'net-other';

/** A downloader stub that records what was done to it, and can be told to blow up. */
function fakeDownloader(opts: { networks: string[]; throwOn?: 'getNetworkIDs' | 'removeNetwork' } = { networks: [NET] }) {
	const calls: string[] = [];
	return {
		calls,
		dl: {
			getNetworkIDs: () => {
				if (opts.throwOn === 'getNetworkIDs') throw new Error('downloader is broken');
				return opts.networks;
			},
			getOriginalNetworkIDs: () => opts.networks,
			removeNetwork: () => {
				if (opts.throwOn === 'removeNetwork') throw new Error('downloader is broken');
				calls.push('removeNetwork');
			},
			disable: () => calls.push('disable'),
			destroy: async () => {
				calls.push('destroy');
			},
		} as never,
	};
}

function deps(overrides: Partial<LeftDownloaderDeps> = {}) {
	const broadcasts: string[] = [];
	const base: LeftDownloaderDeps = {
		networks: { isJoined: () => false },
		downloadEnabledLishs: new Set<string>(),
		networkSuspended: new Map<string, Set<string>>(),
		activeDownloaders: new Map(),
		recovery: { stop: () => {} },
		broadcast: (event: string) => broadcasts.push(event),
		...overrides,
	};
	return { d: base, broadcasts };
}

/**
 * Leaving a lishnet is announced to every download at once, and the announcement cannot be
 * replayed: by the time it arrives the topic is already unsubscribed. So one download that
 * throws must not cost the others their cleanup — they would go on broadcasting WANTs on a
 * topic this node has left, with nothing left to come back and stop them.
 */
describe('leaving a lishnet — one broken download does not take the rest with it', () => {
	it('stops a download whose last lishnet was the one we left', () => {
		const { d, broadcasts } = deps();
		d.downloadEnabledLishs.add('lish-a');
		const a = fakeDownloader();

		handleLeftDownloader(d, NET, 'lish-a', a.dl);

		expect(a.calls).toEqual(['removeNetwork', 'disable']);
		expect(d.downloadEnabledLishs.has('lish-a')).toBe(false);
		expect(d.networkSuspended.get('lish-a')).toEqual(new Set([NET]));
		expect(broadcasts).toEqual(['transfer.download:disabled']);
	});

	it('keeps a download running when another of its lishnets is still joined', () => {
		const { d, broadcasts } = deps({ networks: { isJoined: (id: string) => id === OTHER } });
		const a = fakeDownloader({ networks: [NET, OTHER] });

		handleLeftDownloader(d, NET, 'lish-a', a.dl);

		expect(a.calls).toEqual(['removeNetwork']); // dropped the left net, nothing else
		expect(broadcasts).toEqual([]);
	});

	it('leaves a download of a different lishnet completely alone', () => {
		const { d, broadcasts } = deps();
		const a = fakeDownloader({ networks: [OTHER] });

		handleLeftDownloader(d, NET, 'lish-a', a.dl);

		expect(a.calls).toEqual([]);
		expect(broadcasts).toEqual([]);
	});

	it('drops a transient download instead of keeping a disabled one around', () => {
		const { d } = deps();
		const a = fakeDownloader();
		d.activeDownloaders.set('lish-a', a.dl);

		handleLeftDownloader(d, NET, 'lish-a', a.dl);

		expect(a.calls).toContain('destroy');
		expect(d.activeDownloaders.has('lish-a')).toBe(false);
	});

	it('cleans up the second download even when the first one throws', () => {
		// The isolation itself. The observer catches per download; this is the behaviour
		// that catch exists to protect.
		const { d, broadcasts } = deps();
		d.downloadEnabledLishs.add('lish-a');
		d.downloadEnabledLishs.add('lish-b');
		const broken = fakeDownloader({ networks: [NET], throwOn: 'getNetworkIDs' });
		const healthy = fakeDownloader();

		let firstThrew = false;
		for (const [lishID, dl] of [
			['lish-a', broken.dl],
			['lish-b', healthy.dl],
		] as const) {
			try {
				handleLeftDownloader(d, NET, lishID, dl);
			} catch {
				firstThrew = true;
			}
		}

		expect(firstThrew).toBe(true);
		expect(healthy.calls).toEqual(['removeNetwork', 'disable']);
		expect(d.downloadEnabledLishs.has('lish-b')).toBe(false);
		expect(broadcasts).toEqual(['transfer.download:disabled']);
	});
});
