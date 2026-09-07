import { ptr, read, toArrayBuffer, type Pointer } from 'bun:ffi';
import type { NetWifiNetwork } from '@shared';
import { type WlanApi, type WlanHandle, MAX_SSID_LENGTH, ERROR_ALREADY_EXISTS, WLAN_PROFILE_USER, withWlanHandle, guidToBytes, utf16z, encodeConnectionParameters, readFixedUtf16, wlanErrorMessage, wlanReasonText, readAssociation } from './system-network-windows-wlan.ts';
import { assertProfileNameWritable, assertWindowsWifiKey, type JoinTarget, type ProfileChange, ssidHex, windowsWifiProfileXml, writeJoinProfile, openJoinDecision, readStoredProfile, writeProfile, readWrittenProfile, undoWifiProfileChange } from './system-network-windows-profiles.ts';


// ---------------------------------------------------------------------------
// wlanapi.dll (scanning and joining)
// ---------------------------------------------------------------------------

/**
 * WLAN_AVAILABLE_NETWORK, x64 (wlanapi.h). Every member is a DWORD or a DWORD
 * array, so the struct needs no padding and its size is the plain sum:
 *
 *   strProfileName[256] WCHAR   512  @   0
 *   dot11Ssid (DOT11_SSID)       36  @ 512   ULONG uSSIDLength + UCHAR ucSSID[32]
 *   dot11BssType                  4  @ 548
 *   uNumberOfBssids               4  @ 552
 *   bNetworkConnectable           4  @ 556
 *   wlanNotConnectableReason      4  @ 560
 *   uNumberOfPhyTypes             4  @ 564
 *   dot11PhyTypes[8]             32  @ 568
 *   bMorePhyTypes                 4  @ 600
 *   wlanSignalQuality             4  @ 604
 *   bSecurityEnabled              4  @ 608
 *   dot11DefaultAuthAlgorithm     4  @ 612
 *   dot11DefaultCipherAlgorithm   4  @ 616
 *   dwFlags                       4  @ 620
 *   dwReserved                    4  @ 624
 */
const AVAILABLE_NETWORK_SIZE = 628;
const AVAILABLE_PROFILE_NAME_OFFSET = 0;
/** strProfileName is a WCHAR[256] field, NUL-padded rather than NUL-terminated when full. */
const AVAILABLE_PROFILE_NAME_CHARS = 256;
const AVAILABLE_SSID_LENGTH_OFFSET = 512;
/** bNetworkConnectable: FALSE when Windows already knows it cannot join this network. */
const AVAILABLE_CONNECTABLE_OFFSET = 556;
/** wlanNotConnectableReason: a WLAN reason code, meaningful only when the flag above is FALSE. */
const AVAILABLE_NOT_CONNECTABLE_REASON_OFFSET = 560;
const AVAILABLE_SSID_OFFSET = 516;
const AVAILABLE_SIGNAL_OFFSET = 604;
const AVAILABLE_SECURITY_OFFSET = 608;
const AVAILABLE_AUTH_OFFSET = 612;
/** WLAN_AVAILABLE_NETWORK.dot11DefaultCipherAlgorithm, the field after the authentication one. */
const AVAILABLE_CIPHER_OFFSET = 616;
const AVAILABLE_FLAGS_OFFSET = 620;
/** Offset of the first WLAN_AVAILABLE_NETWORK inside WLAN_AVAILABLE_NETWORK_LIST (dwNumberOfItems + dwIndex). */
const AVAILABLE_LIST_HEADER = 8;
/** WLAN_AVAILABLE_NETWORK_CONNECTED — the interface is currently associated with this network. */
const AVAILABLE_NETWORK_CONNECTED = 0x00000001;
/**
 * Refuse to walk a list longer than this. The count comes out of a struct whose
 * layout is asserted, not negotiated, so a wrong offset would otherwise have us
 * read gigabytes of unrelated memory instead of failing.
 */
const MAX_AVAILABLE_NETWORKS = 512;
/** DOT11_AUTH_ALGO_WPA3_SAE — WPA3-Personal, which needs a different profile than WPA2. */
const AUTH_ALGO_WPA3_SAE = 9;

/**
 * How long to let the radio sweep before reading the network list.
 *
 * WlanScan is asynchronous: it returns as soon as the request is queued and the
 * results appear in the interface's list some seconds later. Microsoft documents
 * four seconds as the point at which a caller that is not listening for the
 * scan-complete notification should give up waiting, so that is what we wait.
 */
