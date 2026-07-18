import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';

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
 *
 * RDP note: in a Remote Desktop session the only render endpoint is "Remote
 * Audio", whose endpoint master is the real per-session knob attenuating the
 * audio stream — this is what we read and write. The tray slider in that session
 * instead drives client-side RDP dynamic volume and is decoupled from the
 * endpoint master (verified: setting master to 30 leaves the tray unchanged, and
 * moving the tray to 81 leaves master at 30). On a physical console the tray and
 * the endpoint master are the same control.
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
 * Read the OS volume, distinguishing three outcomes:
 * - `{ available: true, volume }` — a device answered.
 * - `{ available: false, volume: null }` — the OS confirms there is NO
 *   controllable device (verified absence): a headless box, no ALSA/PulseAudio
 *   mixer, a Windows host whose `GetDefaultAudioEndpoint` returns
 *   ELEMENT_NOT_FOUND, or a macOS `osascript` read that fails.
 * - `null` — a transient failure (PowerShell timeout, a passing CoreAudio
 *   error): availability is INDETERMINATE, the device likely still exists.
 *   Callers MUST keep their last known availability instead of treating this as
 *   device-less, so a hiccup never flips a present device to "unavailable".
 */
export async function getSystemVolumeStatus(): Promise<VolumeStatus | null> {
	const r = await readMixer();
	if (r.kind === 'ok') return { available: true, volume: r.volume };
	if (r.kind === 'no-device') return { available: false, volume: null };
	return null; // transient error — indeterminate
}

/** A snapshot of the OS volume: the level (0–100, or null when unavailable) and whether a device exists. */
export interface VolumeStatus {
	volume: number | null;
	available: boolean;
}

/**
 * The public shape returned by {@link setSystemVolume}. `volume` is the level
 * actually applied to the mixer (null when nothing was written) — under the
 * latest-wins serializer this is the final written value, which may differ from
 * the value an individual (coalesced) caller requested. Callers seeding the
 * watcher must use this, not their requested value, or they re-seed with a stale
 * level and the next poll misreads their own write as an external change.
 */
export interface VolumeResult {
	success: boolean;
	available: boolean;
	volume: number | null;
}

function mapWrite(r: MixerResult, pct: number): VolumeResult {
	if (r.kind === 'ok') return { success: true, available: true, volume: pct };
	if (r.kind === 'no-device') return { success: false, available: false, volume: null };
	return { success: false, available: true, volume: null };
}

/**
 * Grace period after a write finishes during which the mixer is still treated as
 * busy. Covers the micro-window where the OS getter can still report the old
 * level for a moment after `Set...` returns (propagation latency), which would
 * otherwise be misread as an external change.
 */
const WRITE_SETTLE_MS = 1000;

/** A serialized writer plus a flag telling whether a write is active or still settling. */
export interface SerializedWriter<R> {
	run: (value: number) => Promise<R>;
	isBusy: () => boolean;
}

/**
 * Wrap an async writer so calls never overlap and only the newest queued value
 * is applied (latest-wins, queue depth 1). While a write runs, every new call
 * records only the most recent value and shares one promise; when the running
 * write finishes, the newest queued value (if any) is written next and the
 * intermediates are skipped. So N rapid calls cause at most two real writes and
 * the target always ends on the last requested value. Callers whose value was
 * coalesced resolve with the result of the write that superseded them.
 *
 * `isBusy()` is true while a write is in flight or within {@link WRITE_SETTLE_MS}
 * of the last one finishing, so a concurrent reader (the volume watcher) can skip
 * and avoid racing a not-yet-settled write.
 */
export function createSerializedWriter<R>(write: (value: number) => Promise<R>): SerializedWriter<R> {
	let running = false;
	let lastWriteEnd = 0;
	let queued: number | null = null;
	let queuedResult: Promise<R> | null = null;
	let resolveQueued: ((r: R) => void) | null = null;

	async function run(value: number): Promise<R> {
		if (running) {
			queued = value;
			if (!queuedResult) queuedResult = new Promise<R>(res => (resolveQueued = res));
			return queuedResult;
		}
		running = true;
		let result = await write(value);
		while (queued !== null) {
			const next = queued;
			queued = null;
			const resolve = resolveQueued!;
			queuedResult = null;
			resolveQueued = null;
			result = await write(next);
			resolve(result);
		}
		running = false;
		lastWriteEnd = Date.now();
		return result;
	}

	return { run, isBusy: () => running || Date.now() - lastWriteEnd < WRITE_SETTLE_MS };
}

