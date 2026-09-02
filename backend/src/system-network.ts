import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Mutex } from 'async-mutex';
import { CodedError, ErrorCodes, ipv4BaselineOf, isSelectableInterface, isValidSSID, normalizeDnsServers, sameIPv4Baseline, validateIPv4Config, type NetAddress, type NetCapabilities, type NetInterfaceInfo, type NetIPv4Config, type NetworkStateInfo, type NetWifiNetwork } from '@shared';
import { isWindowsInterfaceID, parseElevation, parseWindowsNetworkState, readWindowsWifi, windowsApplyIPv4Command, WINDOWS_ELEVATION_COMMAND, WINDOWS_STATE_COMMAND } from './system-network-windows.ts';
import { applyLinuxIPv4, connectLinuxWifi, readLinuxCapabilities, readLinuxNetworkState, scanLinuxWifi } from './system-network-linux.ts';
import { applyMacIPv4, isMacWifiConfigurable, isMacWritable, readMacNetworkState } from './system-network-macos.ts';
import { networkHelperAvailable, runElevatedNetworkHelper } from './network-helper-client.ts';
import { windowsPowerShellPath, windowsSystemEnvironment } from './network-helper-windows.ts';

const execFileAsync = promisify(execFile);
const WINDOWS_POWERSHELL = process.platform === 'win32' ? windowsPowerShellPath() : 'powershell.exe';
const WINDOWS_SYSTEM_ENV = process.platform === 'win32' ? windowsSystemEnvironment() : undefined;

/**
 * Host network state and configuration, dispatched per platform.
 *
 * Writing is narrower than reading and says so through {@link NetCapabilities},
 * which the UI uses to decide whether to offer an edit at all:
 *
 *  - IPv4 (address, gateway, DNS) applies on Windows, on a Linux host running
 *    NetworkManager, and on macOS. All three need privileges, and each answers
 *    that question differently — an elevated token on Windows, a polkit verdict
 *    of `yes` on Linux, and an effective root process on macOS. The answer is
 *    probed once and cached, so the UI can hide an edit the process could never
 *    complete instead of letting the user discover it when Save fails.
 *  - Wi-Fi scan/join applies on Linux only. See system-network-windows.ts and
 *    system-network-macos.ts for why the other two are deliberately absent rather
 *    than written blind — on macOS the operating system withholds every network
 *    name from a process without Location access, so there is nothing to offer.
 *
 * Applying can drop the very interface the caller reached us on. That is inherent
 * to changing an address and is the user's decision to make, so it is not
 * prevented here — but every value is validated before a child process sees it.
 *
 * Windows, Linux and macOS all report full detail (medium, carrier, DHCP mode,
 * gateway, DNS, Wi-Fi signal). Any other platform falls back to
 * `os.networkInterfaces()`, which is real data but only addresses and MACs; that
 * is reported honestly as `detail: 'addressesOnly'` rather than padded out with
 * invented fields.
 *
 * Every platform reader uses only tools that ship with the operating system —
 * PowerShell and wlanapi on Windows, iproute2 on Linux, networksetup/ifconfig/
 * ipconfig on macOS. Nothing here requires the user to install anything.
 */

/** Hard cap on how long the PowerShell one-shot may run. */
const WINDOWS_TIMEOUT_MS = 15000;
/**
 * How long a successful read is reused. A Windows read costs one PowerShell
 * spawn (measured 1.4-1.8 s on a 31-adapter workstation), and the poll
 * broadcasts every 10 s, so this keeps a client opening the settings screen
 * right after a tick from paying for a second spawn.
 */
const CACHE_TTL_MS = 5000;
/**
 * Hard cap on an apply. Renegotiating DHCP and rebuilding routes takes far longer
 * than any read, and a too-short timeout would report failure for a change the OS
 * went on to make anyway.
 */
const APPLY_TIMEOUT_MS = 45000;
/** Transport ceiling for a secret sent to NetworkManager. */
export const MAX_WIFI_PASSWORD_BYTES = 1024;

export interface NetworkSnapshot {
	interfaces: NetInterfaceInfo[];
	detail: NetworkStateInfo['detail'];
}