const SCAN_SETTLE_MS = 4000;
/** How long to wait for an association after WlanConnect accepted the request. */
const JOIN_TIMEOUT_MS = 20000;
/** How often the association is re-read while waiting for a join to complete. */
const JOIN_POLL_MS = 500;

/**
 * Decode a WLAN_AVAILABLE_NETWORK_LIST into the networks a user could join.
 *
 * Hidden networks report a zero-length SSID and are dropped for the same reason
 * the Linux reader drops them: they cannot be joined by name, so an unnamed row
 * would offer something that fails. One SSID can appear more than once (a roaming
 * network, or the same name with and without a stored profile), so entries
 * collapse to the strongest reading — carrying `active` and `secured` across,
 * since only one of the duplicates is the associated one.
 *
 * Implausible readings are dropped rather than reported: a signal above 100 or an
 * SSID longer than the 32 octets DOT11_SSID can hold means the offsets are being
 * read against something that is not this struct.
 */
export function parseAvailableNetworks(list: Pointer, reasonText?: (reason: number) => string | null): NetWifiNetwork[] {
	const best = new Map<string, NetWifiNetwork>();
	for (const found of availableNetworks(list)) {
		// Projected explicitly rather than by rest-spread: the decoded entry carries
		// the raw SSID bytes and the stored profile name, which the join path needs
		// and the wire contract does not have a field for.
		const unavailableReason = found.connectable ? null : reasonText?.(found.notConnectableReason);
		const entry: NetWifiNetwork = { ssid: found.ssid, bssid: found.bssid, signal: found.signal, secured: found.secured, security: found.security, supported: found.supported, active: found.active, connectable: found.connectable, ...(unavailableReason ? { unavailableReason } : {}) };
		// Access points are collapsed per NAME AND SECURITY, never per name alone.
		// One name can sit on two networks that are not the same network at all — an
		// open guest AP and an unrelated WPA2 one — and folding those together
		// invented readings neither advertised: the security of the stronger row with
		// the association of the weaker, so an open network the interface was on came
		// back as "WPA2, connected". Keyed this way each row still describes one real
		// network, and access points that agree still collapse into a single row.
		const key = `${entry.ssid}\0${entry.security}`;
		const previous = best.get(key);
		if (!previous) {
			best.set(key, entry);
			continue;
		}
		// One row wins outright and every field describing the NETWORK comes from it.
		// Merging them field by field invented readings no access point advertised:
		// an open row beside a WPA2 row of the same name produced `secured` from one
		// and `security` from the other, so the form asked for a password the profile
		// then declared open — and which of the two answers came out depended on the
		// order Windows happened to list them in.
		const strongest = (entry.signal ?? -1) > (previous.signal ?? -1) ? entry : previous;
		// `active` now only ever carries across access points of the SAME network, so
		// it says what it means: this interface is associated with this network,
		// whichever of its access points holds the association.
		best.set(key, { ...strongest, active: previous.active || entry.active });
	}
	return [...best.values()].sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1));
}

/**
 * The scan entry for one network name, or null when the list does not hold it.
 *
 * This is what a join resolves its target from: the profile name Windows itself
 * uses for the network, the SSID exactly as the radio reported it, and the
 * authentication algorithm that decides between a WPA2 and a WPA3 profile. A
 * network that is not in the list yields null, and the caller then falls back to
 * what the user asked for, which is the best available answer rather than a
 * guess about a network nobody can currently see.
 *
 * ponytail: a name is not an identity — one SSID can be several access points,
 * and on a WPA2/WPA3 transition network they can differ in authentication. The
 * strongest entry is taken, which is also the one the radio is likeliest to
 * associate with. Resolving this properly needs a scan identity (interface +
 * BSSID + SSID bytes) carried through the API, which the wire contract has no
 * field for.
 */
export function findScannedNetwork(list: Pointer, ssid: string): AvailableNetwork | 'ambiguous' | null {
	let best: AvailableNetwork | null = null;
	for (const entry of availableNetworks(list)) {
		if (entry.ssid !== ssid) continue;
		// An SSID is a byte sequence, and a decode is lossy: two DIFFERENT networks
		// whose names differ only in an undecodable octet arrive here under one
		// display name. Picking the strongest of those would join whichever happened
		// to be closer at that instant, which is not the network the user chose - and
		// the choice would flip between the list and the join.
		if (best && !sameBytes(best.ssidBytes, entry.ssidBytes)) return 'ambiguous';
		if (!best || (entry.signal ?? -1) > (best.signal ?? -1)) best = entry;
	}
	return best;
}

