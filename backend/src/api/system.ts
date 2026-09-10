import os from 'os';
import { statfs } from 'fs/promises';
import { readFileSync } from 'fs';
import { type SystemRAMInfo, type SystemStorageInfo, type SystemCPUInfo, type SystemTimeChanges, type NetIPv4Baseline, type NetIPv4Config, type NetworkStateInfo, type NetWifiNetwork, type SystemTimeResult, type SystemTimeStatus, CodedError, ErrorCodes } from '@shared';
import type { Settings } from '../settings.ts';
import { Utils } from '../utils.ts';
import { setSystemVolume, getSystemVolumeStatus, createVolumeWatcher, isMixerWriteBusy, startVolumeMonitor, type VolumeMonitor } from '../system-volume.ts';
import { applySystemTimeSettings, getSystemTimeStatus, listHostTimezones, setSystemClock, setSystemNtpEnabled, setSystemNtpServer, setSystemTimezone, withSystemTimeLock } from '../system-time.ts';
import { applyIPv4Unlocked, connectWifiUnlocked, disconnectWifiUnlocked, readNetworkState, readNetworkStateUnlocked, runNetworkMutation, scanWifi } from '../system-network.ts';
const assert = Utils.assertParams;
type BroadcastFn = (event: string, data: any) => void;
type HasSubscribersFn = (event: string) => boolean;
const POLL_INTERVAL_MS = 5000;
const TIME_POLL_INTERVAL_MS = 15000;
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

/** Require a bounded string, naming the offending parameter when it is not one. */
export function assertString(value: unknown, name: string, maxLength: number, minLength: number = 1): string {
	if (typeof value !== 'string') throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, `${name} must be a string`);
	if (value.length < minLength || value.length > maxLength) throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, `${name} must be ${minLength}-${maxLength} characters`);
	return value;
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
	getTime: () => Promise<SystemTimeStatus>;
	listTimezones: () => string[];
	setClock: (p: { hours: number; minutes: number; seconds: number }) => Promise<SystemTimeResult>;
	setTimezone: (p: { timezone: string }) => Promise<SystemTimeResult>;
	setNtpServer: (p: { server: string }) => Promise<SystemTimeResult>;
	setNtpEnabled: (p: { enabled: boolean }) => Promise<SystemTimeResult>;
	applyTimeSettings: (p: SystemTimeChanges) => Promise<SystemTimeResult>;
	network: () => Promise<NetworkStateInfo>;
	networkApply: (p: { interfaceID: string; config: NetIPv4Config; expected: NetIPv4Baseline }) => Promise<NetworkStateInfo>;
	wifiDisconnect: (p: { interfaceID: string }) => Promise<NetworkStateInfo>;
	wifiScan: (p: { interfaceID: string }) => Promise<NetWifiNetwork[]>;
	wifiConnect: (p: { interfaceID: string; ssid: string; bssid?: string | null; password?: string; expectedSecurity?: string; expectedSsidHex?: string }) => Promise<NetworkStateInfo>;
	startPolling: () => void;
	stopPolling: () => void;
}

/**
 * Run a system-time write and, when it changed something, push the resulting state to
 * every client. The event carries a freshly read status rather than the value that was
 * requested: the OS may normalise it (a timezone alias, an NTP peer the daemon rejects),
 * and a second window must show what the host actually has.
 *
 * The refresh and the broadcast are best-effort and happen strictly AFTER the outcome is
 * decided. The system change is already applied at that point, so letting an exception
 * from the re-read or from a dead client's socket escape would report a successful clock
 * or NTP-mode change as an INTERNAL_ERROR — and invite the client to retry it, which is
 * the one thing a clock change must not be.
 *
 * The write, the read-back and the broadcast are one critical section. Requests arrive
 * concurrently on the WebSocket API, and without the lock a second write lands between
 * this one's write and its read-back — so both clients are told the host looks like
 * whatever the LAST write left, and the earlier request claims an end state it did not
 * produce.
 */