/**
 * TTL cache that shares concurrent reads without letting an invalidated read
 * overwrite a newer snapshot when it eventually settles.
 */
export class NetworkStateCache {
	private cached: { at: number; snapshot: NetworkSnapshot } | null = null;
	private inFlight: { generation: number; promise: Promise<NetworkSnapshot> } | null = null;
	private generation = 0;
	private readonly reader: () => Promise<NetworkSnapshot>;
	private readonly ttlMs: number;

	constructor(reader: () => Promise<NetworkSnapshot>, ttlMs: number = CACHE_TTL_MS) {
		this.reader = reader;
		this.ttlMs = ttlMs;
	}

	async read(): Promise<NetworkSnapshot> {
		const now = Date.now();
		if (this.cached && now - this.cached.at < this.ttlMs) return this.cached.snapshot;

		const generation = this.generation;
		let pending = this.inFlight;
		if (!pending || pending.generation !== generation) {
			pending = { generation, promise: this.reader() };
			this.inFlight = pending;
		}

		let snapshot: NetworkSnapshot;
		try {
			snapshot = await pending.promise;
		} catch (err) {
			if (this.inFlight === pending) this.inFlight = null;
			throw err;
		}
		// Reset means a host mutation began after this read. Returning the old
		// snapshot would still let its caller (notably the periodic broadcaster)
		// publish pre-mutation state over the fresh result, even though it no longer
		// enters the cache. Join the current generation instead; it either reuses the
		// post-mutation read already in flight or serves its completed cache entry.
		if (this.generation !== generation) return this.read();
		this.cached = { snapshot, at: Date.now() };
		if (this.inFlight === pending) this.inFlight = null;
		return snapshot;
	}

	reset(): void {
		this.generation++;
		this.cached = null;
		this.inFlight = null;
	}
}

const stateCache = new NetworkStateCache(async () => {
	const detail: NetworkStateInfo['detail'] = process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin' ? 'full' : 'addressesOnly';
	try {
		return { interfaces: assertReadProducedSomething(await readPlatform()), detail };
	} catch (err) {
		console.warn('[system-network] Platform read failed, falling back to addresses only:', (err as Error).message);
		return { interfaces: readGenericInterfaces(), detail: 'addressesOnly' };
	}
});

const mutationMutex = new Mutex();

/** Serialize changes to the one host network stack. */
export function runNetworkMutation<T>(action: () => Promise<T>): Promise<T> {
	return mutationMutex.runExclusive(action);
}

/**
 * Addresses and MACs from the Node/Bun runtime — everything every platform can
 * answer without a child process. Internal (loopback) entries are skipped; a MAC
 * of all zeroes is the runtime's placeholder for "none" and becomes null.
 */
export function readGenericInterfaces(): NetInterfaceInfo[] {
	const result: NetInterfaceInfo[] = [];
	for (const [name, entries] of Object.entries(os.networkInterfaces())) {
		const usable = (entries ?? []).filter(e => !e.internal);
		if (usable.length === 0) continue;
		const addresses: NetAddress[] = usable.map(e => ({
			family: e.family === 'IPv4' ? 'ipv4' : 'ipv6',
			address: e.address,
			prefixLength: prefixFromNetmask(e.netmask, e.family === 'IPv4'),
		}));
		const mac = usable.find(e => e.mac && e.mac !== '00:00:00:00:00:00')?.mac ?? null;
		result.push({ id: name, name, medium: 'other', link: 'unknown', defaultRoute: false, mac, addresses, ipv4Mode: 'unknown', ipv4Configurable: false, wifiConfigurable: false, gateway: null, dns: [] });
	}
	return result;
}

/** Count the set bits of a dotted-quad or colon-hex netmask. Returns 0 for anything unparseable. */
export function prefixFromNetmask(netmask: string, ipv4: boolean): number {
	if (!netmask) return 0;
	const groups = ipv4
		? netmask.split('.').map(p => parseInt(p, 10))
		: netmask
				.split(':')
				.filter(p => p.length > 0)
				.flatMap(p => {
					const v = parseInt(p, 16);
					return [v >> 8, v & 0xff];
				});
	let bits = 0;
	for (const value of groups) {
		if (!Number.isFinite(value)) return 0;
		for (let bit = 7; bit >= 0; bit--) if (value & (1 << bit)) bits++;
	}
	return bits;
}