/** Byte-for-byte equality of two SSIDs, which is the only identity an SSID has. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** DOT11_CIPHER_ALGO_NONE — what an open network reports. */
const CIPHER_ALGO_NONE = 0;
/** DOT11_CIPHER_ALGO_CCMP — AES, and the only cipher the profiles here name. */
const CIPHER_ALGO_CCMP = 4;

/** DOT11_AUTH_ALGO_80211_OPEN — no authentication at all. */
const AUTH_ALGO_OPEN = 1;
/** DOT11_AUTH_ALGO_RSNA_PSK — WPA2-Personal. Note 6 is RSNA, which is 802.1X enterprise and NOT this. */
const AUTH_ALGO_RSNA_PSK = 7;

/**
 * The security label and joinability of one scanned network.
 *
 * The wire contract carries a scanner label because the Linux reader has one
 * from nmcli; Windows reports a DOT11_AUTH_ALGORITHM instead, so the label is
 * built from it. Only open, WPA2-PSK and WPA3-SAE are offered - everything else
 * (802.1X enterprise, the legacy WPA-None modes) needs a profile shape this app
 * does not write, and offering it would hand the user a button that fails.
 */
function windowsWifiSecurity(auth: number, cipher: number, secured: boolean): { security: string; supported: boolean } {
	if (!secured) return { security: '', supported: auth === AUTH_ALGO_OPEN && cipher === CIPHER_ALGO_NONE };
	// The authentication method is only half the answer. `joinSecurityElement` writes
	// `<encryption>AES</encryption>` and nothing else, so a network running WPA2 with
	// TKIP was offered as joinable and then handed a profile demanding a cipher it
	// does not speak — the association failed and the message sent the user to check
	// a password that was never the problem. Supporting TKIP is not the fix; not
	// claiming to support it is.
	const usable = cipher === CIPHER_ALGO_CCMP;
	if (auth === AUTH_ALGO_WPA3_SAE) return { security: 'WPA3', supported: usable };
	if (auth === AUTH_ALGO_RSNA_PSK) return { security: usable ? 'WPA2' : 'WPA2-TKIP', supported: usable };
	return { security: 'WPA-ENTERPRISE', supported: false };
}

/** One decoded WLAN_AVAILABLE_NETWORK, plus the fields the public list has no room for. */
export type AvailableNetwork = NetWifiNetwork & {
	/** DOT11_AUTH_ALGORITHM, as Windows last saw the network advertise it. */
	auth: number;
	/** The SSID as the radio reported it. Copied out of the list, which the caller frees. */
	ssidBytes: Uint8Array;
	/** Windows' own name for the stored profile of this network. Empty when nothing is stored. */
	profileName: string;
	/** False when Windows has already decided it cannot associate with this network. */
	connectable: boolean;
	/** Why not, as a WLAN reason code. Meaningful only when {@link connectable} is false. */
	notConnectableReason: number;
};

