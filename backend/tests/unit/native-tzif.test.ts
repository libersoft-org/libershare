import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseTzif, tzifLocalToUtc, tzifOffsetAt, type TzifZone } from '../../src/native/tzif.ts';
import offsets from './fixtures/native-tzif/offsets.json';
import inverse from './fixtures/native-tzif/zones.json';

describe('recorded TZif offset oracle', () => {
	test('retains all 16 zones and 31 instants from GNU date', () => {
		expect(Object.keys(offsets.zones)).toHaveLength(16);
		expect(offsets.instants).toHaveLength(31);
	});
	for (const [name, fixture] of Object.entries(offsets.zones)) {
		test(name, () => {
			const zone = parseTzif(Buffer.from(fixture.bytes, 'base64'));
			expect(fixture.offsets).toHaveLength(offsets.instants.length);
			for (const [i, time] of offsets.instants.entries()) {
				const text = fixture.offsets[i]!;
				const expected = (text[0] === '-' ? -1 : 1) * (Number(text.slice(1, 3)) * 3600 + Number(text.slice(3)) * 60);
				// GNU date can label an unknown zero offset -0000.
				expect(tzifOffsetAt(zone, time), `${name} at ${time}`).toBe(expected || 0);
			}
		});
	}
});

describe('recorded systemd local-time oracle', () => {
	const rows = readFileSync(new URL('./fixtures/native-tzif/systemd-local-to-utc.txt', import.meta.url), 'utf8')
		.trim()
		.split('\n');
	const zones = new Map<string, TzifZone>(Object.entries(inverse.zones).map(([name, bytes]) => [name, parseTzif(Buffer.from(bytes, 'base64'))]));
	test('matches every fresh-process result, including gaps and folds', () => {
		expect(rows).toHaveLength(4298);
		expect(zones.size).toBe(446);
		const used = new Set<string>();
		for (const row of rows) {
			const [name, ...values] = row.trim().split(' ');
			const [year, month, day, hour, minute, expected] = values.map(Number);
			const zone = zones.get(name!)!;
			used.add(name!);
			expect(tzifLocalToUtc(zone, { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: 0 }), row).toBe(expected!);
		}
		expect(used.size).toBe(446);
	});

	test('resolves folds from offset zero, not an always-standard policy', () => {
		const cases = [
			['Europe/Prague', 2026, 10, 25, 2, 30, '2026-10-25T01:30:00Z'],
			['America/New_York', 2026, 11, 1, 1, 30, '2026-11-01T05:30:00Z'],
		] as const;
		for (const [name, year, month, day, hour, minute, expected] of cases) {
			expect(tzifLocalToUtc(zones.get(name)!, { year, month, day, hour, minute, second: 0 })).toBe(Date.parse(expected) / 1000);
		}
	});
});
