import { describe, expect, test } from 'bun:test';
import { parseTzif, tzifLocalToUtc, tzifOffsetAt } from '../../src/native/tzif.ts';

interface SyntheticZone {
	version?: '2' | '3';
	transitions?: bigint[];
	indices?: number[];
	types?: { offset: number; dst: boolean }[];
	footer?: string;
	leaps?: { occurrence: bigint; correction: number }[];
}

// Synthetic bytes exercise format boundaries absent from the recorded zone files.
function synthetic(options: SyntheticZone = {}): Buffer {
	const { version = '3', transitions = [], indices = transitions.map(() => 0), types = [{ offset: 0, dst: false }], footer = '', leaps = [] } = options;
	const block = (width: 4 | 8, times: bigint[], leapRecords: typeof leaps): Buffer => {
		const bytes = Buffer.alloc(44 + times.length * (width + 1) + types.length * 6 + 4 + leapRecords.length * (width + 4));
		bytes.write(`TZif${version}`, 0);
		bytes.writeUInt32BE(leapRecords.length, 28);
		bytes.writeUInt32BE(times.length, 32);
		bytes.writeUInt32BE(types.length, 36);
		bytes.writeUInt32BE(4, 40);
		let at = 44;
		for (const value of times) {
			if (width === 8) bytes.writeBigInt64BE(value, at);
			else bytes.writeInt32BE(Number(value), at);
			at += width;
		}
		for (const index of indices.slice(0, times.length)) bytes[at++] = index;
		for (const type of types) {
			bytes.writeInt32BE(type.offset, at);
			bytes[at + 4] = Number(type.dst);
			at += 6;
		}
		bytes.write('TST\0', at);
		at += 4;
		for (const leap of leapRecords) {
			if (width === 8) bytes.writeBigInt64BE(leap.occurrence, at);
			else bytes.writeInt32BE(Number(leap.occurrence), at);
			bytes.writeInt32BE(leap.correction, at + width);
			at += width + 4;
		}
		return bytes;
	};
	return Buffer.concat([block(4, [], []), block(8, transitions, leaps), Buffer.from(`\n${footer}\n`)]);
}

const seconds = (value: string): number => Date.parse(value) / 1000;

describe('TZif transition boundaries', () => {
	test('uses type zero before the first transition and preserves sub-minute offsets', () => {
		const zone = parseTzif(
			synthetic({
				transitions: [-1n, 2147483648n],
				indices: [1, 2],
				types: [
					{ offset: 1172, dst: true },
					{ offset: -30, dst: false },
					{ offset: 7200, dst: false },
				],
			})
		);
		expect(tzifOffsetAt(zone, -1.001)).toBe(1172);
		expect(tzifOffsetAt(zone, -1)).toBe(-30);
		expect(tzifOffsetAt(zone, -0.001)).toBe(-30);
		expect(tzifOffsetAt(zone, 2147483647)).toBe(-30);
		expect(tzifOffsetAt(zone, 2147483648)).toBe(7200);
	});

	test('keeps full signed 64-bit transition values', () => {
		const zone = parseTzif(
			synthetic({
				transitions: [-(2n ** 63n), 2n ** 63n - 1n],
				indices: [1, 0],
				types: [
					{ offset: 0, dst: false },
					{ offset: 3600, dst: false },
				],
			})
		);
		expect(zone.transitions).toEqual([-(2n ** 63n), 2n ** 63n - 1n]);
		expect(tzifOffsetAt(zone, -2208988800)).toBe(3600);
	});

	test('reads a Uint8Array slice without surrounding bytes', () => {
		const data = synthetic({ footer: 'TST-5:45:30' });
		const wrapped = Buffer.concat([Buffer.alloc(13), data, Buffer.alloc(17)]);
		expect(tzifOffsetAt(parseTzif(wrapped.subarray(13, 13 + data.length)), 0)).toBe(20730);
	});

	test('applies the footer only after the final explicit transition', () => {
		const zone = parseTzif(synthetic({ transitions: [0n], footer: 'TST-2' }));
		expect(tzifOffsetAt(zone, -1)).toBe(0);
		expect(tzifOffsetAt(zone, 0)).toBe(0);
		expect(tzifOffsetAt(zone, 1)).toBe(7200);
	});

	test('converts UNIX leap transition times to POSIX seconds', () => {
		// RFC 9636 defines the first two positive leap occurrences at these values.
		const zone = parseTzif(
			synthetic({
				transitions: [78796801n, 94694402n],
				indices: [1, 0],
				types: [
					{ offset: 0, dst: false },
					{ offset: 3600, dst: true },
				],
				leaps: [
					{ occurrence: 78796800n, correction: 1 },
					{ occurrence: 94694401n, correction: 2 },
				],
			})
		);
		expect(tzifOffsetAt(zone, 78796799)).toBe(0);
		expect(tzifOffsetAt(zone, 78796800)).toBe(3600);
		expect(tzifOffsetAt(zone, 94694399)).toBe(3600);
		expect(tzifOffsetAt(zone, 94694400)).toBe(0);
	});

	test('maps a transition in an inserted second to the next POSIX second', () => {
		const zone = parseTzif(
			synthetic({
				transitions: [78796800n],
				indices: [1],
				types: [
					{ offset: 0, dst: false },
					{ offset: 3600, dst: true },
				],
				leaps: [{ occurrence: 78796800n, correction: 1 }],
			})
		);
		expect(tzifOffsetAt(zone, 78796799)).toBe(0);
		expect(tzifOffsetAt(zone, 78796800)).toBe(3600);
	});

	test('applies a negative leap correction on its occurrence', () => {
		const zone = parseTzif(
			synthetic({
				transitions: [94694400n],
				indices: [1],
				types: [
					{ offset: 0, dst: false },
					{ offset: 3600, dst: true },
				],
				leaps: [
					{ occurrence: 78796800n, correction: 1 },
					{ occurrence: 94694400n, correction: 0 },
				],
			})
		);
		expect(tzifOffsetAt(zone, 94694399)).toBe(0);
		expect(tzifOffsetAt(zone, 94694400)).toBe(3600);
	});
});