/** Walk the entries of a WLAN_AVAILABLE_NETWORK_LIST, skipping the ones that cannot be offered. */
function* availableNetworks(list: Pointer): Generator<AvailableNetwork> {
	const count = read.u32(list, 0);
	// A count past the cap is not a long list to be trimmed, it is evidence that
	// this buffer is not the structure we think it is — a wrong header offset, a
	// stale pointer, a layout change. Clamping and walking anyway read whatever
	// followed the allocation and reported it as networks; the only safe reading
	// of a corrupt structure is to refuse it. Windows' own list does not approach
	// this many entries even in the densest environment.
	if (count > MAX_AVAILABLE_NETWORKS) throw new Error(`the WLAN network list declares ${count} entries, which is not a plausible scan result`);
	const decoder = new TextDecoder();
	for (let i = 0; i < count; i++) {
		const base = AVAILABLE_LIST_HEADER + i * AVAILABLE_NETWORK_SIZE;
		const ssidLength = read.u32(list, base + AVAILABLE_SSID_LENGTH_OFFSET);
		const signal = read.u32(list, base + AVAILABLE_SIGNAL_OFFSET);
		if (ssidLength === 0 || ssidLength > MAX_SSID_LENGTH || signal > 100) continue;
		// `slice`, not `subarray`: the caller frees the list as soon as this
		// generator is drained, and the bytes have to outlive it.
		const ssidBytes = new Uint8Array(toArrayBuffer(list, base + AVAILABLE_SSID_OFFSET, MAX_SSID_LENGTH)).slice(0, ssidLength);
		const secured = read.u32(list, base + AVAILABLE_SECURITY_OFFSET) !== 0;
		const auth = read.u32(list, base + AVAILABLE_AUTH_OFFSET);
		const cipher = read.u32(list, base + AVAILABLE_CIPHER_OFFSET);
		yield {
			// Lossy by nature — an SSID is not guaranteed to be UTF-8 — so this form
			// is for display and for matching what the user picked, never for
			// building a profile. `ssidBytes` is the authoritative value.
			ssid: decoder.decode(ssidBytes),
			ssidBytes,
			profileName: readFixedUtf16(list, base + AVAILABLE_PROFILE_NAME_OFFSET, AVAILABLE_PROFILE_NAME_CHARS),
			signal,
			secured,
			active: (read.u32(list, base + AVAILABLE_FLAGS_OFFSET) & AVAILABLE_NETWORK_CONNECTED) !== 0,
			auth,
			...windowsWifiSecurity(auth, cipher, secured),
			// WLAN_AVAILABLE_NETWORK describes a NETWORK, not one access point, and
			// carries no BSSID. The Linux reader has one and uses it to tell equal
			// names apart; here the profile names the SSID and the WLAN service picks
			// the access point itself, so there is nothing honest to put here.
			bssid: null,
			connectable: read.u32(list, base + AVAILABLE_CONNECTABLE_OFFSET) !== 0,
			notConnectableReason: read.u32(list, base + AVAILABLE_NOT_CONNECTABLE_REASON_OFFSET),
		};
	}
}

/**
 * Explain a refused scan.
 *
 * Windows gates the available-network APIs on the location permission, so a scan
 * that comes back access-denied is almost never about privileges — it is the
 * location setting, and saying only "access denied" sends the user looking in the
 * wrong place. Every other code keeps its ordinary description.
 */
export function wlanScanErrorMessage(code: number): string {
	return code === 5 ? 'Windows refused the scan: allow location access for this app in Windows privacy settings' : wlanErrorMessage(code);
}

/** Scan for the Wi-Fi networks one adapter can see. */
export async function scanWindowsWifi(guid: string): Promise<NetWifiNetwork[]> {
	const guidBytes = guidToBytes(guid);
	const scanResult = withWlanHandle((api, handle) => api.WlanScan(handle, ptr(guidBytes), null, null, null));
	await delay(SCAN_SETTLE_MS);
	const networks = withWlanHandle((api, handle) => {
		const listOut = new BigUint64Array(1);
		const rc = api.WlanGetAvailableNetworkList(handle, ptr(guidBytes), 0, null, ptr(listOut));
		if (rc !== 0) throw new Error(wlanScanErrorMessage(rc));
		const list = Number(listOut[0]) as Pointer;
		try {
			return parseAvailableNetworks(list, reason => wlanReasonText(api, reason));
		} finally {
			api.WlanFreeMemory(list);
		}
	});
	// A refused scan is only worth reporting when it left us with nothing to show.
	// Windows declines a rescan that comes too soon after the last one, and in that
	// case the list it already holds is a perfectly good answer.
	if (networks.length === 0 && scanResult !== 0) throw new Error(wlanScanErrorMessage(scanResult));
	return networks;
}

