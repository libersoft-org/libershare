import { describe, expect, it } from 'bun:test';
import { applySystemTimeSettings, buildSetClockCommands, buildSetNtpEnabledCommands, buildSetNtpServerCommands, buildSetTimezoneCommands, clockWriteRefusal, getSystemTimeStatus, listSystemTimezones, runAll, setSystemClock, setSystemNtpEnabled, setSystemNtpServer, setSystemTimezone, type CommandRunner, type SystemCommand, type SystemTimeWriters, type WindowsModeState, W32TM_ERROR_RE, withSystemTimeLock } from '../../src/system-time.ts';
import type { SystemTimeChanges, SystemTimeStatus } from '@shared';
import { W32TM_STATUS, fakeRunner } from '../helpers/system-time-fixtures.ts';

const AT = { year: 2026, month: 8, day: 14, hours: 23, minutes: 46, seconds: 28 };

/** A host where everything is available and synchronisation is off. */
function statusFixture(overrides: Partial<SystemTimeStatus> = {}): SystemTimeStatus {
	return {
		supported: true,
		nowMs: Date.UTC(2026, 7, 14, 21, 46, 28),
		timezone: 'Europe/Prague',
		utcOffsetMinutes: 120,
		timezoneSource: 'intl',
		ntpEnabled: false,
		ntpSynchronized: null,
		ntpServer: 'ntp1.example.org',
		capabilities: { setClock: true, setTimezone: true, setNtpServer: true, setNtpEnabled: true },
		...overrides,
	};
}

