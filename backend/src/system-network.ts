import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Mutex } from 'async-mutex';
import { CodedError, ErrorCodes, isValidSSID, isValidWifiKey, validateIPv4Config, type NetAddress, type NetCapabilities, type NetInterfaceInfo, type NetIPv4Config, type NetworkStateInfo, type NetWifiNetwork } from '@shared';
import { connectWindowsWifi, isWindowsInterfaceID, isWindowsWifiConfigurable, parseElevation, parseWindowsNetworkState, readWindowsWifi, scanWindowsWifi, windowsApplyIPv4Command, windowsIPv4Objection, WINDOWS_ELEVATION_COMMAND, WINDOWS_STATE_COMMAND } from './system-network-windows.ts';
import { applyLinuxIPv4, connectLinuxWifi, isLinuxWritable, readLinuxNetworkState, scanLinuxWifi } from './system-network-linux.ts';
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
 *  - Wi-Fi scan/join applies on Windows (wlanapi, no elevation needed) and on a
 *    Linux host running NetworkManager. It does not apply on macOS, where the
 *    operating system withholds every network name from a process without
 *    Location access — see system-network-macos.ts for the measurements.
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
 * Bumped by {@link resetNetworkStateCache}. A read carries the generation it
 * started under, so a read still in flight when a configuration change lands
 * publishes nothing — its answer describes the host as it was before the change.
 */
let cacheGeneration = 0;

/**
 * Serializes every host reconfiguration.
 *
 * An apply is several destructive steps — flush the address, set the new one,
 * rewrite the route, bring the profile back up — and two clients running them at
 * once interleave those steps and leave the interface with both configurations
 * stacked. One lock for the whole host rather than one per interface: a Wi-Fi
 * join and an IPv4 apply on different interfaces still contend over the default
 * route and the resolver list.
 */
const applyLock = new Mutex();

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
		// This reader is the fallback for a platform with no configuration backend at
		// all, and its ids are runtime device names rather than the identifiers an
		// apply resolves. Nothing it reports can be edited.
		result.push({ id: name, name, medium: 'other', link: 'unknown', defaultRoute: false, mac, addresses, ipv4Mode: 'unknown', gateway: null, dns: [], ipv4Configurable: false, wifiScannable: false, wifiConnectable: false });
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
 * Read the current network state WITHOUT waiting for a reconfiguration to
 * finish.
 *
 * Results are cached for {@link CACHE_TTL_MS} and concurrent callers share the
 * one in-flight read, so a poll tick and an RPC call arriving together cost a
 * single spawn. A failed platform read degrades to the address-only reader
 * rather than throwing — a settings screen showing addresses beats an error.
 *
 * The name is a warning. This is the read a mutation performs on ITSELF, to
 * establish its own premise from inside {@link runHostMutation} — it cannot wait
 * for a lock its own caller is holding. Every other caller wants
 * {@link readSettledNetworkState}: called during a mutation this one reaches the
 * platform between two destructive steps and answers with an interface that has
 * no address yet, or an address with no route.
 */
export async function readNetworkStateUnlocked(primaryInterface: string = ''): Promise<NetworkStateInfo> {
	// Two attempts at most. An apply landing mid-read invalidates that read — its
	// answer describes the host before the change — which leaves the cache empty,
	// and the caller deserves the state after the change rather than "unknown".
	for (let attempt = 0; attempt < 2 && isCacheStale(); attempt++) await startOrJoinRead();
	const interfaces = cached?.interfaces ?? [];
	return { interfaces, primaryID: resolvePrimaryID(interfaces, primaryInterface), detail: cached?.detail ?? 'addressesOnly', known: cached !== null, capabilities: await readCapabilities() };
}

/**
 * Read the network state a reconfiguration has SETTLED on — the read every
 * caller outside a mutation wants.
 *
 * Taking the same lock the mutations take is the whole of it: a read that
 * arrives while one is running waits for it instead of describing the host
 * halfway through, and a mutation that would start while this read is in flight
 * waits for the read. Skipping the poll tick was only ever half the answer,
 * because a direct `system.network` request never consulted the lock at all —
 * and a Windows Wi-Fi join holds it for far longer than {@link CACHE_TTL_MS}, so
 * the cache expires mid-join and the next request reads the machine between the
 * old profile going and the new association arriving.
 *
 * Waiting is bounded by the mutation itself ({@link APPLY_TIMEOUT_MS}, or the
 * association timeout for a join), and the answer is worth the wait: the reading
 * it replaces was not slower, it was wrong.
 *
 * NEVER call this from inside {@link runHostMutation} — the lock is not
 * reentrant and the mutation would wait on itself. That path has
 * {@link readNetworkStateUnlocked}.
 */
