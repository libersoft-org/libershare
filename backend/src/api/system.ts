import os from 'os';
import { statfs } from 'fs/promises';
import { readFileSync } from 'fs';
import { type SystemRAMInfo, type SystemStorageInfo, type SystemCPUInfo, type NetIPv4Config, type NetworkStateInfo, type NetWifiNetwork, CodedError, ErrorCodes } from '@shared';
import type { Settings } from '../settings.ts';
import { Utils } from '../utils.ts';
import { setSystemVolume, getSystemVolumeStatus, createVolumeWatcher, isMixerWriteBusy, startVolumeMonitor, type VolumeMonitor } from '../system-volume.ts';
import { applyIPv4, connectWifi, hostMutationInProgress, readSettledNetworkState, scanWifi } from '../system-network.ts';
const assert = Utils.assertParams;
type BroadcastFn = (event: string, data: any) => void;
type HasSubscribersFn = (event: string) => boolean;
const POLL_INTERVAL_MS = 5000;
/**
 * Broadcast the network state on every Nth poll tick (5 s × 2 = 10 s). A read
 * costs a PowerShell spawn on Windows and link state does not change faster than
 * a user notices, so the slower cadence is deliberate.
 */
const NETWORK_POLL_EVERY_N_TICKS = 2;
/**
 * Upper bounds on the network parameters a client may send.
 *
 * `assertParams` only establishes that a value is not `undefined`, so without
 * these an object, an array or a megabyte-long string reaches the platform code
 * and fails somewhere far from the request that caused it. The limits are the
 * widest any real value can be: a Windows adapter GUID is 38 characters, an SSID
 * is 32 octets, and a WPA passphrase is 63 characters or a 64-character hex key.
 */
const MAX_INTERFACE_ID = 64;
const MAX_SSID_PARAM = 64;
const MAX_WIFI_PASSWORD = 128;

/** Require a bounded string, naming the offending parameter when it is not one. */
export function assertString(value: unknown, name: string, maxLength: number, minLength: number = 1): string {
	if (typeof value !== 'string') throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, `${name} must be a string`);
	if (value.length < minLength || value.length > maxLength) throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, `${name} must be ${minLength}-${maxLength} characters`);
	return value;
}

/**
 * Run a host reconfiguration and publish the state it actually left behind,
 * whether it succeeded or not.
 *
 * A platform apply is several commands and is not atomic: it can change the
 * address and then fail on the route, or change it and roll back. An error tells
 * the caller the request did not complete, but says nothing about what the
 * machine now looks like — so on the failure path the client used to keep
 * rendering the configuration from before the attempt, and every other connected
 * client heard nothing at all. Reading and broadcasting on both paths is what
 * makes the published state the real one.
 *
 * The read is uncached by construction: `runHostMutation` invalidates the cache
 * in its own `finally`, so this reaches the platform rather than returning the
 * reading the mutation displaced. It is also taken through
 * `readSettledNetworkState`, which re-acquires the mutation lock — the mutation
 * has released it by the time this runs, so what that buys is the guarantee that
 * a second reconfiguration queued behind this one cannot be halfway through when
 * the state is read. A read that fails as well is swallowed when there is already
 * a mutation error to report — replacing it would hide the reason the user
 * actually needs.
 */
export async function applyAndPublish(mutate: () => Promise<void>, readState: () => Promise<NetworkStateInfo>, broadcast: BroadcastFn): Promise<NetworkStateInfo> {
	let failure: unknown = null;
	try {
		await mutate();
	} catch (err) {
		failure = err;
	}
	let state: NetworkStateInfo | null = null;
	try {
		state = await readState();
		broadcast('system:network', state);
	} catch (readError) {
		if (!failure) throw readError;
	}
	if (failure) throw failure;
	return state as NetworkStateInfo;
}

