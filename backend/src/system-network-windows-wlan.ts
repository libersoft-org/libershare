import { dlopen, FFIType, ptr, read, toArrayBuffer, type Pointer } from 'bun:ffi';
import type { NetWifiInfo } from '@shared';


// ---------------------------------------------------------------------------
// wlanapi.dll (SSID / signal quality / radio state)
// ---------------------------------------------------------------------------

/** WLAN_INTERFACE_INFO: GUID(16) + WCHAR strInterfaceDescription[256] (512) + WLAN_INTERFACE_STATE(4). */
const WLAN_INTERFACE_INFO_SIZE = 532;
/** Offset of the first WLAN_INTERFACE_INFO inside WLAN_INTERFACE_INFO_LIST (dwNumberOfItems + dwIndex). */
const WLAN_INTERFACE_LIST_HEADER = 8;
/** wlan_intf_opcode_radio_state. */
const OPCODE_RADIO_STATE = 4;
/** wlan_intf_opcode_current_connection. */
const OPCODE_CURRENT_CONNECTION = 7;
/** DOT11_RADIO_STATE: 0 unknown, 1 on, 2 off. */
const RADIO_ON = 1;
const RADIO_OFF = 2;
/** ERROR_INVALID_STATE — the adapter is simply not associated. Not a failure. */
const ERROR_INVALID_STATE = 5023;
/** WLAN_CONNECTION_ATTRIBUTES: isState(4) + wlanConnectionMode(4) + strProfileName[256] (512) = 520. */
const CONN_ASSOCIATION_OFFSET = 520;
/** WLAN_CONNECTION_ATTRIBUTES.isState is the first member. */
const CONN_STATE_OFFSET = 0;
/** WLAN_INTERFACE_STATE: 1 = wlan_interface_state_connected. Every other value is on the way to or from it. */
const INTERFACE_STATE_CONNECTED = 1;
/** WLAN_ASSOCIATION_ATTRIBUTES: DOT11_SSID = ULONG uSSIDLength + UCHAR ucSSID[32]. */
const ASSOC_SSID_LENGTH_OFFSET = CONN_ASSOCIATION_OFFSET;
const ASSOC_SSID_OFFSET = CONN_ASSOCIATION_OFFSET + 4;
/** WLAN_ASSOCIATION_ATTRIBUTES: ssid(36) + bssType(4) + bssid(6, padded to 8) + phyType(4) + phyIndex(4) = 56. */
const ASSOC_SIGNAL_QUALITY_OFFSET = CONN_ASSOCIATION_OFFSET + 56;
/** DOT11_SSID caps the SSID at 32 octets — a longer value means we read the wrong offset. */
export const MAX_SSID_LENGTH = 32;

/**
 * A Windows HANDLE is an opaque 64-bit value, not a virtual address, so it is
 * declared to the FFI as `u64` and carried as a bigint. Declaring it as `ptr`
 * happens to work while handle values stay small, but nothing guarantees that.
 */
export type WlanHandle = bigint;

export interface WlanApi {
	WlanOpenHandle: (version: number, reserved: null, negotiated: Pointer, handle: Pointer) => number;
	WlanCloseHandle: (handle: WlanHandle, reserved: null) => number;
	WlanEnumInterfaces: (handle: WlanHandle, reserved: null, list: Pointer) => number;
	WlanQueryInterface: (handle: WlanHandle, guid: Pointer, opcode: number, reserved: null, size: Pointer, data: Pointer, valueType: Pointer) => number;
	WlanScan: (handle: WlanHandle, guid: Pointer, ssid: null, ieData: null, reserved: null) => number;
	WlanGetAvailableNetworkList: (handle: WlanHandle, guid: Pointer, flags: number, reserved: null, list: Pointer) => number;
	WlanSetProfile: (handle: WlanHandle, guid: Pointer, flags: number, xml: Pointer, security: null, overwrite: number, reserved: null, reasonCode: Pointer) => number;
	WlanGetProfile: (handle: WlanHandle, guid: Pointer, name: Pointer, reserved: null, xml: Pointer, flags: Pointer, access: null) => number;
	WlanDeleteProfile: (handle: WlanHandle, guid: Pointer, name: Pointer, reserved: null) => number;
	WlanGetProfileCustomUserData: (handle: WlanHandle, guid: Pointer, name: Pointer, reserved: null, size: Pointer, data: Pointer) => number;
	WlanSetProfileCustomUserData: (handle: WlanHandle, guid: Pointer, name: Pointer, size: number, data: Pointer | null, reserved: null) => number;
	WlanConnect: (handle: WlanHandle, guid: Pointer, parameters: Pointer, reserved: null) => number;
	WlanReasonCodeToString: (reason: number, size: number, buffer: Pointer, reserved: null) => number;
	WlanFreeMemory: (memory: Pointer) => void;
}

