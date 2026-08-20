import { describe, it, expect } from 'bun:test';
import { getJoinedEnabledNetworkIDs, handleLeftDownloader, destroyAllDownloaders, initDownloadState, removeDownloadState, setActiveDownloadersRef, setNetworkSuspendedRef, TransferAdmissionGate, TransferTeardownError, type LeftDownloaderDeps } from '../../../src/api/transfer.ts';
import { runFactoryReset } from '../../../src/api/factory-reset.ts';

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

	it('drops a transient download only after its runtime cleanup succeeds', async () => {
		const { d } = deps();
		const a = fakeDownloader();
		d.activeDownloaders.set('lish-a', a.dl);

		await handleLeftDownloader(d, NET, 'lish-a', a.dl);

		expect(a.calls).toContain('destroy');
		expect(d.activeDownloaders.has('lish-a')).toBe(false);
	});

	it('keeps a transient downloader registered when cleanup fails', async () => {
		const { d } = deps();
		const downloader = {
			getNetworkIDs: () => [NET],
			getOriginalNetworkIDs: () => [NET],
			removeNetwork: () => {},
			destroy: () => Promise.reject(new Error('cleanup failed')),
		} as never;
		d.activeDownloaders.set('lish-a', downloader);

		await expect(handleLeftDownloader(d, NET, 'lish-a', downloader)).rejects.toThrow('cleanup failed');
		expect(d.activeDownloaders.get('lish-a')).toBe(downloader);
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

describe('download lifecycle state', () => {
	it('closes admission before waiting for an in-flight transfer operation', async () => {
		const gate = new TransferAdmissionGate();
		const leave = gate.tryEnter();
		expect(leave).not.toBeNull();

		let drained = false;
		const closing = gate.closeAndDrain().then(() => {
			drained = true;
		});
		await Promise.resolve();

		expect(gate.tryEnter()).toBeNull();
		expect(drained).toBe(false);

		leave!();
		await closing;
		expect(drained).toBe(true);
	});

	it('re-opens transfer admission only when explicitly resumed', async () => {
		const gate = new TransferAdmissionGate();
		await gate.closeAndDrain();
		expect(gate.tryEnter()).toBeNull();

		gate.open();
		const leave = gate.tryEnter();
		expect(leave).not.toBeNull();
		leave!();
	});

	it('removes a deleted LISH from suspended rejoin state', async () => {
		const suspended = new Map<string, Set<string>>([['lish-a', new Set([NET])]]);
		const active = new Map<string, any>();
		initDownloadState(new Set(['lish-a']), () => {});
		setActiveDownloadersRef(active);
		setNetworkSuspendedRef(suspended);

		await removeDownloadState('lish-a');

		expect(suspended.has('lish-a')).toBe(false);
	});

	it('tries every downloader and reports teardown failures to the reset barrier', async () => {
		const calls: string[] = [];
		const downloaders = new Map<string, any>([
			[
				'broken',
				{
					destroy: async () => {
						calls.push('broken');
						throw new Error('close failed');
					},
				},
			],
			[
				'healthy',
				{
					destroy: async () => {
						calls.push('healthy');
					},
				},
			],
		]);

		await expect(destroyAllDownloaders(downloaders)).rejects.toThrow('Failed to stop 1 active download');
		expect(calls).toEqual(['broken', 'healthy']);
		expect(downloaders.has('broken')).toBe(true);
		expect(downloaders.has('healthy')).toBe(false);
	});

	it('restores every downloader when teardown only partly succeeds', async () => {
		const restored: string[] = [];
		let downloadsWiped = false;
		const replacements = new Map<string, any>();
		const downloaders = new Map<string, any>([
			['a', { destroy: async () => {} }],
			['b', { destroy: async () => Promise.reject(new Error('close failed')) }],
		]);

		const result = await runFactoryReset({
			prepare: () =>
				destroyAllDownloaders(downloaders, async lishID => {
					restored.push(lishID);
					const replacement = { running: true, destroy: async () => {} };
					replacements.set(lishID, replacement);
					return replacement;
				}),
			downloads: () => {
				downloadsWiped = true;
			},
		});

		expect(result.success).toBe(false);
		expect(result.phases[0]?.detail).toContain('Failed to stop 1 active download');
		expect(downloadsWiped).toBe(false);
		expect(restored).toEqual(['a', 'b']);
		expect(downloaders.get('a')).toBe(replacements.get('a'));
		expect(downloaders.get('b')).toBe(replacements.get('b'));
		expect(downloaders.get('a')?.running).toBe(true);
		expect(downloaders.get('b')?.running).toBe(true);
	});

	it('marks a failed partial teardown unsafe when runtime restoration also fails', async () => {
		const downloaders = new Map<string, any>([
			['a', { destroy: async () => {} }],
			['b', { destroy: async () => Promise.reject(new Error('close failed')) }],
		]);

		let caught: unknown;
		try {
			await destroyAllDownloaders(downloaders, async lishID => {
				if (lishID === 'a') throw new Error('restore failed');
				return { destroy: async () => {} } as any;
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(TransferTeardownError);
		expect((caught as TransferTeardownError).runtimeRestored).toBe(false);
	});

	it('uses only networks that are both enabled and actually joined', () => {
		const networks = {
			getEnabled: () => [{ networkID: NET }, { networkID: OTHER }],
			isJoined: (networkID: string) => networkID === OTHER,
		};

		expect(getJoinedEnabledNetworkIDs(networks as never)).toEqual([OTHER]);
	});
});
