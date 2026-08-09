import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CodedError, ErrorCodes, isValidSSID, validateIPv4Config, type NetAddress, type NetCapabilities, type NetInterfaceInfo, type NetIPv4Config, type NetworkStateInfo, type NetWifiNetwork } from '@shared';
import { isWindowsInterfaceID, parseWindowsNetworkState, readWindowsWifi, windowsApplyIPv4Command, WINDOWS_STATE_COMMAND } from './system-network-windows.ts';
import { applyLinuxIPv4, connectLinuxWifi, isLinuxWritable, readLinuxNetworkState, scanLinuxWifi } from './system-network-linux.ts';
import { applyMacIPv4, isMacWifiConfigurable, isMacWritable, readMacNetworkState } from './system-network-macos.ts';

const execFileAsync = promisify(execFile);

/**
 * Host network state and configuration, dispatched per platform.
 *
 * Writing is narrower than reading and says so through {@link NetCapabilities},
 * which the UI uses to decide whether to offer an edit at all:
 *
 *  - IPv4 (address, gateway, DNS) applies on Windows and on a Linux host running
 *    NetworkManager. Both need privileges; a refusal surfaces as NETCONFIG_FAILED
 *    rather than being pre-flighted, because probing costs a spawn on every read.
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

let cached: { at: number; interfaces: NetInterfaceInfo[]; detail: NetworkStateInfo['detail'] } | null = null;
let inFlight: Promise<NetInterfaceInfo[]> | null = null;

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
		result.push({ id: name, name, medium: 'other', link: 'unknown', defaultRoute: false, mac, addresses, ipv4Mode: 'unknown', gateway: null, dns: [] });
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
	const now = Date.now();
	if (!cached || now - cached.at >= CACHE_TTL_MS) {
		if (!inFlight) {
			const detail: NetworkStateInfo['detail'] = process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin' ? 'full' : 'addressesOnly';
			inFlight = readPlatform()
				.then(assertReadProducedSomething)
				.then(interfaces => {
					cached = { at: Date.now(), interfaces, detail };
					return interfaces;
				})
				.catch(err => {
					console.warn('[system-network] Platform read failed, falling back to addresses only:', (err as Error).message);
					const interfaces = readGenericInterfaces();
					cached = { at: Date.now(), interfaces, detail: 'addressesOnly' };
					return interfaces;
				})
				.finally(() => {
					inFlight = null;
				});
		}
		await inFlight;
	}
	const interfaces = cached?.interfaces ?? [];
	return { interfaces, primaryID: resolvePrimaryID(interfaces, primaryInterface), detail: cached?.detail ?? 'addressesOnly', known: cached !== null, capabilities: await readCapabilities() };
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
	cached = null;
	inFlight = null;
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
		// IPv4 applies through Get/Set-Net* and only needs elevation, which is
		// reported when the apply fails rather than probed up front — probing it
		// would cost a second spawn on every read. Wi-Fi is deliberately read-only.
		capabilities = { ipv4: true, wifi: false };
	} else if (process.platform === 'linux') {
		const managed = await isLinuxWritable();
		capabilities = { ipv4: managed, wifi: managed };
	} else if (process.platform === 'darwin') {
		// networksetup persists a change and is present on every macOS install, so
		// addressing is editable. Wi-Fi is not: see isMacWifiConfigurable.
		capabilities = { ipv4: await isMacWritable(), wifi: isMacWifiConfigurable() };
	} else {
		// Everything else reads through os.networkInterfaces(), which cannot even
		// report whether an address came from DHCP. Offering to edit a configuration
		// we cannot describe would be worse than not offering it.
		capabilities = { ipv4: false, wifi: false };
	}
	return capabilities;
}

/** Apply an IPv4 configuration to one interface, then drop the cache so the next read reflects it. */
export async function applyIPv4(interfaceID: string, config: NetIPv4Config): Promise<void> {
	const invalid = validateIPv4Config(config);
	if (invalid) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, `invalid ${invalid}`);
	const supported = await readCapabilities();
	if (!supported.ipv4) throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'this host does not expose a writable network configuration');
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
	resetNetworkStateCache();
}

/** Scan for joinable Wi-Fi networks on one interface. */
export async function scanWifi(interfaceID: string): Promise<NetWifiNetwork[]> {
	await assertWirelessInterface(interfaceID);
	return run(() => scanLinuxWifi(assertDeviceName(interfaceID)));
}

/** Join a Wi-Fi network on one interface. An empty password means an open network. */
export async function connectWifi(interfaceID: string, ssid: string, password: string): Promise<void> {
	await assertWirelessInterface(interfaceID);
	if (!isValidSSID(ssid)) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid ssid');
	await run(() => connectLinuxWifi(assertDeviceName(interfaceID), ssid, password));
	resetNetworkStateCache();
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
function assertDeviceName(interfaceID: string): string {
	if (!interfaceID || interfaceID.length > 15 || /[/\0]/.test(interfaceID)) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid interface');
	return interfaceID;
}

/**
 * Turn a failed configuration command into one coded error the UI can show.
 *
 * The useful part of such a failure is what the tool printed — "Access is
 * denied", "Connection activation failed: Secrets were required" — and that lands
 * on stderr, which a plain Error message does not carry. Our own coded errors
 * pass through untouched.
 */
async function run<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (err) {
		if (err instanceof CodedError) throw err;
		const stderr = (err as { stderr?: string | Buffer }).stderr?.toString().trim();
		throw new CodedError(ErrorCodes.NETCONFIG_FAILED, (stderr || (err as Error).message || 'command failed').slice(0, 300));
	}
}