/**
 * Join a Wi-Fi network, and wait until the adapter is actually on it.
 *
 * Windows only associates through a stored profile, so the whole job is deciding
 * which profile to connect by:
 *
 *  - With a password, the profile is written first, replacing any earlier one —
 *    that is what lets a user fix a network whose key has changed.
 *  - Without one, the stored profile is used as it stands. Only if there is none
 *    to use is a profile written, and then with overwrite off, so this path can
 *    never quietly replace a saved key with an open-network profile. A network
 *    that turns out not to be open then simply fails to associate.
 *
 * WlanConnect merely queues the association: it returns success long before the
 * adapter has associated, and a wrong password produces no error from it at all.
 * So the association is confirmed by re-reading it, and a join that never lands
 * is reported as a failure rather than as the success WlanConnect claimed.
 *
 * EVERY step that can change stored state is inside one try/catch, and the catch
 * undoes exactly what was done. This used to be three separate concerns and none
 * of them held: the profile overwrite and the synchronous WlanConnect happened
 * BEFORE the guard, so an immediately-refused connect threw past the restore
 * entirely; a profile this attempt had CREATED was never deleted, only "restored"
 * to nothing; and the restoring write ignored its own return code, its reason
 * code and the profile's original flags alike. One failed attempt could therefore
 * leave a network's stored configuration permanently changed or a dead profile
 * behind, and report neither.
 */
export async function connectWindowsWifi(guid: string, ssid: string, password: string): Promise<void> {
	const guidBytes = guidToBytes(guid);
	// Everything about the target is resolved once, from the list the WLAN service
	// already holds — no scan is triggered, so this costs a call and not four
	// seconds. Null when the network is not currently visible.
	const lookup = withWlanHandle((api, handle) => readScannedNetwork(api, handle, guidBytes, ssid));
	// A list that could not be read is not a network that is not there. Everything
	// below falls back to values GUESSED from what the user typed — the SSID as
	// text, the SSID as the profile name, WPA2 — and then writes a profile out of
	// them. That fallback is right for a network which is genuinely not visible;
	// running it because the WLAN service hiccuped is how a transient error came to
	// overwrite a saved network's configuration.
	if (lookup.kind === 'readError') throw new Error(`the list of visible networks could not be read, so this network was not joined (${lookup.message})`);
	// Two networks whose names differ only in a byte no decode can show apart. The
	// user picked one of them and there is no way to tell which, so neither is
	// joined rather than the stronger one being guessed at.
	if (lookup.kind === 'ambiguous') throw new Error('more than one network is broadcasting this name, and they cannot be told apart by name alone');
	const scanned = lookup.kind === 'found' ? lookup.network : null;
	// A profile name is NOT an SSID. Windows keeps the two apart, the profile name
	// is case-sensitive, and `WLAN_AVAILABLE_NETWORK` already carries the real one —
	// so addressing everything below by SSID meant an existing custom-named profile
	// was never found, never backed up, and a second competing profile was created
	// beside it. The SSID is only the fallback for a network the scan cannot see.
	const profileName = scanned?.profileName || ssid;
	// The SSID is a byte sequence, not text. The decoded form is what the user
	// picked from and what the association is checked against, but the profile is
	// built from the bytes the radio actually reported.
	const ssidBytes = scanned?.ssidBytes ?? new TextEncoder().encode(ssid);
	// WPA2 is the right default for a network the list does not name: it is what
	// the transition mode most access points run advertises, and it is also what an
	// out-of-date list would have said.
	const sae = scanned?.auth === AUTH_ALGO_WPA3_SAE;
	// Windows sets `bNetworkConnectable` FALSE when it has already decided it
	// cannot associate — an unsupported authentication or cipher, a policy
	// restriction. Attempting anyway spent twenty seconds waiting for an
	// association that was never going to happen and then told the user to check
	// the password, which was not the problem. The reason code Windows supplied
	// alongside it is the answer, so it is asked for by name.
	if (scanned && !scanned.connectable) throw new Error(withWlanHandle(api => wlanReasonText(api, scanned.notConnectableReason)) ?? 'Windows reports that this network cannot be joined');
	assertProfileNameWritable(profileName);
	if (password) assertWindowsWifiKey(password, sae);
	// Held in a local of its own: WLAN_CONNECTION_PARAMETERS stores only the
	// ADDRESS of the profile name, so the array behind it has to outlive the call.
	const profileNameW = utf16z(profileName);
	const parameters = encodeConnectionParameters(BigInt(ptr(profileNameW)));
	// A profile this join CREATES is written `manual`: the user is never asked, so
	// a one-off join must not make the machine re-associate by itself later. An
	// existing profile is edited instead, and keeps whatever it already said.
	const target: JoinTarget = { ssidHex: ssidHex(ssidBytes), password, sae, newProfile: () => windowsWifiProfileXml(profileName, ssidBytes, password, sae) };
	/** What this attempt did to the profile store, or null while it has done nothing. */
	let change: ProfileChange | null = null;
	try {
		withWlanHandle((api, handle) => {
			if (password) {
				change = writeJoinProfile(api, handle, guidBytes, profileName, target);
				connectByProfile(api, handle, guidBytes, parameters);
				return;
			}
			// The profile is addressed BY NAME here too, so what it holds is checked
			// before it is used. Connecting first and asking afterwards let
			// `WlanConnect` associate with whatever network the stored profile named.
			if (openJoinDecision(readStoredProfile(api, handle, guidBytes, profileName), target) === 'connect') {
				connectByProfile(api, handle, guidBytes, parameters);
				return;
			}
			// Believed absent, and the write is what makes that checkable: anything but
			// ERROR_ALREADY_EXISTS means it landed on the empty name it was aimed at.
			if (writeProfile(api, handle, guidBytes, target.newProfile(), WLAN_PROFILE_USER, 0) === ERROR_ALREADY_EXISTS) throw new Error('another process saved a profile for this network while it was being joined, so it was not joined');
			change = { replaced: null, created: true, written: readWrittenProfile(api, handle, guidBytes, profileName) };
			connectByProfile(api, handle, guidBytes, parameters);
		});
		await waitForAssociation(guid, ssid);
	} catch (err) {
		const rollback = undoWifiProfileChange(guidBytes, profileName, change);
		// Both errors, not just the first. A rollback that failed leaves the machine
		// in a state neither error describes on its own, and reporting only the
		// original one would claim the attempt had been undone.
		if (rollback) throw new Error(`${(err as Error).message} — and undoing the attempt failed: ${rollback}`);
		throw err;
	}
}

