import { CFunction, dlopen, FFIType, ptr, read, type Pointer } from 'bun:ffi';
import type { MixerResult } from './system-volume.ts';

/**
 * Windows OS master-volume access via the CoreAudio `IAudioEndpointVolume` COM
 * interface, called in-process through `bun:ffi` (ole32.dll). No PowerShell,
 * no runtime code compilation, no child processes — each read/write is a
 * handful of C-ABI calls taking microseconds.
 *
 * COM objects are plain vtables: the object pointer's first field points to a
 * function-pointer table whose slot order is fixed by the interface definition
 * (`mmdeviceapi.h` / `endpointvolume.h`, with IUnknown occupying slots 0–2).
 * The slot constants below encode exactly the layout knowledge the previous
 * runtime-compiled C# helper carried in its stub methods.
 *
 * The default render endpoint is re-resolved on every operation, so a default
 * device switch is picked up immediately and nothing has to be cached or
 * invalidated. HRESULT 0x80070490 (ELEMENT_NOT_FOUND from
 * `GetDefaultAudioEndpoint`, i.e. no active output device) maps to `no-device`;
 * any other failure is a transient `error`.
 *
 * RDP note: in a Remote Desktop session the only render endpoint is "Remote
 * Audio", whose endpoint master is the real per-session knob attenuating the
 * audio stream — this is what we read and write. The tray slider in that
 * session instead drives client-side RDP dynamic volume and is decoupled from
 * the endpoint master (verified: setting master to 30 leaves the tray
 * unchanged, and moving the tray to 81 leaves master at 30). On a physical
 * console the tray and the endpoint master are the same control.
 */

/** HRESULT for ELEMENT_NOT_FOUND — no active render endpoint exists. */
const E_NOTFOUND = 0x80070490;
/** CLSCTX_ALL — let COM pick the server type when activating objects. */
const CLSCTX_ALL = 23;
/** eRender — audio rendering (output) endpoints. */
const DATAFLOW_RENDER = 0;
/** eMultimedia — the default device role for ordinary playback. */
const ROLE_MULTIMEDIA = 1;

// vtable slots (IUnknown = slots 0–2 on every COM interface)
const SLOT_RELEASE = 2;
/** IMMDeviceEnumerator: QI, AddRef, Release, EnumAudioEndpoints, GetDefaultAudioEndpoint */
const SLOT_GET_DEFAULT_AUDIO_ENDPOINT = 4;
/** IMMDevice: QI, AddRef, Release, Activate */
const SLOT_ACTIVATE = 3;
/** IAudioEndpointVolume: ..., 6 SetMasterVolumeLevel, 7 SetMasterVolumeLevelScalar */
const SLOT_SET_MASTER_VOLUME_SCALAR = 7;
/** IAudioEndpointVolume: ..., 8 GetMasterVolumeLevel, 9 GetMasterVolumeLevelScalar */
const SLOT_GET_MASTER_VOLUME_SCALAR = 9;

/** Encode a canonical GUID string into its 16-byte little-endian memory layout. */
function guidBytes(guid: string): Uint8Array {
	const hex = guid.replace(/-/g, '');
	const bytes = new Uint8Array(16);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, parseInt(hex.slice(0, 8), 16), true);
	view.setUint16(4, parseInt(hex.slice(8, 12), 16), true);
	view.setUint16(6, parseInt(hex.slice(12, 16), 16), true);
	for (let i = 0; i < 8; i++) bytes[8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
	return bytes;
}

const CLSID_MMDeviceEnumerator = guidBytes('BCDE0395-E52F-467C-8E3D-C4579291692E');
const IID_IMMDeviceEnumerator = guidBytes('A95664D2-9614-4F35-A746-DE8DB63617E6');
const IID_IAudioEndpointVolume = guidBytes('5CDF2C82-841E-4546-9722-0CF74078229A');

interface Ole32 {
	CoInitializeEx: (reserved: null, coinit: number) => number;
	CoCreateInstance: (clsid: Pointer, outer: null, clsctx: number, iid: Pointer, out: Pointer) => number;
}

let ole32: Ole32 | null = null;

/** Load ole32 and initialize COM once, lazily — importing this module has no side effects on any platform. */
function getOle32(): Ole32 {
	if (!ole32) {
		const lib = dlopen('ole32.dll', {
			CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			CoCreateInstance: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		});
		ole32 = lib.symbols as unknown as Ole32;
		// S_FALSE / RPC_E_CHANGED_MODE only mean COM is already initialized on
		// this thread — it is usable either way, so the result is ignored.
		ole32.CoInitializeEx(null, 0);
	}
	return ole32;
}