/** One FFI symbol declaration: the ABI of each parameter, and of the result. */
export interface WlanSymbol {
	readonly args: readonly FFIType[];
	readonly returns: FFIType;
}

/**
 * The wlanapi.dll symbol table handed to `dlopen`.
 *
 * Lifted out of {@link getWlanApi} so the declared ABI of each parameter is a
 * value a test can assert rather than a literal buried inside a lazy loader.
 *
 * Every leading `HANDLE` is {@link FFIType.u64}, never `ptr` — see
 * {@link WlanHandle}. `WlanOpenHandle`'s fourth argument is the exception that
 * proves it: that one really is a pointer, to the caller's output buffer.
 */
export const WLAN_SYMBOLS: Record<keyof WlanApi, WlanSymbol> = {
	WlanOpenHandle: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanCloseHandle: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
	WlanEnumInterfaces: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanQueryInterface: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanScan: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanGetAvailableNetworkList: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanSetProfile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanGetProfile: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanDeleteProfile: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanGetProfileCustomUserData: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanSetProfileCustomUserData: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanConnect: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	// The one entry point here that takes no handle at all: a reason code is
	// translated by the DLL itself, so the first argument is the code.
	WlanReasonCodeToString: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	WlanFreeMemory: { args: [FFIType.ptr], returns: FFIType.void },
};

let wlanApi: WlanApi | null = null;
let wlanUnavailable = false;

/** Load wlanapi.dll once. Returns null on a host without the WLAN stack (Server Core, stripped images). */
function getWlanApi(): WlanApi | null {
	if (wlanUnavailable) return null;
	if (!wlanApi) {
		try {
			wlanApi = dlopen('wlanapi.dll', WLAN_SYMBOLS).symbols as unknown as WlanApi;
		} catch {
			wlanUnavailable = true;
			return null;
		}
	}
	return wlanApi;
}

/**
 * Open and close a WLAN client handle, for the FFI test.
 *
 * Throws when the service cannot be reached — which is the point: {@link
 * readWindowsWifi} is best-effort and answers an unreachable service with an
 * empty map, so a test asserting its return TYPE passed on a host where nothing
 * worked at all.
 */
export function openWlanHandleForTest(): void {
	withWlanHandle(() => undefined);
}

/** Whether this host has a WLAN adapter at all, for the FFI test to tell 'none' from 'unreachable'. */
export function hasWlanAdapter(): boolean {
	return withWlanHandle((api, handle) => {
		const listOut = new BigUint64Array(1);
		if (api.WlanEnumInterfaces(handle, null, ptr(listOut)) !== 0) return false;
		const list = Number(listOut[0]) as Pointer;
		try {
			return read.u32(list, 0) > 0;
		} finally {
			api.WlanFreeMemory(list);
		}
	});
}

/** The loaded library, for the FFI test that checks every declared symbol really bound. */
export function loadWlanApiForTest(): WlanApi | null {
	return getWlanApi();
}

/** Format the 16 raw GUID bytes at `offset` as the canonical `{XXXXXXXX-XXXX-...}` string Windows prints. */
function guidToString(base: Pointer, offset: number): string {
	const bytes = new Uint8Array(toArrayBuffer(base, offset, 16));
	const hex = (i: number): string => bytes[i]!.toString(16).padStart(2, '0').toUpperCase();
	const d1 = `${hex(3)}${hex(2)}${hex(1)}${hex(0)}`;
	const d2 = `${hex(5)}${hex(4)}`;
	const d3 = `${hex(7)}${hex(6)}`;
	const d4 = `${hex(8)}${hex(9)}`;
	let d5 = '';
	for (let i = 10; i < 16; i++) d5 += hex(i);
	return `{${d1}-${d2}-${d3}-${d4}-${d5}}`;
}

