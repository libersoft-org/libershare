import { expect, it } from 'bun:test';
import { runElevatedSystemTime } from '../../src/network-helper-client.ts';
import { applySystemTimeSettingsWithElevation } from '../../src/system-time-elevation.ts';
import { withSaveBudget } from '../../src/system-time-common.ts';
import { withSystemTimeLock } from '../../src/system-time.ts';

/**
 * A time save that needs the helper, whose trust check outlives the save. The save must end
 * with its own budget, release the time lock for the next save, and never go on to launch the
 * helper when the check finally answers.
 */
it('ends the save, frees the lock and does not act on a late trust answer', async () => {
	let answered = false;
	let settledBeforeAnswer = false;
	const lateTrust = (): Promise<boolean> =>
		new Promise(resolve =>
			setTimeout(() => {
				answered = true;
				resolve(true);
			}, 400)
		);
	const elevate = (changes: Parameters<typeof runElevatedSystemTime>[0]) => runElevatedSystemTime(changes, 'linux', () => 1000, lateTrust);
	const unreachable = async (): Promise<never> => {
		throw new Error('the local attempt must not run on a host that elevates up front');
	};
	const result = await withSaveBudget(() => applySystemTimeSettingsWithElevation({ ntpEnabled: false }, elevate, unreachable, 'darwin', () => 501), undefined, 100);
	settledBeforeAnswer = !answered;
	expect(result.outcome).toBe('error');
	expect(result.changed).toBeUndefined();
	expect(result.stateMayHaveChanged).toBeUndefined();
	expect(settledBeforeAnswer).toBe(true);

	// The next save gets the lock at once instead of queueing behind the abandoned check.
	const started = performance.now();
	await withSystemTimeLock(async () => undefined);
	expect(performance.now() - started).toBeLessThan(100);
	await Bun.sleep(500);
	expect(answered).toBe(true);
});
