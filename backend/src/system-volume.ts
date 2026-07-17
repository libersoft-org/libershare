import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Hard cap on how long any volume child process may run before we give up. */
const EXEC_TIMEOUT_MS = 5000;

/** Sentinel printed by the Windows helper when there is no active audio endpoint. */
const NO_AUDIO_DEVICE = 'NO_AUDIO_DEVICE';

/**
 * Outcome of talking to the OS mixer.
 * - `ok`: a controllable device answered (for a read, `volume` is 0–100).
 * - `no-device`: the OS reported there is no controllable audio device.
 * - `error`: a transient/unexpected failure — a device may still exist.
 */
type MixerResult = { kind: 'ok'; volume: number | null } | { kind: 'no-device' } | { kind: 'error' };

/**
 * Windows lacks a built-in command-line volume control, so we drive the
 * CoreAudio `IAudioEndpointVolume` COM interface from an inline C# type compiled
 * at runtime via PowerShell `Add-Type`. The scalar API (Get/SetMasterVolume-
 * LevelScalar) works on a 0.0–1.0 float. The single-letter method stubs are
 * unused vtable slots kept only to preserve the COM interface layout — the
 * ordering matches `endpointvolume.h`, so `SetMasterVolumeLevelScalar` lands at
 * slot 5 and `GetMasterVolumeLevelScalar` at slot 7. `GetStatus`/`SetStatus`
 * translate HRESULT 0x80070490 (ELEMENT_NOT_FOUND from GetDefaultAudioEndpoint,
 * i.e. no active output device) into the NO_AUDIO_DEVICE sentinel so the caller
 * can distinguish "no device" from a transient COM error.
 */
const WINDOWS_AUDIO_CSHARP = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Globalization;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int dwClsCtx, int pActivationParams, out IAudioEndpointVolume aev);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int f();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class AudioEndpoint {
  const uint E_NOTFOUND = 0x80070490;
  static IAudioEndpointVolume Endpoint() {
    var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume epv = null;
    var epvGuid = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref epvGuid, 23, 0, out epv));
    return epv;
  }
  public static string GetStatus() {
    try { float v = 0; Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v)); return v.ToString(CultureInfo.InvariantCulture); }
    catch (COMException e) { if ((uint)e.HResult == E_NOTFOUND) return "${NO_AUDIO_DEVICE}"; throw; }
  }
  public static string SetStatus(float v) {
    try { Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(v, Guid.Empty)); return "OK"; }
    catch (COMException e) { if ((uint)e.HResult == E_NOTFOUND) return "${NO_AUDIO_DEVICE}"; throw; }
  }
}
'@
`;

/** Clamp to the 0–100 integer range every platform expects. */
function clampPercent(percent: number): number {
	if (!Number.isFinite(percent)) return 0;
	return Math.min(100, Math.max(0, Math.round(percent)));
}

/**
 * Extract the first `NN%` token from `amixer`/`pactl` output (e.g. a mixer line
 * like `Front Left: Playback 65536 [72%] [-8.50dB] [on]`). Returns null when no
 * percentage is present — which also covers `pactl`'s `Failure: No such entity`
 * on a system with no default sink.
 */
export function parseAlsaVolume(output: string): number | null {
	const match = output.match(/(\d{1,3})%/);
	if (!match || !match[1]) return null;
	return clampPercent(parseInt(match[1], 10));
}

/** Parse the bare integer printed by `osascript` (`output volume of ...`). */
export function parseMacVolume(output: string): number | null {
	const match = output.trim().match(/^(\d{1,3})$/);
	if (!match || !match[1]) return null;
	return clampPercent(parseInt(match[1], 10));
}

/** Parse the `0.0`–`1.0` scalar printed by the Windows CoreAudio getter. */
export function parseWindowsVolume(output: string): number | null {
	const scalar = parseFloat(output.trim());
	if (!Number.isFinite(scalar)) return null;
	return clampPercent(scalar * 100);
}

/** Classify the Windows `GetStatus` output into a mixer result. */
export function interpretWindowsRead(output: string): MixerResult {
	const out = output.trim();
	if (out === NO_AUDIO_DEVICE) return { kind: 'no-device' };
	const v = parseWindowsVolume(out);
	return v === null ? { kind: 'error' } : { kind: 'ok', volume: v };
}

/** Classify the Windows `SetStatus` output into a mixer result. */
export function interpretWindowsWrite(output: string): MixerResult {
	const out = output.trim();
	if (out === NO_AUDIO_DEVICE) return { kind: 'no-device' };
	return out === 'OK' ? { kind: 'ok', volume: null } : { kind: 'error' };
}

/**
 * Pick the first parseable volume from a set of mixer readings (amixer, then
 * pactl). `null` entries are binaries that were absent or failed. When nothing
 * yields a percentage the system has no controllable audio device.
 */
export function classifyMixerReadings(outputs: Array<string | null>): MixerResult {
	for (const out of outputs) {
		if (out === null) continue;
		const v = parseAlsaVolume(out);
		if (v !== null) return { kind: 'ok', volume: v };
	}
	return { kind: 'no-device' };
}

/** Run a binary with args, returning trimmed stdout. Throws on missing binary or non-zero exit. */
async function run(cmd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync(cmd, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true });
	return stdout.toString();
}

/** Run a binary, returning its stdout or null when the binary is missing/fails. */
async function tryRun(cmd: string, args: string[]): Promise<string | null> {
	try {
		return await run(cmd, args);
	} catch {
		return null;
	}
}

/**
 * Build the base64 payload for PowerShell `-EncodedCommand`, which expects the
 * script encoded as UTF-16LE. Using an encoded command sidesteps all shell
 * quoting concerns with the inline C#.
 */
function encodePowershell(script: string): string {
	return Buffer.from(script, 'utf16le').toString('base64');
}

async function runPowershell(script: string): Promise<string> {
	const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowershell(script)];
	try {
		return await run('powershell', args);
	} catch {
		// Activating the default audio endpoint can transiently fail with
		// ELEMENT_NOT_FOUND (0x80070490) when the device is momentarily busy —
		// retry once after a short delay before surfacing the error.
		await new Promise(r => setTimeout(r, 200));
		return run('powershell', args);
	}
}

async function readMixer(): Promise<MixerResult> {
	try {
		if (process.platform === 'win32') {
			return interpretWindowsRead(await runPowershell(`${WINDOWS_AUDIO_CSHARP}\n[System.Console]::WriteLine([AudioEndpoint]::GetStatus())`));
		}
		if (process.platform === 'darwin') {
			// macOS has no clean "no device" signal — treat any osascript read failure
			// as unavailable (documented on getSystemVolumeStatus).
			const out = await tryRun('osascript', ['-e', 'output volume of (get volume settings)']);
			if (out === null) return { kind: 'no-device' };
			const v = parseMacVolume(out);
			return v === null ? { kind: 'no-device' } : { kind: 'ok', volume: v };
		}
		// Linux: try ALSA's amixer, then PulseAudio/PipeWire's pactl.
		const amixer = await tryRun('amixer', ['get', 'Master']);
		const pactl = amixer !== null && parseAlsaVolume(amixer) !== null ? null : await tryRun('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);
		return classifyMixerReadings([amixer, pactl]);
	} catch {
		return { kind: 'error' };
	}
}

async function writeMixer(pct: number): Promise<MixerResult> {
	try {
		if (process.platform === 'win32') {
			return interpretWindowsWrite(await runPowershell(`${WINDOWS_AUDIO_CSHARP}\n[System.Console]::WriteLine([AudioEndpoint]::SetStatus(${(pct / 100).toFixed(4)}))`));
		}
		if (process.platform === 'darwin') {
			return (await tryRun('osascript', ['-e', `set volume output volume ${pct}`])) === null ? { kind: 'no-device' } : { kind: 'ok', volume: null };
		}
		// Linux: prefer ALSA's amixer, fall back to PulseAudio/PipeWire's pactl.
		if ((await tryRun('amixer', ['set', 'Master', `${pct}%`])) !== null) return { kind: 'ok', volume: null };
		if ((await tryRun('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${pct}%`])) !== null) return { kind: 'ok', volume: null };
		return { kind: 'no-device' };
	} catch {
		return { kind: 'error' };
	}
}

