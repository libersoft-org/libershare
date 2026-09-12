import { describe, expect, it } from 'bun:test';
import { applySystemTimeSettings, applyTimesyncdDropIn, setSystemNtpEnabled, setSystemNtpServer, waitForWindowsTimeService, withSystemTimeLock, withSaveBudget, remainingSaveBudget, SAVE_BUDGET_MS, SEQUENCE_BUDGET_MS, WRITE_TIMEOUT_MS, type CommandRunner, type WindowsModeState } from '../../src/system-time.ts';
import { SIGNATURE_TIMEOUT_MS, WINDOWS_TIME_HELPER_TIMEOUT_MS } from '../../src/network-helper-client.ts';
import { WINDOWS_ELEVATION_PROMPT_ALLOWANCE_MS, WINDOWS_ELEVATION_WAIT_MS } from '../../src/network-helper-windows.ts';
import { SYSTEM_TIME_SAVE_TIMEOUT_MS } from '@shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SystemTimeStatus } from '@shared';

/** The blank line `sc.exe` puts between its `[SC] ... FAILED <code>:` line and the localized reason. */
const CRLF2 = '\r\n\r\n';

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

async function windows(body: () => Promise<void>): Promise<void> {
	const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
	Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
	try {
		await body();
	} finally {
		Object.defineProperty(process, 'platform', descriptor);
	}
}

