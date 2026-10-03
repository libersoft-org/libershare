import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { darwinLocalToUtc } from '../../src/native/darwin/time-clock.ts';
import { prepareDarwinClock } from '../../src/native/darwin/time-native.ts';
import { parseTzif, tzifOffsetAt, type TzifLocalTime, type TzifZone } from '../../src/native/tzif.ts';

function local(seconds: number): TzifLocalTime {
	const date = new Date(seconds * 1000);
	return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
}

function transitionCases(zone: TzifZone): TzifLocalTime[] {
	const walls = new Set<number>();
	for (const year of [1900, 1969, 1970, 2026, 2038, 2050]) for (const month of [0, 6]) walls.add(Date.UTC(year, month, 15, 12, 34, 56) / 1000);
	for (const value of zone.transitions) {
		const utc = Number(value);
		if (utc < Date.UTC(1900, 0, 1) / 1000 || utc > Date.UTC(2051, 0, 1) / 1000) continue;
		const a = utc + tzifOffsetAt(zone, utc - 1),
			b = utc + tzifOffsetAt(zone, utc);
		const low = Math.min(a, b),
			high = Math.max(a, b);
		for (const point of [low - 1, low, Math.floor((low + high) / 2), high - 1, high, high + 1]) walls.add(point);
	}
	return [...walls].map(local).filter(value => value.year >= 1900 && value.year <= 2050);
}

describe.skipIf(process.platform !== 'darwin')('live Darwin clock oracle without OS writes', () => {
	let directory = '';
	let executable = '';
	beforeAll(async () => {
		directory = mkdtempSync(join(tmpdir(), 'lish-darwin-clock-'));
		executable = join(directory, 'oracle');
		const compiler = Bun.spawn(['/usr/bin/clang', '-O2', fileURLToPath(new URL('../helpers/darwin-mktime-oracle.c', import.meta.url)), '-o', executable], { stdout: 'pipe', stderr: 'pipe' });
		const [exit, error] = await Promise.all([compiler.exited, new Response(compiler.stderr).text()]);
		if (exit !== 0) throw new Error(error);
	}, 30000);
	afterAll(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	async function oracle(cases: TzifLocalTime[], zoneFile?: string): Promise<number[]> {
		const env = { ...process.env };
		delete env['TZ'];
		if (zoneFile) env['TZ'] = ':' + zoneFile;
		const child = Bun.spawn([executable], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
		child.stdin.write(cases.map(value => [value.year, value.month, value.day, value.hour, value.minute, value.second].join(' ')).join('\n') + '\n');
		child.stdin.end();
		const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		if (exit !== 0) throw new Error(error);
		return output.trim().split('\n').map(Number);
	}

	test('matches native mktime around timezone transitions, folds and gaps', async () => {
		let checked = 0;
		for (const name of ['Europe/Prague', 'America/New_York', 'Australia/Lord_Howe', 'UTC', 'Europe/Dublin', 'Pacific/Chatham', 'Africa/Casablanca', 'Antarctica/Troll', 'Pacific/Apia', 'Asia/Kathmandu', 'Europe/London', 'America/St_Johns']) {
			const path = '/var/db/timezone/zoneinfo/' + name;
			const zone = parseTzif(readFileSync(path));
			const cases = transitionCases(zone);
			const expected = await oracle(cases, path);
			expect(expected).toHaveLength(cases.length);
			for (const [index, value] of cases.entries()) {
				let actual: number;
				try {
					actual = darwinLocalToUtc(zone, value);
				} catch {
					actual = -1;
				}
				expect(actual, `${name} ${JSON.stringify(value)}`).toBe(expected[index]!);
			}
			checked += cases.length;
		}
		console.log(`Darwin mktime oracle: ${checked} local times matched`);
	}, 120000);

	test('the real host clock conversion ignores inherited TZ without changing it', async () => {
		const inherited = process.env['TZ'];
		const clock = { hours: 12, minutes: 34, seconds: 56 };
		const result = prepareDarwinClock(clock);
		const [year, month, day] = result.reference.localDate.split('-').map(Number);
		const expected = await oracle([{ year: year!, month: month!, day: day!, hour: clock.hours, minute: clock.minutes, second: clock.seconds }]);
		expect(result.targetUtcMs).toBe(expected[0]! * 1000);
		expect(process.env['TZ']).toBe(inherited);
	});
});