describe('buildSetClockCommands', () => {
	it('builds the linux argv with a full local timestamp', () => {
		expect(buildSetClockCommands('linux', AT)).toEqual([{ cmd: 'timedatectl', args: ['set-time', '2026-08-14 23:46:28'] }]);
	});

	it('sends only the time on macOS, leaving the date alone', () => {
		expect(buildSetClockCommands('darwin', AT)).toEqual([{ cmd: '/usr/sbin/systemsetup', args: ['-settime', '23:46:28'] }]);
	});

	it('builds the windows argv with an unambiguous ISO timestamp', () => {
		const [command] = buildSetClockCommands('win32', AT);
		expect(command?.cmd).toBe('powershell');
		expect(command?.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
		expect(command?.args[3]).toContain("Set-Date -Date '2026-08-14T23:46:28' -ErrorAction Stop");
	});

	it('zero-pads single-digit parts', () => {
		expect(buildSetClockCommands('linux', { year: 2026, month: 1, day: 2, hours: 3, minutes: 4, seconds: 5 })[0]?.args[1]).toBe('2026-01-02 03:04:05');
		expect(buildSetClockCommands('darwin', { ...AT, hours: 0, minutes: 0, seconds: 0 })[0]?.args[1]).toBe('00:00:00');
	});
});

describe('buildSetTimezoneCommands', () => {
	it('passes the IANA identifier straight through on linux and macOS', () => {
		expect(buildSetTimezoneCommands('linux', 'Europe/Prague', null)).toEqual([{ cmd: 'timedatectl', args: ['set-timezone', 'Europe/Prague'] }]);
		expect(buildSetTimezoneCommands('darwin', 'Europe/Prague', null)).toEqual([{ cmd: '/usr/sbin/systemsetup', args: ['-settimezone', 'Europe/Prague'] }]);
	});

	it('uses the converted identifier on windows', () => {
		expect(buildSetTimezoneCommands('win32', 'Europe/Prague', 'Central Europe Standard Time')).toEqual([{ cmd: 'tzutil', args: ['/s', 'Central Europe Standard Time'] }]);
	});

	it('yields no command on windows without a converted identifier', () => {
		expect(buildSetTimezoneCommands('win32', 'Europe/Prague', null)).toEqual([]);
	});
});

describe('buildSetNtpServerCommands', () => {
	it('only restarts the daemon on linux, where the address lives in the drop-in', () => {
		expect(buildSetNtpServerCommands('linux', 'ntp.example.org', true)).toEqual([{ cmd: 'systemctl', args: ['restart', 'systemd-timesyncd'] }]);
	});

	/**
	 * `systemctl restart` starts a stopped unit. Running it while the user has
	 * synchronisation switched off would re-arm the daemon and let it step the clock
	 * they are about to set by hand — the drop-in on disk is the whole change here.
	 */
	it('runs nothing on linux while synchronisation is off', () => {
		expect(buildSetNtpServerCommands('linux', 'ntp.example.org', false)).toEqual([]);
	});

	it('configures the peer and resyncs on windows while synchronisation is on', () => {
		expect(buildSetNtpServerCommands('win32', 'ntp.example.org', true)).toEqual([
			{ cmd: 'w32tm', args: ['/config', '/manualpeerlist:ntp.example.org,0x8', '/update'], failOnOutput: W32TM_ERROR_RE },
			{ cmd: 'w32tm', args: ['/resync'], failOnOutput: W32TM_ERROR_RE },
		]);
	});

	/**
	 * A resync is a request to the Windows Time service, so with the service stopped it
	 * can only fail — and the UI arrives here exactly that way, switching synchronisation
	 * off before writing a server. Configuring the peer list is the whole change then.
	 *
	 * `/update` goes with it: it notifies the RUNNING service that the configuration
	 * changed, so against a stopped one it is the same failed request — which is how a
	 * peer list that had in fact been written came back to the user as an error. The
	 * registry write happens without it, and the service reads it when it next starts.
	 */
	it('skips the resync and the update notification on windows while synchronisation is off', () => {
		expect(buildSetNtpServerCommands('win32', 'ntp.example.org', false)).toEqual([{ cmd: 'w32tm', args: ['/config', '/manualpeerlist:ntp.example.org,0x8'], failOnOutput: W32TM_ERROR_RE }]);
	});

	it('sets the single supported server on macOS', () => {
		expect(buildSetNtpServerCommands('darwin', 'ntp.example.org', true)).toEqual([{ cmd: '/usr/sbin/systemsetup', args: ['-setnetworktimeserver', 'ntp.example.org'] }]);
	});
});

describe('buildSetNtpEnabledCommands', () => {
	it('is a single switch on linux and macOS', () => {
		expect(buildSetNtpEnabledCommands('linux', true)).toEqual([{ cmd: 'timedatectl', args: ['set-ntp', 'true'] }]);
		expect(buildSetNtpEnabledCommands('linux', false)).toEqual([{ cmd: 'timedatectl', args: ['set-ntp', 'false'] }]);
		expect(buildSetNtpEnabledCommands('darwin', true)).toEqual([{ cmd: '/usr/sbin/systemsetup', args: ['-setusingnetworktime', 'on'] }]);
		expect(buildSetNtpEnabledCommands('darwin', false)).toEqual([{ cmd: '/usr/sbin/systemsetup', args: ['-setusingnetworktime', 'off'] }]);
	});

	/**
	 * The one mode where "switch synchronisation on" has to invent a time source: the
	 * host has none, so the /config step is what clears Type=NoSync. Without it the
	 * status read still reports synchronisation as off and the toggle looks like it did
	 * not stick.
	 */
	it('gives a host with no time source one, on windows', () => {
		expect(buildSetNtpEnabledCommands('win32', true, 'none')).toEqual([
			{ cmd: 'sc', args: ['config', 'w32time', 'start=', 'auto'] },
			{ cmd: 'sc', args: ['start', 'w32time'], benignCodes: [1056] },
			{ cmd: 'w32tm', args: ['/config', '/syncfromflags:manual', '/update'], failOnOutput: W32TM_ERROR_RE },
			{ cmd: 'w32tm', args: ['/resync'], failOnOutput: W32TM_ERROR_RE },
		]);
	});

	/**
	 * The destructive case. On a domain member Type is NT5DS and the machine takes its
	 * time from the Active Directory hierarchy; rewriting syncfromflags to manual
	 * detaches it from the forest's time and eventually breaks Kerberos. Switching
	 * synchronisation on must start the service and nothing else.
	 */
	it('never rewrites a time source it did not create, on windows', () => {
		for (const mode of ['domain-hierarchy', 'manual', 'all', 'managed', 'unknown'] as const) {
			const commands = buildSetNtpEnabledCommands('win32', true, mode);
			expect(commands.map(c => [c.cmd, ...c.args].join(' '))).toEqual(['sc config w32time start= auto', 'sc start w32time', 'w32tm /resync']);
			expect(commands.some(c => c.args.some(a => a.startsWith('/syncfromflags')))).toBe(false);
		}
	});

	/** A caller that could not determine the mode must get the harmless behaviour. */
	it('rewrites nothing when the mode was not given at all', () => {
		expect(buildSetNtpEnabledCommands('win32', true).some(c => c.args.includes('/syncfromflags:manual'))).toBe(false);
	});

	it('stops and disables the service on windows, whatever the source was', () => {
		for (const mode of ['none', 'manual', 'all'] as const) {
			expect(buildSetNtpEnabledCommands('win32', false, mode)).toEqual([
				{ cmd: 'sc', args: ['stop', 'w32time'], benignCodes: [1062] },
				{ cmd: 'sc', args: ['config', 'w32time', 'start=', 'disabled'] },
			]);
		}
	});

	it('stops the service before disabling it, so the switch takes effect at once', () => {
		expect(buildSetNtpEnabledCommands('win32', false).map(c => c.args[0])).toEqual(['stop', 'config']);
	});

	it('marks only the service run-state steps as tolerable, never the ones carrying the change', () => {
		// A host whose service is already in the requested run state must still get its
		// sync type and start mode written, so those steps may not sit behind an abort.
		const tolerated = (enabled: boolean): string[] =>
			buildSetNtpEnabledCommands('win32', enabled, 'none')
				.filter(c => c.benignCodes !== undefined)
				.map(c => [c.cmd, ...c.args].join(' '));
		expect(tolerated(true)).toEqual(['sc start w32time']);
		expect(tolerated(false)).toEqual(['sc stop w32time']);
	});
});

describe('setSystemNtpEnabled', () => {
	/** Run `body` with `process.platform` reporting the given host. */
	async function onPlatform(platform: string, body: () => Promise<void>): Promise<void> {
		const original = Object.getOwnPropertyDescriptor(process, 'platform');
		Object.defineProperty(process, 'platform', { value: platform, configurable: true });
		try {
			await body();
		} finally {
			if (original) Object.defineProperty(process, 'platform', original);
		}
	}

	const capable = async (): Promise<SystemTimeStatus> => statusFixture();

	/** A Windows host whose time source this application configured itself. */
	const ourWindowsHost = async (): Promise<WindowsModeState> => ({ mode: 'manual', start: 'automatic', membership: 'standalone' });

	it('reports success once every step has succeeded', async () => {
		await onPlatform('linux', async () => {
			const { exec, calls } = fakeRunner([]);
			expect(await setSystemNtpEnabled(true, capable, exec)).toEqual({ success: true, outcome: 'ok', message: null });
			expect(calls).toEqual(['timedatectl set-ntp true']);
		});
	});

	/**
	 * The masking this used to do. A re-read afterwards saw `ntpEnabled` matching the
	 * request and rewrote the whole thing to `ok`, so a step that genuinely refused —
	 * here the one that carries the change — was reported to the user as saved.
	 */
	it('does not turn a refused step into a success because the state happens to match', async () => {
		await onPlatform('linux', async () => {
			const { exec } = fakeRunner([{ kind: 'failed', code: 1, output: 'Failed to set ntp: something went wrong\n' }]);
			// The host reads back exactly as requested, which is what used to erase the error.
			const readsAsEnabled = async (): Promise<SystemTimeStatus> => statusFixture({ ntpEnabled: true });
			const r = await setSystemNtpEnabled(true, readsAsEnabled, exec);
			expect(r.success).toBe(false);
			expect(r.outcome).toBe('error');
			expect(r.message).toBe('Failed to set ntp: something went wrong');
		});
	});

	it('keeps a failed windows resync visible even though the service did start', async () => {
		await onPlatform('win32', async () => {
			// Keyed on the command rather than on a queue: the exact step list depends on
			// the mode this host's registry reports, and only the resync matters here.
			const calls: string[] = [];
			const exec: CommandRunner = async (cmd, args) => {
				const line = [cmd, ...args].join(' ');
				calls.push(line);
				return line === 'w32tm /resync' ? { kind: 'ok', output: 'The computer did not resync because no time data was available. (0x800705B4)\r\n' } : { kind: 'ok', output: '' };
			};
			const r = await setSystemNtpEnabled(true, capable, exec, ourWindowsHost, async () => true);
			expect(r.success).toBe(false);
			expect(r.outcome).toBe('error');
			expect(calls).toContain('w32tm /resync');
			expect(calls[0]).toBe('sc config w32time start= auto');
		});
	});

	/** Still tolerated, but at the source: `sc` exits 1056 when the service is already up. */
	it('still carries on past a service that was already in the requested state', async () => {
		await onPlatform('win32', async () => {
			const { exec } = fakeRunner([
				{ kind: 'ok', output: '' },
				{ kind: 'failed', code: 1056, output: '[SC] StartService FAILED 1056:\r\n' },
			]);
			expect((await setSystemNtpEnabled(true, capable, exec, ourWindowsHost, async () => true)).success).toBe(true);
		});
	});

	it('refuses without running anything when the host does not allow the change', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const managed = async (): Promise<SystemTimeStatus> => statusFixture({ capabilities: { setClock: true, setTimezone: true, setNtpServer: false, setNtpEnabled: false } });
			expect((await setSystemNtpEnabled(true, managed, exec)).outcome).toBe('unsupported');
			expect(calls).toEqual([]);
		});
	});

	/**
	 * The capability came from a status read before the write started. A host joined to a
	 * domain in between must not have W32Time stopped and disabled on the strength of it,
	 * so ownership is decided again on a read taken immediately before the commands run.
	 */
	it('refuses when the host stopped being ours between the status read and the write', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const joinedADomain = async (): Promise<WindowsModeState> => ({ mode: 'domain-hierarchy', start: 'automatic', membership: 'domain' });
			expect((await setSystemNtpEnabled(false, capable, exec, joinedADomain)).outcome).toBe('unsupported');
			expect(calls).toEqual([]);
		});
	});

	it('refuses when a group policy arrived between the status read and the write', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const policyApplied = async (): Promise<WindowsModeState> => ({ mode: 'managed', start: 'automatic', membership: 'standalone' });
			expect((await setSystemNtpEnabled(true, capable, exec, policyApplied)).outcome).toBe('unsupported');
			expect(calls).toEqual([]);
		});
	});

	/**
	 * The destructive one. A forest-root PDC synchronising against an external source is
	 * configured as local `Type=NTP` with no policy branch, which reads as `manual` — and
	 * `manual` used to be enough to run `sc stop w32time` and `sc config w32time start=
	 * disabled` on it, stopping the time service the whole forest depends on and keeping it
	 * off across reboots. Not one command may reach a host that belongs to a domain.
	 */
	it('runs nothing on a domain member whose source reads as a plain peer list', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const forestRootPdc = async (): Promise<WindowsModeState> => ({ mode: 'manual', start: 'automatic', membership: 'domain' });
			expect((await setSystemNtpEnabled(false, capable, exec, forestRootPdc)).outcome).toBe('unsupported');
			expect(calls).toEqual([]);
		});
	});

	/** An unreadable join state may be that same PDC, so it is refused the same way. */
	it('runs nothing when the domain membership could not be established', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const cannotTell = async (): Promise<WindowsModeState> => ({ mode: 'manual', start: 'automatic', membership: 'unknown' });
			expect((await setSystemNtpEnabled(false, capable, exec, cannotTell)).outcome).toBe('unsupported');
			expect(calls).toEqual([]);
		});
	});
});

