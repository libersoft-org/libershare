import { expect, test } from 'bun:test';
import type { SystemTimeChanges, SystemTimeStatus } from '@shared';
import { NativeTimeChanges } from '../../src/native/time-changes.ts';
import type { NativeMutationHost, NativeSettlement } from '../../src/native/mutation-host.ts';
import type { JournalValue, NativeMutationRecord } from '../../src/native/mutation-journal.ts';
import type { LinuxTimeSnapshot } from '../../src/native/linux/time-mutation-state.ts';

const zone = { resolved: '/usr/share/zoneinfo/Etc/UTC', name: 'Etc/UTC', sha256: 'a'.repeat(64), symlink: true };
const target = { resolved: '/usr/share/zoneinfo/Europe/Prague', name: 'Europe/Prague', sha256: 'b'.repeat(64), symlink: true };
const original: LinuxTimeSnapshot = { utcMs: 100000, hostUptimeMs: 20000, bootId: 'boot-1', timezone: zone, offsetSeconds: 0 };
const status: SystemTimeStatus = { supported: true, nowMs: 100000, timezone: 'Etc/UTC', utcOffsetMinutes: 0, timezoneSource: 'intl', ntpEnabled: false, ntpSynchronized: false, ntpServer: null, capabilities: { setClock: true, setTimezone: true, setNtpServer: true, setNtpEnabled: true } };

async function verify(changes: SystemTimeChanges, current: LinuxTimeSnapshot, metadata: unknown, malformed = false): Promise<NativeSettlement> {
	const controller = new NativeTimeChanges({} as NativeMutationHost, async () => status, {
		async call<T>() {
			return current as T;
		},
		close() {
			return true;
		},
	});
	const record = { recoveryData: malformed ? metadata : ({ kind: 'time', changes, original: { timezone: 'Etc/UTC', ntpEnabled: false, ntpServer: null }, physical: original, time: metadata } as unknown as JournalValue) } as NativeMutationRecord;
	// Exercise settlement without creating a journal or claiming a live executor has ended.
	return (controller as unknown as { verify(record: NativeMutationRecord): Promise<NativeSettlement> }).verify(record);
}

test('recovery completes both the original state and a verified target timezone', async () => {
	expect(await verify({ timezone: 'Europe/Prague' }, original, undefined)).toBe('completed');
	expect(await verify({ timezone: 'Europe/Prague' }, { ...original, timezone: target }, { timezone: { before: zone, target } })).toBe('completed');
});

test('recovery never trusts a cached timezone name over the physical file', async () => {
	const foreign = { ...target, sha256: 'c'.repeat(64) };
	expect(await verify({ timezone: 'Europe/Prague' }, { ...original, timezone: foreign }, { timezone: { before: zone, target } })).toBe('interrupted');
});

test('clock recovery requires the recorded boot and actual target reference', async () => {
	const changes = { clock: { hours: 12, minutes: 0, seconds: 0 } };
	const metadata = { clock: { targetUtcMs: 110000, hostUptimeMs: 20000, bootId: 'boot-1' } };
	const current = { ...original, utcMs: 111000, hostUptimeMs: 21000 };
	expect(await verify(changes, current, metadata)).toBe('completed');
	expect(await verify(changes, current, undefined)).toBe('interrupted');
	expect(await verify(changes, { ...current, bootId: 'boot-2' }, metadata)).toBe('interrupted');
});

test('a partial timezone-and-clock operation remains interrupted', async () => {
	expect(await verify({ timezone: 'Europe/Prague', clock: { hours: 12, minutes: 0, seconds: 0 } }, { ...original, timezone: target }, { timezone: { before: zone, target }, clock: { targetUtcMs: 120000, hostUptimeMs: 20000, bootId: 'boot-1' } })).toBe('interrupted');
});

test('malformed recovery metadata cannot unlock the operation', async () => {
	expect(await verify({}, original, {}, true)).toBe('interrupted');
	expect(await verify({ timezone: 'Europe/Prague' }, { ...original, timezone: target }, { timezone: { target: { ...target, sha256: 'invalid' } } })).toBe('interrupted');
});

test('restoring the old drop-in is insufficient when its previously running provider is stopped', async () => {
	const controller = new NativeTimeChanges({} as NativeMutationHost, async () => ({ ...status, ntpEnabled: false }), {
		async call<T>(request: { method: string }) {
			return (request.method === 'linux.time.jobs.state' ? { enabled: false, selected: 'systemd-timesyncd.service', providers: [{ id: 'systemd-timesyncd.service', active: 'inactive' }] } : { ...original, dropinHash: null, configurationHash: 'c'.repeat(64) }) as T;
		},
		close() {
			return true;
		},
	});
	const record = { recoveryData: { kind: 'time', changes: { ntpServer: 'ntp.example.org' }, original: { timezone: 'Etc/UTC', ntpEnabled: true, ntpServer: null }, physical: { ...original, dropinHash: null, configurationHash: 'c'.repeat(64) } } as unknown as JournalValue } as NativeMutationRecord;
	expect(await (controller as unknown as { verify(record: NativeMutationRecord): Promise<NativeSettlement> }).verify(record)).toBe('interrupted');
});