/**
 * Report whether the OS has a controllable audio device and, if so, its current
 * master volume (0–100).
 *
 * `available` is true only when a device actually answered — a headless box,
 * a system with no ALSA/PulseAudio mixer, or a Windows host with no active
 * endpoint reports `{ available: false, volume: null }` so callers never show a
 * fabricated level. Detection per platform:
 * - Windows: CoreAudio `GetDefaultAudioEndpoint` returning ELEMENT_NOT_FOUND.
 * - Linux: neither `amixer` nor `pactl` yields a percentage (missing binaries,
 *   or `pactl` failing with `No such entity` on a host with no default sink).
 * - macOS: any `osascript` read failure (the platform gives no finer signal, so
 *   a transient read error is also reported as unavailable).
 */
export async function getSystemVolumeStatus(): Promise<{ available: boolean; volume: number | null }> {
	const r = await readMixer();
	return r.kind === 'ok' ? { available: true, volume: r.volume } : { available: false, volume: null };
}

/**
 * Set the OS master output volume. `percent` is clamped to 0–100. Applied via
 * built-in tooling only (no native addons): Windows CoreAudio COM, macOS
 * `osascript`, Linux `amixer` with a `pactl` fallback.
 *
 * Returns `{ success, available }`: `success` is whether the OS volume actually
 * changed; `available` is whether a controllable device exists. They differ only
 * on a transient error (`{ success: false, available: true }`) — a genuinely
 * device-less system returns `{ success: false, available: false }`. Never
 * throws, so a headless host cannot crash the backend.
 */
export async function setSystemVolume(percent: number): Promise<{ success: boolean; available: boolean }> {
	const r = await writeMixer(clampPercent(percent));
	if (r.kind === 'ok') return { success: true, available: true };
	if (r.kind === 'no-device') return { success: false, available: false };
	return { success: false, available: true };
}