export function readSettledNetworkState(primaryInterface: string = ''): Promise<NetworkStateInfo> {
	return applyLock.runExclusive(() => readNetworkStateUnlocked(primaryInterface));
}

function isCacheStale(): boolean {
	return !cached || Date.now() - cached.at >= CACHE_TTL_MS;
}

/** Start a platform read, or join the one already running. Never rejects. */
function startOrJoinRead(): Promise<NetInterfaceInfo[]> {
	if (!inFlight) {
		const generation = cacheGeneration;
		const detail: NetworkStateInfo['detail'] = process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin' ? 'full' : 'addressesOnly';
		inFlight = readPlatform()
			.then(assertReadProducedSomething)
			.then(interfaces => {
				publish(generation, interfaces, detail);
				return interfaces;
			})
			.catch(err => {
				console.warn('[system-network] Platform read failed, falling back to addresses only:', (err as Error).message);
				const interfaces = readGenericInterfaces();
				publish(generation, interfaces, 'addressesOnly');
				return interfaces;
			})
			.finally(() => {
				// Only clear the slot we own: after an invalidation it has already been
				// cleared, and a newer read may be sitting in it.
				if (cacheGeneration === generation) inFlight = null;
			});
	}
	return inFlight;
}

/** Store a completed read, unless a configuration change has since invalidated it. */
function publish(generation: number, interfaces: NetInterfaceInfo[], detail: NetworkStateInfo['detail']): void {
	if (generation !== cacheGeneration) return;
	cached = { at: Date.now(), interfaces, detail };
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

/**
 * Drop the cached reading — after an apply, and in tests so a stale entry cannot
 * leak between cases. A read already in flight cannot be cancelled, so instead the
 * generation is bumped and that read is left to finish and publish nothing.
 */
export function resetNetworkStateCache(): void {
	cached = null;
	inFlight = null;
	cacheGeneration++;
}

/**
 * True while a host reconfiguration holds the lock.
 *
 * The generation counter discards a read that STARTED before a mutation, but not
 * one that starts during it: such a read carries the current generation, is
 * accepted when it finishes, and describes an interface halfway through the
 * change — no address yet, or an address with no route. The 10 s poll hits that
 * window on any apply that outlasts one tick, and the two-attempt retry in
 * {@link readNetworkStateUnlocked} walks straight into it, because the attempt that gets
 * discarded is followed by one taken mid-apply.
 *
 * There is no reading of a half-applied interface worth broadcasting, so the
 * publisher skips the tick instead. Nothing is lost: `applyAndPublish` reads and
 * broadcasts the settled state the moment the mutation is done.
 *
 * Counted rather than read off the lock. {@link readSettledNetworkState} takes the
 * same lock — that is how it waits for a reconfiguration — so `applyLock.isLocked()`
 * was also true throughout every ordinary read, and the publisher then dropped its
 * tick because another read was in progress. Nothing was damaged by that, but the
 * footer sat up to a poll interval behind for no reason.
 */
export function hostMutationInProgress(): boolean {
	return mutationDepth > 0;
}

/** How many host reconfigurations are running. Only {@link runHostMutation} moves it. */
let mutationDepth = 0;

/**
 * The current cache generation. Exported so a test can observe that a mutation
 * invalidated the cache on both sides of the platform action, which is otherwise
 * only visible as the absence of a stale reading several seconds later.
 */
export function networkStateGeneration(): number {
	return cacheGeneration;
}

/**
 * Run one host reconfiguration, with the cached reading invalidated on both
 * sides of it.
 *
 * The leading invalidation is the half that used to be missing. A platform apply
 * is several commands and is not atomic — it can change the address and then fail
 * rewriting the route — while the 10 s poll reads the host on its own schedule. A
 * read that starts mid-apply used to carry the pre-apply generation, so when it
 * finished it was accepted as valid and an intermediate state was published as
 * the truth. Bumping first means any read overlapping the mutation is discarded.
 *
 * The trailing invalidation is in a `finally` for the same reason: a failed apply
 * is precisely the case where the cached reading is fiction, because the failure
 * says the request did not complete but says nothing about how much of it did.
 */
export async function runHostMutation<T>(action: () => Promise<T>): Promise<T> {
	return applyLock.runExclusive(() => trackedMutation(action));
}

/** The body of {@link runHostMutation}, minus taking the lock — see {@link mutateAndReadBack}. */
async function trackedMutation<T>(action: () => Promise<T>): Promise<T> {
	mutationDepth++;
	resetNetworkStateCache();
	try {
		return await action();
	} finally {
		resetNetworkStateCache();
		mutationDepth--;
	}
}

/** A reconfiguration and the state the host settled on afterwards, whether it worked or not. */
export interface MutationOutcome {
	/** The state read once the change was done, or null when that read failed too. */
	readonly state: NetworkStateInfo | null;
	/** Why the reconfiguration failed, or null when it did not. */
	readonly failure: unknown;
	/** Why the follow-up read failed, or null when it did not. */
	readonly readError: unknown;
}

/**
 * Reconfigure the host and read the result WITHOUT letting go of the lock in
 * between.
 *
 * Doing the two separately looked equivalent and was not. `runExclusive` hands the
 * mutex to the longest-waiting owner the instant it is released, so a second apply
 * already queued behind this one started before the first had read anything — and
 * the first request then waited for the second to finish and answered with ITS
 * state. Two clients saving at once each got the other's configuration back, and a
 * fast apply could be held up behind a twenty-second Wi-Fi join for a reading it
 * was not going to use.
 *
 * The read is `readNetworkStateUnlocked` deliberately: the settled read takes this
 * very lock, and the mutex is not reentrant. It runs after {@link trackedMutation}
 * has invalidated the cache on its way out, so it reaches the platform rather than
 * returning the reading the mutation displaced.
 *
 * Both failures are carried out rather than thrown, because the caller has to
 * broadcast the state before deciding which error to report — a half-applied
 * change leaves the machine in a state the error does not describe.
 *
 * `read` is a parameter so a test can make the reading depend on what the action
 * did, which is the only way the swapped answer above is visible at all.
 * Production passes nothing.
 */
export function mutateAndReadBack(action: () => Promise<void>, primaryInterface: string, read: (primary: string) => Promise<NetworkStateInfo> = readNetworkStateUnlocked): Promise<MutationOutcome> {
	return applyLock.runExclusive(async () => {
		let failure: unknown = null;
		try {
			await trackedMutation(action);
		} catch (err) {
			failure = err;
		}
		try {
			return { state: await read(primaryInterface), failure, readError: null };
		} catch (readError) {
			return { state: null, failure, readError };
		}
	});
}

/**
 * What this host lets the app change.
 *
 * Remembered rather than asked on every read, because two of the three probes
 * cost a child process. What "remembered" means differs by platform, and each
 * difference is a property of the answer rather than a policy:
 *
 *  - Windows Wi-Fi is re-asked every time. It is an in-process wlanapi
 *    enumeration, and it genuinely changes under a running app — a USB adapter
 *    plugged in, or WLAN AutoConfig restarted, used to leave the whole Wi-Fi
 *    section hidden until a restart. See {@link withVolatileCapabilities}.
 *  - Windows IPv4 and macOS are remembered for good. An elevated token is fixed
 *    for the life of a process and `admin` group membership for the life of a
 *    login; neither can be re-answered differently without a new process.
 *  - Linux expires after {@link CAPABILITIES_TTL_MS}. That answer is a polkit
 *    verdict about a daemon, and all of "NetworkManager was not running yet",
 *    "the first `nmcli` call failed" and "a polkit rule changed" are ordinary
 *    events inside one run — remembering the first answer for the life of the
 *    process meant a restart was the only way to pick any of them up.
 */
let capabilities: { at: number; value: NetCapabilities } | null = null;

/**
 * How long a probe that can go stale is remembered.
 *
 * Long enough that the 5 s read cadence does not pay for an `nmcli` spawn again
 * and again — the reason the answer was remembered for ever in the first place —
 * and short enough that starting NetworkManager, or being granted the polkit
 * rule, shows up without restarting the app.
 */
const CAPABILITIES_TTL_MS = 60000;

/**
 * Re-answer the parts of a remembered probe that can change while the app runs.
 *
 * Only the Windows Wi-Fi answer can be re-asked for free: it is an in-process
 * wlanapi enumeration. An elevated token is fixed for the life of a process and
 * `admin` group membership for the life of a login, so neither is worth asking
 * twice, and the Linux answer costs an `nmcli` spawn that a 5 s read cadence must
 * not pay for on every tick — that one expires on a timer instead, see
 * {@link isCapabilityProbeStale}.
 */
export function withVolatileCapabilities(remembered: NetCapabilities, platform: string, probeWifi: () => boolean): NetCapabilities {
	return platform === 'win32' ? { ...remembered, wifi: probeWifi() } : remembered;
}

/**
 * True when a remembered probe is old enough to be worth asking again.
 *
 * Only the Linux one is: see the platform notes on {@link capabilities}. Ageing
 * the Windows set would buy nothing and cost a PowerShell spawn a minute, since
 * the only Windows answer that can change is already re-asked on every read.
 */
export function isCapabilityProbeStale(at: number, platform: string): boolean {
	return platform === 'linux' && Date.now() - at >= CAPABILITIES_TTL_MS;
}

/**
 * The probe currently running, shared by every caller that found the answer stale.
 *
 * Without it, each of the concurrent callers that arrive once the Linux TTL has
 * expired ran its own `nmcli` probe, and the last one to FINISH stored its answer
 * whichever had started first. A transient failure racing a success could
 * therefore land last and pin `ipv4: false, wifi: false` — the whole settings
 * screen greyed out — for the next minute. One probe, one answer, everybody gets
 * it.
 *
 * No generation token goes with it, because nothing invalidates a probe
 * explicitly: it expires on age alone, so the single probe in flight is always the
 * newest one there is.
 */
let capabilitiesInFlight: Promise<NetCapabilities> | null = null;

/**
 * What this host lets the app change, remembered per {@link capabilities}.
 *
 * `platform` and `probe` are parameters so a test can drive the staleness and
 * single-flight behaviour of a platform it is not running on; production passes
 * neither.
 */
export function readCapabilities(platform: string = process.platform, probe: (target: string) => Promise<NetCapabilities> = probeCapabilities): Promise<NetCapabilities> {
	if (capabilities && !isCapabilityProbeStale(capabilities.at, platform)) return Promise.resolve(withVolatileCapabilities(capabilities.value, platform, isWindowsWifiConfigurable));
	if (!capabilitiesInFlight) {
		capabilitiesInFlight = probe(platform)
			.then(value => {
				capabilities = { at: Date.now(), value };
				return value;
			})
			.finally(() => {
				capabilitiesInFlight = null;
			});
	}
	return capabilitiesInFlight;
}

/** Drop the remembered probe, so a test cannot inherit one another case installed. */
export function resetCapabilityProbe(): void {
	capabilities = null;
	capabilitiesInFlight = null;
}

/** Ask the host itself, once. */
async function probeCapabilities(platform: string): Promise<NetCapabilities> {
	// The Get/Set-Net* cmdlets refuse outright without an elevated token, so the
	// capability is that token — probed here rather than discovered by the user when
	// Save fails. Wi-Fi goes through wlanapi instead, which asks for no elevation at
	// all, so the two are probed separately.
	if (platform === 'win32') return { ipv4: await isWindowsElevated(), wifi: isWindowsWifiConfigurable(), staticGatewayRequired: false };
	if (platform === 'linux') {
		const managed = await isLinuxWritable();
		return { ipv4: managed, wifi: managed, staticGatewayRequired: false };
	}
	// networksetup persists a change and is present on every macOS install, so
	// addressing is editable. Wi-Fi is not: see isMacWifiConfigurable. The gateway
	// requirement is macOS's alone — `-setmanual` takes the router as a mandatory
	// value, and the form has to know that before the user presses Save.
	if (platform === 'darwin') return { ipv4: await isMacWritable(), wifi: isMacWifiConfigurable(), staticGatewayRequired: true };
	// Everything else reads through os.networkInterfaces(), which cannot even report
	// whether an address came from DHCP. Offering to edit a configuration we cannot
	// describe would be worse than not offering it.
	return { ipv4: false, wifi: false, staticGatewayRequired: false };
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

/**
 * Why one interface may not have its IPv4 configuration replaced right now, or
 * null when it may.
 *
 * These are the same three conditions the settings screen checks before it
 * offers the edit — and the frontend must not be the boundary that enforces
 * them. A direct RPC client sends none of them, and a frontend acting on a
 * snapshot a few seconds old sends them as they WERE. The apply is destructive
 * in a way that cannot be walked back from a wrong premise: on Windows it
 * removes every IPv4 address and every default route before creating the single
 * new one, which is exactly the aliases this last condition exists to protect.
 */
export function ipv4EditObjection(state: NetworkStateInfo, interfaceID: string): CodedError | null {
	// An address-only reading reports runtime device names where the apply
	// resolves adapter GUIDs or NetworkManager profiles, and cannot say whether
	// an address came from DHCP. Nothing in it is a safe premise for a write.
	if (state.detail !== 'full') return new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'the host network state could not be read in full');
	const target = state.interfaces.find(i => i.id === interfaceID);
	if (!target) return new CodedError(ErrorCodes.NETCONFIG_INVALID, 'unknown interface');
	if (target.ipv4Configurable !== true) return new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'this interface cannot be reconfigured');
	// The configuration holds ONE address and applying it replaces every address
	// the interface had. Until the API can express and preserve aliases, an
	// interface carrying several is one this app must decline rather than thin out.
	if (target.addresses.filter(a => a.family === 'ipv4').length > 1) return new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'this interface carries several IPv4 addresses, which this app cannot preserve');
	return null;
}