/**
 * Decide the radio state from a WLAN_RADIO_STATE buffer.
 *
 * The struct is `DWORD dwNumberOfPhys` followed by up to 64
 * `WLAN_PHY_RADIO_STATE { dwPhyIndex; softwareRadioState; hardwareRadioState }`
 * entries. A phy is usable only when BOTH switches are on, and the adapter as a
 * whole is on as soon as one phy is usable (verified live against a 6-phy
 * MediaTek adapter with the software radio killed: soft=2, hard=1 → 'off').
 */
function readRadioState(data: Pointer, size: number): NetWifiInfo['radio'] {
	const phys = Math.min(read.u32(data, 0), Math.floor(Math.max(0, size - 4) / 12));
	let sawOff = false;
	for (let i = 0; i < phys; i++) {
		const base = 4 + i * 12;
		const software = read.u32(data, base + 4);
		const hardware = read.u32(data, base + 8);
		if (software === RADIO_ON && hardware === RADIO_ON) return 'on';
		if (software === RADIO_OFF || hardware === RADIO_OFF) sawOff = true;
	}
	return sawOff ? 'off' : 'unknown';
}

/**
 * Extract the SSID and signal quality from a WLAN_CONNECTION_ATTRIBUTES buffer.
 *
 * The struct offsets are documentation-derived — the machine this was written on
 * had its Wi-Fi radio soft-killed and associating would have been a mutation, so
 * they could not be confirmed against a populated struct. The sanity gate below
 * is what makes that acceptable: an out-of-range signal or SSID length yields
 * `null` (widget renders "unknown"), never a plausible-looking wrong percentage.
 */
export function readConnectionAttributes(data: Pointer, size: number): { ssid: string | null; signal: number | null; connected: boolean } {
	if (size < ASSOC_SIGNAL_QUALITY_OFFSET + 4) return { ssid: null, signal: null, connected: false };
	// The SSID is filled in while the adapter is still ASSOCIATING, so its presence
	// is a statement of intent, not of success. Only `isState` says whether the
	// adapter is actually on the network.
	const connected = read.u32(data, CONN_STATE_OFFSET) === INTERFACE_STATE_CONNECTED;
	const signalRaw = read.u32(data, ASSOC_SIGNAL_QUALITY_OFFSET);
	const ssidLength = read.u32(data, ASSOC_SSID_LENGTH_OFFSET);
	if (signalRaw > 100 || ssidLength > MAX_SSID_LENGTH) return { ssid: null, signal: null, connected };
	const ssidBytes = new Uint8Array(toArrayBuffer(data, ASSOC_SSID_OFFSET, MAX_SSID_LENGTH)).subarray(0, ssidLength);
	const ssid = ssidLength > 0 ? new TextDecoder().decode(ssidBytes) : null;
	return { ssid, signal: signalRaw, connected };
}

/**
 * Adapters the last {@link readWindowsWifi} found actually associated, as opposed
 * to merely attempting it. Kept beside the map rather than inside `NetWifiInfo`
 * because it answers a question only the join path asks, and `link` already tells
 * the UI the same thing.
 */

/**
 * Run one WlanQueryInterface and map the returned buffer, freeing it afterwards.
 *
 * A non-zero result yields null; the common one is ERROR_INVALID_STATE
 * ({@link ERROR_INVALID_STATE}), which just means the adapter is not associated
 * and is not worth logging.
 */
function queryInterface<T>(api: WlanApi, handle: WlanHandle, guidPtr: Pointer, opcode: number, map: (data: Pointer, size: number) => T): T | null {
	const size = new Uint32Array(1);
	const dataOut = new BigUint64Array(1);
	const valueType = new Uint32Array(1);
	const rc = api.WlanQueryInterface(handle, guidPtr, opcode, null, ptr(size), ptr(dataOut), ptr(valueType));
	if (rc !== 0) return null;
	const data = Number(dataOut[0]) as Pointer;
	try {
		return map(data, size[0]!);
	} finally {
		api.WlanFreeMemory(data);
	}
}