async function readWindows(): Promise<NetInterfaceInfo[]> {
	const { stdout } = await execFileAsync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_STATE_COMMAND], { timeout: WINDOWS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: WINDOWS_SYSTEM_ENV });
	// The Wi-Fi read is in-process FFI and never throws — a missing WLAN service
	// simply yields an empty map, leaving `wifi` undefined on the adapters.
	return parseWindowsNetworkState(stdout, readWindowsWifi());
}

/**
 * Read the current network state.
 *
 * Results are cached for {@link CACHE_TTL_MS} and concurrent callers share the
 * one in-flight read, so a poll tick and an RPC call arriving together cost a
 * single spawn. A failed platform read degrades to the address-only reader
 * rather than throwing — a settings screen showing addresses beats an error.
 *
 * Waits for any host change in progress. A read that started in the middle of
 * a multi-step apply would capture the gap between "old address removed" and
 * "new address created", and the periodic broadcaster would publish that gap as
 * the current state of the host.
 */
export function readNetworkState(primaryInterface: string = ''): Promise<NetworkStateInfo> {
	return runNetworkMutation(() => readNetworkStateUnlocked(primaryInterface));
}

/** {@link readNetworkState} for a caller that already holds the network mutation lock. */
export async function readNetworkStateUnlocked(primaryInterface: string = ''): Promise<NetworkStateInfo> {
	const snapshot = await stateCache.read();
	return { interfaces: snapshot.interfaces, primaryID: resolvePrimaryID(snapshot.interfaces, primaryInterface), detail: snapshot.detail, known: true, capabilities: await readCapabilities() };
}

function readPlatform(): Promise<NetInterfaceInfo[]> {
	if (process.platform === 'win32') return readWindows();
	if (process.platform === 'linux') return readLinuxNetworkState();
	if (process.platform === 'darwin') return readMacNetworkState();
	return Promise.resolve(readGenericInterfaces());
}

/**
 * Reject a read that produced nothing.
 *
 * An empty list is not evidence that the host is offline — it is a reader that
 * failed quietly. PowerShell keeps going after a non-terminating `Get-Net*`
 * failure (missing NetAdapter module, broken CIM/NSI service) and still emits a
 * well-formed document with empty collections, and `ip -j addr` on a host with
 * only loopback yields nothing after loopback is dropped. Accepting either as
 * `detail: 'full'` would have the footer state a confident "Disconnected" on a
 * perfectly connected machine; throwing degrades it to the address-only reader,
 * whose honest answer is "unknown".
 */
export function assertReadProducedSomething(interfaces: NetInterfaceInfo[]): NetInterfaceInfo[] {
	if (interfaces.length === 0) throw new Error('platform reader returned no interfaces');
	return interfaces;
}

/** The user's pick when it still exists, else the default-route interface, else nothing. */
export function resolvePrimaryID(interfaces: NetInterfaceInfo[], primaryInterface: string): string | null {
	if (primaryInterface && interfaces.some(i => i.id === primaryInterface && isSelectableInterface(i))) return primaryInterface;
	return interfaces.find(i => i.defaultRoute)?.id ?? null;
}

/** Drop the cached reading — used by tests so a stale entry cannot leak between cases. */
export function resetNetworkStateCache(): void {
	stateCache.reset();
}

/**
 * True when the requested address change is already represented by a complete
 * interface snapshot. Undefined DNS is intentionally ignored: it means preserve
 * the resolver policy, whereas either form of explicit DNS is a real user action.
 */
/** True when the interface holds an IPv4 address that identifies it on a network, not an APIPA fallback. */
function hasUsableIPv4(target: NetInterfaceInfo): boolean {
	return target.addresses.some(address => address.family === 'ipv4' && !address.address.startsWith('169.254.'));
}

export function isIPv4AddressingUnchanged(target: NetInterfaceInfo, config: NetIPv4Config): boolean {
	if (!target.ipv4Configurable || target.ipv4Mode !== config.mode) return false;
	if (config.mode === 'dhcp') return true;
	const addresses = target.addresses.filter(address => address.family === 'ipv4');
	if (addresses.length !== 1) return false;
	const current = addresses[0]!;
	return current.address === config.address && current.prefixLength === config.prefixLength && (target.gateway ?? '') === (config.gateway ?? '');
}