/**
 * Apply an IPv4 configuration to one interface and answer with the state the host
 * settled on.
 *
 * The state is read inside the same critical section as the change — see
 * {@link mutateAndReadBack} — so it is this request's own outcome rather than
 * whatever a second apply queued behind it went on to do.
 *
 * Everything checkable without touching the host is checked BEFORE the lock, so a
 * malformed configuration is refused immediately instead of waiting out a
 * twenty-second Wi-Fi join queued ahead of it. Such a refusal happens before
 * anything changed, so it carries no state to publish and simply throws.
 */
export async function applyIPv4(interfaceID: string, config: NetIPv4Config, primaryInterface: string = ''): Promise<MutationOutcome> {
	const invalid = validateIPv4Config(config);
	if (invalid) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, `invalid ${invalid}`);
	// Coherent is not the same as expressible. The shared validator answers the
	// first for every platform; the second is the platform's own answer, and asking
	// it here rather than mid-apply is the difference between a refused request and
	// an interface whose addresses have already been removed. See
	// {@link windowsIPv4Objection}.
	const unsupported = process.platform === 'win32' ? windowsIPv4Objection(config) : null;
	if (unsupported) throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, unsupported);
	const supported = await readCapabilities();
	if (!supported.ipv4) throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'this host does not expose a writable network configuration');
	return mutateAndReadBack(async () => {
		// Inside the lock and after the cache has been invalidated, so this reaches the
		// platform: the premise is the host as it is now, not as some earlier reading
		// described it.
		const objection = ipv4EditObjection(await readNetworkStateUnlocked(), interfaceID);
		if (objection) throw objection;
		await run(async () => {
			if (process.platform === 'win32') {
				await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsApplyIPv4Command(assertWindowsGuid(interfaceID), config)], { timeout: APPLY_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true });
			} else if (process.platform === 'darwin') {
				await applyMacIPv4(assertDeviceName(interfaceID), config);
			} else {
				await applyLinuxIPv4(assertDeviceName(interfaceID), config);
			}
		});
	}, primaryInterface);
}