/**
 * Read the Wi-Fi state of every WLAN adapter, keyed by canonical interface GUID.
 * Returns an empty map when the WLAN service is not running or the DLL is absent
 * — the caller then leaves `wifi` undefined rather than guessing.
 */
export function readWindowsWifi(): Map<string, NetWifiInfo> {
	try {
		return withWlanHandle((api, handle) => {
			const result = new Map<string, NetWifiInfo>();
			const listOut = new BigUint64Array(1);
			if (api.WlanEnumInterfaces(handle, null, ptr(listOut)) !== 0) return result;
			const list = Number(listOut[0]) as Pointer;
			try {
				const count = read.u32(list, 0);
				for (let i = 0; i < count; i++) {
					const base = WLAN_INTERFACE_LIST_HEADER + i * WLAN_INTERFACE_INFO_SIZE;
					const guid = guidToString(list, base);
					const guidPtr = ((list as unknown as number) + base) as unknown as Pointer;
					const radio = queryInterface(api, handle, guidPtr, OPCODE_RADIO_STATE, readRadioState) ?? 'unknown';
					const connection = queryInterface(api, handle, guidPtr, OPCODE_CURRENT_CONNECTION, readConnectionAttributes);
					result.set(guid, { ssid: connection?.ssid ?? null, signal: connection?.signal ?? null, radio });
				}
			} finally {
				api.WlanFreeMemory(list);
			}
			return result;
		});
	} catch {
		// Reading Wi-Fi is best-effort: a host with no WLAN service simply has no
		// wireless detail to report, which is not a reason to fail the whole read.
		return new Map();
	}
}

/**
 * Open a WLAN client handle, run `fn`, and close the handle whatever happens.
 *
 * Every WLAN call needs one, and leaking it would hold a handle in the WLAN
 * service for the life of the process. Client version 2 is Vista and later, which
 * every supported Windows negotiates.
 */
export function withWlanHandle<T>(fn: (api: WlanApi, handle: WlanHandle) => T): T {
	const api = getWlanApi();
	if (!api) throw new Error('the Windows WLAN service is not available on this host');
	const negotiated = new Uint32Array(1);
	const handleOut = new BigUint64Array(1);
	// Client version 2 = Vista and later; every supported Windows negotiates it.
	const rc = api.WlanOpenHandle(2, null, ptr(negotiated), ptr(handleOut));
	if (rc !== 0) throw new Error(wlanErrorMessage(rc));
	const handle: WlanHandle = handleOut[0]!;
	try {
		return fn(api, handle);
	} finally {
		api.WlanCloseHandle(handle, null);
	}
}

/**
 * Canonical braced GUID — the shape {@link normalizeGuid} produces and the only
 * thing ever interpolated into a PowerShell script. Anything else is rejected
 * before a child process is spawned.
 */
const GUID_PATTERN = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/i;

/** True when an interface id is a well-formed adapter GUID. */
export function isWindowsInterfaceID(id: string): boolean {
	return GUID_PATTERN.test(id);
}

/** WLAN_CONNECTION_MODE: connect using a stored profile, by name. The only mode used here. */
const CONNECTION_MODE_PROFILE = 0;
/** dot11_BSS_type_infrastructure — an access point, as opposed to ad-hoc. */
const BSS_TYPE_INFRASTRUCTURE = 1;
/** WlanSetProfile with bOverwrite FALSE: this network is already saved, and we asked not to replace it. */
export const ERROR_ALREADY_EXISTS = 183;
/**
 * ERROR_NOT_FOUND — the ONLY `WlanGetProfile` result that means "Windows holds
 * nothing under this name". Every other non-zero code (access denied, invalid
 * handle, out of memory, an RPC failure) leaves the question unanswered, and
 * reading one as absence is how a profile that did exist gets overwritten with no
 * backup and then deleted by the rollback.
 */
export const ERROR_NOT_FOUND = 1168;
/**
 * ERROR_FILE_NOT_FOUND — the only `WlanGetProfileCustomUserData` result that means
 * "this profile has no custom data". Measured on Windows 11 both for a profile that
 * never had any and for one whose data a rewrite discarded.
 */
