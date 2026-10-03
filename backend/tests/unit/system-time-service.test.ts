import type { TimesyncdOperations } from '../../src/native/linux/time-mutation-dropin.ts';
import { describe, expect, it } from 'bun:test';
import { applySystemTimeSettings, withSaveBudget, remainingSaveBudget, SAVE_BUDGET_MS, SEQUENCE_BUDGET_MS, FOLLOW_UP_BUDGET_MS, WRITE_TIMEOUT_MS, type WindowsModeState } from '../../src/system-time.ts';
import { applyTimesyncdFixture as applyTimesyncdDropIn } from '../helpers/system-time-timesyncd.ts';
import { SIGNATURE_TIMEOUT_MS, WINDOWS_NETWORK_HELPER_TIMEOUT_MS, WINDOWS_TIME_HELPER_TIMEOUT_MS } from '../../src/network-helper-client.ts';
import { WINDOWS_ELEVATION_HELPER_BUDGET_MS, WINDOWS_ELEVATION_PROMPT_ALLOWANCE_MS, WINDOWS_ELEVATION_WAIT_MS, WINDOWS_NETWORK_ELEVATION_WAIT_MS } from '../../src/network-helper-windows.ts';
import { SYSTEM_TIME_SAVE_TIMEOUT_MS } from '@shared';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SystemTimeStatus } from '@shared';

const status: SystemTimeStatus = {
	supported: true,
	nowMs: 0,
	timezone: 'UTC',
	utcOffsetMinutes: 0,
	timezoneSource: 'intl',
	ntpEnabled: false,
	ntpSynchronized: false,
	ntpServer: 'ntp.example.org',
	capabilities: { setClock: true, setTimezone: true, setNtpServer: true, setNtpEnabled: true },
};
const readStatus = async () => status;
const mode = async (): Promise<WindowsModeState> => ({ mode: 'none', start: 'on-demand', membership: 'standalone', service: 'stopped' });

/**
 * The budget has to survive the path a real save takes, not just `runAll` in isolation.
 *
 * Two ways it did not. The Windows branch of `setSystemNtpEnabled` wraps the runner to watch
 * the service transition, and that wrapper took only `(cmd, args)` - so the remaining budget
 * `runAll` had just computed was dropped and every command got a fresh 90 s. And a combined
 * save runs four operations, each of which used to start a sequence budget of its own, so
 * four times 150 s could outlast the screen's wait even with each sequence "in budget".
 *
 * Neither is visible from a `runAll` test: the first is lost in a caller's wrapper, the second
 * lives above the call. These go through the real entry points.
 */
describe('the budget along the real save path', () => {
	it('shares one budget across every operation of a combined save', async () => {
		const seen: Array<number | null> = [];
		const operation = async () => {
			seen.push(remainingSaveBudget());
			return { success: true, outcome: 'ok' as const, message: null };
		};
		const answer = await applySystemTimeSettings({ ntpEnabled: false, ntpServer: 'ntp.example.org', timezone: 'UTC', clock: { hours: 1, minutes: 2, seconds: 3 } }, { setNtpEnabled: operation, setNtpServer: operation, setTimezone: operation, setClock: operation }, readStatus, mode);
		expect(answer.success).toBe(true);
		// Four operations, each of which sees a budget, and all of them the SAME one: it only
		// ever shrinks. Four independent budgets would each start at the full figure.
		expect(seen.length).toBe(4);
		expect(seen.every(entry => entry !== null && entry <= SAVE_BUDGET_MS)).toBe(true);
		for (let index = 1; index < seen.length; index++) expect(seen[index]!).toBeLessThanOrEqual(seen[index - 1]!);
	});

	/** A save's budget is the ceiling for the sequences inside it, not the other way round. */
	it('never lets one sequence claim more than the save has left', async () => {
		await withSaveBudget(async () => {
			const remaining = remainingSaveBudget();
			expect(remaining).not.toBeNull();
			expect(remaining!).toBeLessThanOrEqual(SAVE_BUDGET_MS);
		});
		// Outside a save there is no deadline to inherit, and a directly used writer still gets
		// the sequence budget of its own.
		expect(remainingSaveBudget()).toBeNull();
		expect(SEQUENCE_BUDGET_MS).toBeLessThanOrEqual(SAVE_BUDGET_MS);
		expect(WRITE_TIMEOUT_MS).toBeLessThan(SEQUENCE_BUDGET_MS);
	});
});

