import { ptr, type Library } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';
import type { MixerResult } from '../../system-volume.ts';

const symbols = {
	AudioObjectGetPropertyData: { args: ['u32', 'ptr', 'u32', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
	AudioHardwareServiceGetPropertyData: { args: ['u32', 'ptr', 'u32', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
	AudioHardwareServiceSetPropertyData: { args: ['u32', 'ptr', 'u32', 'ptr', 'u32', 'ptr'], returns: 'i32' },
} as const;
export type MacAudioSymbols = Library<typeof symbols>['symbols'];
let library: Library<typeof symbols> | undefined;
function audio(): MacAudioSymbols {
	return (library ??= loadSystemLibrary('/System/Library/Frameworks/AudioToolbox.framework/AudioToolbox', symbols)).symbols;
}

export function macVolume(percent?: number, api: MacAudioSymbols = audio()): MixerResult {
	const device = new Uint32Array(1);
	const size = new Uint32Array([4]);
	const address = new Uint32Array([0x644f7574, 0x676c6f62, 0]); // dOut, glob
	if (api.AudioObjectGetPropertyData(1, ptr(address), 0, null, ptr(size), ptr(device)) !== 0) return { kind: 'error' };
	if (!device[0]) return { kind: 'no-device' };
	if (size[0] !== 4) return { kind: 'error' };
	address.set([0x766d7663, 0x6f757470, 0]); // vmvc, outp: virtual master includes every output channel.
	if (percent !== undefined) {
		if (!Number.isFinite(percent)) return { kind: 'error' };
		const value = new Float32Array([Math.max(0, Math.min(100, Math.round(percent))) / 100]);
		if (api.AudioHardwareServiceSetPropertyData(device[0], ptr(address), 0, null, 4, ptr(value)) !== 0) return { kind: 'error' };
	}
	const value = new Float32Array(1);
	if (api.AudioHardwareServiceGetPropertyData(device[0], ptr(address), 0, null, ptr(size), ptr(value)) !== 0 || size[0] !== 4 || !Number.isFinite(value[0])) return { kind: 'error' };
	return { kind: 'ok', volume: Math.round(Math.min(1, Math.max(0, value[0]!)) * 100) };
}

export function readMacVolume(): MixerResult {
	return macVolume();
}
export function writeMacVolume(percent: number): MixerResult {
	return macVolume(percent);
}
