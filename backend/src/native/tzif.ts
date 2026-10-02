import { civilSeconds, parsePosixTimezone, posixTimeTypeAt, type PosixTimezone, type TzifTimeType } from './tzif-posix.ts';

export interface TzifZone {
	readonly transitions: readonly bigint[];
	readonly transitionTypes: readonly number[];
	readonly types: readonly TzifTimeType[];
	readonly footer: PosixTimezone | null;
}

export interface TzifLocalTime {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
}

interface Header {
	version: '2' | '3';
	utCount: number;
	standardCount: number;
	leapCount: number;
	timeCount: number;
	typeCount: number;
	charCount: number;
}

function readHeader(bytes: Buffer, at: number): Header {
	if (at + 44 > bytes.length || bytes.toString('latin1', at, at + 4) !== 'TZif') throw new Error('Invalid TZif header');
	const version = bytes.toString('latin1', at + 4, at + 5);
	if (version !== '2' && version !== '3') throw new Error('Unsupported TZif version');
	const header: Header = {
		version,
		utCount: bytes.readUInt32BE(at + 20),
		standardCount: bytes.readUInt32BE(at + 24),
		leapCount: bytes.readUInt32BE(at + 28),
		timeCount: bytes.readUInt32BE(at + 32),
		typeCount: bytes.readUInt32BE(at + 36),
		charCount: bytes.readUInt32BE(at + 40),
	};
	if (header.typeCount < 1 || header.typeCount > 256 || header.charCount < 1) throw new Error('Invalid TZif type counts');
	if (![0, header.typeCount].includes(header.utCount) || ![0, header.typeCount].includes(header.standardCount)) throw new Error('Invalid TZif indicator counts');
	return header;
}

function blockEnd(bytes: Buffer, header: Header, start: number, width: number): number {
	const end = start + header.timeCount * (width + 1) + header.typeCount * 6 + header.charCount + header.leapCount * (width + 4) + header.standardCount + header.utCount;
	if (end > bytes.length) throw new Error('Truncated TZif data');
	return end;
}

function applyLeapCorrections(bytes: Buffer, at: number, count: number, transitions: bigint[]): void {
	let previousOccurrence = -1n;
	let previousCorrection = 0;
	let transition = 0;
	for (let i = 0; i < count; i++) {
		const occurrence = bytes.readBigInt64BE(at + i * 12);
		const correction = bytes.readInt32BE(at + i * 12 + 8);
		if (occurrence <= previousOccurrence || Math.abs(correction - previousCorrection) !== 1) throw new Error('Invalid or truncated TZif leap-second table');
		while (transition < transitions.length && transitions[transition]! < occurrence) {
			transitions[transition] = transitions[transition]! - BigInt(previousCorrection);
			transition++;
		}
		// RFC 9636: transition times use UNIX leap time. POSIX cannot name an
		// inserted second, so its type first applies at the following second.
		if (transition < transitions.length && transitions[transition] === occurrence && correction > previousCorrection) {
			transitions[transition] = occurrence - BigInt(previousCorrection);
			transition++;
		}
		previousOccurrence = occurrence;
		previousCorrection = correction;
	}
	while (transition < transitions.length) {
		transitions[transition] = transitions[transition]! - BigInt(previousCorrection);
		transition++;
	}
}