/**
 * The end of the save, which is where the limits stop being arithmetic and start mattering.
 *
 * Two ways it did not hold. On Windows the launcher's wait starts only once
 * `ShellExecuteExW` has returned - and that call does not return while the consent prompt is
 * up - so the prompt's time was outside every figure, and the caller's 200 s could kill the
 * launcher while the launcher still believed it had 180 s left. Killing it matters: the
 * launcher is the only thing holding the elevated process's handle and terminating it.
 *
 * On Linux the drop-in write never consulted the budget at all. With synchronisation off there
 * is no daemon to restart, so that write and its verification ARE the whole change and used to
 * run however late the save already was.
 */
describe('finishing one save', () => {
	it('lets the launcher outlive the prompt and the work it waits for', () => {
		expect(WINDOWS_TIME_HELPER_TIMEOUT_MS).toBeGreaterThan(WINDOWS_ELEVATION_PROMPT_ALLOWANCE_MS + WINDOWS_ELEVATION_WAIT_MS);
	});

	/**
	 * Not just the arithmetic of the formula - the numbers have to mean what they say, or the
	 * previous version passes: with the prompt allowance at zero and the whole figure folded
	 * into the launcher's wait, `helper > prompt + wait` still holds while the prompt's time is
	 * once again unaccounted for. So the allowance is pinned to the bound the design actually
	 * relies on: Windows dismisses an unanswered elevation prompt itself, ~120 s by default.
	 */
	/**
	 * The network path is older than this work and must not be shortened by it. Its own steps
	 * are a read, the change and a read back - 14 + 40 + 14 s is inside every one of their
	 * limits and past a 60 s wait, so a single shared figure would terminate a change that was
	 * merely working.
	 */
	it('does not shorten the network operation to suit a time save', () => {
		expect(WINDOWS_NETWORK_ELEVATION_WAIT_MS).toBeGreaterThan(WINDOWS_ELEVATION_WAIT_MS);
		expect(WINDOWS_NETWORK_ELEVATION_WAIT_MS).toBeGreaterThanOrEqual(180_000);
		// And its caller outlives its launcher for the same reason the time one does.
		expect(WINDOWS_NETWORK_HELPER_TIMEOUT_MS).toBeGreaterThan(WINDOWS_ELEVATION_PROMPT_ALLOWANCE_MS + WINDOWS_NETWORK_ELEVATION_WAIT_MS);
	});

	it('budgets for the prompt Windows itself is timing', () => {
		expect(WINDOWS_ELEVATION_PROMPT_ALLOWANCE_MS).toBeGreaterThanOrEqual(120_000);
		// And the launcher's wait is for the WORK: measured at 9-12 s, so a figure near the
		// prompt's own would mean the prompt had been folded back into it.
		expect(WINDOWS_ELEVATION_WAIT_MS).toBeLessThan(WINDOWS_ELEVATION_PROMPT_ALLOWANCE_MS);
	});

	it('still leaves the screen waiting longer than the backend can spend', () => {
		const readBackAllowance = 30_000;
		const elevated = SIGNATURE_TIMEOUT_MS + WINDOWS_TIME_HELPER_TIMEOUT_MS + readBackAllowance;
		// A save that fails late pays for its own restore on top of its budget, and a save
		// that spends all of it still has to be able to read the host back - both come out of
		// the same follow-up allowance, and it has to stay inside the screen's wait.
		const local = SIGNATURE_TIMEOUT_MS + SAVE_BUDGET_MS + FOLLOW_UP_BUDGET_MS + readBackAllowance;
		expect(Math.max(elevated, local)).toBeLessThan(SYSTEM_TIME_SAVE_TIMEOUT_MS);
	});

	/**
	 * The launcher enforces its wait with `TerminateProcess`, so nothing the elevated helper
	 * may legitimately spend can reach it. It did: the wait was 60 s while one write command
	 * inside the helper was allowed 90 s and a whole save 200 s, so a slow but healthy step
	 * could be killed while every limit it knew about said it still had time - and a sequence
	 * that had already changed something came back with no account of what.
	 */
	it('holds the elevated helper inside the wait the launcher enforces', () => {
		expect(WINDOWS_ELEVATION_HELPER_BUDGET_MS).toBeLessThan(WINDOWS_ELEVATION_WAIT_MS);
		// The margin is real time, not a rounding: the helper has to notice, stop and report.
		expect(WINDOWS_ELEVATION_WAIT_MS - WINDOWS_ELEVATION_HELPER_BUDGET_MS).toBeGreaterThanOrEqual(10_000);
		// And nothing inside it can be handed more than it has: `runAll` gives a command the
		// smaller of the write limit and what is left, so this is the worst case a step gets.
		expect(Math.min(WRITE_TIMEOUT_MS, WINDOWS_ELEVATION_HELPER_BUDGET_MS)).toBeLessThan(WINDOWS_ELEVATION_WAIT_MS);
		// Pinning why the override exists at all: the unelevated default is LONGER than the
		// wait, so an elevated save left on it is the case that used to be terminated.
		expect(SAVE_BUDGET_MS).toBeGreaterThan(WINDOWS_ELEVATION_WAIT_MS);
	});

	it('refuses a linux drop-in write that starts past the deadline', async () => {
		const root = await mkdtemp(join(tmpdir(), 'lish-budget-'));
		try {
			const path = join(root, '90-libershare.conf');
			let ran = 0;
			const exec: TimesyncdOperations = {
				verify: async () => {
					ran++;
					return null;
				},
				restart: async () => {
					ran++;
					return { success: true, outcome: 'ok', message: null };
				},
			};
			// A budget that is already spent: the clock is read once when the budget opens and
			// again inside, so a clock that has advanced past it leaves nothing.
			let clock = 0;
			const answer = await withSaveBudget(
				async () => {
					clock = SAVE_BUDGET_MS + 1;
					return applyTimesyncdDropIn('ntp.example.org', false, path, exec);
				},
				() => clock
			);
			expect(answer.success).toBe(false);
			expect(answer.message).toContain('did not start within');
			// Nothing was written and nothing was run: this refusal is decided before the write.
			expect(ran).toBe(0);
			expect(answer.changed).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('hands the linux verification the remainder instead of a fresh limit', async () => {
		const root = await mkdtemp(join(tmpdir(), 'lish-budget-'));
		try {
			// mkdtemp leaves this at 0700, and on Linux the drop-in's reachability check reports
			// that before the verification this test is about ever runs.
			await chmod(root, 0o755);
			const path = join(root, '90-libershare.conf');
			const limits: Array<number | undefined> = [];
			const exec: TimesyncdOperations = {
				verify: async (_server, timeoutMs) => {
					limits.push(timeoutMs);
					return null;
				},
				restart: async () => ({ success: true, outcome: 'ok', message: null }),
			};
			let clock = 0;
			await withSaveBudget(
				async () => {
					clock = SAVE_BUDGET_MS - 5_000;
					return applyTimesyncdDropIn('ntp.example.org', false, path, exec);
				},
				() => clock
			);
			expect(limits.length).toBeGreaterThan(0);
			// 5 s left of the save, so the verification gets that and not the 90 s write limit.
			expect(limits[0]).toBe(5_000);
			expect(limits[0]).toBeLessThan(WRITE_TIMEOUT_MS);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	/** A writer used on its own still works: no budget means the ordinary write limit. */
	it('leaves a writer used outside a save on its own limit', async () => {
		const root = await mkdtemp(join(tmpdir(), 'lish-budget-'));
		try {
			await chmod(root, 0o755);
			const path = join(root, '90-libershare.conf');
			const limits: Array<number | undefined> = [];
			const exec: TimesyncdOperations = {
				verify: async (_server, timeoutMs) => {
					limits.push(timeoutMs);
					return null;
				},
				restart: async () => ({ success: true, outcome: 'ok', message: null }),
			};
			expect(remainingSaveBudget()).toBeNull();
			await applyTimesyncdDropIn('ntp.example.org', false, path, exec);
			expect(limits[0]).toBe(WRITE_TIMEOUT_MS);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
