import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { readWindowsVolume, writeWindowsVolume } from './system-volume-windows.ts';

const execFileAsync = promisify(execFile);

/** Hard cap on how long any volume child process may run before we give up. */
const EXEC_TIMEOUT_MS = 5000;

/**
 * Outcome of talking to the OS mixer.
 * - `ok`: a controllable device answered (for a read, `volume` is 0–100).
 * - `no-device`: the OS reported there is no controllable audio device.
 * - `error`: a transient/unexpected failure — a device may still exist.
 */
export type MixerResult = { kind: 'ok'; volume: number | null } | { kind: 'no-device' } | { kind: 'error' };

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

/**
 * Pick the first parseable volume from a set of mixer readings (pactl, then
 * amixer). `null` entries are binaries that were absent or failed. When nothing
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
	// SIGKILL: the promise settles only after the child actually exits, so a wedged
	// helper ignoring the default SIGTERM would hang the poll loop forever.
	const { stdout } = await execFileAsync(cmd, args, { timeout: EXEC_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true });
	return stdout.toString();
}

/**
 * Run a binary, returning its stdout, or null when the binary is missing or
 * exits non-zero — both definitive "this mixer path yields nothing" answers
 * (e.g. pactl's `Failure: No such entity` on a sink-less host). A TIMEOUT kill
 * is different: the helper exists and may just be wedged, so it is rethrown and
 * the caller's catch classifies it as a transient `error` (indeterminate), never
 * as `no-device` — see the getSystemVolumeStatus contract.
 */
async function tryRun(cmd: string, args: string[]): Promise<string | null> {
	try {
		return await run(cmd, args);
	} catch (err) {
		const e = err as { killed?: boolean; signal?: string | null };
		if (e?.killed || e?.signal) throw err;
		return null;
	}
}

