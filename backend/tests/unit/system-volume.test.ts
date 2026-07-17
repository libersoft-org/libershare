import { describe, expect, it } from 'bun:test';
import { parseAlsaVolume, parseMacVolume, parseWindowsVolume, interpretWindowsRead, interpretWindowsWrite, classifyMixerReadings } from '../../src/system-volume.ts';

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

	it('returns null for pactl failure on a host with no sink', () => {
		expect(parseAlsaVolume('Failure: No such entity')).toBeNull();
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

describe('interpretWindowsRead', () => {
	it('maps the sentinel to no-device', () => {
		expect(interpretWindowsRead('NO_AUDIO_DEVICE\n')).toEqual({ kind: 'no-device' });
	});

	it('maps a scalar to ok with a percentage', () => {
		expect(interpretWindowsRead('0.30')).toEqual({ kind: 'ok', volume: 30 });
	});

	it('maps garbage to a transient error', () => {
		expect(interpretWindowsRead('boom')).toEqual({ kind: 'error' });
	});
});

describe('interpretWindowsWrite', () => {
	it('maps OK to ok', () => {
		expect(interpretWindowsWrite('OK\n')).toEqual({ kind: 'ok', volume: null });
	});

	it('maps the sentinel to no-device', () => {
		expect(interpretWindowsWrite('NO_AUDIO_DEVICE')).toEqual({ kind: 'no-device' });
	});

	it('maps anything else to a transient error', () => {
		expect(interpretWindowsWrite('')).toEqual({ kind: 'error' });
	});
});

describe('classifyMixerReadings', () => {
	it('returns ok from the first parseable reading (amixer)', () => {
		expect(classifyMixerReadings(['Mono: Playback 200 [65%] [on]', null])).toEqual({ kind: 'ok', volume: 65 });
	});

	it('falls back to pactl when amixer is absent', () => {
		expect(classifyMixerReadings([null, 'Volume: front-left: 40000 / 55% / -13 dB'])).toEqual({ kind: 'ok', volume: 55 });
	});

	it('reports no-device when no binary yields a percentage', () => {
		expect(classifyMixerReadings([null, null])).toEqual({ kind: 'no-device' });
		expect(classifyMixerReadings([null, 'Failure: No such entity'])).toEqual({ kind: 'no-device' });
	});
});