/** True when neither addressing nor resolver policy would change. */
export function isIPv4ConfigUnchanged(target: NetInterfaceInfo, config: NetIPv4Config): boolean {
	return config.dns === undefined && isIPv4AddressingUnchanged(target, config);
}

/**
 * What applying `config` to `target` has to do.
 *
 * Saving DHCP on an interface that is on DHCP but holds no lease (APIPA, or no
 * IPv4 at all) is the user asking for the lease to be obtained, so it runs the
 * addressing path instead of being a no-op reported as applied. When the same
 * request also changes DNS, only DNS is changed: resolvers can be set without a
 * lease, and the lease will arrive when the network does.
 */
export function planIPv4Change(target: NetInterfaceInfo, config: NetIPv4Config): { unchanged: boolean; addressingChanged: boolean } {
	const renewLease = config.dns === undefined && config.mode === 'dhcp' && !hasUsableIPv4(target);
	return { unchanged: isIPv4ConfigUnchanged(target, config) && !renewLease, addressingChanged: !isIPv4AddressingUnchanged(target, config) || renewLease };
}

export function assertAppliedIPv4State(state: NetworkStateInfo, interfaceID: string, config: NetIPv4Config, addressingChanged: boolean = true): void {
	if (!state.known || state.detail !== 'full') throw new Error('network state could not be verified after the privileged change');
	const target = state.interfaces.find(item => item.id === interfaceID);
	if (!target || target.ipv4Mode !== config.mode) throw new Error('network helper did not preserve the requested IPv4 method');
	if (config.mode === 'static') {
		const ipv4 = target.addresses.filter(item => item.family === 'ipv4');
		if (ipv4.length !== 1 || ipv4[0]?.address !== config.address || ipv4[0]?.prefixLength !== config.prefixLength) throw new Error('network helper did not apply the requested IPv4 address');
		if ((target.gateway ?? '') !== (config.gateway ?? '')) throw new Error('network helper did not apply the requested IPv4 gateway');
	} else if (addressingChanged && !target.addresses.some(item => item.family === 'ipv4')) {
		// A lease is only owed when DHCP was just switched on. A DNS-only change on
		// an interface that is already on DHCP but has no lease right now (cable out,
		// no server answering) succeeded exactly as requested.
		throw new Error('network helper enabled DHCP but no IPv4 lease was obtained');
	}
	// An empty list means "restore automatic DNS". The public snapshot contains
	// the resulting resolver addresses, not the policy that produced them, so only
	// a non-empty custom list can be compared here. The privileged platform apply
	// path verifies the automatic policy before it returns.
	if (config.dns?.length) {
		const actualDns = normalizeDnsServers(target.dns)
			.map(value => value.toLowerCase())
			.sort();
		const expectedDns = normalizeDnsServers(config.dns)
			.map(value => value.toLowerCase())
			.sort();
		if (actualDns.length !== expectedDns.length || actualDns.some((value, index) => value !== expectedDns[index])) throw new Error('network helper did not apply the requested DNS servers');
	}
}

/** What this host lets the app change, with short-lived negative results. */
export const CAPABILITY_NEGATIVE_TTL_MS: number = 15_000;
export const CAPABILITY_POSITIVE_TTL_MS: number = 5 * 60_000;
let capabilityCache: { value: NetCapabilities; expiresAt: number } | null = null;
let capabilityProbeInFlight: Promise<NetCapabilities> | null = null;
let capabilityGeneration = 0;

export function resetNetworkCapabilitiesCache(): void {
	capabilityCache = null;
	capabilityProbeInFlight = null;
	capabilityGeneration++;
}

