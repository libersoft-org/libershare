import { describe, expect, it } from 'bun:test';
import { HelperVerificationTimeoutError } from '../../src/network-helper-integrity.ts';
import { runElevatedSystemTime } from '../../src/network-helper-client.ts';
import { withSaveBudget } from '../../src/system-time-common.ts';

/**
 * A time save whose helper could not be verified in time stops before anything elevated is
 * started: it answers `error` with neither change flag, so the screen does not claim the host
 * may have changed. A trust check that simply outlives the save ends only that save's wait.
 */

const changes = { ntpEnabled: false } as const;
const timesOut = async (): Promise<boolean> => {
	throw new HelperVerificationTimeoutError();
};
const never = (): Promise<boolean> => new Promise<boolean>(() => {});

describe('elevated time save before launch', () => {
	for (const platform of ['linux', 'darwin', 'win32'] as const) {
		it(`answers error without change flags when verification times out on ${platform}`, async () => {
			const result = await runElevatedSystemTime(changes, platform, () => 1000, timesOut);
			expect(result.outcome).toBe('error');
			expect(result.changed).toBeUndefined();
			expect(result.stateMayHaveChanged).toBeUndefined();
		});
	}

	it('ends a save whose budget runs out while the shared check is still running', async () => {
		let clock = 0;
		const started = performance.now();
		const result = await withSaveBudget(
			() => runElevatedSystemTime(changes, 'linux', () => 1000, never),
			() => clock,
			50
		);
		clock = 1_000;
		expect(result.outcome).toBe('error');
		expect(result.stateMayHaveChanged).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it('refuses to launch with no budget left after the check passed', async () => {
		let clock = 0;
		const passesLate = async (): Promise<boolean> => {
			clock = 1_000;
			return true;
		};
		const result = await withSaveBudget(
			() => runElevatedSystemTime(changes, 'linux', () => 1000, passesLate),
			() => clock,
			50
		);
		expect(result).toMatchObject({ outcome: 'error' });
		expect(result.stateMayHaveChanged).toBeUndefined();
	});

	it('keeps an untrusted helper as permission-denied', async () => {
		expect(
			(
				await runElevatedSystemTime(
					changes,
					'linux',
					() => 1000,
					async () => false
				)
			).outcome
		).toBe('permission-denied');
	});
});

describe('windows trust budget', () => {
	it('counts reading the files into the budget instead of starting it afterwards', async () => {
		const { verifyWindowsHelper } = await import('../../src/network-helper-client.ts');
		// The first reading starts the budget; every later one is past it, as after a stuck stat.
		let calls = 0;
		const clock = (): number => (calls++ === 0 ? 0 : 31_000);
		await expect(verifyWindowsHelper('C:/no-such-dir/lish-network-helper.exe', clock)).rejects.toBeInstanceOf(HelperVerificationTimeoutError);
	});
});