const serializedWrite = createSerializedWriter<VolumeResult>(async pct => mapWrite(await writeMixer(pct), pct));

/** True while a mixer write is in flight or still settling — the watcher skips its poll then. */
export function isMixerWriteBusy(): boolean {
	return serializedWrite.isBusy();
}

/**
 * Set the OS master output volume. `percent` is clamped to 0–100. Applied via
 * built-in tooling only (no native addons): Windows CoreAudio COM, macOS
 * `osascript`, Linux `amixer` with a `pactl` fallback.
 *
 * A single node process owns the OS mixer, so writes are serialized latest-wins
 * (see {@link createSerializedWriter}): concurrent calls never overlap and the
 * mixer always ends on the newest requested value. A call whose value was
 * superseded before it ran resolves with the result of the coalescing write.
 *
 * Returns `{ success, available }`: `success` is whether the OS volume actually
 * changed; `available` is whether a controllable device exists. They differ only
 * on a transient error (`{ success: false, available: true }`) — a genuinely
 * device-less system returns `{ success: false, available: false }`. Never
 * throws, so a headless host cannot crash the backend.
 */
export function setSystemVolume(percent: number): Promise<VolumeResult> {
	return serializedWrite.run(clampPercent(percent));
}

/**
 * Watch for OS-side volume changes (system tray, media keys, a device being
 * plugged/unplugged) and surface them. Each {@link VolumeWatcher.poll} reads the
 * current status and, when it differs from the last one seen, persists the new
 * level and broadcasts it. `remember` is called after our own writes so a
 * self-initiated change does not echo back as an external one.
 *
 * `isBusy` lets the poll skip entirely while a mixer write is active or settling,
 * so a poll cannot read a not-yet-applied value and mistake it for an external
 * change. Deps are injected so the diff/echo logic is testable without spawning
 * the OS mixer tooling.
 */
export interface VolumeWatcher {
	poll: () => Promise<void>;
	/** Feed a known status (from the instant push monitor) through the same diff/broadcast path as poll. */
	ingest: (status: VolumeStatus) => void;
	remember: (status: VolumeStatus) => void;
	/** Last observed availability (true until the first reading), used to gate the push monitor. */
	available: () => boolean;
}

export function createVolumeWatcher(deps: { getStatus: () => Promise<VolumeStatus | null>; broadcast: (status: VolumeStatus) => void; persist: (volume: number) => void; isBusy: () => boolean }): VolumeWatcher {
	let last: VolumeStatus | null = null;
	let polling = false;

	// Diff a fresh status against the last one seen; on a real change persist and
	// broadcast it. Shared by poll (fallback) and the instant push monitor.
	function ingest(status: VolumeStatus): void {
		if (last !== null && last.volume === status.volume && last.available === status.available) return;
		last = status;
		// The user changed the level via the OS — keep the persisted preference in sync.
		if (status.available && status.volume !== null) deps.persist(status.volume);
		deps.broadcast(status);
	}

	return {
		ingest,
		available: () => (last === null ? true : last.available),
		remember(status: VolumeStatus): void {
			last = status;
		},
		async poll(): Promise<void> {
			// A mixer write is in flight or settling — reading now could race it.
			if (deps.isBusy()) return;
			// A previous poll is still reading (a slow getter can outlast the poll
			// interval) — skip so reads never overlap or resolve out of order.
			if (polling) return;
			polling = true;
			try {
				const status = await deps.getStatus();
				// Transient read error (indeterminate) — keep the last known state, do
				// not broadcast, so a hiccup never reports a present device as gone.
				if (status === null) return;
				ingest(status);
			} finally {
				polling = false;
			}
		},
	};
}

/** Handle to a running instant-volume monitor process. */
export interface VolumeMonitor {
	stop: () => void;
}

/** How often the persistent Windows monitor re-reads the endpoint (sub-second push latency). */
const WINDOWS_MONITOR_POLL_MS = 150;