describe('setSystemNtpServer', () => {
	/** Run `body` with `process.platform` reporting the given host. */
	async function onPlatform(platform: string, body: () => Promise<void>): Promise<void> {
		const original = Object.getOwnPropertyDescriptor(process, 'platform');
		Object.defineProperty(process, 'platform', { value: platform, configurable: true });
		try {
			await body();
		} finally {
			if (original) Object.defineProperty(process, 'platform', original);
		}
	}

	const capable = async (): Promise<SystemTimeStatus> => statusFixture();

	it('does not enable synchronization or resync when configuring a running NoSync service', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const mode = async (): Promise<WindowsModeState> => ({ mode: 'none', start: 'automatic', membership: 'standalone', running: true });
			expect((await setSystemNtpServer('ntp.example.org', capable, mode, exec)).success).toBe(true);
			expect(calls).toEqual(['w32tm /config /manualpeerlist:ntp.example.org,0x8 /update']);
		});
	});
	it('does not notify or resync a stopped trigger-start service just because policy enables it', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const mode = async (): Promise<WindowsModeState> => ({ mode: 'manual', start: 'on-demand', membership: 'standalone', running: false });
			expect((await setSystemNtpServer('ntp.example.org', capable, mode, exec)).success).toBe(true);
			expect(calls).toEqual(['w32tm /config /manualpeerlist:ntp.example.org,0x8']);
		});
	});
	it('refuses a server write when the service running state is unknown', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const mode = async (): Promise<WindowsModeState> => ({ mode: 'manual', start: 'on-demand', membership: 'standalone', running: null });
			expect((await setSystemNtpServer('ntp.example.org', capable, mode, exec)).success).toBe(false);
			expect(calls).toEqual([]);
		});
	});
	it('writes the peer list on a host whose time source is ours', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const ours = async (): Promise<WindowsModeState> => ({ mode: 'manual', start: 'disabled', membership: 'standalone', running: false });
			expect((await setSystemNtpServer('ntp.example.org', capable, ours, exec)).success).toBe(true);
			// The SCM reports stopped, so the peer update does not notify or start the service.
			expect(calls).toEqual(['w32tm /config /manualpeerlist:ntp.example.org,0x8']);
		});
	});

	/**
	 * This check did not exist at all: the write went off the capability in the status and
	 * never looked at the mode, so a domain member could have its peer list and sync flags
	 * overwritten — which is what detaches it from the forest's time.
	 */
	it('refuses a host whose time source stopped being ours before the write', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const joinedADomain = async (): Promise<WindowsModeState> => ({ mode: 'domain-hierarchy', start: 'automatic', membership: 'domain' });
			expect((await setSystemNtpServer('ntp.example.org', capable, joinedADomain, exec)).outcome).toBe('unsupported');
			expect(calls).toEqual([]);
		});
	});

	it('refuses a host that became policy-managed before the write', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const policyApplied = async (): Promise<WindowsModeState> => ({ mode: 'managed', start: 'automatic', membership: 'standalone' });
			expect((await setSystemNtpServer('ntp.example.org', capable, policyApplied, exec)).outcome).toBe('unsupported');
			expect(calls).toEqual([]);
		});
	});

	/**
	 * The same forest-root PDC. Its peer list is what the whole domain's time derives from,
	 * and `manual` alone used to be enough to overwrite it here too.
	 */
	it('refuses a domain member whose source reads as a plain peer list', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const forestRootPdc = async (): Promise<WindowsModeState> => ({ mode: 'manual', start: 'automatic', membership: 'domain' });
			expect((await setSystemNtpServer('ntp.example.org', capable, forestRootPdc, exec)).outcome).toBe('unsupported');
			expect(calls).toEqual([]);
		});
	});
});

