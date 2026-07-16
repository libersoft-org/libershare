import { describe, expect, it } from 'bun:test';
import { parseAlsaVolume, parseMacVolume, parseWindowsVolume } from '../../src/system-volume.ts';

describe('parseAlsaVolume', () => {
	it('extracts the percentage from an amixer mixer line', () => {
		const out = '  Front Left: Playback 47104 [72%] [-8.50dB] [on]\n  Front Right: Playback 47104 [72%] [-8.50dB] [on]\n';
		expect(parseAlsaVolume(out)).toBe(72);
	});

	it('extracts the percentage from pactl output', () => {
		expect(parseAlsaVolume('Volume: front-left: 42000 /  64% / -12.00 dB')).toBe(64);
	});

	it('clamps out-of-range values', () => {
		expect(parseAlsaVolume('[150%]')).toBe(100);
	});

	it('returns null when no percentage is present', () => {
		expect(parseAlsaVolume('no volume here')).toBeNull();
	});
});

describe('parseMacVolume', () => {
	it('parses the bare integer osascript prints', () => {
		expect(parseMacVolume('45\n')).toBe(45);
	});

	it('returns null for non-numeric output', () => {
		expect(parseMacVolume('missing value')).toBeNull();
	});
});

describe('parseWindowsVolume', () => {
	it('converts a 0..1 scalar to a 0..100 percentage', () => {
		expect(parseWindowsVolume('0.42\n')).toBe(42);
		expect(parseWindowsVolume('1')).toBe(100);
		expect(parseWindowsVolume('0')).toBe(0);
	});

	it('returns null for unparseable output', () => {
		expect(parseWindowsVolume('')).toBeNull();
		expect(parseWindowsVolume('nope')).toBeNull();
	});
});