/**
 * Windows CoreAudio push monitor. ONE long-running PowerShell process activates
 * the default render endpoint once and then tight-loops `GetMasterVolumeLevel-
 * Scalar` every {@link WINDOWS_MONITOR_POLL_MS} in-process, printing the new
 * level (0–100, invariant) to stdout whenever it changes. This is a persistent
 * process, not a per-check spawn: each read is a cheap in-process COM call, so
 * latency is sub-second without repeatedly launching PowerShell.
 *
 * ponytail: chosen over IAudioEndpointVolumeCallback — that COM callback proved
 * unreliable here (the host process died with exit code 5 after the first
 * notification, a fragile CCW/apartment interaction). A 150 ms in-process loop
 * gives the same sub-second result robustly. It binds the default endpoint at
 * spawn; a device switch is caught by the 5 s poll fallback and a monitor
 * respawn on availability flip (see the poll-driven lifecycle in system.ts).
 */
const WINDOWS_MONITOR_CSHARP = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Globalization;
using System.Threading;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid ctx);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid iid, int ctx, int p, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice ep); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class VolMonitor {
  public static void Start() {
    var en = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev;
    if (en.GetDefaultAudioEndpoint(0, 1, out dev) != 0) return;
    IAudioEndpointVolume epv;
    var iid = typeof(IAudioEndpointVolume).GUID;
    if (dev.Activate(ref iid, 23, 0, out epv) != 0) return;
    int last = -1;
    int errors = 0;
    while (true) {
      float v;
      if (epv.GetMasterVolumeLevelScalar(out v) == 0) {
        errors = 0;
        int pct = (int)Math.Round(v * 100);
        if (pct != last) {
          last = pct;
          Console.WriteLine(pct.ToString(CultureInfo.InvariantCulture));
          Console.Out.Flush();
        }
      } else if (++errors >= 5) {
        return; // endpoint likely gone — exit so the parent respawns on the new default
      }
      Thread.Sleep(${WINDOWS_MONITOR_POLL_MS});
    }
  }
}
'@
[VolMonitor]::Start()
`;

function startWindowsMonitor(emit: (status: VolumeStatus) => void, onExit: () => void): VolumeMonitor {
	const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowershell(WINDOWS_MONITOR_CSHARP)], { windowsHide: true });
	const rl = createInterface({ input: proc.stdout });
	rl.on('line', line => {
		const v = parseMonitorVolume(line);
		if (v !== null) emit({ volume: v, available: true });
	});
	let stopped = false;
	const exit = (): void => {
		if (!stopped) onExit();
	};
	proc.on('exit', exit);
	proc.on('error', exit);
	return {
		stop: () => {
			stopped = true;
			rl.close();
			proc.kill();
		},
	};
}

function startLinuxMonitor(emit: (status: VolumeStatus) => void, onExit: () => void): VolumeMonitor {
	// pactl streams events; a sink change means the default sink volume may have
	// moved — re-read it and diff. (amixer has no push; that path stays on poll.)
	const proc = spawn('pactl', ['subscribe']);
	const rl = createInterface({ input: proc.stdout });
	rl.on('line', async line => {
		if (!/on sink #|on sink\b/i.test(line)) return;
		const status = await getSystemVolumeStatus();
		if (status) emit(status);
	});
	let stopped = false;
	const exit = (): void => {
		if (!stopped) onExit();
	};
	proc.on('exit', exit);
	proc.on('error', exit);
	return {
		stop: () => {
			stopped = true;
			rl.close();
			proc.kill();
		},
	};
}

/** Parse one stdout line from the Windows monitor: a bare integer percentage. */
export function parseMonitorVolume(line: string): number | null {
	return parseMacVolume(line);
}

/**
 * Start the platform's instant OS→FE volume monitor, calling `emit` the moment
 * the OS volume changes and `onExit` if the process dies (so the caller can
 * respawn). Returns a `stop()` handle. On platforms without a push source
 * (macOS, or Linux without pactl) returns a no-op monitor — the caller then
 * relies on the 5s poll fallback alone.
 */
export function startVolumeMonitor(emit: (status: VolumeStatus) => void, onExit: () => void): VolumeMonitor {
	try {
		if (process.platform === 'win32') return startWindowsMonitor(emit, onExit);
		if (process.platform === 'linux') return startLinuxMonitor(emit, onExit);
	} catch (err) {
		console.warn('[system-volume] Failed to start volume monitor:', (err as Error).message);
	}
	return { stop: () => {} };
}