describe('runAll', () => {
	const DISABLE: SystemCommand[] = buildSetNtpEnabledCommands('win32', false);

	it('succeeds only once every command has exited 0', async () => {
		const { exec, calls } = fakeRunner([
			{ kind: 'ok', output: '' },
			{ kind: 'ok', output: '[SC] ChangeServiceConfig SUCCESS\r\n' },
		]);
		expect(await runAll('win32', DISABLE, exec)).toEqual({ success: true, outcome: 'ok', message: null });
		expect(calls).toEqual(['sc stop w32time', 'sc config w32time start= disabled']);
	});

	it('stops at the first failure and reports it as a denial with its first output line', async () => {
		const { exec, calls } = fakeRunner([{ kind: 'failed', code: 5, output: '[SC] OpenService FAILED 5:\r\n\r\nAccess is denied.\r\n' }]);
		expect(await runAll('win32', DISABLE, exec)).toEqual({ success: false, outcome: 'permission-denied', message: '[SC] OpenService FAILED 5:', changed: false, stateMayHaveChanged: true, steps: [{ command: 'sc stop w32time', ok: false }] });
		expect(calls).toEqual(['sc stop w32time']);
	});

	it('carries on past a step that only failed because it had nothing to do', async () => {
		// `sc start` exits 1056 when the service is already up. Aborting there would skip
		// the /config step that clears a NoSync sync type, and enabling would report a
		// failure on a host it could have fixed.
		const { exec, calls } = fakeRunner([
			{ kind: 'ok', output: '' },
			{ kind: 'failed', code: 1056, output: '[SC] StartService FAILED 1056:\r\n\r\nAn instance of the service is already running.\r\n' },
		]);
		expect(await runAll('win32', buildSetNtpEnabledCommands('win32', true, 'none'), exec)).toEqual({ success: true, outcome: 'ok', message: null });
		expect(calls).toEqual(['sc config w32time start= auto', 'sc start w32time', 'w32tm /config /syncfromflags:manual /update', 'w32tm /resync']);
	});

	/**
	 * The failure that used to look like "nothing happened": the service is already down
	 * and its start mode is already changed by the time the next step refuses. A caller
	 * that shows the old state after this is showing something the host no longer is.
	 */
	it('reports what a sequence already applied before it stopped', async () => {
		const { exec } = fakeRunner([
			{ kind: 'ok', output: '' },
			{ kind: 'failed', code: 5, output: '[SC] OpenService FAILED 5:\r\n' },
		]);
		const r = await runAll('win32', DISABLE, exec);
		expect(r.success).toBe(false);
		expect(r.changed).toBe(true);
		expect(r.stateMayHaveChanged).toBe(true);
		expect(r.steps).toEqual([
			{ command: 'sc stop w32time', ok: true },
			{ command: 'sc config w32time start= disabled', ok: false },
		]);
	});

	/** A step tolerated by its benign code still counts as run, so it is reported as such. */
	it('counts a tolerated step among the ones that ran', async () => {
		const { exec } = fakeRunner([
			{ kind: 'failed', code: 1062, output: '[SC] ControlService FAILED 1062:\r\n' },
			{ kind: 'failed', code: 5, output: '[SC] OpenService FAILED 5:\r\n' },
		]);
		const r = await runAll('win32', DISABLE, exec);
		expect(r.changed).toBe(true);
		expect(r.steps?.map(step => step.ok)).toEqual([true, false]);
	});

	it('still reports a real refusal on a step whose benign code did not match', async () => {
		const { exec, calls } = fakeRunner([{ kind: 'failed', code: 5, output: '[SC] OpenService FAILED 5:\r\n' }]);
		expect((await runAll('win32', DISABLE, exec)).outcome).toBe('permission-denied');
		expect(calls).toEqual(['sc stop w32time']);
	});

	it('reports a missing binary as unsupported, naming it', async () => {
		const { exec } = fakeRunner([{ kind: 'missing' }]);
		// A binary that does not exist never ran, so nothing on the host can have moved.
		expect(await runAll('linux', buildSetNtpEnabledCommands('linux', true), exec)).toEqual({ success: false, outcome: 'unsupported', message: 'timedatectl is not installed', changed: false, stateMayHaveChanged: false, steps: [{ command: 'timedatectl set-ntp true', ok: false }] });
	});

	it('reports a wedged command as a transient error, never as an absence', async () => {
		const { exec } = fakeRunner([{ kind: 'timeout' }]);
		// A killed command DID start, so it may have applied part of its change.
		expect(await runAll('linux', buildSetNtpEnabledCommands('linux', true), exec)).toEqual({ success: false, outcome: 'error', message: 'timedatectl timed out', changed: false, stateMayHaveChanged: true, steps: [{ command: 'timedatectl set-ntp true', ok: false }] });
	});

	it('falls back to the exit code when the command said nothing', async () => {
		const { exec } = fakeRunner([{ kind: 'failed', code: 9009, output: '   \n' }]);
		expect(await runAll('win32', [{ cmd: 'w32tm', args: ['/resync'] }], exec)).toEqual({ success: false, outcome: 'error', message: 'w32tm exited with 9009', changed: false, stateMayHaveChanged: true, steps: [{ command: 'w32tm /resync', ok: false }] });
	});

	/**
	 * The case an exit-code check alone gets wrong. `w32tm` prints the HRESULT of a
	 * refusal and returns zero anyway, so without reading the output a refused `/resync`
	 * is reported to the user as a saved setting.
	 */
	it('fails a w32tm step that printed an HRESULT and still exited 0', async () => {
		const { exec, calls } = fakeRunner([
			{ kind: 'ok', output: '' },
			{ kind: 'ok', output: 'The computer did not resync because no time data was available.\r\n0x80070005\r\n' },
		]);
		const r = await runAll('win32', buildSetNtpServerCommands('win32', 'ntp.example.org', true), exec);
		expect(r.success).toBe(false);
		expect(r.outcome).toBe('permission-denied');
		expect(r.message).toBe('The computer did not resync because no time data was available.');
		expect(calls).toHaveLength(2);
	});

	it('reads the HRESULT rather than the localized sentence around it', async () => {
		const { exec } = fakeRunner([{ kind: 'ok', output: 'Pocitac se nesynchronizoval, protoze nebyla k dispozici zadna data. (0x800705B4)\r\n' }]);
		const r = await runAll('win32', [{ cmd: 'w32tm', args: ['/resync'], failOnOutput: W32TM_ERROR_RE }], exec);
		expect(r.success).toBe(false);
		expect(r.outcome).toBe('error');
	});

	it('does not mistake the identifiers a healthy w32tm prints for a failure', async () => {
		// ReferenceId and the poll interval carry hex and digits but no 0x8 HRESULT.
		const { exec } = fakeRunner([{ kind: 'ok', output: W32TM_STATUS }]);
		expect((await runAll('win32', [{ cmd: 'w32tm', args: ['/resync'], failOnOutput: W32TM_ERROR_RE }], exec)).success).toBe(true);
	});

	it('leaves a command without an output check judged on its exit code alone', async () => {
		const { exec } = fakeRunner([{ kind: 'ok', output: 'mentions 0x80070005 but is not checked' }]);
		expect((await runAll('win32', [{ cmd: 'sc', args: ['query', 'w32time'] }], exec)).success).toBe(true);
	});

	it('runs nothing and reports unsupported when the platform yields no command', async () => {
		const { exec, calls } = fakeRunner([]);
		expect(await runAll('win32', buildSetTimezoneCommands('win32', 'Europe/Prague', null), exec)).toEqual({ success: false, outcome: 'unsupported', message: 'no command available for this platform' });
		expect(calls).toEqual([]);
	});
});

