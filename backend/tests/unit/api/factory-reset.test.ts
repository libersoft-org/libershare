import { describe, it, expect } from 'bun:test';
import { runFactoryReset } from '../../../src/api/factory-reset.ts';

describe('runFactoryReset', () => {
	it('runs EVERY selected category even when some fail — no category is skipped because a previous one threw', async () => {
		const ran: string[] = [];
		const res = await runFactoryReset({
			prepare: (): void => {},
			downloads: (): void => {
				ran.push('downloads');
			},
			networks: (): void => {
				ran.push('networks');
				throw new Error('networks boom');
			},
			identity: async (): Promise<void> => {
				ran.push('identity');
			},
			settings: (): void => {
				ran.push('settings');
				throw new Error('settings boom');
			},
		});
		// All four executed in order despite #2 and #4 throwing.
		expect(ran).toEqual(['downloads', 'networks', 'identity', 'settings']);
		// Overall failure, but per-category outcomes are precise.
		expect(res.success).toBe(false);
		expect(res.results).toEqual([
			{ category: 'downloads', ok: true },
			{ category: 'networks', ok: false, detail: 'networks boom' },
			{ category: 'identity', ok: true },
			{ category: 'settings', ok: false, detail: 'settings boom' },
		]);
	});

	it('only reports selected categories', async () => {
		const res = await runFactoryReset({ prepare: (): void => {}, downloads: (): void => {} });
		expect(res.results).toEqual([{ category: 'downloads', ok: true }]);
		expect(res.success).toBe(true);
	});

	/**
	 * `prepare` is a barrier, so its ABSENCE proves exactly as little as its failure. Treating
	 * a missing barrier as a passed one let this wipe the downloads, the networks, the
	 * peerstore and the identity out from under a running node and report success.
	 */
	it('a destructive category selected without any prepare is skipped, not run', async () => {
		const ran: string[] = [];
		const res = await runFactoryReset({
			downloads: (): void => {
				ran.push('downloads');
			},
			networks: (): void => {
				ran.push('networks');
			},
			peers: (): void => {
				ran.push('peers');
			},
			identity: (): void => {
				ran.push('identity');
			},
			settings: (): void => {
				ran.push('settings');
			},
			restart: (): void => {
				ran.push('restart');
			},
		});

		expect(ran).toEqual(['settings']);
		expect(res.success).toBe(false);
		expect(res.results.filter(r => !r.ok).map(r => r.category)).toEqual(['downloads', 'networks', 'peers', 'identity']);
		expect(res.phases[0]).toEqual({ phase: 'prepare', ok: false, detail: 'no prepare step was supplied, so nothing was stopped' });
		expect(res.phases[1]?.ok).toBe(false);
	});

	it('a settings-only reset needs no barrier and reports no prepare phase', async () => {
		const res = await runFactoryReset({ settings: (): void => {} });
		expect(res.success).toBe(true);
		expect(res.phases).toEqual([]);
		expect(res.results).toEqual([{ category: 'settings', ok: true }]);
	});

	it('lets a caller require preparation for settings that need a node restart', async () => {
		const ran: string[] = [];
		const res = await runFactoryReset({
			requiresPrepare: ['settings'],
			prepare: () => {
				throw new Error('stop failed');
			},
			settings: () => {
				ran.push('settings');
			},
		});

		expect(ran).toEqual([]);
		expect(res.results).toEqual([{ category: 'settings', ok: false, detail: 'skipped: transfers and the node could not be stopped safely' }]);
		expect(res.success).toBe(false);
	});

	it('runs prepare before the wipes and restart after, reporting both as phases', async () => {
		const order: string[] = [];
		const res = await runFactoryReset({
			prepare: (): void => {
				order.push('prepare');
			},
			downloads: (): void => {
				order.push('downloads');
			},
			restart: (): void => {
				order.push('restart');
			},
		});
		expect(order).toEqual(['prepare', 'downloads', 'restart']);
		expect(res.success).toBe(true);
		expect(res.phases).toEqual([
			{ phase: 'prepare', ok: true },
			{ phase: 'restart', ok: true },
		]);
	});

	it('a failed prepare skips every wipe that needs the node down, and the restart', async () => {
		const ran: string[] = [];
		const res = await runFactoryReset({
			prepare: (): void => {
				throw new Error('stopAllNetworks boom');
			},
			downloads: (): void => {
				ran.push('downloads');
			},
			networks: (): void => {
				ran.push('networks');
			},
			peers: (): void => {
				ran.push('peers');
			},
			identity: (): void => {
				ran.push('identity');
			},
			// The one wipe that touches neither the node nor the transfers.
			settings: (): void => {
				ran.push('settings');
			},
			restart: (): void => {
				ran.push('restart');
			},
		});

		expect(ran).toEqual(['settings']);
		expect(res.success).toBe(false);
		expect(res.results.filter(r => !r.ok).map(r => r.category)).toEqual(['downloads', 'networks', 'peers', 'identity']);
		expect(res.results.find(r => r.category === 'settings')).toEqual({ category: 'settings', ok: true });
		expect(res.phases[0]).toEqual({ phase: 'prepare', ok: false, detail: 'stopAllNetworks boom' });
		expect(res.phases[1]?.phase).toBe('restart');
		expect(res.phases[1]?.ok).toBe(false);
	});

	it('a failed restart forces success=false even when every category passed', async () => {
		const res = await runFactoryReset({
			prepare: (): void => {},
			downloads: (): void => {},
			restart: (): void => {
				throw new Error('restart boom');
			},
		});
		expect(res.results).toEqual([{ category: 'downloads', ok: true }]);
		expect(res.success).toBe(false);
		expect(res.phases).toEqual([
			{ phase: 'prepare', ok: true },
			{ phase: 'restart', ok: false, detail: 'restart boom' },
		]);
	});

	it('reports success=true when every selected category passes', async () => {
		const res = await runFactoryReset({ prepare: (): void => {}, settings: (): void => {}, identity: (): void => {}, downloads: (): void => {}, networks: (): void => {} });
		expect(res.success).toBe(true);
		expect(res.results.map(r => r.category)).toEqual(['downloads', 'networks', 'identity', 'settings']);
		expect(res.results.every(r => r.ok)).toBe(true);
	});
});