describe('POSIX footer calendar rules', () => {
	test('uses the last weekday for week five and changes on the exact second', () => {
		const zone = parseTzif(synthetic({ version: '2', footer: 'CET-1CEST,M3.5.0,M10.5.0/3' }));
		expect(tzifOffsetAt(zone, seconds('2099-03-29T00:59:59Z'))).toBe(3600);
		expect(tzifOffsetAt(zone, seconds('2099-03-29T01:00:00Z'))).toBe(7200);
		expect(tzifOffsetAt(zone, seconds('2099-10-25T00:59:59Z'))).toBe(7200);
		expect(tzifOffsetAt(zone, seconds('2099-10-25T01:00:00Z'))).toBe(3600);
	});

	test('distinguishes Julian days excluding February 29 from zero-based days', () => {
		const julian = parseTzif(synthetic({ footer: 'STD0DST,J60/0,J300/0' }));
		const ordinal = parseTzif(synthetic({ footer: 'STD0DST,59/0,299/0' }));
		expect(tzifOffsetAt(julian, seconds('2024-02-29T00:00:00Z'))).toBe(0);
		expect(tzifOffsetAt(julian, seconds('2024-03-01T00:00:00Z'))).toBe(3600);
		expect(tzifOffsetAt(ordinal, seconds('2024-02-29T00:00:00Z'))).toBe(3600);
		expect(tzifOffsetAt(julian, seconds('2100-03-01T00:00:00Z'))).toBe(3600);
	});

	test('handles southern seasons, negative DST and non-hour changes', () => {
		const south = parseTzif(synthetic({ footer: '<+1030>-10:30<+11>-11,M10.1.0,M4.1.0' }));
		expect(tzifOffsetAt(south, seconds('2099-01-15T00:00:00Z'))).toBe(39600);
		expect(tzifOffsetAt(south, seconds('2099-07-15T00:00:00Z'))).toBe(37800);
		const negative = parseTzif(synthetic({ footer: 'IST-1GMT0,M10.5.0,M3.5.0/1' }));
		expect(tzifOffsetAt(negative, seconds('2099-01-15T00:00:00Z'))).toBe(0);
		expect(tzifOffsetAt(negative, seconds('2099-07-15T00:00:00Z'))).toBe(3600);
	});

	test('handles signed v3 times crossing a year boundary', () => {
		const zone = parseTzif(synthetic({ footer: 'STD0DST,J1/-2,J180/26' }));
		expect(tzifOffsetAt(zone, seconds('2025-12-31T21:59:59Z'))).toBe(0);
		expect(tzifOffsetAt(zone, seconds('2025-12-31T22:00:00Z'))).toBe(3600);
		expect(tzifOffsetAt(zone, seconds('2026-01-01T00:00:00Z'))).toBe(3600);
		expect(tzifOffsetAt(zone, seconds('2026-06-30T00:59:59Z'))).toBe(3600);
		expect(tzifOffsetAt(zone, seconds('2026-06-30T01:00:00Z'))).toBe(0);
	});

	test('handles the v3 permanent-daylight rule including leap years', () => {
		const zone = parseTzif(synthetic({ footer: 'STD0DST,J1/0,J365/25' }));
		for (const date of ['2024-01-01T00:00:00Z', '2024-12-31T23:59:59Z', '2025-01-01T00:00:00Z']) expect(tzifOffsetAt(zone, seconds(date))).toBe(3600);
	});

	test('preserves years 0 through 99 and negative epochs', () => {
		const zone = parseTzif(synthetic({ footer: 'UTC0' }));
		for (const year of [0, 1, 99, 100, 1969]) {
			const value = `${String(year).padStart(4, '0')}-01-01T01:02:03Z`;
			expect(tzifLocalToUtc(zone, { year, month: 1, day: 1, hour: 1, minute: 2, second: 3 })).toBe(seconds(value));
		}
		const dst = parseTzif(synthetic({ footer: 'STD0DST,J60/0,J300/0' }));
		expect(tzifOffsetAt(dst, seconds('0000-02-29T12:00:00Z'))).toBe(0);
		expect(tzifOffsetAt(dst, seconds('0000-03-01T12:00:00Z'))).toBe(3600);
	});
});