describe('the write lock covers every writer', () => {
	/**
	 * Start `write` while another system-time write holds the lock and report whether it
	 * waited. A writer that never takes the lock settles straight away.
	 */
	async function waitsForTheLock(write: () => Promise<unknown>): Promise<boolean> {
		let release = (): void => {};
		const held = new Promise<void>(resolve => {
			release = resolve;
		});
		let settled = false;
		const holder = withSystemTimeLock(() => held);
		const pending = write().then(() => {
			settled = true;
		});
		await new Promise(resolve => setTimeout(resolve, 20));
		const waited = !settled;
		release();
		await holder;
		await pending;
		return waited;
	}

	/**
	 * The clock decides whether it may be written at all from a status read a moment
	 * earlier, so a `setNtpEnabled(true)` landing between that read and the command turns
	 * "synchronisation is off, this is the user's to set" into a clock the daemon steps
	 * back seconds later. It was the one writer whose read-then-decide-then-write was not
	 * a critical section, while the lock's own comment said it was.
	 */
	it('holds a clock set behind another write', async () => {
		const syncing = async (): Promise<SystemTimeStatus> => statusFixture({ ntpEnabled: true });
		const { exec } = fakeRunner([]);
		expect(await waitsForTheLock(() => setSystemClock(1, 2, 3, syncing, exec))).toBe(true);
	});

	/** The zone is what a clock reading is interpreted against, so it belongs in the same queue. */
	it('holds a timezone set behind another write', async () => {
		const refused: CommandRunner = async () => ({ kind: 'failed', code: 1, output: 'refused' });
		expect(await waitsForTheLock(() => setSystemTimezone(listSystemTimezones()[0]!, refused))).toBe(true);
	});

	/** Both still run: waiting for the lock must not mean waiting forever. */
	it('lets a clock set through once the lock is free', async () => {
		const syncing = async (): Promise<SystemTimeStatus> => statusFixture({ ntpEnabled: true });
		const { exec, calls } = fakeRunner([]);
		expect((await setSystemClock(1, 2, 3, syncing, exec)).outcome).toBe('auto-sync-enabled');
		expect(calls).toEqual([]);
	});
});

