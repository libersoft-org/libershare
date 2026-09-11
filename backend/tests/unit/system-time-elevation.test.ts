import { describe, expect, it } from 'bun:test';
import { SYSTEM_TIME_OUTCOMES, type SystemTimeChanges, type SystemTimeResult } from '@shared';
import { decodeNetworkHelperRequest, encodeNetworkHelperRequest, executeNetworkHelperRequest, networkHelperExitCode, parseNetworkHelperResponse } from '../../src/network-helper-protocol.ts';
import { isSystemTimeChanges, isSystemTimeResult, parseSystemTimeExitCode, systemTimeExitCode, SYSTEM_TIME_EXIT_BASE } from '../../src/system-time-helper.ts';
import { isValidNtpServer } from '../../src/system-time-common.ts';
import { parseNtpConfServer, parseZoneinfoLink, readMacLocaltimeZone, readMacNtpConfServer, readMacStatus } from '../../src/system-time-macos.ts';
import { ianaToWindowsTimezoneId, rememberWindowsZone, windowsToIanaTimezone } from '../../src/system-time-windows.ts';
import { applySystemTimeSettings, sameHostZone, setSystemNtpEnabled } from '../../src/system-time.ts';
import type { SystemTimeStatus } from '@shared';
import { applySystemTimeSettingsWithElevation, localAttemptIsPointless, needsElevation, requiresPrivilegesUpFront } from '../../src/system-time-elevation.ts';
import { windowsSystemTimeExit } from '../../src/network-helper-client.ts';
import { NETWORK_HELPER_EXIT } from '../../src/network-helper-protocol.ts';
import { WINDOWS_LAUNCHER_EXIT } from '../../src/network-helper-windows.ts';

/** Run `body` with `process.env.TZ` restored afterwards, whatever it does to it. */
async function withTemporaryTZ(body: () => Promise<void>): Promise<void> {
	const before = process.env['TZ'];
	try {
		await body();
	} finally {
		if (before === undefined) delete process.env['TZ'];
		else process.env['TZ'] = before;
	}
}