/**
 * Broadcast the host's network state on the poll tick — unless a reconfiguration
 * is running.
 *
 * Checked twice, because the two failures are different: a mutation already
 * running when the tick fires means the read would be taken mid-apply, and a
 * mutation that starts while the read is in flight (a Windows read takes 1.4-1.8 s)
 * means the answer became a mid-apply reading between the request and the reply.
 * Either way the tick is dropped rather than corrected — see
 * {@link hostMutationInProgress}.
 */
export async function publishNetworkState(readState: () => Promise<NetworkStateInfo>, broadcast: BroadcastFn, mutating: () => boolean = hostMutationInProgress): Promise<void> {
	if (mutating()) return;
	const state = await readState();
	if (mutating()) return;
	broadcast('system:network', state);
}

/** A single CPU-times sample: accumulated idle ticks and total ticks across all cores. */
interface ICpuSample {
	idle: number;
	total: number;
}
interface SystemHandlers {
	ram: () => SystemRAMInfo;
	storage: () => Promise<SystemStorageInfo>;
	cpu: () => SystemCPUInfo;
	setVolume: (p: { volume: number }) => Promise<{ success: boolean; available: boolean }>;
	getVolume: () => Promise<{ volume: number | null; available: boolean }>;
	network: () => Promise<NetworkStateInfo>;
	networkApply: (p: { interfaceID: string; config: NetIPv4Config }) => Promise<NetworkStateInfo>;
	wifiScan: (p: { interfaceID: string }) => Promise<NetWifiNetwork[]>;
	wifiConnect: (p: { interfaceID: string; ssid: string; password?: string }) => Promise<NetworkStateInfo>;
	startPolling: () => void;
	stopPolling: () => void;
}