// COM vtables are static per class, so trampolines are cached by their actual
// function-pointer address and never freed (the set is tiny and stable).
const trampolines = new Map<Pointer, (...args: unknown[]) => number>();

/** Call a COM method through the object's vtable. `argTypes`/`argValues` exclude the implicit `this`. */
function comCall(obj: Pointer, slot: number, argTypes: FFIType[], argValues: unknown[]): number {
	const vtable = read.ptr(obj, 0) as Pointer;
	const fnPtr = read.ptr(vtable, slot * 8) as Pointer;
	let fn = trampolines.get(fnPtr);
	if (!fn) {
		fn = CFunction({ ptr: fnPtr, returns: FFIType.i32, args: [FFIType.ptr, ...argTypes] }) as unknown as (...args: unknown[]) => number;
		trampolines.set(fnPtr, fn);
	}
	return fn(obj, ...argValues);
}

function release(obj: Pointer): void {
	comCall(obj, SLOT_RELEASE, [], []);
}

/** Map a COM HRESULT to the three-state mixer outcome (`0` = ok, ELEMENT_NOT_FOUND = no-device, anything else = transient error). */
export function classifyHresult(hr: number): 'ok' | 'no-device' | 'error' {
	if (hr === 0) return 'ok';
	return hr >>> 0 === E_NOTFOUND ? 'no-device' : 'error';
}

function failure(hr: number): MixerResult {
	return classifyHresult(hr) === 'no-device' ? { kind: 'no-device' } : { kind: 'error' };
}

/**
 * Resolve the current default render endpoint's `IAudioEndpointVolume`, run
 * `fn` on it and release every interface afterwards. Out-pointers are only
 * dereferenced after their call returned S_OK, so a COM failure can never
 * cause an invalid pointer access.
 */
function withEndpointVolume(fn: (endpoint: Pointer) => MixerResult): MixerResult {
	const out = new BigUint64Array(1);
	const outPtr = ptr(out);
	let hr = getOle32().CoCreateInstance(ptr(CLSID_MMDeviceEnumerator), null, CLSCTX_ALL, ptr(IID_IMMDeviceEnumerator), outPtr);
	if (hr !== 0) return failure(hr);
	const enumerator = Number(out[0]) as Pointer;
	try {
		hr = comCall(enumerator, SLOT_GET_DEFAULT_AUDIO_ENDPOINT, [FFIType.i32, FFIType.i32, FFIType.ptr], [DATAFLOW_RENDER, ROLE_MULTIMEDIA, outPtr]);
		if (hr !== 0) return failure(hr);
		const device = Number(out[0]) as Pointer;
		try {
			hr = comCall(device, SLOT_ACTIVATE, [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], [ptr(IID_IAudioEndpointVolume), CLSCTX_ALL, null, outPtr]);
			if (hr !== 0) return failure(hr);
			const endpoint = Number(out[0]) as Pointer;
			try {
				return fn(endpoint);
			} finally {
				release(endpoint);
			}
		} finally {
			release(device);
		}
	} finally {
		release(enumerator);
	}
}

/** Read the master volume of the current default render endpoint (`ok` carries 0–100). Never throws. */
export function readWindowsVolume(): MixerResult {
	try {
		return withEndpointVolume(endpoint => {
			const level = new Float32Array(1);
			const hr = comCall(endpoint, SLOT_GET_MASTER_VOLUME_SCALAR, [FFIType.ptr], [ptr(level)]);
			if (hr !== 0) return failure(hr);
			return { kind: 'ok', volume: Math.min(100, Math.max(0, Math.round(level[0]! * 100))) };
		});
	} catch {
		return { kind: 'error' };
	}
}

/** Set the master volume of the current default render endpoint. `percent` must already be clamped to 0–100. Never throws. */
export function writeWindowsVolume(percent: number): MixerResult {
	try {
		return withEndpointVolume(endpoint => {
			// The second parameter is an optional event-context GUID pointer; null
			// means "no context", which is what every stock volume UI passes too.
			const hr = comCall(endpoint, SLOT_SET_MASTER_VOLUME_SCALAR, [FFIType.f32, FFIType.ptr], [percent / 100, null]);
			if (hr !== 0) return failure(hr);
			return { kind: 'ok', volume: null };
		});
	} catch {
		return { kind: 'error' };
	}
}