export function runTimeWrite(write: () => Promise<SystemTimeResult>, readStatus: () => Promise<SystemTimeStatus>, broadcast: BroadcastFn): Promise<SystemTimeResult> {
	return withSystemTimeLock(async () => {
		const res = await write();
		// A failure is not "nothing happened". A sequence that stopped part-way left the
		// steps before it applied — the service already stopped, the start mode already
		// changed — so the clients are told what the host looks like NOW. Skipping that
		// leaves every open window showing a state the host no longer has.
		if (!res.success && !res.stateMayHaveChanged) return res;
		try {
			broadcast('system:timeChanged', await readStatus());
		} catch (err) {
			console.warn('[system-time] Applied, but could not announce the new time status:', (err as Error).message);
		}
		return res;
	});
}

/**
 * Run one host change and publish the state it left behind.
 *
 * The network lock is held through the read-back. Released any earlier, a
 * change queued behind this one could start before the read, and what got
 * published as this change's result would be a mix of the two. Both callbacks
 * therefore have to be the lock-free variants.
 */
export function runAndPublishNetworkMutation(action: () => Promise<NetworkStateInfo>, readCurrent: () => Promise<NetworkStateInfo>, publish: (state: NetworkStateInfo) => void): Promise<NetworkStateInfo> {
	return runNetworkMutation(async () => {
		try {
			const state = await action();
			publish(state);
			return state;
		} catch (error) {
			try {
				publish(await readCurrent());
			} catch {}
			throw error;
		}
	});
}

/** Remove mutation capabilities when this API instance has no authentication token. */
export function restrictNetworkCapabilities(state: NetworkStateInfo, networkAdminEnabled: boolean): NetworkStateInfo {
	if (networkAdminEnabled) return state;
	return { ...state, capabilities: { ...state.capabilities, ipv4: false, ipv4Elevation: false, wifi: false } };
}

