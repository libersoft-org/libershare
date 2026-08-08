import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NetAddress, NetInterfaceInfo, NetworkStateInfo } from '@shared';
import { parseWindowsNetworkState, readWindowsWifi, WINDOWS_STATE_COMMAND } from './system-network-windows.ts';
import { readLinuxNetworkState } from './system-network-linux.ts';

const execFileAsync = promisify(execFile);

/**
 * Read-only host network state, dispatched per platform.
 *
 * This module NEVER changes network configuration — there is no code path here
 * that writes an address, a route, a DNS server or a radio state. Applying
 * configuration needs elevation on every supported platform and can lock a user
 * out of the very machine running the app, so it is deliberately out of scope.
 *
 * Windows and Linux report full detail (medium, carrier, DHCP mode, gateway,
 * DNS, Wi-Fi). Every other platform — macOS included — falls back to
 * `os.networkInterfaces()`, which is real data but only addresses and MACs;
 * that is reported honestly as `detail: 'addressesOnly'` rather than padded
 * out with invented fields.
 */

/** Hard cap on how long the PowerShell one-shot may run. */
const WINDOWS_TIMEOUT_MS = 15000;
/**
 * How long a successful read is reused. A Windows read costs one ~700 ms
 * PowerShell spawn, and the poll broadcasts every 10 s, so this keeps a client
 * opening the settings screen right after a tick from paying for a second spawn.
 */
const CACHE_TTL_MS = 5000;

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
			const detail: NetworkStateInfo['detail'] = process.platform === 'win32' || process.platform === 'linux' ? 'full' : 'addressesOnly';
			inFlight = readPlatform()
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
	return { interfaces, primaryID: resolvePrimaryID(interfaces, primaryInterface), detail: cached?.detail ?? 'addressesOnly', known: cached !== null };
}

function readPlatform(): Promise<NetInterfaceInfo[]> {
	if (process.platform === 'win32') return readWindows();
	if (process.platform === 'linux') return readLinuxNetworkState();
	return Promise.resolve(readGenericInterfaces());
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