export const ERROR_FILE_NOT_FOUND = 2;
/** WLAN_PROFILE_GROUP_POLICY — pushed by policy. Not this app's to replace, and not restorable if it were. */
export const WLAN_PROFILE_GROUP_POLICY = 0x00000001;
/** WLAN_PROFILE_USER — visible to this account only, which is all a one-off join needs. */
export const WLAN_PROFILE_USER = 0x00000002;
/** Buffer given to WlanReasonCodeToString. Microsoft's own samples use this size. */
const WLAN_REASON_TEXT_CHARS = 256;

/**
 * Turn a Win32 result code into something a user can act on.
 *
 * These are the codes the WLAN calls in this module actually return; anything
 * else keeps its hexadecimal form rather than being described as something it
 * might not be.
 */
export function wlanErrorMessage(code: number): string {
	switch (code) {
		case 5:
			return 'access denied by Windows';
		case 87:
			return 'the WLAN service rejected the request as invalid';
		case 1062:
			return 'the WLAN AutoConfig service is not running';
		case 1168:
			// ERROR_NOT_FOUND. Whether the missing thing is a saved profile or the
			// interface itself depends on the call — a scan on a Wi-Fi Direct virtual
			// adapter answers with this too, and naming only the profile there would
			// describe a cause that has nothing to do with what was asked.
			return 'Windows found no matching interface or saved profile';
		case 1223:
			return 'the request was cancelled';
		case 2150899714:
			return 'the Wi-Fi radio is switched off';
		case ERROR_INVALID_STATE:
			return 'the adapter is not in a state that allows this';
		default:
			return `Wi-Fi error 0x${(code >>> 0).toString(16).toUpperCase()}`;
	}
}

/**
 * The 16 raw bytes of a `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}` GUID.
 *
 * The inverse of {@link guidToString}: the first three fields are little-endian
 * words and the last two are byte sequences, which is what makes a GUID's text
 * form and its memory form disagree. Throws rather than returning a wrong GUID,
 * because a malformed one would silently address a different adapter.
 */
export function guidToBytes(guid: string): Uint8Array {
	if (!isWindowsInterfaceID(guid)) throw new Error('not a Windows interface GUID');
	const hex = guid.replace(/[{}-]/g, '');
	const raw = new Uint8Array(16);
	for (let i = 0; i < 16; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	const bytes = new Uint8Array(16);
	bytes.set([raw[3]!, raw[2]!, raw[1]!, raw[0]!, raw[5]!, raw[4]!, raw[7]!, raw[6]!]);
	bytes.set(raw.subarray(8), 8);
	return bytes;
}

/** A NUL-terminated UTF-16LE string, which is what every `LPCWSTR` parameter here expects. */
export function utf16z(text: string): Uint16Array {
	const out = new Uint16Array(text.length + 1);
	for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
	return out;
}

/** First block of characters mapped by {@link readUtf16z}; comfortably larger than any real profile. */
const INITIAL_UTF16_BLOCK = 1024;

/**
 * Read a NUL-terminated UTF-16LE string back out of a pointer the WLAN API
 * allocated. The counterpart of {@link utf16z}, for the profile document
 * WlanGetProfile hands back.
 *
 * The length is not known up front, so the buffer is walked to the terminator;
 * the cap is a safety stop for a pointer that is not the string we think it is,
 * well above any real profile (a WLAN profile is a few hundred characters).
 * Reaching that cap without finding a terminator is an ERROR, never a shorter
 * string — see the throw below.
 */
export function readUtf16z(pointer: Pointer, maxChars: number = 65536): string {
	// Mapped in growing blocks rather than as one 128 KiB view. The length of the
	// allocation is not knowable from here, so every character mapped beyond the
	// terminator is a read of memory that may not belong to this buffer; a real
	// profile is a few hundred characters, and starting small means the usual case
	// never maps more than the first block.
	for (let mapped = Math.min(INITIAL_UTF16_BLOCK, maxChars); ; mapped = Math.min(mapped * 2, maxChars)) {
		const view = new Uint16Array(toArrayBuffer(pointer, 0, mapped * 2));
		const end = view.indexOf(0);
		if (end !== -1) return String.fromCharCode(...view.subarray(0, end));
		// No terminator yet. Growing is only worthwhile while there is room left.
		if (mapped >= maxChars) break;
	}
	// Returning the first `maxChars` here would be a silent truncation, and the
	// caller's whole purpose is to hand this document back to WlanSetProfile — a
	// truncated profile is not a smaller profile, it is a malformed one that would
	// replace a working network's saved configuration.
	throw new Error('the WLAN profile document is not NUL-terminated within its expected length');
}

/**
 * A WLAN_CONNECTION_PARAMETERS for a connect-by-profile, x64:
 *
 *   wlanConnectionMode   4  @  0   (4 bytes of padding follow, the next member is a pointer)
 *   strProfile           8  @  8
 *   pDot11Ssid           8  @ 16   NULL — the profile already names the network
 *   pDesiredBssidList    8  @ 24   NULL — any access point of that network will do
 *   dot11BssType         4  @ 32
 *   dwFlags              4  @ 36
 *
 * The profile address is passed as a bigint so this stays a pure function a test
 * can check byte for byte.
 */
export function encodeConnectionParameters(profile: bigint): Uint8Array {
	const bytes = new Uint8Array(40);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, CONNECTION_MODE_PROFILE, true);
	view.setBigUint64(8, profile, true);
	view.setUint32(32, BSS_TYPE_INFRASTRUCTURE, true);
	return bytes;
}

