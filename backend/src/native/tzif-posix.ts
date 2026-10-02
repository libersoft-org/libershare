export interface TzifTimeType {
	readonly offset: number;
	readonly isDst: boolean;
}

type TransitionRule = { kind: 'month'; month: number; week: number; weekday: number; seconds: number } | { kind: 'julian' | 'day'; day: number; seconds: number };

export interface PosixTimezone {
	readonly standard: TzifTimeType;
	readonly daylight: TzifTimeType | null;
	readonly start: TransitionRule | null;
	readonly end: TransitionRule | null;
}

function offsetSeconds(value: string, maxHours: number): number {
	const match = /^([+-]?)(\d{1,3})(?::(\d{2}))?(?::(\d{2}))?$/.exec(value);
	if (!match) throw new Error('Invalid POSIX timezone offset');
	const hours = Number(match[2]);
	const minutes = Number(match[3] ?? 0);
	const seconds = Number(match[4] ?? 0);
	if (hours > maxHours || minutes > 59 || seconds > 59) throw new Error('POSIX timezone offset out of range');
	return (match[1] === '-' ? -1 : 1) * (hours * 3600 + minutes * 60 + seconds);
}

function transitionRule(value: string, version: '2' | '3'): TransitionRule {
	const [date, time, extra] = value.split('/');
	if (extra !== undefined) throw new Error('Invalid POSIX transition rule');
	if (version === '2' && time !== undefined && /^[+-]/.test(time)) throw new Error('Signed transition times require TZif v3');
	const seconds = time === undefined ? 7200 : offsetSeconds(time, version === '3' ? 167 : 24);
	const month = /^M(\d{1,2})\.(\d)\.(\d)$/.exec(date!);
	if (month) {
		const m = Number(month[1]);
		const week = Number(month[2]);
		const weekday = Number(month[3]);
		if (m < 1 || m > 12 || week < 1 || week > 5 || weekday > 6) throw new Error('POSIX month rule out of range');
		return { kind: 'month', month: m, week, weekday, seconds };
	}
	const day = /^(J?)(\d{1,3})$/.exec(date!);
	if (!day) throw new Error('Invalid POSIX transition date');
	const n = Number(day[2]);
	if (n < (day[1] ? 1 : 0) || n > 365) throw new Error('POSIX day rule out of range');
	return { kind: day[1] ? 'julian' : 'day', day: n, seconds };
}

export function parsePosixTimezone(value: string, version: '2' | '3'): PosixTimezone | null {
	if (value === '') return null;
	const name = '(?:[A-Za-z]{3,}|<[A-Za-z0-9+-]{3,}>)';
	const offset = '[+-]?\\d{1,3}(?::\\d{2}){0,2}';
	const match = new RegExp(`^${name}(${offset})(?:(${name})(${offset})?,([^,]+),([^,]+))?$`).exec(value);
	if (!match) throw new Error('Invalid POSIX timezone footer');
	const standard: TzifTimeType = { offset: -offsetSeconds(match[1]!, 24) || 0, isDst: false };
	if (match[2] === undefined) return { standard, daylight: null, start: null, end: null };
	const daylight: TzifTimeType = { offset: match[3] === undefined ? standard.offset + 3600 : -offsetSeconds(match[3], 24) || 0, isDst: true };
	return { standard, daylight, start: transitionRule(match[4]!, version), end: transitionRule(match[5]!, version) };
}

// Date.UTC treats years 0..99 as 1900..1999; setUTCFullYear preserves them.
export function civilSeconds(year: number, month: number, day: number): number {
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	return date.getTime() / 1000;
}

function transitionWall(rule: TransitionRule, year: number): number {
	if (rule.kind === 'month') {
		const first = new Date(civilSeconds(year, rule.month, 1) * 1000).getUTCDay();
		let day = 1 + ((rule.weekday - first + 7) % 7) + (rule.week - 1) * 7;
		const daysInMonth = new Date(civilSeconds(year, rule.month + 1, 0) * 1000).getUTCDate();
		if (day > daysInMonth) day -= 7;
		return civilSeconds(year, rule.month, day) + rule.seconds;
	}
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const day = rule.kind === 'day' ? rule.day : rule.day - 1 + (leap && rule.day >= 60 ? 1 : 0);
	return civilSeconds(year, 1, 1) + day * 86400 + rule.seconds;
}

export function posixTimeTypeAt(zone: PosixTimezone, epochSeconds: number): TzifTimeType {
	if (!zone.daylight || !zone.start || !zone.end) return zone.standard;
	const year = new Date(epochSeconds * 1000).getUTCFullYear();
	let latest = -Infinity;
	let type = zone.standard;
	// A v3 transition may fall up to 167 hours outside its named calendar year.
	for (let y = year - 2; y <= year + 1; y++) {
		const end = transitionWall(zone.end, y) - zone.daylight.offset;
		if (end <= epochSeconds && end >= latest) {
			latest = end;
			type = zone.standard;
		}
		const start = transitionWall(zone.start, y) - zone.standard.offset;
		if (start <= epochSeconds && start >= latest) {
			latest = start;
			type = zone.daylight;
		}
	}
	return type;
}
