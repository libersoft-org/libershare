import { expect, it } from 'bun:test';
import { toArrayBuffer, type Pointer } from 'bun:ffi';
import { macVolume, type MacAudioSymbols } from '../../src/native/darwin/audio.ts';

it('resolves the current macOS output for every request and reads back virtual master volume', () => {
	let current = 42,
		level = 0.81;
	const api = {
		AudioObjectGetPropertyData: (_o: unknown, _a: unknown, _q: unknown, _qd: unknown, _s: unknown, out: Pointer) => {
			new Uint32Array(toArrayBuffer(out, 0, 4))[0] = current;
			return 0;
		},
		AudioHardwareServiceGetPropertyData: (device: number, _a: unknown, _q: unknown, _qd: unknown, _s: unknown, out: Pointer) => {
			expect(device).toBe(current);
			new Float32Array(toArrayBuffer(out, 0, 4))[0] = level;
			return 0;
		},
		AudioHardwareServiceSetPropertyData: (device: number, _a: unknown, _q: unknown, _qd: unknown, _s: unknown, value: Pointer) => {
			expect(device).toBe(current);
			level = new Float32Array(toArrayBuffer(value, 0, 4))[0]!;
			return 0;
		},
	} as unknown as MacAudioSymbols;
	expect(macVolume(undefined, api)).toEqual({ kind: 'ok', volume: 81 });
	current = 43;
	expect(macVolume(37, api)).toEqual({ kind: 'ok', volume: 37 });
	current = 0;
	expect(macVolume(undefined, api)).toEqual({ kind: 'no-device' });
});
it('does not return a successful macOS write when the native setter fails', () => {
	const api = {
		AudioObjectGetPropertyData: (_o: unknown, _a: unknown, _q: unknown, _qd: unknown, _s: unknown, out: Pointer) => {
			new Uint32Array(toArrayBuffer(out, 0, 4))[0] = 42;
			return 0;
		},
		AudioHardwareServiceSetPropertyData: () => -1,
	} as unknown as MacAudioSymbols;
	expect(macVolume(37, api)).toEqual({ kind: 'error' });
});
