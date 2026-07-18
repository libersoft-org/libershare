import { describe, expect, it } from 'bun:test';
import { parseAlsaVolume, parseMacVolume, parseWindowsVolume, interpretWindowsRead, interpretWindowsWrite, classifyMixerReadings, createSerializedWriter } from '../../src/system-volume.ts';

/** Resolve pending microtasks + timers so the serializer can advance. */
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

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

describe('createSerializedWriter', () => {
	it('serializes overlapping writes and ends on the latest value', async () => {
		const started: number[] = [];
		const releases: Array<() => void> = [];
		const write = (v: number) =>
			new Promise<number>(res => {
				started.push(v);
				releases.push(() => res(v));
			});
		const s = createSerializedWriter(write);

		const p1 = s(30);
		const p2 = s(80);
		await flush();
		expect(started).toEqual([30]); // 80 is queued, not written while 30 runs

		releases[0]!(); // finish write(30)
		await flush();
		expect(started).toEqual([30, 80]); // drain applies the newest queued value

		releases[1]!(); // finish write(80)
		expect(await p2).toBe(80); // coalesced caller gets the final write's result
		await p1;
		expect(started).toEqual([30, 80]); // exactly two real writes for two requests
	});

	it('coalesces a burst to at most two writes', async () => {
		const started: number[] = [];
		const releases: Array<() => void> = [];
		const write = (v: number) =>
			new Promise<number>(res => {
				started.push(v);
				releases.push(() => res(v));
			});
		const s = createSerializedWriter(write);

		void s(10);
		void s(20);
		void s(30);
		void s(40);
		await flush();
		expect(started).toEqual([10]); // only the first started; 20/30 superseded by 40

		releases[0]!();
		await flush();
		releases[1]!();
		await flush();
		expect(started).toEqual([10, 40]); // intermediates skipped, ends on the latest
	});
});