describe('applySystemTimeSettings', () => {
	const okResult = { success: true, outcome: 'ok' as const, message: null };

	function writers(calls: string[], overrides: Partial<SystemTimeWriters> = {}): SystemTimeWriters {
		return {
			setNtpEnabled: async enabled => {
				calls.push(`ntp:${enabled}`);
				return okResult;
			},
			setNtpServer: async server => {
				calls.push(`server:${server}`);
				return okResult;
			},
			setTimezone: async timezone => {
				calls.push(`zone:${timezone}`);
				return okResult;
			},
			setClock: async clock => {
				calls.push(`clock:${clock.hours}:${clock.minutes}:${clock.seconds}`);
				return okResult;
			},
			...overrides,
		};
	}

	const invalidChanges: Array<[string, SystemTimeChanges]> = [
		['NTP server', { ntpEnabled: false, ntpServer: 'bad host' }],
		['clock', { ntpEnabled: false, clock: { hours: 25, minutes: 0, seconds: 0 } }],
		['timezone', { ntpEnabled: false, timezone: 'Mars/Olympus_Mons' }],
	];
	it.each(invalidChanges)('validates the whole save before disabling NTP for an invalid %s', async (_field, changes) => {
		const calls: string[] = [];
		const result = await applySystemTimeSettings(changes, writers(calls));
		expect(result).toMatchObject({ success: false, outcome: 'invalid-input' });
		expect(result.changed).not.toBe(true);
		expect(result.stateMayHaveChanged).not.toBe(true);
		expect(calls).toEqual([]);
	});

	it('applies one save in dependency order under one operation', async () => {
		const calls: string[] = [];
		const result = await applySystemTimeSettings({ ntpEnabled: false, ntpServer: 'ntp.example.org', timezone: 'Europe/Prague', clock: { hours: 1, minutes: 2, seconds: 3 } }, writers(calls));
		expect(result).toEqual(okResult);
		expect(calls).toEqual(['ntp:false', 'server:ntp.example.org', 'zone:Europe/Prague', 'clock:1:2:3']);
	});

	it('enables NTP only after every other requested change', async () => {
		const calls: string[] = [];
		await applySystemTimeSettings({ ntpEnabled: true, ntpServer: 'ntp.example.org', timezone: 'Europe/Prague' }, writers(calls));
		expect(calls).toEqual(['server:ntp.example.org', 'zone:Europe/Prague', 'ntp:true']);
	});

	it('stops on failure and reports that an earlier step changed the host', async () => {
		const calls: string[] = [];
		const denied = { success: false, outcome: 'permission-denied' as const, message: 'denied' };
		const result = await applySystemTimeSettings(
			{ ntpEnabled: false, timezone: 'Europe/Prague', clock: { hours: 1, minutes: 2, seconds: 3 } },
			writers(calls, {
				setTimezone: async timezone => {
					calls.push(`zone:${timezone}`);
					return denied;
				},
			})
		);
		expect(result).toEqual({ ...denied, changed: true, stateMayHaveChanged: true });
		expect(calls).toEqual(['ntp:false', 'zone:Europe/Prague']);
	});

	it('does not interleave two clients saves', async () => {
		const calls: string[] = [];
		let releaseFirst!: () => void;
		let firstStarted!: () => void;
		const started = new Promise<void>(resolve => (firstStarted = resolve));
		const release = new Promise<void>(resolve => (releaseFirst = resolve));
		const firstWriters = writers(calls, {
			setNtpEnabled: async enabled => {
				calls.push(`first-ntp:${enabled}`);
				firstStarted();
				await release;
				return okResult;
			},
		});
		const secondWriters = writers(calls, {
			setNtpEnabled: async enabled => {
				calls.push(`second-ntp:${enabled}`);
				return okResult;
			},
		});

		const first = applySystemTimeSettings({ ntpEnabled: false, timezone: 'Europe/Prague' }, firstWriters);
		await started;
		const second = applySystemTimeSettings({ ntpEnabled: false, timezone: 'UTC' }, secondWriters);
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toEqual(['first-ntp:false']);
		releaseFirst();
		await Promise.all([first, second]);
		expect(calls).toEqual(['first-ntp:false', 'zone:Europe/Prague', 'second-ntp:false', 'zone:UTC']);
	});
});