/** Queue an association through a stored profile, or fail with the code Windows gave. */
function connectByProfile(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, parameters: Uint8Array): void {
	const rc = api.WlanConnect(handle, ptr(guidBytes), ptr(parameters), null);
	if (rc !== 0) throw new Error(wlanErrorMessage(rc));
}

/**
 * What a lookup in the WLAN service's own network list established.
 *
 * `notFound` and `readError` are not the same answer, and treating them as one
 * was how a transient WLAN failure came to trigger the destructive fallback: the
 * caller took `null` for "this network is not currently visible", carried on with
 * a guessed profile name, guessed SSID bytes and a guessed security type, and
 * wrote a profile from them. A list that could not be read says nothing about the
 * network, so nothing may be guessed from it.
 */
type ScanLookup = { readonly kind: 'found'; readonly network: AvailableNetwork } | { readonly kind: 'notFound' } | { readonly kind: 'ambiguous' } | { readonly kind: 'readError'; readonly message: string };

/**
 * What the WLAN service currently knows about one network name on one adapter.
 *
 * Reads the list the service already holds — no scan is triggered, so this costs
 * a call and not four seconds.
 */
function readScannedNetwork(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, ssid: string): ScanLookup {
	const listOut = new BigUint64Array(1);
	const rc = api.WlanGetAvailableNetworkList(handle, ptr(guidBytes), 0, null, ptr(listOut));
	if (rc !== 0) return { kind: 'readError', message: wlanScanErrorMessage(rc) };
	const list = Number(listOut[0]) as Pointer;
	try {
		const network = findScannedNetwork(list, ssid);
		if (network === 'ambiguous') return { kind: 'ambiguous' };
		return network ? { kind: 'found', network } : { kind: 'notFound' };
	} catch (err) {
		// A list that describes itself impossibly (see MAX_AVAILABLE_NETWORKS) is a
		// structure we cannot read, not a network that is not there.
		return { kind: 'readError', message: (err as Error).message };
	} finally {
		api.WlanFreeMemory(list);
	}
}

/** Poll the adapter's association until it reports the requested network, or give up. */
async function waitForAssociation(guid: string, ssid: string): Promise<void> {
	const deadline = Date.now() + JOIN_TIMEOUT_MS;
	for (;;) {
		// Both conditions matter: the adapter has to be ON a network, and it has to be
		// THIS one. WlanConnect only queues the attempt, and the SSID shows up in the
		// connection attributes while the adapter is still associating — so a check on
		// the name alone reports a join that never happened.
		const association = readAssociation(guid);
		if (association?.connected && association.ssid === ssid) return;
		if (Date.now() >= deadline) throw new Error('the adapter did not join the network — check the password');
		await delay(JOIN_POLL_MS);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
