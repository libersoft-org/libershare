import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Hard cap on how long any volume child process may run before we give up. */
const EXEC_TIMEOUT_MS = 5000;

/**
 * Windows lacks a built-in command-line volume control, so we drive the
 * CoreAudio `IAudioEndpointVolume` COM interface from an inline C# type compiled
 * at runtime via PowerShell `Add-Type`. The scalar API (Get/SetMasterVolume-
 * LevelScalar) works on a 0.0–1.0 float. The single-letter method stubs are
 * unused vtable slots kept only to preserve the COM interface layout — the
 * ordering matches `endpointvolume.h`, so `SetMasterVolumeLevelScalar` lands at
 * slot 5 and `GetMasterVolumeLevelScalar` at slot 7.
 */
const WINDOWS_AUDIO_CSHARP = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
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
  static IAudioEndpointVolume Endpoint() {
    var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume epv = null;
    var epvGuid = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref epvGuid, 23, 0, out epv));
    return epv;
  }
  public static float Get() { float v = 0; Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v)); return v; }
  public static void Set(float v) { Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(v, Guid.Empty)); }
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
 * percentage is present.
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

/** Run a binary with args, returning trimmed stdout. Throws on missing binary or non-zero exit. */
async function run(cmd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync(cmd, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true });
	return stdout.toString();
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

/**
 * Set the OS master output volume. `percent` is clamped to 0–100.
 *
 * Per platform (all via built-in tooling, no native addons):
 * - Windows: PowerShell + inline CoreAudio COM (`SetMasterVolumeLevelScalar`).
 * - macOS: `osascript -e 'set volume output volume <pct>'`.
 * - Linux: `amixer set Master <pct>%`, falling back to
 *   `pactl set-sink-volume @DEFAULT_SINK@ <pct>%` when ALSA's amixer is absent.
 *
 * Never throws: a headless box or a missing mixer binary logs a warning and
 * returns false so the caller (and the backend) keep running.
 */
export async function setSystemVolume(percent: number): Promise<boolean> {
	const pct = clampPercent(percent);
	try {
		if (process.platform === 'win32') {
			await runPowershell(`${WINDOWS_AUDIO_CSHARP}\n[AudioEndpoint]::Set(${(pct / 100).toFixed(4)})`);
			return true;
		}
		if (process.platform === 'darwin') {
			await run('osascript', ['-e', `set volume output volume ${pct}`]);
			return true;
		}
		// Linux: prefer ALSA's amixer, fall back to PulseAudio/PipeWire's pactl.
		try {
			await run('amixer', ['set', 'Master', `${pct}%`]);
			return true;
		} catch {
			await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${pct}%`]);
			return true;
		}
	} catch (err) {
		console.warn(`[system-volume] Failed to set system volume to ${pct}%:`, (err as Error).message);
		return false;
	}
}

/**
 * Read the current OS master output volume as 0–100, or null when it cannot be
 * determined (no mixer, headless system, unsupported platform). Callers that
 * need a guaranteed value should fall back to the persisted `audio.volume`
 * setting — every platform here implements a real getter, but hardware without
 * a mixer (CI, headless servers) legitimately yields null.
 */
export async function getSystemVolume(): Promise<number | null> {
	try {
		if (process.platform === 'win32') {
			// Force invariant culture so the scalar is printed with a '.' decimal
			// separator — under locales that use ',' (e.g. cs-CZ) the default
			// formatting would emit "0,3", which parses as 0.
			return parseWindowsVolume(await runPowershell(`${WINDOWS_AUDIO_CSHARP}\n[System.Console]::WriteLine(([AudioEndpoint]::Get()).ToString([System.Globalization.CultureInfo]::InvariantCulture))`));
		}
		if (process.platform === 'darwin') {
			return parseMacVolume(await run('osascript', ['-e', 'output volume of (get volume settings)']));
		}
		try {
			return parseAlsaVolume(await run('amixer', ['get', 'Master']));
		} catch {
			return parseAlsaVolume(await run('pactl', ['get-sink-volume', '@DEFAULT_SINK@']));
		}
	} catch (err) {
		console.warn('[system-volume] Failed to read system volume:', (err as Error).message);
		return null;
	}
}