describe('Windows Time service transitions', () => {
	it.each([true, false])('waits for the confirmed service state before proceeding: enabled=%s', async enabled => {
		await windows(async () => {
			const calls: string[] = [];
			const exec: CommandRunner = async (cmd, args) => {
				calls.push([cmd, ...args].join(' '));
				return { kind: 'ok', output: '' };
			};
			const wait = async (target: boolean) => {
				expect(target).toBe(enabled);
				let now = 0,
					reads = 0;
				const reached = await waitForWindowsTimeService(
					target,
					() => {
						expect(calls[calls.length - 1]).toBe(`sc ${enabled ? 'start' : 'stop'} w32time`);
						return ++reads < 4 ? null : enabled;
					},
					async ms => {
						now += ms;
					},
					() => now
				);
				expect(now).toBe(750);
				calls.push('confirmed');
				return reached;
			};
			expect((await setSystemNtpEnabled(enabled, readStatus, exec, mode, wait)).success).toBe(true);
			expect(calls).toEqual(enabled ? ['sc config w32time start= auto', 'sc start w32time', 'confirmed', 'w32tm /config /syncfromflags:manual /update', 'w32tm /resync'] : ['sc stop w32time', 'confirmed', 'sc config w32time start= disabled']);
		});
	});
	it.each([true, false])('bounds an unconfirmed transition to 15 seconds: enabled=%s', async enabled => {
		let now = 0,
			reads = 0;
		expect(
			await waitForWindowsTimeService(
				enabled,
				() => {
					reads++;
					return null;
				},
				async ms => {
					now += ms;
				},
				() => now
			)
		).toBe(false);
		expect(now).toBe(15000);
		expect(reads).toBe(61);
	});
	it.each([true, false])('still confirms the state after an already-running/stopped response: enabled=%s', async enabled => {
		await windows(async () => {
			let waits = 0;
			// What `sc` actually answers with: its own small exit code, and the Win32 reason in
			// the output. Measured on Windows 11 - exit 32 with "[SC] StartService FAILED 1056:"
			// and exit 38 with "[SC] ControlService FAILED 1062:".
			const exec: CommandRunner = async (cmd, args) => (cmd === 'sc' && args[0] === (enabled ? 'start' : 'stop') ? { kind: 'failed', code: enabled ? 32 : 38, output: enabled ? '[SC] StartService FAILED 1056:' + CRLF2 + 'An instance of the service is already running.' : '[SC] ControlService FAILED 1062:' + CRLF2 + 'The service has not been started.' } : { kind: 'ok', output: '' });
			expect(
				(
					await setSystemNtpEnabled(enabled, readStatus, exec, mode, async () => {
						waits++;
						return true;
					})
				).success
			).toBe(true);
			expect(waits).toBe(1);
		});
	});
	it('does not wait or proceed after a refused stop request', async () => {
		await windows(async () => {
			let waits = 0,
				commands = 0;
			const result = await setSystemNtpEnabled(
				false,
				readStatus,
				async () => {
					commands++;
					return { kind: 'failed', code: 5, output: 'Access denied' };
				},
				mode,
				async () => {
					waits++;
					return true;
				}
			);
			expect(result.outcome).toBe('permission-denied');
			expect(commands).toBe(1);
			expect(waits).toBe(0);
		});
	});
	it.each([true, false])('reports an incomplete transition and skips all later commands: enabled=%s', async enabled => {
		await windows(async () => {
			const calls: string[] = [];
			const exec: CommandRunner = async (cmd, args) => {
				calls.push([cmd, ...args].join(' '));
				return { kind: 'ok', output: '' };
			};
			const result = await setSystemNtpEnabled(enabled, readStatus, exec, mode, async () => false);
			expect(result).toMatchObject({ success: false, outcome: 'error', stateMayHaveChanged: true });
			expect(result.message).toContain('Windows Time');
			expect(calls).toEqual(enabled ? ['sc config w32time start= auto', 'sc start w32time'] : ['sc stop w32time']);
		});
	});
	it('holds the write lock through stopping and the subsequent server edit', async () => {
		await windows(async () => {
			const calls: string[] = [];
			let release!: (value: boolean) => void;
			let entered!: () => void;
			const waiting = new Promise<void>(resolve => {
				entered = resolve;
			});
			const transition = new Promise<boolean>(resolve => {
				release = resolve;
			});
			const exec: CommandRunner = async (cmd, args) => {
				calls.push([cmd, ...args].join(' '));
				return { kind: 'ok', output: '' };
			};
			const save = applySystemTimeSettings(
				{ ntpEnabled: false, ntpServer: 'new.example.org' },
				{
					setNtpEnabled: enabled =>
						setSystemNtpEnabled(enabled, readStatus, exec, mode, async () => {
							entered();
							return transition;
						}),
					setNtpServer: server => setSystemNtpServer(server, readStatus, mode, exec),
					setClock: async () => {
						throw new Error('Unexpected clock write');
					},
					setTimezone: async () => {
						throw new Error('Unexpected timezone write');
					},
				}
			);
			// Also resolves if an implementation incorrectly skips the service wait.
			await Promise.race([waiting, save]);
			const second = withSystemTimeLock(async () => {
				calls.push('next writer');
			});
			try {
				expect(calls).toEqual(['sc stop w32time']);
			} finally {
				release(true);
				await save;
				await second;
			}
			expect(calls).toEqual(['sc stop w32time', 'sc config w32time start= disabled', 'w32tm /config /manualpeerlist:new.example.org,0x8 /update', 'next writer']);
		});
	});
});

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
	it('passes the remaining limit through the Windows service wrapper', async () => {
		await windows(async () => {
			const limits: Array<number | undefined> = [];
			const exec: CommandRunner = async (_cmd, _args, timeoutMs) => {
				limits.push(timeoutMs);
				return { kind: 'ok', output: '' };
			};
			await setSystemNtpEnabled(true, readStatus, exec, mode, async () => true);
			expect(limits.length).toBeGreaterThan(1);
			// Every command, including the `sc` one the wrapper intercepts, carries a limit.
			expect(limits.every(limit => typeof limit === 'number' && limit > 0)).toBe(true);
		});
	});

	it('shares one budget across every operation of a combined save', async () => {
		const seen: Array<number | null> = [];
		const operation = async () => {
			seen.push(remainingSaveBudget());
			return { success: true, outcome: 'ok' as const, message: null };
		};
		const answer = await applySystemTimeSettings({ ntpEnabled: false, ntpServer: 'ntp.example.org', timezone: 'UTC', clock: { hours: 1, minutes: 2, seconds: 3 } }, { setNtpEnabled: operation, setNtpServer: operation, setTimezone: operation, setClock: operation }, readStatus);
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
	it('budgets for the prompt Windows itself is timing', () => {
		expect(WINDOWS_ELEVATION_PROMPT_ALLOWANCE_MS).toBeGreaterThanOrEqual(120_000);
		// And the launcher's wait is for the WORK: measured at 9-12 s, so a figure near the
		// prompt's own would mean the prompt had been folded back into it.
		expect(WINDOWS_ELEVATION_WAIT_MS).toBeLessThan(WINDOWS_ELEVATION_PROMPT_ALLOWANCE_MS);
	});

	it('still leaves the screen waiting longer than the backend can spend', () => {
		const readBackAllowance = 30_000;
		const elevated = SIGNATURE_TIMEOUT_MS + WINDOWS_TIME_HELPER_TIMEOUT_MS + readBackAllowance;
		const local = SIGNATURE_TIMEOUT_MS + SAVE_BUDGET_MS + readBackAllowance;
		expect(Math.max(elevated, local)).toBeLessThan(SYSTEM_TIME_SAVE_TIMEOUT_MS);
	});

	it('refuses a linux drop-in write that starts past the deadline', async () => {
		const root = await mkdtemp(join(tmpdir(), 'lish-budget-'));
		try {
			const path = join(root, '90-libershare.conf');
			let ran = 0;
			const exec: CommandRunner = async () => {
				ran++;
				return { kind: 'ok', output: '' };
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
			const path = join(root, '90-libershare.conf');
			const limits: Array<number | undefined> = [];
			const exec: CommandRunner = async (cmd, _args, timeoutMs) => {
				limits.push(timeoutMs);
				// The verification reads the effective configuration; answer with the server it asked
				// for so the save reaches its end rather than stopping on a mismatch.
				if (cmd === 'systemd-analyze') return { kind: 'ok', output: '[Time]\nNTP=ntp.example.org\n' };
				return { kind: 'ok', output: '' };
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
			const path = join(root, '90-libershare.conf');
			const limits: Array<number | undefined> = [];
			const exec: CommandRunner = async (cmd, _args, timeoutMs) => {
				limits.push(timeoutMs);
				if (cmd === 'systemd-analyze') return { kind: 'ok', output: '[Time]\nNTP=ntp.example.org\n' };
				return { kind: 'ok', output: '' };
			};
			expect(remainingSaveBudget()).toBeNull();
			await applyTimesyncdDropIn('ntp.example.org', false, path, exec);
			expect(limits[0]).toBe(WRITE_TIMEOUT_MS);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