/** Scan for joinable Wi-Fi networks on one interface. */
export async function scanWifi(interfaceID: string): Promise<NetWifiNetwork[]> {
	await assertWirelessInterface(interfaceID, 'wifiScannable');
	if (process.platform === 'win32') return run(() => scanWindowsWifi(assertWindowsGuid(interfaceID)));
	return run(() => scanLinuxWifi(assertDeviceName(interfaceID)));
}

/**
 * Join a Wi-Fi network on one interface, and answer with the state that resulted.
 * An empty password means an open network. See {@link applyIPv4} on why the read
 * shares the mutation's critical section.
 */
export async function connectWifi(interfaceID: string, ssid: string, password: string, primaryInterface: string = ''): Promise<MutationOutcome> {
	if (!isValidSSID(ssid)) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid ssid');
	// Checked before anything is written. On Windows the profile lands on disk
	// ahead of the association attempt, so a credential no WPA2/WPA3 network could
	// ever accept would overwrite a working saved one purely in order to fail.
	if (password && !isValidWifiKey(password)) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid password');
	// The passphrase reaches nmcli as an argv entry, so every text derived from a
	// failure of that child process has to be scrubbed of it before it is logged
	// or sent back — including the timeout case, where the only text available is
	// the message execFile assembled out of the whole command line.
	return mutateAndReadBack(async () => {
		// Both premises are established INSIDE the lock, after the cache has been
		// invalidated — exactly as applyIPv4 does. Read outside it, they come from a
		// reading up to CACHE_TTL_MS old and from before any mutation queued ahead of
		// this one ran, so "not currently on that network" could already be false by
		// the time the join starts. The interface the guard approved is then the one
		// the join runs against.
		const target = await assertWirelessInterface(interfaceID, 'wifiConnectable');
		if (isAlreadyJoined(target, ssid)) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'this interface is already connected to that network');
		if (process.platform === 'win32') await run(() => connectWindowsWifi(assertWindowsGuid(interfaceID), ssid, password), [password]);
		else await run(() => connectLinuxWifi(assertDeviceName(interfaceID), ssid, password), [password]);
	}, primaryInterface);
}