export async function readCachedCapabilities(probe: () => Promise<NetCapabilities>, now: number = Date.now()): Promise<NetCapabilities> {
	if (capabilityCache && now < capabilityCache.expiresAt) return capabilityCache.value;
	if (capabilityProbeInFlight) return capabilityProbeInFlight;
	const generation = capabilityGeneration;
	const pending = probe().then(value => {
		if (generation === capabilityGeneration) {
			const writable = value.ipv4 || value.wifi;
			capabilityCache = { value, expiresAt: now + (writable ? CAPABILITY_POSITIVE_TTL_MS : CAPABILITY_NEGATIVE_TTL_MS) };
		}
		return value;
	});
	capabilityProbeInFlight = pending;
	try {
		return await pending;
	} finally {
		if (capabilityProbeInFlight === pending) capabilityProbeInFlight = null;
	}
}

async function probeCapabilities(): Promise<NetCapabilities> {
	if (process.platform === 'win32') {
		// The Get/Set-Net* cmdlets refuse outright without an elevated token, so the
		// capability is that token — probed before the user reaches Save rather than
		// user when Save fails. Wi-Fi is deliberately read-only.
		const native = await isWindowsElevated();
		const elevated = !native && (await networkHelperAvailable('win32'));
		return { ipv4: native || elevated, ...(elevated && { ipv4Elevation: true }), wifi: false, staticGatewayRequired: false };
	} else if (process.platform === 'linux') {
		const capability = await readLinuxCapabilities();
		if (capability.ipv4Elevation && !(await networkHelperAvailable('linux'))) return { ...capability, ipv4: false, ipv4Elevation: false };
		return capability;
	} else if (process.platform === 'darwin') {
		// networksetup persists a change and is present on every macOS install, so
		// addressing is editable. Wi-Fi is not: see isMacWifiConfigurable.
		const native = await isMacWritable();
		const elevated = !native && (await networkHelperAvailable('darwin'));
		return { ipv4: native || elevated, ...(elevated && { ipv4Elevation: true }), wifi: isMacWifiConfigurable(), staticGatewayRequired: true };
	} else {
		// Everything else reads through os.networkInterfaces(), which cannot even
		// report whether an address came from DHCP. Offering to edit a configuration
		// we cannot describe would be worse than not offering it.
		return { ipv4: false, wifi: false, staticGatewayRequired: false };
	}
}

async function readCapabilities(): Promise<NetCapabilities> {
	return readCachedCapabilities(probeCapabilities);
}

/** True when this process can actually run the privileged cmdlets. One spawn, cached with the capabilities. */
async function isWindowsElevated(): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ELEVATION_COMMAND], { timeout: WINDOWS_TIMEOUT_MS, maxBuffer: 1024, windowsHide: true, env: WINDOWS_SYSTEM_ENV });
		return parseElevation(stdout);
	} catch {
		return false;
	}
}

/**
 * Refuse a change built on a configuration the interface no longer has.
 *
 * The form was seeded from one snapshot; by the time Save is pressed the
 * interface may have been switched to DHCP by a system tool or edited by
 * another client. Applying the form then would silently undo that change.
 */
export function assertIPv4Baseline(target: NetInterfaceInfo, expected: unknown): void {
	if (expected === undefined) return;
	if (!sameIPv4Baseline(ipv4BaselineOf(target), expected)) throw new CodedError(ErrorCodes.NETCONFIG_STALE, 'interface configuration changed since the form was opened');
}

/** Apply an IPv4 configuration and read its resulting state before another mutation may begin. */
export function applyIPv4(interfaceID: string, config: NetIPv4Config, primaryInterface: string = '', allowPrivilegeEscalation: boolean = true, expected?: unknown): Promise<NetworkStateInfo> {
	return runNetworkMutation(() => applyIPv4Unlocked(interfaceID, config, primaryInterface, allowPrivilegeEscalation, expected));
}