describe('clockWriteRefusal', () => {
	it('lets the write through when nothing else owns the clock', () => {
		expect(clockWriteRefusal(statusFixture())).toBeNull();
	});

	it('refuses while automatic synchronisation is enabled', () => {
		expect(clockWriteRefusal(statusFixture({ ntpEnabled: true }))).toEqual({ success: false, outcome: 'auto-sync-enabled', message: 'automatic time synchronisation is enabled' });
	});

	it('refuses on a host with no facility for writing the clock', () => {
		const refusal = clockWriteRefusal(statusFixture({ capabilities: { setClock: false, setTimezone: false, setNtpServer: false, setNtpEnabled: false } }));
		expect(refusal?.outcome).toBe('unsupported');
		expect(refusal?.success).toBe(false);
	});

	/**
	 * The dangerous direction. A read that failed says nothing about whether a daemon
	 * owns the clock, and accepting the write would let it be stepped back seconds later
	 * — looking to the user as though the clock had silently refused to change.
	 */
	it('refuses while the sync state could not be read at all', () => {
		const refusal = clockWriteRefusal(statusFixture({ ntpEnabled: null }));
		expect(refusal?.success).toBe(false);
		expect(refusal?.outcome).toBe('error');
		expect(refusal?.message).toContain('cannot determine');
	});

	it('refuses a synchronised host even though it has already reached a peer', () => {
		// The refusal is about ownership of the clock, not about the sync having worked.
		expect(clockWriteRefusal(statusFixture({ ntpEnabled: true, ntpSynchronized: true }))?.outcome).toBe('auto-sync-enabled');
		expect(clockWriteRefusal(statusFixture({ ntpEnabled: true, ntpSynchronized: false }))?.outcome).toBe('auto-sync-enabled');
	});

	it('names the missing facility before the sync conflict', () => {
		expect(clockWriteRefusal(statusFixture({ ntpEnabled: true, capabilities: { setClock: false, setTimezone: true, setNtpServer: true, setNtpEnabled: true } }))?.outcome).toBe('unsupported');
	});
});