/** Validate a Windows interface id before it addresses an adapter. Same boundary check as {@link assertDeviceName}. */
function assertWindowsGuid(interfaceID: string): string {
	if (!isWindowsInterfaceID(interfaceID)) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid interface');
	return interfaceID;
}

/**
 * Refuse a Wi-Fi operation the interface cannot perform.
 *
 * Without this the request reaches nmcli, which answers "Device 'enp6s18' is not
 * a Wi-Fi device" — a true statement, but one that surfaces as a command failure
 * for what is really a bad request. The medium comes from the same read the UI
 * displays, so the two can never disagree about which interfaces are wireless.
 *
 * `capability` is the per-interface flag the operation actually needs, checked
 * here rather than trusted from the frontend: scanning and joining are separate
 * answers, and a direct RPC client sends neither.
 */
async function assertWirelessInterface(interfaceID: string, capability: 'wifiScannable' | 'wifiConnectable'): Promise<NetInterfaceInfo> {
	const supported = await readCapabilities();
	if (!supported.wifi) throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'this host cannot configure Wi-Fi');
	const state = await readNetworkStateUnlocked();
	const target = state.interfaces.find(i => i.id === interfaceID);
	if (!target) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'unknown interface');
	if (target.medium !== 'wireless') throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'not a wireless interface');
	if (target[capability] !== true) throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'this interface cannot be driven over Wi-Fi');
	return target;
}

