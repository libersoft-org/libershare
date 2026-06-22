import { describe, it, expect } from 'bun:test';
import { runFactoryReset } from '../../../src/api/factory-reset.ts';

describe('runFactoryReset', () => {
	it('runs EVERY selected category even when some fail — no category is skipped because a previous one threw', async () => {
		const ran: string[] = [];
		const res = await runFactoryReset({
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
		const res = await runFactoryReset({ downloads: (): void => {} });
		expect(res.results).toEqual([{ category: 'downloads', ok: true }]);
		expect(res.success).toBe(true);
	});

	it('runs prepare before the wipes and restart after — both best-effort (their failure neither aborts nor flips success)', async () => {
		const order: string[] = [];
		const res = await runFactoryReset({
			prepare: (): void => {
				order.push('prepare');
				throw new Error('prep boom');
			},
			downloads: (): void => {
				order.push('downloads');
			},
			restart: (): void => {
				order.push('restart');
				throw new Error('restart boom');
			},
		});
		expect(order).toEqual(['prepare', 'downloads', 'restart']);
		// prepare/restart failures are infrastructure — not in results, don't fail the reset.
		expect(res.success).toBe(true);
		expect(res.results).toEqual([{ category: 'downloads', ok: true }]);
	});

	it('reports success=true when every selected category passes', async () => {
		const res = await runFactoryReset({ settings: (): void => {}, identity: (): void => {}, downloads: (): void => {}, networks: (): void => {} });
		expect(res.success).toBe(true);
		expect(res.results.map(r => r.category)).toEqual(['downloads', 'networks', 'identity', 'settings']);
		expect(res.results.every(r => r.ok)).toBe(true);
	});
});
