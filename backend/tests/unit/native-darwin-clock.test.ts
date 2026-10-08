import { expect, spyOn, test } from 'bun:test';
import { darwinLocalToUtc } from '../../src/native/darwin/time-clock.ts';
import { prepareDarwinClock, type DarwinClockConversionDeps, type DarwinClockReference } from '../../src/native/darwin/time-native.ts';
import { executeDarwinClockWrite, type DarwinClockWriteDeps } from '../../src/native/darwin/time-worker.ts';
import { parseTzif, type TzifZone } from '../../src/native/tzif.ts';
import recorded from './fixtures/native-tzif/darwin-local-to-utc.json';
import fixtures from './fixtures/native-tzif/zones.json';

const zoneBytes = fixtures.zones as Record<string, string>;
const zones = new Map<string, TzifZone>();
for (const name of new Set(recorded.rows.map(row => row.zone))) zones.set(name, parseTzif(Buffer.from(zoneBytes[name] ?? zoneBytes['Etc/UTC']!, 'base64')));
for (const row of recorded.rows) {
	test(`Darwin oracle: ${row.zone} ${row.label}`, () => {
		const [year, month, day, hour, minute, second] = row.local;
		expect(darwinLocalToUtc(zones.get(row.zone)!, { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: second! }) * 1000).toBe(row.utcMs);
	});
}

test('64-bit search preserves odd and negative seconds on both sides of the epoch', () => {
	const zone = zones.get('UTC')!;
	for (const date of ['1900-01-01T00:00:01Z', '1969-12-31T23:59:59Z', '1970-01-01T00:00:01Z', '2038-01-19T03:14:08Z', '2400-02-29T23:59:59Z']) {
		const value = new Date(date);
		expect(darwinLocalToUtc(zone, { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate(), hour: value.getUTCHours(), minute: value.getUTCMinutes(), second: value.getUTCSeconds() })).toBe(value.getTime() / 1000);
	}
});

test('invalid civil dates and seconds are rejected before any clock write', () => {
	const valid = { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
	for (const patch of [{ year: 1899 }, { month: 2, day: 30 }, { month: 13 }, { day: 0 }, { hour: 24 }, { second: 60 }, { minute: NaN }]) expect(() => darwinLocalToUtc(zones.get('UTC')!, { ...valid, ...patch })).toThrow();
});

const reference: DarwinClockReference = { localDate: '2026-10-03', zoneSha256: 'a'.repeat(64), bootId: 'darwin-boot:00000000-0000-4000-8000-000000000001' };
const clock = { hours: 12, minutes: 34, seconds: 56 };
const target = Date.UTC(2026, 9, 3, 10, 34, 56);
const deps: DarwinClockConversionDeps = { snapshot: () => ({ zone: zones.get('Europe/Prague')!, reference }), reference: () => reference };

test('clock preparation uses the supplied host snapshot without spawning or changing inherited TZ', () => {
	const before = process.env['TZ'];
	const spawn = spyOn(Bun, 'spawn').mockImplementation(() => {
		throw new Error('Unexpected process launch');
	});
	try {
		expect(prepareDarwinClock(clock, deps)).toEqual({ targetUtcMs: target, reference });
		expect(process.env['TZ']).toBe(before);
		expect(spawn).not.toHaveBeenCalled();
	} finally {
		spawn.mockRestore();
	}
});

test('a conversion cannot cross a host date, boot or physical TZif change', () => {
	for (const patch of [{ localDate: '2026-10-04' }, { bootId: 'changed' }, { zoneSha256: 'b'.repeat(64) }]) expect(() => prepareDarwinClock(clock, { ...deps, reference: () => ({ ...reference, ...patch }) })).toThrow('changed during clock conversion');
});

function writerFixture(change: () => void = () => {}) {
	let zone = 'original',
		active = false,
		current = { ...reference },
		writes = 0;
	const writer: DarwinClockWriteDeps = {
		zoneFingerprint: () => zone,
		reference: () => current,
		ntpEnabled: () => active,
		convert: async () => {
			change();
			return { targetUtcMs: target, reference };
		},
		uptime: () => 12345,
		set: () => {
			writes++;
			return 0;
		},
	};
	return {
		deps: writer,
		writes: () => writes,
		zone: () => {
			zone = 'changed';
		},
		ntp: () => {
			active = true;
		},
		reference: (patch: Partial<DarwinClockReference>) => {
			current = { ...current, ...patch };
		},
	};
}

test('the clock writer checks timezone, NTP, date and boot again after conversion', async () => {
	for (const kind of ['zone', 'ntp', 'date', 'boot'] as const) {
		const fixture = writerFixture(() => {
			if (kind === 'zone') fixture.zone();
			else if (kind === 'ntp') fixture.ntp();
			else fixture.reference(kind === 'date' ? { localDate: '2026-10-04' } : { bootId: 'changed' });
		});
		const operation = executeDarwinClockWrite({ kind: 'clock', clock, zoneFingerprint: 'original' }, fixture.deps);
		if (kind === 'ntp') expect((await operation).outcome).toMatchObject({ kind: 'failed', outcome: 'auto-sync-enabled', stateMayHaveChanged: false });
		else await expect(operation).rejects.toThrow('changed during clock preparation');
		expect(fixture.writes()).toBe(0);
	}
});

test('an unreadable host timezone cannot reach settimeofday', async () => {
	const fixture = writerFixture();
	fixture.deps.convert = () => {
		throw new Error('Unreadable host timezone');
	};
	await expect(executeDarwinClockWrite({ kind: 'clock', clock, zoneFingerprint: 'original' }, fixture.deps)).rejects.toThrow('Unreadable host timezone');
	expect(fixture.writes()).toBe(0);
});

test('a verified conversion records the uptime at the actual clock write', async () => {
	const fixture = writerFixture();
	expect(await executeDarwinClockWrite({ kind: 'clock', clock, zoneFingerprint: 'original' }, fixture.deps)).toMatchObject({ outcome: { kind: 'ok' }, clock: { targetUtcMs: target, hostUptimeMs: 12345, bootId: reference.bootId } });
	expect(fixture.writes()).toBe(1);
});
