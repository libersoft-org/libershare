import { describe, expect, it } from 'bun:test';
import { applySystemTimeSettings, type SystemTimeWriters, type WindowsModeState } from '../../src/system-time.ts';
import type { SystemTimeChanges, SystemTimeStatus } from '@shared';

/**
 * A combined save whose clock will be refused must be refused before anything else in it is
 * written. The zone, the NTP server and the clock go out in one request from the settings
 * screen, and the clock is the last of them: refusing it only when its turn came left the host
 * with a new zone and server and the user with an error.
 */

const okResult = { success: true, outcome: 'ok' as const, message: null };
const ZONE = 'Europe/Prague';

function status(overrides: Partial<SystemTimeStatus> = {}): SystemTimeStatus {
	return {
		supported: true,
		nowMs: Date.UTC(2026, 7, 14, 21, 46, 28),
		timezone: ZONE,
		utcOffsetMinutes: 120,
		timezoneSource: 'intl',
		ntpEnabled: false,
		ntpSynchronized: null,
		ntpServer: 'ntp1.example.org',
		clockHeldByUnmanagedDaemon: false,
		capabilities: { setClock: true, setTimezone: true, setNtpServer: true, setNtpEnabled: true },
		...overrides,
	};
}

function writers(calls: string[]): SystemTimeWriters {
	return {
		setNtpEnabled: async enabled => (calls.push(`ntp:${enabled}`), okResult),
		setNtpServer: async server => (calls.push(`server:${server}`), okResult),
		setTimezone: async timezone => (calls.push(`zone:${timezone}`), okResult),
		setClock: async clock => (calls.push(`clock:${clock.hours}`), okResult),
	};
}

const stoppedService = async (): Promise<WindowsModeState> => ({ mode: 'manual', start: 'disabled', membership: 'standalone', service: 'stopped', ntpClientEnabled: true });
const combined: SystemTimeChanges = { ntpServer: 'ntp.example.org', timezone: ZONE, clock: { hours: 1, minutes: 2, seconds: 3 }, expectedTimezone: ZONE };

async function save(changes: SystemTimeChanges, current: SystemTimeStatus, readMode = stoppedService): Promise<{ outcome: string; changed?: boolean | undefined; stateMayHaveChanged?: boolean | undefined; calls: string[] }> {
	const calls: string[] = [];
	const outcome = await applySystemTimeSettings(changes, writers(calls), async () => current, readMode);
	return { outcome: outcome.outcome, changed: outcome.changed, stateMayHaveChanged: outcome.stateMayHaveChanged, calls };
}

describe('combined time save with a clock', () => {
	it('refuses before the zone or server is written when synchronisation is on', async () => {
		const refused = await save(combined, status({ ntpEnabled: true }));
		expect(refused).toEqual({ outcome: 'auto-sync-enabled', changed: undefined, stateMayHaveChanged: undefined, calls: [] });
	});

	it('refuses before any write when the sync state or another daemon is unknown, or the host cannot set clocks', async () => {
		expect((await save(combined, status({ ntpEnabled: null }))).calls).toEqual([]);
		expect((await save(combined, status({ clockHeldByUnmanagedDaemon: true }))).calls).toEqual([]);
		expect((await save(combined, status({ clockHeldByUnmanagedDaemon: null }))).calls).toEqual([]);
		const unsupported = await save(combined, status({ capabilities: { setClock: false, setTimezone: true, setNtpServer: true, setNtpEnabled: true } }));
		expect(unsupported).toMatchObject({ outcome: 'unsupported', calls: [] });
	});

	it('lets the same save through once synchronisation is off', async () => {
		expect((await save(combined, status({ ntpEnabled: true }))).calls).toEqual([]);
		expect(await save(combined, status())).toMatchObject({ outcome: 'ok', calls: ['server:ntp.example.org', `zone:${ZONE}`, 'clock:1'] });
	});

	it('does not pre-check the clock when the same save switches synchronisation off first', async () => {
		const result = await save({ ...combined, ntpEnabled: false }, status({ ntpEnabled: true }));
		expect(result).toMatchObject({ outcome: 'ok', calls: ['ntp:false', 'server:ntp.example.org', `zone:${ZONE}`, 'clock:1'] });
	});

	it('reports a stale zone before a clock refusal', async () => {
		expect((await save(combined, status({ ntpEnabled: true, timezone: 'Europe/Berlin' }))).outcome).toBe('stale');
	});

	it('leaves a save without a clock alone', async () => {
		expect(await save({ timezone: ZONE }, status({ ntpEnabled: true }))).toMatchObject({ outcome: 'ok', calls: [`zone:${ZONE}`] });
	});

	// The service state lives only in the Windows read, so these run where that read is used.
	it.if(process.platform === 'win32')('refuses before any write when W32Time runs or is changing state although sync is configured off', async () => {
		for (const service of ['running', 'changing'] as const) {
			const result = await save(combined, status(), async () => ({ mode: 'manual', start: 'disabled', membership: 'standalone', service, ntpClientEnabled: true }));
			expect(result).toMatchObject({ outcome: 'auto-sync-enabled', calls: [] });
		}
		expect((await save(combined, status())).outcome).toBe('ok');
	});
});