/**
 * Read a fixed-size, NUL-padded UTF-16LE field out of a struct.
 *
 * Unlike {@link readUtf16z} the length is known from the layout, and a field
 * filled to capacity carries no terminator at all — so running off the end is the
 * normal case rather than an error.
 */
export function readFixedUtf16(base: Pointer, offset: number, maxChars: number): string {
	const view = new Uint16Array(toArrayBuffer(base, offset, maxChars * 2));
	const end = view.indexOf(0);
	return String.fromCharCode(...view.subarray(0, end === -1 ? maxChars : end));
}

/**
 * Describe a refused WlanSetProfile, reason code included.
 *
 * The reason code is the whole point of the out-parameter that used to be
 * allocated and then discarded: WlanSetProfile answers the same Win32 code for
 * an unsupported cipher, a schema violation and a policy restriction alike, and
 * only the reason code separates them. Windows can put it into words in the
 * user's own language, so it is asked rather than printing a bare number.
 */
export function describeProfileFailure(api: WlanApi, rc: number, reason: number): string {
	const text = wlanReasonText(api, reason);
	return text ? `${wlanErrorMessage(rc)}: ${text}` : wlanErrorMessage(rc);
}

/** Windows' own wording for a WLAN reason code, or null when it has none for it. */
export function wlanReasonText(api: WlanApi, reason: number): string | null {
	if (reason === 0) return null;
	const buffer = new Uint16Array(WLAN_REASON_TEXT_CHARS);
	if (api.WlanReasonCodeToString(reason, buffer.length, ptr(buffer), null) !== 0) return null;
	const end = buffer.indexOf(0);
	const text = String.fromCharCode(...buffer.subarray(0, end === -1 ? buffer.length : end)).trim();
	return text.length > 0 ? text : null;
}

/**
 * The association of ONE adapter, read straight from the WLAN service.
 *
 * Asked for by GUID rather than taken from {@link readWindowsWifi}, which
 * describes every adapter and answers on the wire contract - it has no field for
 * whether the radio is actually on the network, only for the name it is
 * associating with. Null when the adapter has no current connection, which is
 * what an unassociated one reports.
 */
export function readAssociation(guid: string): { ssid: string | null; connected: boolean } | null {
	try {
		return withWlanHandle((api, handle) => {
			const guidBytes = guidToBytes(guid);
			return queryInterface(api, handle, ptr(guidBytes), OPCODE_CURRENT_CONNECTION, readConnectionAttributes);
		});
	} catch {
		// A service that cannot be asked right now is not an adapter that has
		// joined; the caller polls again until its own deadline.
		return null;
	}
}

/**
 * True when this host has a WLAN stack the app can drive.
 *
 * Enumerating the interfaces is the probe: `wlanapi.dll` is present on every
 * desktop Windows whether or not the machine has a radio, so loading it proves
 * nothing, while an adapter in the list is exactly the thing scanning and joining
 * need. Unlike applying an address, none of this needs an elevated token.
 */
export function isWindowsWifiConfigurable(): boolean {
	return readWindowsWifi().size > 0;
}