export function initSystemHandlers(settings: Settings, broadcast: BroadcastFn, hasSubscribers: HasSubscribersFn, networkAdminEnabled: boolean): SystemHandlers {
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

	/**
	 * Read the host's live time configuration (clock, timezone, NTP state and what
	 * this host is capable of). Never throws — an unsupported or unreadable host is
	 * reported through `supported: false` and empty capabilities.
	 */
	function getTime(): Promise<SystemTimeStatus> {
		return withSystemTimeLock(getSystemTimeStatus);
	}

	/** IANA timezone identifiers this host accepts, for the timezone picker. Excludes zones this platform cannot express. Empty on a runtime without a timezone database. */
	function listTimezones(): string[] {
		return listHostTimezones();
	}

	/** Run a system-time write and tell every client what the host looks like afterwards. */
	function applyTimeWrite(write: () => Promise<SystemTimeResult>): Promise<SystemTimeResult> {
		return runTimeWrite(write, getSystemTimeStatus, broadcast);
	}

	/**
	 * Set the wall clock to the given local time, keeping today's date. Range checks
	 * live in the core so an out-of-range value comes back as an `invalid-input`
	 * outcome the UI can show inline, not as a thrown protocol error.
	 */
	function setClock(p: { hours: number; minutes: number; seconds: number }): Promise<SystemTimeResult> {
		assert(p, ['hours', 'minutes', 'seconds']);
		for (const key of ['hours', 'minutes', 'seconds'] as const) {
			if (typeof p[key] !== 'number' || !Number.isFinite(p[key])) throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, `${key} must be a number`);
		}
		return applyTimeWrite(() => setSystemClock(p.hours, p.minutes, p.seconds));
	}

	/** Set the system timezone from an IANA identifier. An unknown identifier comes back as an `invalid-input` outcome. */
	function setTimezone(p: { timezone: string }): Promise<SystemTimeResult> {
		assert(p, ['timezone']);
		if (typeof p.timezone !== 'string') throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, 'timezone must be a string');
		return applyTimeWrite(() => setSystemTimezone(p.timezone));
	}

	/** Point automatic time synchronisation at an NTP server (host name or IP address). */
	function setNtpServer(p: { server: string }): Promise<SystemTimeResult> {
		assert(p, ['server']);
		if (typeof p.server !== 'string') throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, 'server must be a string');
		return applyTimeWrite(() => setSystemNtpServer(p.server.trim()));
	}

	/** Switch automatic time synchronisation on or off. Setting the clock by hand requires it off. */
	function setNtpEnabled(p: { enabled: boolean }): Promise<SystemTimeResult> {
		assert(p, ['enabled']);
		if (typeof p.enabled !== 'boolean') throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, 'enabled must be a boolean');
		return applyTimeWrite(() => setSystemNtpEnabled(p.enabled));
	}

	/** Validate and apply every changed time field as one serialized save. */
	function applyTimeSettings(p: SystemTimeChanges): Promise<SystemTimeResult> {
		if (!p || typeof p !== 'object' || Array.isArray(p)) throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, 'time settings must be an object');
		const allowed = new Set(['ntpEnabled', 'ntpServer', 'timezone', 'clock', 'expectedTimezone', 'expectedOffsetMinutes']);
		const keys = Object.keys(p);
		if (keys.length === 0 || keys.some(key => !allowed.has(key))) throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, 'time settings must contain only supported changed fields');
		const changes: SystemTimeChanges = {};
		if (p.ntpEnabled !== undefined) {
			if (typeof p.ntpEnabled !== 'boolean') throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, 'ntpEnabled must be a boolean');
			changes.ntpEnabled = p.ntpEnabled;
		}
		if (p.ntpServer !== undefined) {
			if (typeof p.ntpServer !== 'string') throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, 'ntpServer must be a string');
			changes.ntpServer = p.ntpServer.trim();
		}
		if (p.timezone !== undefined) {
			if (typeof p.timezone !== 'string') throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, 'timezone must be a string');
			changes.timezone = p.timezone;
		}
		if (p.expectedOffsetMinutes !== undefined) {
			if (typeof p.expectedOffsetMinutes !== 'number' || !Number.isInteger(p.expectedOffsetMinutes)) throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, 'expectedOffsetMinutes must be an integer');
			changes.expectedOffsetMinutes = p.expectedOffsetMinutes;
		}
		if (p.expectedTimezone !== undefined) {
			if (typeof p.expectedTimezone !== 'string') throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, 'expectedTimezone must be a string');
			changes.expectedTimezone = p.expectedTimezone;
		}
		if (p.clock !== undefined) {
			if (!p.clock || typeof p.clock !== 'object' || Array.isArray(p.clock)) throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, 'clock must be an object');
			assert(p.clock, ['hours', 'minutes', 'seconds']);
			for (const key of ['hours', 'minutes', 'seconds'] as const) {
				if (typeof p.clock[key] !== 'number' || !Number.isFinite(p.clock[key])) throw new CodedError(ErrorCodes.INVALID_INPUT_TYPE, `clock.${key} must be a number`);
			}
			changes.clock = { hours: p.clock.hours, minutes: p.clock.minutes, seconds: p.clock.seconds };
		}
		return applyTimeWrite(() => applySystemTimeSettings(changes));
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
	async function getNetworkState(): Promise<NetworkStateInfo> {
		return restrictNetworkCapabilities(await readNetworkState(settings.get('network.primaryInterface') ?? ''), networkAdminEnabled);
	}

	/**
	 * Apply an IPv4 configuration and answer with the state that resulted.
	 *
	 * The fresh state is read here rather than left to the next poll tick because
	 * the caller has just changed the very interface it is watching and needs to
	 * see the outcome — including the case where the address did not take.
	 */
	async function applyNetworkConfig(p: { interfaceID: string; config: NetIPv4Config; expected: NetIPv4Baseline }): Promise<NetworkStateInfo> {
		assert(p, ['interfaceID', 'config', 'expected']);
		const primary = settings.get('network.primaryInterface') ?? '';
		return runAndPublishNetworkMutation(
			() => applyIPv4Unlocked(p.interfaceID, p.config, primary, true, p.expected),
			() => readNetworkStateUnlocked(primary),
			state => broadcast('system:network', state)
		);
	}

	async function leaveWifiNetwork(p: { interfaceID: string }): Promise<NetworkStateInfo> {
		assert(p, ['interfaceID']);
		const interfaceID = assertString(p.interfaceID, 'interfaceID', MAX_INTERFACE_ID);
		const primary = settings.get('network.primaryInterface') ?? '';
		return runAndPublishNetworkMutation(
			() => disconnectWifiUnlocked(interfaceID, primary),
			() => readNetworkStateUnlocked(primary),
			state => broadcast('system:network', state)
		);
	}

	async function scanWifiNetworks(p: { interfaceID: string }): Promise<NetWifiNetwork[]> {
		assert(p, ['interfaceID']);
		return await scanWifi(assertString(p.interfaceID, 'interfaceID', MAX_INTERFACE_ID));
	}

	async function joinWifiNetwork(p: { interfaceID: string; ssid: string; bssid?: string | null; password?: string; expectedSecurity?: string; expectedSsidHex?: string }): Promise<NetworkStateInfo> {
		assert(p, ['interfaceID', 'ssid']);
		const primary = settings.get('network.primaryInterface') ?? '';
		return runAndPublishNetworkMutation(
			() => connectWifiUnlocked(p.interfaceID, p.ssid, p.password ?? '', primary, p.bssid ?? null, p.expectedSecurity, p.expectedSsidHex),
			() => readNetworkStateUnlocked(primary),
			state => broadcast('system:network', state)
		);
	}

	let networkTick = 0;
	// A Windows read takes 1.4-1.8 s, so it is deliberately not awaited on the
	// broadcast path — a slow read simply skips ticks until it settles.
	let networkReadInFlight = false;
	let timeReadInFlight = false;
	let nextTimeRead = 0;
	let timePollingGeneration = 0;

	function pollTime(generation: number): void {
		if (generation !== timePollingGeneration || !pollInterval || timeReadInFlight || !hasSubscribers('system:timeChanged')) return;
		const now = performance.now();
		if (now < nextTimeRead) return;
		nextTimeRead = now + TIME_POLL_INTERVAL_MS;
		timeReadInFlight = true;
		void withSystemTimeLock(async () => {
			if (generation !== timePollingGeneration || !pollInterval || !hasSubscribers('system:timeChanged')) return;
			const status = await getSystemTimeStatus();
			if (generation === timePollingGeneration && pollInterval && hasSubscribers('system:timeChanged')) broadcast('system:timeChanged', status);
		})
			.catch(error => console.warn('[system-time] Could not refresh host time:', (error as Error).message))
			.finally(() => {
				timeReadInFlight = false;
			});
	}

	function startPolling(): void {
		if (pollInterval) return;
		const generation = ++timePollingGeneration;
		nextTimeRead = 0;
		pollInterval = setInterval(async () => {
			pollTime(generation);
			if (hasSubscribers('system:cpu')) broadcast('system:cpu', getCpuInfo());
			if (hasSubscribers('system:ram')) broadcast('system:ram', getRamInfo());
			if (hasSubscribers('system:storage')) {
				try {
					broadcast('system:storage', await getStorageInfo());
				} catch {}
			}
			if (++networkTick % NETWORK_POLL_EVERY_N_TICKS === 0 && hasSubscribers('system:network') && !networkReadInFlight) {
				networkReadInFlight = true;
				void getNetworkState()
					.then(state => broadcast('system:network', state))
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
		timePollingGeneration++;
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = null;
		}
		if (volumeMonitor) {
			volumeMonitor.stop();
			volumeMonitor = null;
		}
	}

	return { ram: getRamInfo, storage: getStorageInfo, cpu: getCpuInfo, setVolume, getVolume, getTime, listTimezones, setClock, setTimezone, setNtpServer, setNtpEnabled, applyTimeSettings, network: getNetworkState, networkApply: applyNetworkConfig, wifiScan: scanWifiNetworks, wifiConnect: joinWifiNetwork, wifiDisconnect: leaveWifiNetwork, startPolling, stopPolling };
}