/** Reads TZif v2/v3 bytes without consulting the host timezone or process TZ. */
export function parseTzif(input: Uint8Array): TzifZone {
	const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	const first = readHeader(bytes, 0);
	const secondAt = blockEnd(bytes, first, 44, 4);
	const header = readHeader(bytes, secondAt);
	if (header.version !== first.version) throw new Error('Mismatched TZif versions');
	const start = secondAt + 44;
	const end = blockEnd(bytes, header, start, 8);
	const transitions: bigint[] = [];
	for (let i = 0; i < header.timeCount; i++) {
		const time = bytes.readBigInt64BE(start + i * 8);
		if (i > 0 && time <= transitions[i - 1]!) throw new Error('Unsorted TZif transitions');
		transitions.push(time);
	}
	const indicesAt = start + header.timeCount * 8;
	const transitionTypes = [...bytes.subarray(indicesAt, indicesAt + header.timeCount)];
	if (transitionTypes.some(type => type >= header.typeCount)) throw new Error('Invalid TZif transition type');
	const typesAt = indicesAt + header.timeCount;
	const charsAt = typesAt + header.typeCount * 6;
	const charsEnd = charsAt + header.charCount;
	if (bytes[charsEnd - 1] !== 0) throw new Error('Unterminated TZif abbreviations');
	const types: TzifTimeType[] = [];
	for (let i = 0; i < header.typeCount; i++) {
		const at = typesAt + i * 6;
		const offset = bytes.readInt32BE(at);
		const dst = bytes[at + 4]!;
		if (offset === -2147483648 || dst > 1 || bytes[at + 5]! >= header.charCount) throw new Error('Invalid TZif local time type');
		types.push({ offset, isDst: dst === 1 });
	}
	applyLeapCorrections(bytes, charsEnd, header.leapCount, transitions);
	const indicatorsAt = charsEnd + header.leapCount * 12;
	for (let i = indicatorsAt; i < end; i++) {
		if (bytes[i]! > 1) throw new Error('Invalid TZif transition indicator');
	}
	for (let i = 0; i < header.utCount; i++) {
		if (bytes[indicatorsAt + header.standardCount + i] === 1 && (header.standardCount === 0 || bytes[indicatorsAt + i] !== 1)) throw new Error('TZif UTC indicator requires standard time');
	}
	if (bytes[end] !== 10 || bytes[bytes.length - 1] !== 10 || end + 2 > bytes.length) throw new Error('Invalid TZif footer framing');
	const footerBytes = bytes.subarray(end + 1, bytes.length - 1);
	if (footerBytes.some(value => value < 32 || value > 126)) throw new Error('Invalid TZif footer characters');
	return { transitions, transitionTypes, types, footer: parsePosixTimezone(footerBytes.toString('ascii'), header.version) };
}

function checkTimestamp(epochSeconds: number): void {
	if (!Number.isFinite(epochSeconds) || Math.abs(epochSeconds) > 8640000000000) throw new RangeError('Timestamp outside the supported calendar range');
}

function timeTypeAt(zone: TzifZone, epochSeconds: number): TzifTimeType {
	const { transitions, footer } = zone;
	// Flooring preserves the side of a transition for fractional negative epochs.
	const seconds = BigInt(Math.floor(epochSeconds));
	if (transitions.length === 0) return footer ? posixTimeTypeAt(footer, epochSeconds) : zone.types[0]!;
	if (seconds < transitions[0]!) return zone.types[0]!;
	if (seconds > transitions[transitions.length - 1]! && footer) return posixTimeTypeAt(footer, epochSeconds);
	let lo = 0;
	let hi = transitions.length - 1;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (transitions[mid]! <= seconds) lo = mid;
		else hi = mid - 1;
	}
	return zone.types[zone.transitionTypes[lo]!]!;
}

/** Returns seconds east of UTC, including historical offsets with second precision. */
export function tzifOffsetAt(zone: TzifZone, epochSeconds: number): number {
	checkTimestamp(epochSeconds);
	return timeTypeAt(zone, epochSeconds).offset;
}

/** Returns POSIX seconds; gap/fold selection matches fresh glibc mktime(tm_isdst=-1). */
export function tzifLocalToUtc(zone: TzifZone, local: TzifLocalTime): number {
	const { year, month, day, hour, minute, second } = local;
	if (![year, month, day, hour, minute, second].every(Number.isInteger) || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) throw new RangeError('Invalid local datetime');
	const midnight = civilSeconds(year, month, day);
	const date = new Date(midnight * 1000);
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new RangeError('Invalid local date');
	const wall = midnight + hour * 3600 + minute * 60 + second;
	checkTimestamp(wall);
	let time = wall;
	// A new systemd parser process starts glibc's offset cache at zero.
	for (let i = 0; i < 8; i++) {
		const current = timeTypeAt(zone, time);
		const next = wall - current.offset;
		checkTimestamp(next);
		if (next === time) return time;
		const candidate = timeTypeAt(zone, next);
		if (wall - candidate.offset === time) return current.isDst !== candidate.isDst ? (current.isDst ? time : next) : next;
		time = next;
	}
	throw new Error('Local datetime conversion did not converge');
}