/**
 * True when this interface is ALREADY associated with the named network.
 *
 * Such a join cannot be verified and must not be attempted. Windows confirms an
 * association by polling whether the adapter is connected and to which SSID —
 * and if it was already connected to that SSID, the very first poll sees the
 * still-live old connection and reports success before Windows has finished the
 * new attempt. A wrong password is then never noticed, because success has been
 * reported and no rollback runs. It is also destructive for nothing: on Windows
 * a join rewrites the stored profile before associating, so re-joining the
 * current network replaces a working saved configuration to arrive back where it
 * started.
 *
 * The frontend already hides the row, which is not the same as the backend
 * refusing it — a snapshot a few seconds old, a state change mid-operation, or a
 * direct RPC call all reach here regardless.
 *
 * ponytail: this closes the false-success path for the case that produces it.
 * Proving an association in general needs `WlanRegisterNotification` and a
 * notification-driven state machine correlated by interface, profile and
 * attempt — a redesign, not a guard.
 */
export function isAlreadyJoined(iface: NetInterfaceInfo, ssid: string): boolean {
	return iface.link === 'up' && iface.wifi?.ssid === ssid;
}

/**
 * Validate a Unix interface id before it reaches a child process.
 *
 * A device name is what the kernel exposes, so the accepted set is the kernel's:
 * up to IFNAMSIZ-1 bytes of anything but `/` and NUL — the same limit on Linux
 * and macOS. The check exists because the id crosses the API boundary from a
 * client, not because the tools would misparse it: arguments are passed as argv,
 * never through a shell.
 *
 * The limit is counted in BYTES, which is what IFNAMSIZ measures. `.length`
 * counts UTF-16 code units, so a name of accented characters passed a
 * 15-character check while being well over 15 octets — and the kernel then
 * truncates or refuses a name the boundary had already accepted.
 */