export function initSystemHandlers(settings: Settings, broadcast: BroadcastFn, hasSubscribers: HasSubscribersFn): SystemHandlers {
	let pollInterval: ReturnType<typeof setInterval> | null = null;
	let volumeMonitor: VolumeMonitor | null = null;

	/**
	 * Persist the volume (the user's preference is kept even with no audio device)
	 * and push it to the OS mixer. Returns whether the OS volume actually changed
	 * and whether a controllable device exists.
	 */
	async function setVolume(p: { volume: number }): Promise<{ success: boolean; available: boolean }> {
		assert(p, ['volume']);
		if (typeof p.volume !== 'number' || !Number.isFinite(p.volume)) throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, 'volume must be a number');
		const pct = Math.min(100, Math.max(0, Math.round(p.volume)));
		writeGeneration++;
		await settings.set('audio.volume', pct);
		const res = await setSystemVolume(pct);
		// A write is as authoritative as a read about device presence — but only its
		// definitive outcomes (ok / no-device). A transient write failure reports
		// available:true conservatively; carrying that into the watcher/broadcast
		// would flip a known device-less host to "available", so an indeterminate
		// result falls back to the last known availability everywhere below.
		const definitive = res.success || !res.available;
		if (definitive) lastKnownAvailable = res.available;
		const available = definitive ? res.available : lastKnownAvailable;
		// Seed the watcher with the value the mixer ACTUALLY ended on (res.volume,
		// which under latest-wins may differ from pct) so its poll does not echo it.
		volumeWatcher.remember({ volume: res.volume, available });
		// The watcher now suppresses this write's echo, so other connected clients
		// (a second window/tab) would never hear about it — tell them directly.
		// Unconditional: a failed write still carries news (a device that vanished
		// mid-write reports available:false, which the suppressed poll would never
		// re-deliver). The originating client ignores the level while its own
		// adjustment is fresh, so this cannot fight the user's in-progress input.
		broadcast('system:volumeChanged', { volume: res.volume, available });
		return { success: res.success, available };
	}

	// Last availability we determined from an unambiguous read/write. A transient
	// read error must never flip this to false, so getVolume reuses it as the
	// fallback rather than reporting a present device as unavailable.
	let lastKnownAvailable = true;
	// Bumped on every setVolume — lets the startup adoption detect a client write
	// that started AFTER its read began (isMixerWriteBusy alone misses a write that
	// already finished settling while a slow read was still in flight).
	let writeGeneration = 0;

	/**
	 * Report the live OS volume and whether a controllable audio device exists.
	 * On a confirmed device-less system volume is null and available false. On a
	 * transient read error (getSystemVolumeStatus returns null) availability is
	 * indeterminate, so we keep the last known availability and fall back to the
	 * persisted level instead of falsely reporting "unavailable".
	 *
	 * `known` is false only for that transient fallback: the returned level is the
	 * persisted preference, not a live reading, so the UI must not open its +/- gate
	 * on it (adjusting from a stale value would move the OS volume once the helper
	 * recovers). A definitive read (device present or confirmed absent) sets known true.
	 */
	async function getVolume(): Promise<{ volume: number | null; available: boolean; known: boolean }> {
		const status = await getSystemVolumeStatus();
		if (status === null) return { volume: lastKnownAvailable ? (settings.get('audio.volume') as number) : null, available: lastKnownAvailable, known: false };
		lastKnownAvailable = status.available;
		if (!status.available) return { volume: null, available: false, known: true };
		return { volume: status.volume ?? (settings.get('audio.volume') as number), available: true, known: true };
	}

	// Detect OS-side volume changes (system tray, media keys, device plug/unplug)
	// and broadcast them to connected clients so the UI stays in sync both ways.
	const volumeWatcher = createVolumeWatcher({
		getStatus: getSystemVolumeStatus,
		broadcast: status => {
			// The watcher only emits definitive statuses — keep the availability cache
			// in sync so a later transient-read fallback reflects device plug/unplug
			// observed through the poll/monitor path too.
			lastKnownAvailable = status.available;
			broadcast('system:volumeChanged', status);
		},
		persist: v => void settings.set('audio.volume', v),
		isBusy: isMixerWriteBusy,
	});

	// Adopt the OS state on startup: read the current volume and take it over as
	// the initial value (watcher seed + persisted preference). The backend must
	// NEVER write to the OS mixer on start — launching the app while the user had
	// set a level via the tray must not yank it back to a stale persisted value.
	// Fire-and-forget; a device-less host logs a single info line.
	const startupGeneration = writeGeneration;
	void getSystemVolumeStatus().then(status => {
		// Transient read error — leave seeding to the first successful poll.
		if (status === null) return;
		// A client write that landed while we were reading is authoritative and has
		// already seeded the watcher — do not clobber it with a pre-write reading.
		// The generation check also catches a write that finished (and settled)
		// while a slow startup read was still in flight.
		if (isMixerWriteBusy() || writeGeneration !== startupGeneration) return;
		lastKnownAvailable = status.available;
		volumeWatcher.remember(status);
		if (status.available && status.volume !== null) void settings.set('audio.volume', status.volume);
		if (!status.available) console.log('[system-volume] No controllable audio device detected; OS volume control disabled.');
	});

	function getLinuxAvailableMem(): number | null {
		try {
			const meminfo = readFileSync('/proc/meminfo', 'utf8');
			const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
			if (!match || !match[1]) return null;
			return parseInt(match[1], 10) * 1024;
		} catch {
			return null;
		}
	}

	// Reads a single integer from a cgroup file. Returns null on error or sentinel "max".
	function readCgroupNumber(path: string): number | null {
		try {
			const raw = readFileSync(path, 'utf8').trim();
			if (raw === 'max' || raw === '') return null;
			const n = parseInt(raw, 10);
			if (!Number.isFinite(n) || n <= 0) return null;
			return n;
		} catch {
			return null;
		}
	}

	// Detect cgroup memory limit + usage (Docker / containers). Returns null if unconstrained.
	// Tries cgroup v2 first, then v1. Treats limits >= host total as "no limit".
	function getCgroupRamInfo(hostTotal: number): SystemRAMInfo | null {
		// cgroup v2
		const v2Limit = readCgroupNumber('/sys/fs/cgroup/memory.max');
		if (v2Limit !== null && v2Limit < hostTotal) {
			const current = readCgroupNumber('/sys/fs/cgroup/memory.current');
			if (current !== null) {
				// memory.current includes page cache; subtract reclaimable to mirror MemAvailable semantics
				let used = current;
				try {
					const stat = readFileSync('/sys/fs/cgroup/memory.stat', 'utf8');
					const fileMatch = stat.match(/^file\s+(\d+)/m);
					if (fileMatch && fileMatch[1]) used -= parseInt(fileMatch[1], 10);
				} catch {}
				return { used: Math.max(0, used), total: v2Limit };
			}
		}
		// cgroup v1
		const v1Limit = readCgroupNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes');
		if (v1Limit !== null && v1Limit < hostTotal) {
			const v1Usage = readCgroupNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes');
			if (v1Usage !== null) {
				let used = v1Usage;
				try {
					const stat = readFileSync('/sys/fs/cgroup/memory/memory.stat', 'utf8');
					const cacheMatch = stat.match(/^total_inactive_file\s+(\d+)/m) ?? stat.match(/^cache\s+(\d+)/m);
					if (cacheMatch && cacheMatch[1]) used -= parseInt(cacheMatch[1], 10);
				} catch {}
				return { used: Math.max(0, used), total: v1Limit };
			}
		}
		return null;
	}

	function getRamInfo(): SystemRAMInfo {
		const hostTotal = os.totalmem();
		// Inside a memory-limited container, report container's limit + usage instead of host RAM.
		if (process.platform === 'linux') {
			const cgroup = getCgroupRamInfo(hostTotal);
			if (cgroup) return cgroup;
		}
		// On Linux, MemAvailable reflects truly usable memory (excludes reclaimable cache/buffers).
		// os.freemem() returns only MemFree, which makes used memory look much higher than reality.
		const available = process.platform === 'linux' ? getLinuxAvailableMem() : null;
		const free = available ?? os.freemem();
		return { used: hostTotal - free, total: hostTotal };
	}

	let prevCpuTimes: ICpuSample | null = null;

	function sampleCpuTimes(): ICpuSample {
		const cpus = os.cpus();
		let idle = 0;
		let total = 0;
		for (const cpu of cpus) {
			idle += cpu.times.idle;
			total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
		}
		return { idle, total };
	}

	function getCpuInfo(): SystemCPUInfo {
		const current = sampleCpuTimes();
		if (!prevCpuTimes) {
			prevCpuTimes = current;
			return { usage: 0 };
		}
		const idleDelta = current.idle - prevCpuTimes.idle;
		const totalDelta = current.total - prevCpuTimes.total;
		prevCpuTimes = current;
		return { usage: totalDelta > 0 ? Math.round(((totalDelta - idleDelta) / totalDelta) * 10000) / 100 : 0 };
	}

	// Take initial CPU sample so first poll has a valid delta
	prevCpuTimes = sampleCpuTimes();

	async function getStorageInfo(): Promise<SystemStorageInfo> {
		const downloadPath = Utils.expandHome(settings.get('storage.downloadPath'));
		const stats = await statfs(downloadPath);
		const total = stats.blocks * stats.bsize;
		const free = stats.bavail * stats.bsize;
		return { used: total - free, total };
	}

	/** Live host network state, with the user's primary-interface preference applied. */
	function getNetworkState(): Promise<NetworkStateInfo> {
		return readSettledNetworkState(settings.get('network.primaryInterface') ?? '');
	}

	/**
	 * Apply an IPv4 configuration and answer with the state that resulted.
	 *
	 * The fresh state is read here rather than left to the next poll tick because
	 * the caller has just changed the very interface it is watching and needs to
	 * see the outcome — including the case where the address did not take.
	 */
	function applyNetworkConfig(p: { interfaceID: string; config: NetIPv4Config }): Promise<NetworkStateInfo> {
		assert(p, ['interfaceID', 'config']);
		return applyAndPublish(() => applyIPv4(assertString(p.interfaceID, 'interfaceID', MAX_INTERFACE_ID), p.config), getNetworkState, broadcast);
	}

	async function scanWifiNetworks(p: { interfaceID: string }): Promise<NetWifiNetwork[]> {
		assert(p, ['interfaceID']);
		return await scanWifi(assertString(p.interfaceID, 'interfaceID', MAX_INTERFACE_ID));
	}

	async function joinWifiNetwork(p: { interfaceID: string; ssid: string; password?: string }): Promise<NetworkStateInfo> {
		assert(p, ['interfaceID', 'ssid']);
		// The passphrase is optional and legitimately empty for an open network, but
		// when it is present it has to be a string: `password: ['secret']` would
		// otherwise travel all the way into nmcli's argv, or into a WLAN profile
		// document as "[object Object]".
		const password = p.password === undefined ? '' : assertString(p.password, 'password', MAX_WIFI_PASSWORD, 0);
		return applyAndPublish(() => connectWifi(assertString(p.interfaceID, 'interfaceID', MAX_INTERFACE_ID), assertString(p.ssid, 'ssid', MAX_SSID_PARAM), password), getNetworkState, broadcast);
	}

	let networkTick = 0;
	// A Windows read takes 1.4-1.8 s, so it is deliberately not awaited on the
	// broadcast path — a slow read simply skips ticks until it settles.
	let networkReadInFlight = false;

	function startPolling(): void {
		if (pollInterval) return;
		pollInterval = setInterval(async () => {
			if (hasSubscribers('system:cpu')) broadcast('system:cpu', getCpuInfo());
			if (hasSubscribers('system:ram')) broadcast('system:ram', getRamInfo());
			if (hasSubscribers('system:storage')) {
				try {
					broadcast('system:storage', await getStorageInfo());
				} catch {}
			}
			if (++networkTick % NETWORK_POLL_EVERY_N_TICKS === 0 && hasSubscribers('system:network') && !networkReadInFlight) {
				networkReadInFlight = true;
				void publishNetworkState(getNetworkState, broadcast)
					.catch(() => {})
					.finally(() => {
						networkReadInFlight = false;
					});
			}
			const volumeWanted = hasSubscribers('system:volumeChanged');
			// Run the instant push monitor while a client listens and a device is
			// present; (re)spawn on crash or when a device reappears, stop otherwise.
			if (volumeWanted && volumeWatcher.available() && !volumeMonitor) {
				volumeMonitor = startVolumeMonitor(
					status => volumeWatcher.ingest(status),
					// Linux push events only request a serialized watcher poll — the
					// monitor never reads the mixer itself (read-ordering guarantee).
					() => void volumeWatcher.poll(),
					() => {
						volumeMonitor = null;
					}
				);
			} else if ((!volumeWanted || !volumeWatcher.available()) && volumeMonitor) {
				volumeMonitor.stop();
				volumeMonitor = null;
			}
			// The 5s poll is the fallback and drives availability; on Windows it is
			// a few in-process COM calls, on macOS/Linux a short-lived CLI helper.
			if (volumeWanted) await volumeWatcher.poll();
		}, POLL_INTERVAL_MS);
	}

	function stopPolling(): void {
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = null;
		}
		if (volumeMonitor) {
			volumeMonitor.stop();
			volumeMonitor = null;
		}
	}

	return { ram: getRamInfo, storage: getStorageInfo, cpu: getCpuInfo, setVolume, getVolume, network: getNetworkState, networkApply: applyNetworkConfig, wifiScan: scanWifiNetworks, wifiConnect: joinWifiNetwork, startPolling, stopPolling };
}
