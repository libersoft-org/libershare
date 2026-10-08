import { tzifTimeTypeAt, type TzifLocalTime, type TzifZone } from '../tzif.ts';
import { civilSeconds, type TzifTimeType } from '../tzif-posix.ts';

const MIN_TIME = -(1n << 63n);
const MAX_TIME = (1n << 63n) - 1n;

/** Darwin time2sub returns the first binary-search match, not a fixed side of a fold. */
function search(zone: TzifZone, types: readonly TzifTimeType[], wall: number, isDst: boolean | null): number | null {
	const target = BigInt(wall);
	const offsets = types.map(type => type.offset);
	if (zone.footer) offsets.push(zone.footer.standard.offset);
	const minimumOffset = BigInt(Math.min(...offsets));
	const maximumOffset = BigInt(Math.max(...offsets));
	let low = MIN_TIME;
	let high = MAX_TIME;
	for (;;) {
		// BigInt division truncates toward zero, like Darwin's signed time_t division.
		let time = low / 2n + high / 2n;
		if (time < low) time = low;
		else if (time > high) time = high;
		let direction: number;
		if (time + minimumOffset > target) direction = 1;
		else if (time + maximumOffset < target) direction = -1;
		else direction = Math.sign(Number(time) + tzifTimeTypeAt(zone, Number(time)).offset - wall);
		if (direction === 0) {
			const found = Number(time);
			if (isDst === null || tzifTimeTypeAt(zone, found).isDst === isDst) return found;
			// time2sub searches type indices in reverse when the requested DST flag differs.
			for (let i = types.length - 1; i >= 0; i--) {
				const desired = types[i]!;
				if (desired.isDst !== isDst) continue;
				for (let j = types.length - 1; j >= 0; j--) {
					const other = types[j]!;
					if (other.isDst === isDst) continue;
					const candidate = found + other.offset - desired.offset;
					const actual = tzifTimeTypeAt(zone, candidate);
					if (candidate + actual.offset === wall && actual.isDst === isDst) return candidate;
				}
			}
			return null;
		}
		if (time === low) {
			time++;
			low++;
		} else if (time === high) {
			time--;
			high--;
		}
		if (low > high) return null;
		if (direction > 0) high = time;
		else low = time;
	}
}

/** Apple Libc-1698.140.3, stdtime/FreeBSD/localtime.c: time2sub/time1, PCTS, tm_isdst=-1 (public domain). */
export function darwinLocalToUtc(zone: TzifZone, local: TzifLocalTime): number {
	const { year, month, day, hour, minute, second } = local;
	if (![year, month, day, hour, minute, second].every(Number.isInteger) || year < 1900 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) throw new RangeError('Invalid Darwin local datetime');
	const midnight = civilSeconds(year, month, day);
	const date = new Date(midnight * 1000);
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new RangeError('Invalid local date');
	const wall = midnight + hour * 3600 + minute * 60 + second;
	const types = [...zone.types];
	const recentTypes: TzifTimeType[] = [];
	if (zone.footer?.daylight) {
		// tzload appends the footer's generated DST/standard types and future transitions.
		types.push(zone.footer.daylight, zone.footer.standard);
		recentTypes.push(zone.footer.standard, zone.footer.daylight);
	}
	const exact = search(zone, types, wall, null);
	if (exact !== null) return exact;
	const seen = new Set<number>();
	for (let i = zone.transitionTypes.length - 1; i >= 0; i--) {
		const index = zone.transitionTypes[i]!;
		if (!seen.has(index)) {
			seen.add(index);
			recentTypes.push(zone.types[index]!);
		}
	}
	// PCTS retries a nonexistent time as standard time shifted into a DST type.
	for (const standard of recentTypes) {
		if (standard.isDst) continue;
		for (const daylight of recentTypes) {
			if (!daylight.isDst) continue;
			const adjusted = wall + daylight.offset - standard.offset;
			if (adjusted < civilSeconds(1900, 1, 1)) continue;
			const found = search(zone, types, adjusted, true);
			if (found !== null) return found;
		}
	}
	throw new Error('Darwin local datetime conversion failed');
}