describe('malformed TZif data', () => {
	test('rejects truncated blocks and unsupported headers', () => {
		const valid = synthetic();
		for (const length of [0, 4, 43, 44, valid.length - 1]) expect(() => parseTzif(valid.subarray(0, length))).toThrow();
		valid[4] = 0;
		expect(() => parseTzif(valid)).toThrow('version');
		const badMagic = synthetic();
		badMagic[0] = 0xd4;
		expect(() => parseTzif(badMagic)).toThrow('header');
	});

	test('rejects invalid type counts and references before lookup', () => {
		const count = synthetic();
		count.writeUInt32BE(0xffffffff, 32);
		expect(() => parseTzif(count)).toThrow('Truncated');
		const types = synthetic();
		types.writeUInt32BE(0, 36);
		expect(() => parseTzif(types)).toThrow('counts');
		expect(() => parseTzif(synthetic({ transitions: [0n], indices: [1] }))).toThrow('type');
		expect(() => parseTzif(synthetic({ transitions: [1n, 0n] }))).toThrow('Unsorted');
	});

	test('rejects leap tables with unknown prior correction or descending times', () => {
		expect(() => parseTzif(synthetic({ leaps: [{ occurrence: 78796800n, correction: 2 }] }))).toThrow('leap-second');
		expect(() =>
			parseTzif(
				synthetic({
					leaps: [
						{ occurrence: 78796800n, correction: 1 },
						{ occurrence: 78796800n, correction: 2 },
					],
				})
			)
		).toThrow('leap-second');
	});

	test('rejects malformed POSIX rules rather than assuming a host default', () => {
		for (const footer of ['ABC0DEF', 'ABC0DEF,M0.1.0,M10.1.0', 'ABC0DEF,M3.6.0,M10.1.0', 'ABC0DEF,J0,J365', 'ABC0DEF,366,0', 'ABC25', 'ABC0DEF,J1/168,J365', 'ABC0DEF,J1/1:60,J365', 'ABC0\n']) expect(() => parseTzif(synthetic({ footer })), footer).toThrow();
		expect(() => parseTzif(synthetic({ version: '2', footer: 'ABC0DEF,J1/-2,J365' }))).toThrow('v3');
	});

	test('rejects invalid local dates and timestamps', () => {
		const zone = parseTzif(synthetic());
		const local = { year: 2026, month: 2, day: 29, hour: 0, minute: 0, second: 0 };
		expect(() => tzifLocalToUtc(zone, local)).toThrow('date');
		expect(() => tzifLocalToUtc(zone, { ...local, day: 28, hour: 24 })).toThrow('datetime');
		for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER]) expect(() => tzifOffsetAt(zone, value)).toThrow('range');
	});
});