/** A status where every capability is available and synchronisation is off. */
function statusFixture(overrides: Partial<SystemTimeStatus> = {}): SystemTimeStatus {
	return {
		supported: true,
		nowMs: Date.UTC(2026, 8, 11, 12, 0, 0),
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

/** Run `body` with `process.platform` reporting Windows. */
async function onWindows(body: () => Promise<void>): Promise<void> {
	const original = Object.getOwnPropertyDescriptor(process, 'platform');
	Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
	try {
		await body();
	} finally {
		if (original) Object.defineProperty(process, 'platform', original);
	}
}

const CHANGES: SystemTimeChanges = { ntpEnabled: false, clock: { hours: 12, minutes: 30, seconds: 0 }, expectedTimezone: 'Europe/Prague', expectedOffsetMinutes: 120 };
const refused: SystemTimeResult = { success: false, outcome: 'permission-denied', message: 'A required privilege is not held by the client', stateMayHaveChanged: true };

describe('isSystemTimeChanges', () => {
	it('accepts the change set the backend builds', () => {
		expect(isSystemTimeChanges(CHANGES)).toBe(true);
		expect(isSystemTimeChanges({ timezone: 'Europe/London' })).toBe(true);
	});

	it('refuses anything else crossing the privilege boundary', () => {
		expect(isSystemTimeChanges({})).toBe(false);
		expect(isSystemTimeChanges(null)).toBe(false);
		expect(isSystemTimeChanges([])).toBe(false);
		expect(isSystemTimeChanges({ timezone: 'Europe/London', extra: 1 })).toBe(false);
		expect(isSystemTimeChanges({ ntpEnabled: 'true' })).toBe(false);
		expect(isSystemTimeChanges({ ntpServer: 'a\nb' })).toBe(false);
		// The NTP address has the bound the ordinary validator enforces, not the 64 of the
		// other values: a 79-character name is syntactically valid and used to be refused here.
		expect(isSystemTimeChanges({ ntpServer: 'ntp.' + 'a'.repeat(63) + '.example.org' })).toBe(true);
		// The explicit-root form: the ordinary validator strips the dot before measuring, so
		// 253 characters PLUS a dot is the longest address it accepts, and this boundary has to
		// accept exactly the same ones. Built from real labels, because a single 253-character
		// label is invalid on its own - a label may be 63.
		const longest = ['a'.repeat(63), 'a'.repeat(63), 'a'.repeat(63), 'a'.repeat(61)].join('.');
		expect(longest.length).toBe(253);
		expect(isValidNtpServer(longest)).toBe(true);
		expect(isSystemTimeChanges({ ntpServer: longest })).toBe(true);
		expect(isValidNtpServer(longest + '.')).toBe(true);
		expect(isSystemTimeChanges({ ntpServer: longest + '.' })).toBe(true);
		// One character further out, both sides refuse.
		const tooLong = ['a'.repeat(63), 'a'.repeat(63), 'a'.repeat(63), 'a'.repeat(62)].join('.') + '.';
		expect(isValidNtpServer(tooLong)).toBe(false);
		expect(isSystemTimeChanges({ ntpServer: tooLong })).toBe(false);
		expect(isSystemTimeChanges({ timezone: 'a'.repeat(65) })).toBe(false);
		expect(isSystemTimeChanges({ clock: { hours: 1, minutes: 2 } })).toBe(false);
		expect(isSystemTimeChanges({ clock: { hours: 1.5, minutes: 2, seconds: 3 } })).toBe(false);
		expect(isSystemTimeChanges({ expectedOffsetMinutes: '120' })).toBe(false);
	});

	/** The privileged side owns the range rules; this is a shape gate, so a value it will reject still crosses. */
	it('leaves range checks to the privileged side', () => {
		expect(isSystemTimeChanges({ clock: { hours: 99, minutes: 0, seconds: 0 } })).toBe(true);
	});
});

describe('the exit code an elevated Windows helper answers with', () => {
	/**
	 * The only channel out of an elevated process on Windows: it owns a console the
	 * unelevated caller never reads. The outcome has to survive it, because the screen
	 * renders a different message for each one.
	 */
	it('round-trips every outcome with both change flags', () => {
		for (const outcome of SYSTEM_TIME_OUTCOMES) {
			for (const changed of [false, true]) {
				for (const attempted of [false, true]) {
					const result: SystemTimeResult = { success: outcome === 'ok', outcome, message: 'ignored on this path', ...(changed ? { changed: true } : {}), ...(attempted ? { stateMayHaveChanged: true } : {}) };
					const decoded = parseSystemTimeExitCode(systemTimeExitCode(result));
					expect(decoded?.outcome).toBe(outcome);
					expect(decoded?.success).toBe(outcome === 'ok');
					expect(decoded?.changed === true).toBe(changed);
					expect(decoded?.stateMayHaveChanged === true).toBe(attempted);
				}
			}
		}
	});

	/** The launcher passes the helper's code through unchanged, so the two numberings must not overlap. */
	it('never collides with a network or launcher code', () => {
		const reserved = [...Object.values(NETWORK_HELPER_EXIT), ...Object.values(WINDOWS_LAUNCHER_EXIT), 0, 1];
		for (const outcome of SYSTEM_TIME_OUTCOMES) {
			const code = systemTimeExitCode({ success: false, outcome, message: null, changed: true, stateMayHaveChanged: true });
			expect(reserved).not.toContain(code);
			expect(parseSystemTimeExitCode(code)).not.toBeNull();
		}
		for (const code of reserved) expect(parseSystemTimeExitCode(code)).toBeNull();
	});

	it('reads a code below the base as carrying no outcome', () => {
		expect(parseSystemTimeExitCode(SYSTEM_TIME_EXIT_BASE - 1)).toBeNull();
		expect(parseSystemTimeExitCode(SYSTEM_TIME_EXIT_BASE + SYSTEM_TIME_OUTCOMES.length * 4)).toBeNull();
		expect(parseSystemTimeExitCode(-1)).toBeNull();
	});

	it('maps the launcher codes to something the user can act on', () => {
		expect(windowsSystemTimeExit(WINDOWS_LAUNCHER_EXIT.cancelled).message).toContain('cancelled');
		expect(windowsSystemTimeExit(WINDOWS_LAUNCHER_EXIT.cancelled).outcome).toBe('permission-denied');
		expect(windowsSystemTimeExit(WINDOWS_LAUNCHER_EXIT.untrusted).outcome).toBe('permission-denied');
		expect(windowsSystemTimeExit(WINDOWS_LAUNCHER_EXIT.timeout).outcome).toBe('error');
		expect(windowsSystemTimeExit(0, true).message).toContain('timed out');
		expect(windowsSystemTimeExit(undefined).outcome).toBe('error');
	});

	it('carries an ok through as a success', () => {
		const applied = windowsSystemTimeExit(systemTimeExitCode({ success: true, outcome: 'ok', message: null }));
		expect(applied.success).toBe(true);
		expect(applied.outcome).toBe('ok');
	});
});

describe('the time request across the helper protocol', () => {
	it('survives encode and decode unchanged', () => {
		const request = decodeNetworkHelperRequest(encodeNetworkHelperRequest({ version: 1, operation: 'applySystemTime', changes: CHANGES }));
		expect(request.operation).toBe('applySystemTime');
		expect(request.operation === 'applySystemTime' && request.changes).toEqual(CHANGES);
	});

	it('refuses a request whose changes are not the shape the backend builds', () => {
		const encoded = Buffer.from(JSON.stringify({ version: 1, operation: 'applySystemTime', changes: { timezone: 'Europe/London', rogue: true } })).toString('base64url');
		expect(() => decodeNetworkHelperRequest(encoded)).toThrow('invalid network helper time changes');
	});

	it('refuses a request carrying network fields alongside the time operation', () => {
		const encoded = Buffer.from(JSON.stringify({ version: 1, operation: 'applySystemTime', changes: CHANGES, interfaceID: 'eth0' })).toString('base64url');
		expect(() => decodeNetworkHelperRequest(encoded)).toThrow('invalid network helper request');
	});

	it('hands the change set to the privileged apply and answers with the host result', async () => {
		const request = decodeNetworkHelperRequest(encodeNetworkHelperRequest({ version: 1, operation: 'applySystemTime', changes: CHANGES }));
		const seen: SystemTimeChanges[] = [];
		const response = await executeNetworkHelperRequest(
			request,
			async () => null,
			async changes => {
				seen.push(changes);
				return refused;
			}
		);
		expect(seen).toEqual([CHANGES]);
		expect(response).toEqual({ ok: true, time: refused });
		// A refused write is an ordinary answer, so the exit code carries its outcome.
		expect(parseSystemTimeExitCode(networkHelperExitCode(response))?.outcome).toBe('permission-denied');
	});

	it('refuses the time operation on a helper build that cannot run it', async () => {
		const request = decodeNetworkHelperRequest(encodeNetworkHelperRequest({ version: 1, operation: 'applySystemTime', changes: CHANGES }));
		const response = await executeNetworkHelperRequest(request, async () => null);
		expect(response.ok).toBe(false);
	});

	it('parses the result back off the stdout platforms', () => {
		const response = { ok: true as const, time: { success: false, outcome: 'auto-sync-enabled' as const, message: 'automatic time synchronisation is enabled', steps: [{ command: 'timedatectl set-time 2026-09-10 12:30:00', ok: false }] } };
		expect(parseNetworkHelperResponse(JSON.stringify(response))).toEqual(response);
	});

	it('refuses a result that is not the shape the privileged side produces', () => {
		expect(isSystemTimeResult({ success: true, outcome: 'nope', message: null })).toBe(false);
		expect(isSystemTimeResult({ success: true, outcome: 'permission-denied', message: null })).toBe(false);
		expect(isSystemTimeResult({ success: true, outcome: 'ok', message: null, rogue: 1 })).toBe(false);
		expect(isSystemTimeResult({ success: true, outcome: 'ok', message: 'a'.repeat(501) })).toBe(false);
		expect(isSystemTimeResult({ success: true, outcome: 'ok', message: null, steps: [{ command: 'x', ok: 'yes' }] })).toBe(false);
		expect(isSystemTimeResult({ success: true, outcome: 'ok', message: null })).toBe(true);
	});
});

describe('applySystemTimeSettingsWithElevation', () => {
	it('never asks for rights when the host applied the change itself', async () => {
		let elevated = 0;
		const outcome = await applySystemTimeSettingsWithElevation(
			CHANGES,
			async () => {
				elevated++;
				return refused;
			},
			async () => ({ success: true, outcome: 'ok', message: null }),
			'linux',
			() => 0
		);
		expect(outcome.outcome).toBe('ok');
		expect(elevated).toBe(0);
	});

	it('retries elevated when the host refused for want of privileges', async () => {
		const seen: SystemTimeChanges[] = [];
		const outcome = await applySystemTimeSettingsWithElevation(
			CHANGES,
			async changes => {
				seen.push(changes);
				return { success: true, outcome: 'ok', message: null };
			},
			async () => refused,
			'linux',
			() => 0
		);
		expect(outcome.outcome).toBe('ok');
		expect(seen).toEqual([CHANGES]);
	});

	/**
	 * The one case a retry must not happen: a step that COMPLETED before the refusal has
	 * already moved the host, so re-running the whole save elevated would apply it twice
	 * against a state it was never composed against.
	 */
	it('reports the partial failure instead of re-running it elevated', async () => {
		let elevated = 0;
		const partial: SystemTimeResult = { success: false, outcome: 'permission-denied', message: 'denied half way', changed: true, stateMayHaveChanged: true };
		const outcome = await applySystemTimeSettingsWithElevation(
			CHANGES,
			async () => {
				elevated++;
				return { success: true, outcome: 'ok', message: null };
			},
			async () => partial,
			'linux',
			() => 0
		);
		expect(outcome).toEqual(partial);
		expect(elevated).toBe(0);
	});

	it('leaves every other refusal alone', async () => {
		for (const outcome of ['unsupported', 'auto-sync-enabled', 'invalid-input', 'stale', 'error'] as const) {
			let elevated = 0;
			const answer = await applySystemTimeSettingsWithElevation(
				CHANGES,
				async () => {
					elevated++;
					return { success: true, outcome: 'ok', message: null };
				},
				async () => ({ success: false, outcome, message: null }),
				'linux',
				() => 0
			);
			expect(answer.outcome).toBe(outcome);
			expect(elevated).toBe(0);
		}
	});

	it('reads a refusal that merely started a command as still worth elevating', () => {
		expect(needsElevation(refused)).toBe(true);
		expect(needsElevation({ ...refused, changed: true })).toBe(false);
		expect(needsElevation({ success: false, outcome: 'error', message: null })).toBe(false);
	});
});

describe('a helper answer that never arrived', () => {
	/**
	 * "We did not get an answer" is not "nothing happened". The helper may have applied the
	 * change and then been killed, or answered something unparsable - and without
	 * `stateMayHaveChanged` the API skips the read-back, so every open window keeps showing
	 * a state the host no longer has.
	 */
	it('is reported as a state that may have changed', () => {
		for (const code of [WINDOWS_LAUNCHER_EXIT.timeout, 1, 99]) {
			const outcome = windowsSystemTimeExit(code);
			expect(outcome.outcome).toBe('error');
			expect(outcome.stateMayHaveChanged).toBe(true);
		}
		expect(windowsSystemTimeExit(0, true).stateMayHaveChanged).toBe(true);
	});

	/** The two that PROVE the helper never started stay a plain permission refusal. */
	it('is not claimed for a helper that never started', () => {
		for (const code of [WINDOWS_LAUNCHER_EXIT.untrusted, WINDOWS_LAUNCHER_EXIT.cancelled]) {
			const outcome = windowsSystemTimeExit(code);
			expect(outcome.outcome).toBe('permission-denied');
			expect(outcome.stateMayHaveChanged).toBeUndefined();
		}
	});

	it('leaves a real outcome alone', () => {
		const applied = windowsSystemTimeExit(systemTimeExitCode({ success: true, outcome: 'ok', message: null }));
		expect(applied.success).toBe(true);
		expect(applied.stateMayHaveChanged).toBeUndefined();
	});
});

describe('where trying unprivileged first is pointless', () => {
	/**
	 * The dead end this closes: on macOS every `systemsetup -get...` needs root (measured
	 * on 15.7.4), so the status says `ntpEnabled: null`, and a clock write is then refused
	 * for not knowing whether synchronisation owns the clock. That refusal is an `error`,
	 * which `needsElevation` does not retry - so a user could switch synchronisation off
	 * through the helper and still never set the clock, because the confirming read was
	 * unprivileged again.
	 */
	it('is macOS below root, and nothing else', () => {
		expect(localAttemptIsPointless('darwin', 501)).toBe(true);
		expect(localAttemptIsPointless('darwin', undefined)).toBe(true);
		expect(localAttemptIsPointless('darwin', 0)).toBe(false);
		// A Windows timezone change succeeds unprivileged, and on Linux the unprivileged
		// path is the authorized one: both must keep their local attempt.
		expect(localAttemptIsPointless('win32', 501)).toBe(false);
		expect(localAttemptIsPointless('linux', 501)).toBe(false);
	});

	it('sends the macOS save straight to the helper, without a pointless local write', async () => {
		const attempted: string[] = [];
		const outcome = await applySystemTimeSettingsWithElevation(
			CHANGES,
			async () => {
				attempted.push('elevated');
				return { success: true, outcome: 'ok', message: null };
			},
			async () => {
				attempted.push('local');
				return { success: false, outcome: 'error', message: 'cannot determine whether automatic time synchronisation is enabled, so the clock is left alone' };
			},
			'darwin',
			() => 501
		);
		expect(attempted).toEqual(['elevated']);
		expect(outcome.outcome).toBe('ok');
	});

	it('still writes locally as root on macOS', async () => {
		const attempted: string[] = [];
		await applySystemTimeSettingsWithElevation(
			CHANGES,
			async () => {
				attempted.push('elevated');
				return { success: true, outcome: 'ok', message: null };
			},
			async () => {
				attempted.push('local');
				return { success: true, outcome: 'ok', message: null };
			},
			'darwin',
			() => 0
		);
		expect(attempted).toEqual(['local']);
	});
});

describe('deciding privileges before the first write', () => {
	/**
	 * The gap this covers: the retry is refused once a step has completed, which is right,
	 * and it made an ordinary save unreachable. On Windows a save of a timezone AND a clock
	 * applies the timezone unprivileged - `Users` hold `SeTimeZonePrivilege` and `tzutil /s`
	 * really writes - then meets `SeSystemtimePrivilege`, which they do not hold. The result
	 * carried `changed: true`, so no prompt ever appeared and the host was left with a new
	 * zone and the old clock.
	 */
	it('sends a Windows set that needs more than the timezone straight to the helper', () => {
		expect(requiresPrivilegesUpFront('win32', 0, { timezone: 'Europe/Prague', clock: { hours: 1, minutes: 2, seconds: 3 } }, false)).toBe(true);
		expect(requiresPrivilegesUpFront('win32', 0, { ntpEnabled: true }, false)).toBe(true);
		expect(requiresPrivilegesUpFront('win32', 0, { ntpServer: 'ntp.example.org' }, false)).toBe(true);
	});

	/** A timezone-only save needs no rights on Windows, so it must raise no prompt. */
	it('leaves a Windows timezone-only save alone', () => {
		expect(requiresPrivilegesUpFront('win32', 0, { timezone: 'Europe/Prague' }, false)).toBe(false);
		expect(requiresPrivilegesUpFront('win32', 0, { timezone: 'Europe/Prague', expectedTimezone: 'Etc/UTC', expectedOffsetMinutes: 0 }, false)).toBe(false);
	});

	it('leaves an already elevated Windows process alone', () => {
		expect(requiresPrivilegesUpFront('win32', 0, { clock: { hours: 1, minutes: 2, seconds: 3 } }, true)).toBe(false);
	});

	/**
	 * Linux keeps its local attempt, because `timedatectl` and `systemctl` ask polkit
	 * themselves and that IS the authorized path. The NTP server is the exception: its
	 * change is a direct write into `/etc` that no polkit rule covers.
	 */
	it('only routes the Linux NTP server up front, and not for root', () => {
		expect(requiresPrivilegesUpFront('linux', 1000, { ntpServer: 'ntp.example.org' }, false)).toBe(true);
		expect(requiresPrivilegesUpFront('linux', 1000, { clock: { hours: 1, minutes: 2, seconds: 3 } }, false)).toBe(false);
		expect(requiresPrivilegesUpFront('linux', 1000, { ntpEnabled: false }, false)).toBe(false);
		expect(requiresPrivilegesUpFront('linux', 0, { ntpServer: 'ntp.example.org' }, false)).toBe(false);
	});

	it('routes every macOS save below root', () => {
		expect(requiresPrivilegesUpFront('darwin', 501, { timezone: 'Europe/Prague' }, false)).toBe(true);
		expect(requiresPrivilegesUpFront('darwin', 0, { timezone: 'Europe/Prague' }, false)).toBe(false);
	});

	it('does not attempt the Windows timezone-and-clock save locally at all', async () => {
		const attempted: string[] = [];
		const outcome = await applySystemTimeSettingsWithElevation(
			{ timezone: 'Europe/London', clock: { hours: 1, minutes: 2, seconds: 3 } },
			async () => {
				attempted.push('elevated');
				return { success: true, outcome: 'ok', message: null };
			},
			async () => {
				attempted.push('local');
				return { success: false, outcome: 'permission-denied', message: 'denied after the zone moved', changed: true };
			},
			'win32',
			() => 0,
			() => false
		);
		expect(attempted).toEqual(['elevated']);
		expect(outcome.outcome).toBe('ok');
	});

	/**
	 * Writing the OS timezone does not invalidate a running process's ICU cache, and the
	 * assignment that compensates for it lives in the writer - which now runs inside the
	 * helper, a process that then exits. Without carrying it back, the backend keeps
	 * formatting in the old zone AND sends it as `expectedTimezone` on the next clock save,
	 * which the helper then refuses as composed against state that has changed.
	 *
	 * What is carried back is the zone the host ENDED UP in, read through something that
	 * works without privileges - never the zone that was asked for.
	 */
	it('adopts the zone the host ended up in', async () => {
		await withTemporaryTZ(async () => {
			await applySystemTimeSettingsWithElevation(
				{ timezone: 'Asia/Tokyo' },
				async () => ({ success: true, outcome: 'ok', message: null }),
				async () => ({ success: false, outcome: 'permission-denied', message: null }),
				'darwin',
				() => 501,
				() => false,
				() => 'Asia/Tokyo'
			);
			expect(process.env['TZ']).toBe('Asia/Tokyo');
		});
	});

	/**
	 * The case adopting only on success got wrong: the elevated save moved the ZONE and then
	 * refused the clock, so it is a failure that nevertheless changed the host. On macOS the
	 * follow-up read cannot reach `systemsetup`, so the stale process zone would have been
	 * reported for as long as the backend ran.
	 */
	it('adopts it after a save that moved the zone and then failed', async () => {
		await withTemporaryTZ(async () => {
			const partial: SystemTimeResult = { success: false, outcome: 'auto-sync-enabled', message: 'automatic time synchronisation is enabled', changed: true, stateMayHaveChanged: true };
			const outcome = await applySystemTimeSettingsWithElevation(
				{ timezone: 'Europe/Prague', clock: { hours: 1, minutes: 2, seconds: 3 } },
				async () => partial,
				async () => partial,
				'darwin',
				() => 501,
				() => false,
				() => 'Europe/Prague'
			);
			expect(outcome).toEqual(partial);
			expect(process.env['TZ']).toBe('Europe/Prague');
		});
	});

	/** And the mirror image: a save that failed BEFORE the zone step must not record one. */
	it('records nothing when the host is not in the requested zone', async () => {
		await withTemporaryTZ(async () => {
			process.env['TZ'] = 'Etc/UTC';
			await applySystemTimeSettingsWithElevation(
				{ timezone: 'Europe/London' },
				async () => ({ success: false, outcome: 'permission-denied', message: null }),
				async () => ({ success: false, outcome: 'permission-denied', message: null }),
				'darwin',
				() => 501,
				() => false,
				() => null
			);
			expect(process.env['TZ']).toBe('Etc/UTC');
		});
	});

	/**
	 * Windows keys its Windows-to-IANA memory on the Windows identifier, and `Europe/Prague`
	 * and `Europe/Budapest` share `Central Europe Standard Time`. Without repointing it, a
	 * save that really moved the host to Budapest kept the screen offering Prague - the very
	 * thing `rememberWindowsZone` exists for on the direct path.
	 */
	it('repoints the Windows zone memory as well', async () => {
		await withTemporaryTZ(async () => {
			const windowsId = ianaToWindowsTimezoneId('Europe/Budapest');
			// No ICU on this host means the timezone capability is off on the direct path too.
			if (windowsId === null) return;
			rememberWindowsZone(windowsId, 'Europe/Prague');
			expect(windowsToIanaTimezone(windowsId)).toBe('Europe/Prague');
			await applySystemTimeSettingsWithElevation(
				{ timezone: 'Europe/Budapest', ntpServer: 'tik.cesnet.cz' },
				async () => ({ success: true, outcome: 'ok', message: null }),
				async () => ({ success: false, outcome: 'permission-denied', message: null }),
				'win32',
				() => 0,
				() => false,
				() => 'Europe/Budapest'
			);
			expect(windowsToIanaTimezone(windowsId)).toBe('Europe/Budapest');
			expect(process.env['TZ']).toBe('Europe/Budapest');
		});
	});
});

describe('the macOS server an unprivileged reader can still see', () => {
	/**
	 * `systemsetup` needs root for its READS too, so without a second source the server
	 * field came back EMPTY on an unprivileged backend - including right after the user had
	 * saved one through the privileged helper. Measured on macOS 15.7.4: `/etc/ntp.conf` is
	 * `-rw-r--r-- root:wheel` and holds `server time.euro.apple.com`, and it tracks what
	 * `systemsetup -setnetworktimeserver` writes.
	 */
	it('is the first server line of ntp.conf', () => {
		expect(parseNtpConfServer('server time.euro.apple.com\n')).toBe('time.euro.apple.com');
		expect(parseNtpConfServer('# comment\n\nserver tik.cesnet.cz iburst\nserver tak.cesnet.cz\n')).toBe('tik.cesnet.cz');
		// Per-server options are not part of the address, and a commented-out line is not one.
		expect(parseNtpConfServer('#server old.example.org\nserver ntp.example.org minpoll 4\n')).toBe('ntp.example.org');
		expect(parseNtpConfServer('')).toBeNull();
		expect(parseNtpConfServer('restrict default\nfudge 127.127.1.0 stratum 10\n')).toBeNull();
	});

	it('is only a fallback: systemsetup stays the authority', async () => {
		const status = await readMacStatus(() => 'from.the.file');
		// Reads on this test host are not macOS reads at all, so the file is what is left.
		expect(status.ntpServer).toBe('from.the.file');
	});

	it('never throws on a missing or unreadable file', () => {
		expect(readMacNtpConfServer('/definitely/not/here/ntp.conf')).toBeNull();
	});
});

describe('switching the Windows NTP client provider back on', () => {
	/**
	 * The path that begins with a REGISTRY write, and the only one that does. `reg.exe`
	 * cannot report its own refusal usably - exit 1 for every failure, and a localized
	 * sentence with no error number - so the whole save came back as a generic `error`,
	 * which is not the outcome that asks for privileges. The key is asked first instead.
	 */
	it('refuses with a permission problem when the key may not be written', async () => {
		await onWindows(async () => {
			let commands = 0;
			const outcome = await setSystemNtpEnabled(
				true,
				async () => statusFixture(),
				async () => {
					commands++;
					return { kind: 'ok', output: '' };
				},
				async () => ({ mode: 'manual', start: 'disabled', membership: 'standalone', service: 'stopped', ntpClientEnabled: false }),
				async () => true,
				async () => {},
				() => 0,
				() => 'denied'
			);
			expect(outcome.outcome).toBe('permission-denied');
			expect(outcome.message).toContain('administrator rights');
			// Nothing ran: the refusal is decided before the first command.
			expect(commands).toBe(0);
		});
	});

	it('proceeds when the key is writable', async () => {
		await onWindows(async () => {
			const calls: string[] = [];
			const outcome = await setSystemNtpEnabled(
				true,
				async () => statusFixture(),
				async (cmd, args) => {
					calls.push([cmd, ...args].join(' '));
					return { kind: 'ok', output: '' };
				},
				async () => ({ mode: 'manual', start: 'disabled', membership: 'standalone', service: 'stopped', ntpClientEnabled: false }),
				async () => true,
				async () => {},
				() => 0,
				() => 'writable'
			);
			expect(outcome.success).toBe(true);
			expect(calls[0]).toContain('reg add');
		});
	});

	/** A provider that is already on never reaches the registry, so its state is irrelevant. */
	it('does not consult the key when the provider is already on', async () => {
		await onWindows(async () => {
			let probed = 0;
			await setSystemNtpEnabled(
				true,
				async () => statusFixture(),
				async () => ({ kind: 'ok', output: '' }),
				async () => ({ mode: 'manual', start: 'disabled', membership: 'standalone', service: 'stopped', ntpClientEnabled: true }),
				async () => true,
				async () => {},
				() => 0,
				() => {
					probed++;
					return 'denied';
				}
			);
			expect(probed).toBe(0);
		});
	});
});

describe('the macOS zone an unprivileged reader can still see', () => {
	/**
	 * `systemsetup` refuses an unprivileged read, so without this the zone fell through to
	 * the PROCESS zone - and after the privileged helper changed the host, the backend
	 * reported the old zone for as long as it ran, and sent it as `expectedTimezone` on the
	 * next save. Measured on macOS 15.7.4: `/etc/localtime` is a world-readable symlink to
	 * `/var/db/timezone/zoneinfo/<Zone>` that follows `systemsetup -settimezone` at once.
	 */
	it('is the zone inside the localtime symlink', () => {
		expect(parseZoneinfoLink('/var/db/timezone/zoneinfo/Europe/Prague')).toBe('Europe/Prague');
		expect(parseZoneinfoLink('/usr/share/zoneinfo/Etc/UTC')).toBe('Etc/UTC');
		expect(parseZoneinfoLink('../usr/share/zoneinfo/America/New_York')).toBe('America/New_York');
		expect(parseZoneinfoLink('/etc/localtime')).toBeNull();
		expect(parseZoneinfoLink('/var/db/timezone/zoneinfo/')).toBeNull();
	});

	it('is only a fallback: systemsetup stays the authority', async () => {
		const status = await readMacStatus(
			() => null,
			() => 'Pacific/Auckland'
		);
		expect(status.timezone).toBe('Pacific/Auckland');
	});

	it('never throws on a missing link', () => {
		expect(readMacLocaltimeZone('/definitely/not/here/localtime')).toBeNull();
	});
});

describe('the same host zone under two different names', () => {
	/**
	 * The bug this exists for: Windows stores one identifier for several IANA names -
	 * `Europe/Prague` and `Europe/Budapest` are both `Central Europe Standard Time` - and
	 * which name a process reports for it depends on a per-process memory. The privileged
	 * helper is always a fresh process, so it resolved the identifier to its own zone while
	 * the backend reported the city the user had picked. The staleness check compared the
	 * NAMES and refused every clock save with `stale`, before writing anything - and a
	 * reload did not help, because the backend kept reporting the remembered name.
	 */
	it('is the same zone on Windows, and not anywhere else', () => {
		expect(sameHostZone('win32', 'Europe/Prague', 'Europe/Prague')).toBe(true);
		expect(sameHostZone('linux', 'Europe/Prague', 'Europe/Prague')).toBe(true);
		if (ianaToWindowsTimezoneId('Europe/Budapest') !== null) {
			expect(sameHostZone('win32', 'Europe/Prague', 'Europe/Budapest')).toBe(true);
			// A genuinely different zone is still a different zone.
			expect(sameHostZone('win32', 'Europe/Prague', 'Europe/London')).toBe(false);
		}
		// Elsewhere the name IS the identifier, so two cities never collapse into one.
		expect(sameHostZone('linux', 'Europe/Prague', 'Europe/Budapest')).toBe(false);
		expect(sameHostZone('darwin', 'Europe/Prague', 'Europe/Budapest')).toBe(false);
	});

	/** No conversion available means no claim of equality: the names decide, which is the strict direction. */
	it('falls back to the names when the conversion cannot answer', () => {
		expect(sameHostZone('win32', 'Not/AZone', 'Other/AZone')).toBe(false);
		expect(sameHostZone('win32', 'Not/AZone', 'Not/AZone')).toBe(true);
	});

	/**
	 * The offset check the call site does alongside this one is deliberately untouched: it
	 * is what still catches Windows switching automatic daylight saving off, which moves the
	 * offset while the identifier stays put.
	 */
	it('still refuses a save composed against a different offset', async () => {
		const at = Date.UTC(2026, 8, 11, 12, 0, 0);
		const host = async (): Promise<SystemTimeStatus> => statusFixture({ nowMs: at, timezone: 'Europe/Prague', utcOffsetMinutes: 60 });
		const outcome = await applySystemTimeSettings({ clock: { hours: 1, minutes: 2, seconds: 3 }, expectedTimezone: 'Europe/Prague', expectedOffsetMinutes: 120 }, undefined, host);
		expect(outcome.outcome).toBe('stale');
		expect(outcome.message).toContain('minutes from UTC');
	});
});

describe('a save that never reached the host', () => {
	/**
	 * A cancelled administrator prompt returns `permission-denied` with NEITHER change flag,
	 * because nothing ran. Without checking that, the zone was adopted anyway: on Windows the
	 * confirmation can only check that the requested zone converts to the identifier the host
	 * reports, and when two cities share one identifier that holds before the change as well
	 * as after it. So a user who picked Budapest and then said no to the prompt had Budapest
	 * recorded, and every open window saw the switch move on its own.
	 */
	it('records no zone after a cancelled prompt', async () => {
		await withTemporaryTZ(async () => {
			process.env['TZ'] = 'Europe/Prague';
			let measured = 0;
			const cancelled: SystemTimeResult = { success: false, outcome: 'permission-denied', message: 'the administrator prompt was cancelled' };
			await applySystemTimeSettingsWithElevation(
				{ timezone: 'Europe/Budapest', ntpServer: 'tik.cesnet.cz' },
				async () => cancelled,
				async () => cancelled,
				'win32',
				() => 0,
				() => false,
				() => {
					measured++;
					return 'Europe/Budapest';
				}
			);
			expect(process.env['TZ']).toBe('Europe/Prague');
			// Not even measured: nothing ran, so there is nothing to confirm.
			expect(measured).toBe(0);
		});
	});

	it('records no zone when the helper was not trusted', async () => {
		await withTemporaryTZ(async () => {
			process.env['TZ'] = 'Europe/Prague';
			const untrusted: SystemTimeResult = { success: false, outcome: 'permission-denied', message: 'the privileged helper is missing or not trusted' };
			await applySystemTimeSettingsWithElevation(
				{ timezone: 'Europe/Budapest' },
				async () => untrusted,
				async () => untrusted,
				'darwin',
				() => 501,
				() => false,
				() => 'Europe/Budapest'
			);
			expect(process.env['TZ']).toBe('Europe/Prague');
		});
	});

	/**
	 * A refusal that DID reach the host still carries a flag, and then the zone is measured
	 * as before - this is the partial save that moved the zone and then failed.
	 */
	it('still measures after a refusal that reached the host', async () => {
		await withTemporaryTZ(async () => {
			process.env['TZ'] = 'Etc/UTC';
			const reached: SystemTimeResult = { success: false, outcome: 'permission-denied', message: 'denied half way', stateMayHaveChanged: true };
			await applySystemTimeSettingsWithElevation(
				{ timezone: 'Europe/Prague' },
				async () => reached,
				async () => reached,
				'darwin',
				() => 501,
				() => false,
				() => 'Europe/Prague'
			);
			expect(process.env['TZ']).toBe('Europe/Prague');
		});
	});
});