/** {@link applyIPv4} for a caller that already holds the network mutation lock. */
export async function applyIPv4Unlocked(interfaceID: string, config: NetIPv4Config, primaryInterface: string = '', allowPrivilegeEscalation: boolean = true, expected?: unknown): Promise<NetworkStateInfo> {
	if (typeof interfaceID !== 'string' || !config || typeof config !== 'object') throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid request');
	const invalid = validateIPv4Config(config);
	if (invalid) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, `invalid ${invalid}`);
	const desired = config.dns === undefined ? config : { ...config, dns: normalizeDnsServers(config.dns) };
	const supported = await readCapabilities();
	if (!supported.ipv4) throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'this host does not expose a writable network configuration');
	const platformInvalid = validateIPv4Config(desired, supported);
	if (platformInvalid) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, `invalid ${platformInvalid}`);
	// Never trust the UI snapshot at this boundary. A platform reader marks an
	// adapter read-only when its complete address/route state cannot be preserved,
	// and a fresh read closes the gap between opening the form and pressing Save.
	resetNetworkStateCache();
	const before = await readNetworkStateUnlocked(primaryInterface);
	const target = before.interfaces.find(item => item.id === interfaceID);
	if (!target) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'unknown interface');
	if (!target.ipv4Configurable || target.ipv4Mode === 'unknown') throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'interface configuration cannot be preserved safely');
	assertIPv4Baseline(target, expected);
	const { unchanged, addressingChanged } = planIPv4Change(target, desired);
	if (unchanged) return before;
	let usedHelper = false;
	try {
		await run(async () => {
			if (supported.ipv4Elevation) {
				if (!allowPrivilegeEscalation) throw new Error('network helper cannot recursively request privileges');
				// The helper reads the host again on its own; it gets the baseline this
				// process just verified so a change made while the authorization prompt
				// was open is refused there too, not applied over.
				const response = await runElevatedNetworkHelper({ version: 1, operation: 'applyIPv4', interfaceID, config: desired, expected: ipv4BaselineOf(target) });
				if (!response.ok) throw response.code ? new CodedError(ErrorCodes[response.code], response.error) : new Error(response.error);
				usedHelper = true;
				return;
			}
			if (process.platform === 'win32') {
				if (!isWindowsInterfaceID(interfaceID)) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid interface');
				await execFileAsync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', windowsApplyIPv4Command(interfaceID, desired, addressingChanged)], { timeout: APPLY_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, env: WINDOWS_SYSTEM_ENV });
			} else if (process.platform === 'darwin') {
				await applyMacIPv4(assertDeviceName(interfaceID), desired, addressingChanged);
			} else {
				await applyLinuxIPv4(assertDeviceName(interfaceID), desired, addressingChanged);
			}
		});
	} catch (error) {
		resetNetworkCapabilitiesCache();
		throw error;
	} finally {
		// A multi-step OS command may have changed part of the configuration
		// before failing. Never keep the pre-command snapshot in that case.
		resetNetworkStateCache();
	}
	const after = await readNetworkStateUnlocked(primaryInterface);
	if (usedHelper) assertAppliedIPv4State(after, interfaceID, desired, addressingChanged);
	return after;
}

/** Scan for joinable Wi-Fi networks on one interface. */
export async function scanWifi(interfaceID: string): Promise<NetWifiNetwork[]> {
	if (typeof interfaceID !== 'string') throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid interface');
	// A scan is a device operation; letting it overlap an apply on the same host
	// would race NetworkManager and let the scan read a half-applied state.
	return runNetworkMutation(async () => {
		await assertWirelessInterface(interfaceID);
		try {
			return await run(() => scanLinuxWifi(assertDeviceName(interfaceID)));
		} catch (error) {
			resetNetworkCapabilitiesCache();
			throw error;
		}
	});
}

/** Join a Wi-Fi network on one interface. An empty password means an open network. */
export function connectWifi(interfaceID: string, ssid: string, password: string, primaryInterface: string = '', bssid: string | null = null): Promise<NetworkStateInfo> {
	return runNetworkMutation(() => connectWifiUnlocked(interfaceID, ssid, password, primaryInterface, bssid));
}

/** {@link connectWifi} for a caller that already holds the network mutation lock. */
export async function connectWifiUnlocked(interfaceID: string, ssid: string, password: string, primaryInterface: string = '', bssid: string | null = null): Promise<NetworkStateInfo> {
	if (typeof interfaceID !== 'string') throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid interface');
	if (!isValidSSID(ssid)) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid ssid');
	if (!isValidWifiPassword(password)) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid password');
	if (bssid !== null && typeof bssid !== 'string') throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid bssid');
	await assertWirelessInterface(interfaceID);
	let available: NetWifiNetwork[];
	try {
		available = await run(() => scanLinuxWifi(assertDeviceName(interfaceID)));
	} catch (error) {
		resetNetworkCapabilitiesCache();
		throw error;
	}
	const matches = available.filter(item => item.ssid === ssid);
	const network = bssid === null ? (matches.length === 1 ? matches[0] : undefined) : matches.find(item => item.bssid?.toLowerCase() === bssid.toLowerCase());
	if (!network) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'network is no longer available');
	if (!network.supported) throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'this Wi-Fi authentication method is not supported');
	try {
		await run(() => connectLinuxWifi(assertDeviceName(interfaceID), ssid, password, network.bssid));
	} catch (error) {
		resetNetworkCapabilitiesCache();
		throw error;
	} finally {
		resetNetworkStateCache();
	}
	return readNetworkStateUnlocked(primaryInterface);
}

