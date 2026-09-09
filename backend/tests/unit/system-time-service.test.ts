import { describe, expect, it } from 'bun:test';
import { applySystemTimeSettings, setSystemNtpEnabled, setSystemNtpServer, waitForWindowsTimeService, withSystemTimeLock, type CommandRunner, type WindowsModeState } from '../../src/system-time.ts';
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
const mode = async (): Promise<WindowsModeState> => ({ mode: 'none', start: 'on-demand', membership: 'standalone', running: false });

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
			const exec: CommandRunner = async (cmd, args) => (cmd === 'sc' && args[0] === (enabled ? 'start' : 'stop') ? { kind: 'failed', code: enabled ? 1056 : 1062, output: 'Service already in requested state' } : { kind: 'ok', output: '' });
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
			expect(calls).toEqual(['sc stop w32time', 'sc config w32time start= disabled', 'w32tm /config /manualpeerlist:new.example.org,0x8', 'next writer']);
		});
	});
});
