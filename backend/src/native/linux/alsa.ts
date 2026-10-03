import { FFIType, ptr, type Library, type Pointer } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';
import type { MixerResult } from '../../system-volume.ts';

const symbols = {
	snd_mixer_open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	snd_mixer_attach: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
	snd_mixer_selem_register: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	snd_mixer_load: { args: [FFIType.ptr], returns: FFIType.i32 },
	snd_mixer_first_elem: { args: [FFIType.ptr], returns: FFIType.ptr },
	snd_mixer_elem_next: { args: [FFIType.ptr], returns: FFIType.ptr },
	snd_mixer_selem_get_name: { args: [FFIType.ptr], returns: FFIType.cstring },
	snd_mixer_selem_get_index: { args: [FFIType.ptr], returns: FFIType.u32 },
	snd_mixer_selem_is_active: { args: [FFIType.ptr], returns: FFIType.i32 },
	snd_mixer_selem_has_playback_channel: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	snd_mixer_selem_has_playback_volume: { args: [FFIType.ptr], returns: FFIType.i32 },
	snd_mixer_selem_get_playback_volume_range: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	snd_mixer_selem_get_playback_volume: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	snd_mixer_selem_set_playback_volume_all: { args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 },
	snd_mixer_close: { args: [FFIType.ptr], returns: FFIType.i32 },
} as const;

let library: Library<typeof symbols> | undefined;
export function alsaVolume(percent?: number): MixerResult {
	const a = (library ??= loadSystemLibrary('libasound.so.2', symbols)).symbols;
	const out = new BigUint64Array(1);
	let mixer: Pointer | null = null;
	try {
		if (a.snd_mixer_open(ptr(out), 0) < 0) return { kind: 'no-device' };
		mixer = Number(out[0]) as Pointer;
		const name = Buffer.from('default\0');
		if (a.snd_mixer_attach(mixer, ptr(name)) < 0 || a.snd_mixer_selem_register(mixer, null, null) < 0 || a.snd_mixer_load(mixer) < 0) return { kind: 'no-device' };
		for (let element = a.snd_mixer_first_elem(mixer); element; element = a.snd_mixer_elem_next(element)) {
			if (String(a.snd_mixer_selem_get_name(element)) !== 'Master' || a.snd_mixer_selem_get_index(element) !== 0 || !a.snd_mixer_selem_is_active(element) || !a.snd_mixer_selem_has_playback_volume(element)) continue;
			const minimum = new BigInt64Array(1),
				maximum = new BigInt64Array(1),
				value = new BigInt64Array(1);
			if (a.snd_mixer_selem_get_playback_volume_range(element, ptr(minimum), ptr(maximum)) < 0) return { kind: 'no-device' };
			const low = Number(minimum[0]),
				high = Number(maximum[0]);
			if (high <= low) return { kind: 'no-device' };
			let channel = 0;
			while (channel < 32 && !a.snd_mixer_selem_has_playback_channel(element, channel)) channel++;
			if (channel === 32) return { kind: 'no-device' };
			if (percent !== undefined && a.snd_mixer_selem_set_playback_volume_all(element, BigInt(low + Math.round(((high - low) * percent) / 100))) < 0) return { kind: 'no-device' };
			if (a.snd_mixer_selem_get_playback_volume(element, channel, ptr(value)) < 0) return { kind: 'no-device' };
			return { kind: 'ok', volume: Math.min(100, Math.max(0, Math.round(((Number(value[0]) - low) * 100) / (high - low)))) };
		}
		return { kind: 'no-device' };
	} finally {
		if (mixer) a.snd_mixer_close(mixer);
	}
}