/** A bounded string that can be written to a child process stdin. Empty = open network. */
export function isValidWifiPassword(password: unknown): password is string {
	return typeof password === 'string' && !/[\0\r\n]/.test(password) && new TextEncoder().encode(password).byteLength <= MAX_WIFI_PASSWORD_BYTES;
}

/**
 * Refuse a Wi-Fi operation the interface cannot perform.
 *
 * Without this the request reaches nmcli, which answers "Device 'enp6s18' is not
 * a Wi-Fi device" — a true statement, but one that surfaces as a command failure
 * for what is really a bad request. The medium comes from the same read the UI
 * displays, so the two can never disagree about which interfaces are wireless.
 */
async function assertWirelessInterface(interfaceID: string): Promise<void> {
	const supported = await readCapabilities();
	if (!supported.wifi) throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'this host cannot configure Wi-Fi');
	resetNetworkStateCache();
	const state = await readNetworkStateUnlocked();
	assertWifiConfigurableInterface(state.interfaces, interfaceID);
}

/** Recheck the exact device at the API boundary; global host capability is not enough. */
export function assertWifiConfigurableInterface(interfaces: NetInterfaceInfo[], interfaceID: string): void {
	const target = interfaces.find(i => i.id === interfaceID);
	if (!target) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'unknown interface');
	if (target.medium !== 'wireless') throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'not a wireless interface');
	if (!target.wifiConfigurable) throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'this Wi-Fi interface is not managed by NetworkManager');
}

/**
 * Validate a Unix interface id before it reaches a child process.
 *
 * A device name is what the kernel exposes, so the accepted set is the kernel's:
 * up to IFNAMSIZ-1 bytes of anything but `/` and NUL — the same limit on Linux
 * and macOS. The check exists because the id crosses the API boundary from a
 * client, not because the tools would misparse it: arguments are passed as argv,
 * never through a shell.
 */
export function assertDeviceName(interfaceID: string): string {
	if (!interfaceID || new TextEncoder().encode(interfaceID).byteLength > 15 || /[/\0]/.test(interfaceID)) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid interface');
	return interfaceID;
}

/**
 * Turn a failed configuration command into one coded error the UI can show.
 *
 * The useful part of such a failure is what the tool printed — "Access is
 * denied", "Connection activation failed: Secrets were required", "Command
 * requires admin privileges" — and which stream carries it depends on the tool:
 * nmcli and PowerShell use stderr, but macOS `networksetup` prints its errors to
 * STDOUT and signals the failure only through the exit code. Reading stderr alone
 * would leave a macOS user with "Command failed: /usr/sbin/networksetup …" and no
 * reason. Our own coded errors pass through untouched.
 */
/**
 * The first meaningful line of a tool's error output.
 *
 * PowerShell follows its message with the offending command and a caret ruler,
 * so the raw text would fill a dialog with our own script; only the first line
 * carries the reason.
 */
export function firstLine(text: string | undefined): string {
	return (
		(text ?? '')
			.split(/\r?\n/)
			.map(line => line.trim())
			.find(line => line.length > 0)
			?.slice(0, 300) ?? ''
	);
}

async function run<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (err) {
		if (err instanceof CodedError) throw err;
		const failure = err as { stderr?: string | Buffer; stdout?: string | Buffer };
		const detail = failure.stderr?.toString().trim() || failure.stdout?.toString().trim();
		throw new CodedError(ErrorCodes.NETCONFIG_FAILED, firstLine(detail) || (err as Error).message || 'command failed');
	}
}