async function readMixer(): Promise<MixerResult> {
	try {
		if (process.platform === 'win32') return readWindowsVolume();
		if (process.platform === 'darwin') {
			// macOS has no clean "no device" signal — treat a failing osascript as
			// unavailable (documented on getSystemVolumeStatus). A timeout is
			// rethrown by tryRun and lands in the transient-error catch below.
			const out = await tryRun('osascript', ['-e', 'output volume of (get volume settings)']);
			if (out === null) return { kind: 'no-device' };
			const v = parseMacVolume(out);
			return v === null ? { kind: 'no-device' } : { kind: 'ok', volume: v };
		}
		// Linux: prefer PulseAudio/PipeWire's default sink — that is the mixer the
		// tray, media keys and our pactl monitor act on. Raw ALSA `Master` can be a
		// different (decoupled) control on such systems, so amixer is only the
		// fallback for pure-ALSA setups without a sound server.
		const pactl = await tryRun('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);
		const amixer = pactl !== null && parseAlsaVolume(pactl) !== null ? null : await tryRun('amixer', ['get', 'Master']);
		return classifyMixerReadings([pactl, amixer]);
	} catch {
		return { kind: 'error' };
	}
}

async function writeMixer(pct: number): Promise<MixerResult> {
	try {
		if (process.platform === 'win32') return writeWindowsVolume(pct);
		if (process.platform === 'darwin') {
			return (await tryRun('osascript', ['-e', `set volume output volume ${pct}`])) === null ? { kind: 'no-device' } : { kind: 'ok', volume: null };
		}
		// Linux: write where we read — the Pulse/PipeWire default sink first,
		// raw ALSA `Master` only as the pure-ALSA fallback.
		if ((await tryRun('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${pct}%`])) !== null) return { kind: 'ok', volume: null };
		if ((await tryRun('amixer', ['set', 'Master', `${pct}%`])) !== null) return { kind: 'ok', volume: null };
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
 * - `null` — a transient failure (a CLI helper timing out, a passing CoreAudio
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
	let settleQueued: { resolve: (r: R) => void; reject: (e: unknown) => void } | null = null;

	async function run(value: number): Promise<R> {
		if (running) {
			queued = value;
			if (!queuedResult) queuedResult = new Promise<R>((resolve, reject) => (settleQueued = { resolve, reject }));
			return queuedResult;
		}
		running = true;
		// A throwing writer must not leave the serializer locked forever or a
		// queued caller hanging: the catch settles any waiter, the finally always
		// releases the lock. (The production writer never throws — this guards the
		// primitive itself against future refactors.)
		try {
			let result = await write(value);
			while (queued !== null) {
				const next = queued;
				queued = null;
				const settle = settleQueued!;
				queuedResult = null;
				settleQueued = null;
				try {
					result = await write(next);
				} catch (err) {
					settle.reject(err);
					throw err;
				}
				settle.resolve(result);
			}
			return result;
		} catch (err) {
			if (settleQueued) settleQueued.reject(err);
			queued = null;
			queuedResult = null;
			settleQueued = null;
			throw err;
		} finally {
			running = false;
			lastWriteEnd = Date.now();
		}
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
 * built-in OS facilities only (no shipped native addons): Windows CoreAudio COM
 * in-process via FFI, macOS `osascript`, Linux `pactl` with an `amixer` fallback.
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
		// A push observed while our own write is in flight or settling reflects an
		// intermediate level, not an external change — drop it. The write seeds
		// the final state via remember() and the poll catches real changes later.
		if (deps.isBusy()) return;
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

/** How often the in-process Windows monitor re-reads the endpoint (sub-second push latency). */
const WINDOWS_MONITOR_POLL_MS = 150;

/** Consecutive failed reads after which the Windows monitor gives up and hands availability back to the 5 s poll. */
const WINDOWS_MONITOR_MAX_ERRORS = 5;

/**
 * Windows push monitor: an in-process timer reading the endpoint master via the
 * CoreAudio FFI every {@link WINDOWS_MONITOR_POLL_MS} — each read is a few
 * microseconds of COM calls, no child process. The default endpoint is
 * re-resolved on every read, so a default-device switch is picked up
 * immediately. After {@link WINDOWS_MONITOR_MAX_ERRORS} consecutive failed
 * reads (device gone, transient COM trouble) it stops and calls `onExit`,
 * letting the 5 s poll drive availability and respawn it when a device is back.
 *
 * ponytail: a fixed 150 ms poll instead of RegisterControlChangeNotify — a
 * COM callback would need a hand-built vtable of JSCallbacks for the same
 * sub-second result; upgrade only if the poll ever shows up in profiles.
 */
function startWindowsMonitor(emit: (status: VolumeStatus) => void, onExit: () => void): VolumeMonitor {
	let last: number | null = null;
	let errors = 0;
	const timer = setInterval(() => {
		const r = readWindowsVolume();
		if (r.kind === 'ok' && r.volume !== null) {
			errors = 0;
			if (r.volume !== last) {
				last = r.volume;
				emit({ volume: r.volume, available: true });
			}
		} else if (++errors >= WINDOWS_MONITOR_MAX_ERRORS) {
			clearInterval(timer);
			onExit();
		}
	}, WINDOWS_MONITOR_POLL_MS);
	return { stop: () => clearInterval(timer) };
}

/** True for a pactl `subscribe` line about a sink (`Event 'change' on sink #3`). Deliberately not matching `sink-input` — per-stream events fire constantly during playback and say nothing about the master volume. */
export function isSinkEvent(line: string): boolean {
	return /on sink #/i.test(line);
}

function startLinuxMonitor(emit: (status: VolumeStatus) => void, onExit: () => void): VolumeMonitor {
	// pactl streams events; a sink change means the default sink volume may have
	// moved — re-read it and diff. (amixer has no push; that path stays on poll.)
	const proc = spawn('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'] });
	const rl = createInterface({ input: proc.stdout! });
	// Sink events arrive in bursts (dragging a tray slider emits dozens); run one
	// mixer read at a time and a single trailing re-read after a burst instead of
	// spawning a reader process per event.
	let reading = false;
	let pending = false;
	async function refresh(): Promise<void> {
		if (reading) {
			pending = true;
			return;
		}
		reading = true;
		try {
			do {
				pending = false;
				const status = await getSystemVolumeStatus();
				if (status) emit(status);
			} while (pending);
		} finally {
			reading = false;
		}
	}
	rl.on('line', line => {
		if (isSinkEvent(line)) void refresh();
	});
	let stopped = false;
	const exit = (): void => {
		if (stopped) return;
		// Latch: a child can emit both 'error' and 'exit' — onExit must run once,
		// or the second call would tear down a replacement monitor already started.
		stopped = true;
		onExit();
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