// These reach the real setters, but every case is rejected by validation or by the
// platform gate before any child process or file write can happen.
describe('setters reject bad input before touching the system', () => {
	it('rejects an out-of-range or non-integer clock', async () => {
		expect(await setSystemClock(24, 0, 0)).toEqual({ success: false, outcome: 'invalid-input', message: 'hours must be between 0 and 23' });
		expect((await setSystemClock(-1, 0, 0)).outcome).toBe('invalid-input');
		expect((await setSystemClock(12, 60, 0)).outcome).toBe('invalid-input');
		expect((await setSystemClock(12, 0, 60)).outcome).toBe('invalid-input');
		expect((await setSystemClock(12.5, 0, 0)).outcome).toBe('invalid-input');
	});

	it('rejects a timezone the host does not list', async () => {
		expect(await setSystemTimezone('Mars/Olympus_Mons')).toEqual({ success: false, outcome: 'invalid-input', message: 'unknown timezone: Mars/Olympus_Mons' });
		expect((await setSystemTimezone('')).outcome).toBe('invalid-input');
		expect((await setSystemTimezone('Europe/Prague; reboot')).outcome).toBe('invalid-input');
		expect((await setSystemTimezone('../../../etc/localtime')).outcome).toBe('invalid-input');
	});

	it('rejects an NTP server carrying whitespace or shell metacharacters', async () => {
		for (const bad of ['ntp.example.org; reboot', 'ntp.example.org two.example.org', 'ntp.example.org && echo x', '$(id)', 'ntp.example.org\nNTP=evil.example.org', '']) {
			const r = await setSystemNtpServer(bad);
			expect(r.success).toBe(false);
			expect(r.outcome).toBe('invalid-input');
		}
	});
});

describe('on a platform with no time backend', () => {
	/** Run `body` with `process.platform` reporting a host we have no backend for. */
	async function onUnsupportedPlatform(body: () => Promise<void>): Promise<void> {
		const original = Object.getOwnPropertyDescriptor(process, 'platform');
		Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
		try {
			await body();
		} finally {
			if (original) Object.defineProperty(process, 'platform', original);
		}
	}

	it('reports a status with no capabilities and never claims support', async () => {
		await onUnsupportedPlatform(async () => {
			const status = await getSystemTimeStatus();
			expect(status.supported).toBe(false);
			expect(status.capabilities).toEqual({ setClock: false, setTimezone: false, setNtpServer: false, setNtpEnabled: false });
			// Unknown, not "off": nothing was read, so nothing may be claimed.
			expect(status.ntpEnabled).toBeNull();
			expect(status.ntpServer).toBeNull();
			// The clock and the zone come from the process itself, so they stay real.
			expect(status.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
			expect(status.nowMs).toBeGreaterThan(0);
		});
	});

	it('refuses every write, naming the platform', async () => {
		await onUnsupportedPlatform(async () => {
			const results = [await setSystemClock(12, 0, 0), await setSystemTimezone(listSystemTimezones()[0]!), await setSystemNtpServer('ntp.example.org'), await setSystemNtpEnabled(true)];
			for (const r of results) {
				expect(r.success).toBe(false);
				expect(r.outcome).toBe('unsupported');
				expect(r.message).toContain('freebsd');
			}
		});
	});
});

it('keeps an authoritative fixed OS offset instead of recomputing it from an IANA zone', async () => {
	const status = await getSystemTimeStatus(async () => ({ timezone: 'Europe/Prague', utcOffsetMinutes: 345, timezoneOffsetMode: 'fixed' as const, ntpEnabled: false, ntpSynchronized: null, ntpServer: null, capabilities: { setClock: true, setTimezone: true, setNtpEnabled: true, setNtpServer: true } }));
	expect(status.utcOffsetMinutes).toBe(345);
	expect(status.timezoneOffsetMode).toBe('fixed');
});

describe.if(process.platform === 'win32')('Windows timezone preference preservation', () => {
	it('keeps disabled daylight saving when selecting a timezone', async () => {
		const original = process.env['TZ'];
		try {
			const { exec, calls } = fakeRunner([]);
			const result = await setSystemTimezone('Europe/Prague', exec, () => ({ windowsId: 'Central Europe Standard Time', utcOffsetMinutes: 60, daylightDisabled: true }));
			expect(result.success).toBe(true);
			expect(calls).toHaveLength(1);
			expect(calls[0]).toEndWith('_dstoff');
		} finally {
			if (original === undefined) delete process.env['TZ'];
			else process.env['TZ'] = original;
		}
	});
	it('does not change a timezone when its current daylight preference cannot be read', async () => {
		const { exec, calls } = fakeRunner([]);
		const result = await setSystemTimezone('Europe/Prague', exec, () => null);
		expect(result.success).toBe(false);
		expect(calls).toEqual([]);
	});
	it('uses the authoritative OS offset for the date of a manual clock write', async () => {
		const { exec, calls } = fakeRunner([]);
		const status = statusFixture({ nowMs: Date.UTC(2026, 6, 1, 22, 30), utcOffsetMinutes: 60, timezoneOffsetMode: 'fixed' });
		const result = await setSystemClock(12, 0, 0, async () => status, exec);
		expect(result.success).toBe(true);
		expect(calls[0]).toContain('2026-07-01T12:00:00');
	});
});