export function assertDeviceName(interfaceID: string): string {
	if (!interfaceID || Buffer.byteLength(interfaceID, 'utf8') > 15 || /[/\0]/.test(interfaceID)) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'invalid interface');
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

/** Replace every occurrence of each secret with `<redacted>`. Empty secrets are ignored. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
	let result = text;
	for (const secret of secrets) if (secret.length > 0) result = result.split(secret).join('<redacted>');
	return result;
}

/**
 * The string-valued fields of a child-process failure that can carry the argv.
 *
 * `stack` is in the list because an already-materialized stack keeps the message
 * it was rendered with, so scrubbing `message` alone leaves the secret in the
 * trace a logger would print.
 */
const SCRUBBED_ERROR_FIELDS = ['message', 'stack', 'cmd', 'command', 'stdout', 'stderr'] as const;
/** How far down a `cause` chain to keep scrubbing. Deep enough for any wrapper, bounded against a cycle. */
const SCRUB_MAX_DEPTH = 4;

/**
 * Strip secret values out of a failed child process's error, in place.
 *
 * `execFile` builds both `message` and `cmd` out of the whole argv, so a
 * passphrase passed as an argument sits in both — and on a TIMEOUT `stderr` is
 * empty, which is precisely when {@link run} falls back to `message`. Measured
 * against a real failing child: the secret appeared verbatim in `message` and
 * `cmd` on a non-zero exit and on a timeout alike.
 *
 * The object is mutated rather than only read so that a later log of the raw
 * error, or a `JSON.stringify` of it in a bug report, cannot leak what the
 * returned detail no longer carries.
 */
export function scrubChildError<T>(err: T, secrets: readonly string[]): T {
	const usable = secrets.filter(secret => secret.length > 0);
	if (usable.length === 0) return err;
	let node: any = err;
	for (let depth = 0; node && typeof node === 'object' && depth < SCRUB_MAX_DEPTH; depth++) {
		for (const field of SCRUBBED_ERROR_FIELDS) if (typeof node[field] === 'string') assignQuietly(node, field, redactSecrets(node[field], usable));
		if (Array.isArray(node.spawnargs))
			assignQuietly(
				node,
				'spawnargs',
				node.spawnargs.map((arg: unknown) => (typeof arg === 'string' ? redactSecrets(arg, usable) : arg))
			);
		node = node.cause;
	}
	return err;
}

/** Assign, tolerating a getter-only or frozen property — a failed scrub of one field must not abort the rest. */
function assignQuietly(target: Record<string, unknown>, key: string, value: unknown): void {
	try {
		target[key] = value;
	} catch {
		// Read-only property. What it holds still reaches nobody: the detail below is
		// built by redacting a copy, never by reading the object back.
	}
}

/**
 * Run a configuration command, turning any failure into one coded error.
 *
 * `secrets` are values the caller handed to a child process that must never
 * reach the log or the client — see {@link scrubChildError}.
 */
export async function run<T>(action: () => Promise<T>, secrets: readonly string[] = []): Promise<T> {
	try {
		return await action();
	} catch (err) {
		if (err instanceof CodedError) throw err;
		scrubChildError(err, secrets);
		const failure = err as { stderr?: string | Buffer; stdout?: string | Buffer };
		const detail = failure.stderr?.toString().trim() || failure.stdout?.toString().trim();
		throw new CodedError(ErrorCodes.NETCONFIG_FAILED, redactSecrets(firstLine(detail) || (err as Error).message || 'command failed', secrets));
	}
}
