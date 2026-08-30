import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Mutex } from 'async-mutex';
import { CodedError, ErrorCodes, isValidSSID, validateIPv4Config, type NetAddress, type NetCapabilities, type NetInterfaceInfo, type NetIPv4Config, type NetworkStateInfo, type NetWifiNetwork } from '@shared';
import { isWindowsInterfaceID, parseElevation, parseWindowsNetworkState, readWindowsWifi, windowsApplyIPv4Command, WINDOWS_ELEVATION_COMMAND, WINDOWS_STATE_COMMAND } from './system-network-windows.ts';
import { applyLinuxIPv4, connectLinuxWifi, readLinuxCapabilities, readLinuxNetworkState, scanLinuxWifi } from './system-network-linux.ts';
import { applyMacIPv4, isMacWifiConfigurable, isMacWritable, readMacNetworkState } from './system-network-macos.ts';

const execFileAsync = promisify(execFile);

/**
 * Host network state and configuration, dispatched per platform.
 *
 * Writing is narrower than reading and says so through {@link NetCapabilities},
 * which the UI uses to decide whether to offer an edit at all:
 *
 *  - IPv4 (address, gateway, DNS) applies on Windows, on a Linux host running
 *    NetworkManager, and on macOS. All three need privileges, and each answers
 *    that question differently — an elevated token on Windows, a polkit verdict
 *    of `yes` on Linux, membership of the `admin` group on macOS. The answer is
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
		result.push({ id: name, name, medium: 'other', link: 'unknown', defaultRoute: false, mac, addresses, ipv4Mode: 'unknown', ipv4Configurable: false, gateway: null, dns: [] });
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
	const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_STATE_COMMAND], { timeout: WINDOWS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
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
 */
export async function readNetworkState(primaryInterface: string = ''): Promise<NetworkStateInfo> {
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
	if (primaryInterface && interfaces.some(i => i.id === primaryInterface)) return primaryInterface;
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
export function isIPv4ConfigUnchanged(target: NetInterfaceInfo, config: NetIPv4Config): boolean {
	if (!target.ipv4Configurable || target.ipv4Mode !== config.mode || config.dns !== undefined) return false;
	if (config.mode === 'dhcp') return true;
	const addresses = target.addresses.filter(address => address.family === 'ipv4');
	if (addresses.length !== 1) return false;
	const current = addresses[0]!;
	return current.address === config.address && current.prefixLength === config.prefixLength && (target.gateway ?? '') === (config.gateway ?? '');
}

/**
 * What this host lets the app change.
 *
 * Probed once and remembered: on Linux the answer is an `nmcli` spawn, and it
 * cannot change without the daemon being installed or stopped, which does not
 * happen inside one run of the app.
 */
let capabilities: NetCapabilities | null = null;

async function readCapabilities(): Promise<NetCapabilities> {
	if (capabilities) return capabilities;
	if (process.platform === 'win32') {
		// The Get/Set-Net* cmdlets refuse outright without an elevated token, so the
		// capability is that token — probed once here rather than discovered by the
		// user when Save fails. Wi-Fi is deliberately read-only.
		capabilities = { ipv4: await isWindowsElevated(), wifi: false, staticGatewayRequired: false };
	} else if (process.platform === 'linux') {
		capabilities = await readLinuxCapabilities();
	} else if (process.platform === 'darwin') {
		// networksetup persists a change and is present on every macOS install, so
		// addressing is editable. Wi-Fi is not: see isMacWifiConfigurable.
		capabilities = { ipv4: await isMacWritable(), wifi: isMacWifiConfigurable(), staticGatewayRequired: true };
	} else {
		// Everything else reads through os.networkInterfaces(), which cannot even
		// report whether an address came from DHCP. Offering to edit a configuration
		// we cannot describe would be worse than not offering it.
		capabilities = { ipv4: false, wifi: false, staticGatewayRequired: false };
	}
	return capabilities;
}

/** True when this process can actually run the privileged cmdlets. One spawn, cached with the capabilities. */
async function isWindowsElevated(): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ELEVATION_COMMAND], { timeout: WINDOWS_TIMEOUT_MS, maxBuffer: 1024, windowsHide: true });
		return parseElevation(stdout);
	} catch {
		return false;
	}
}

/** Apply an IPv4 configuration and read its resulting state before another mutation may begin. */
export async function applyIPv4(interfaceID: string, config: NetIPv4Config, primaryInterface: string = ''): Promise<NetworkStateInfo> {
	if (typeof interfaceID !== 'string' || !config || typeof config !== 'object') throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid request');
	const invalid = validateIPv4Config(config);
	if (invalid) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, `invalid ${invalid}`);
	return runNetworkMutation(async () => {
		const supported = await readCapabilities();
		if (!supported.ipv4) throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'this host does not expose a writable network configuration');
		const platformInvalid = validateIPv4Config(config, supported);
		if (platformInvalid) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, `invalid ${platformInvalid}`);
		// Never trust the UI snapshot at this boundary. A platform reader marks an
		// adapter read-only when its complete address/route state cannot be preserved,
		// and a fresh read closes the gap between opening the form and pressing Save.
		resetNetworkStateCache();
		const before = await readNetworkState(primaryInterface);
		const target = before.interfaces.find(item => item.id === interfaceID);
		if (!target) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'unknown interface');
		if (!target.ipv4Configurable || target.ipv4Mode === 'unknown') throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'interface configuration cannot be preserved safely');
		if (isIPv4ConfigUnchanged(target, config)) return before;
		try {
			await run(async () => {
				if (process.platform === 'win32') {
					if (!isWindowsInterfaceID(interfaceID)) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid interface');
					await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsApplyIPv4Command(interfaceID, config)], { timeout: APPLY_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true });
				} else if (process.platform === 'darwin') {
					await applyMacIPv4(assertDeviceName(interfaceID), config);
				} else {
					await applyLinuxIPv4(assertDeviceName(interfaceID), config);
				}
			});
		} finally {
			// A multi-step OS command may have changed part of the configuration
			// before failing. Never keep the pre-command snapshot in that case.
			resetNetworkStateCache();
		}
		return readNetworkState(primaryInterface);
	});
}

/** Scan for joinable Wi-Fi networks on one interface. */
export async function scanWifi(interfaceID: string): Promise<NetWifiNetwork[]> {
	if (typeof interfaceID !== 'string') throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid interface');
	await assertWirelessInterface(interfaceID);
	return run(() => scanLinuxWifi(assertDeviceName(interfaceID)));
}

/** Join a Wi-Fi network on one interface. An empty password means an open network. */
export async function connectWifi(interfaceID: string, ssid: string, password: string, primaryInterface: string = ''): Promise<NetworkStateInfo> {
	if (typeof interfaceID !== 'string') throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid interface');
	if (!isValidSSID(ssid)) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid ssid');
	if (!isValidWifiPassword(password)) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid password');
	return runNetworkMutation(async () => {
		await assertWirelessInterface(interfaceID);
		const available = await scanLinuxWifi(assertDeviceName(interfaceID));
		const network = available.find(item => item.ssid === ssid);
		if (!network) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'network is no longer available');
		if (!network.supported) throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'this Wi-Fi authentication method is not supported');
		try {
			await run(() => connectLinuxWifi(assertDeviceName(interfaceID), ssid, password));
		} finally {
			resetNetworkStateCache();
		}
		return readNetworkState(primaryInterface);
	});
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
	const state = await readNetworkState();
	const target = state.interfaces.find(i => i.id === interfaceID);
	if (!target) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'unknown interface');
	if (target.medium !== 'wireless') throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'not a wireless interface');
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
