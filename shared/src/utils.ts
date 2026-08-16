import { CodedError, ErrorCodes } from './errors.ts';
import type { ConnectionStatus, NetInterfaceInfo, NetIPv4Config, NetworkStateInfo } from './index.ts';

export function formatBytes(bytes: number, decimals: number = 2): string {
	if (bytes === 0) return '0 Bytes';
	const k = 1024;
	const dm = decimals < 0 ? 0 : decimals;
	const sizes = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export function parseBytes(value: string | number): number {
	if (typeof value === 'number') return value;
	const match = value
		.trim()
		.toUpperCase()
		.match(/^(\d+(?:\.\d+)?)\s*([KMGTPEZY])?B?$/);
	if (!match) throw new CodedError(ErrorCodes.INVALID_SIZE_FORMAT);
	const [, num, suffix] = match;
	if (!suffix) return Math.floor(parseFloat(num!));
	const sizes = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];
	const i = sizes.indexOf(suffix);
	return Math.floor(parseFloat(num!) * Math.pow(1024, i));
}

/**
 * Project the primary interface of a network state into the footer widget's shape.
 *
 * Every field is copied from what the OS reported — nothing is synthesized. When
 * the medium or the carrier state is not knowable (first read not settled yet, a
 * platform that only exposes addresses, a tunnel/bridge as primary) the result is
 * `unknown` so the widget can say so instead of inventing a signal percentage.
 */
export function deriveConnectionStatus(state: NetworkStateInfo): ConnectionStatus {
	const blank = { connected: false, signal: null, ssid: null, interfaceName: null } as const;
	if (!state.known) return { kind: 'unknown', ...blank };
	const primary = state.interfaces.find(i => i.id === state.primaryID);
	// A platform that only reports addresses cannot tell us there is no default
	// route — it never had routes to report. Saying "disconnected" there would be
	// exactly the fabrication this projection exists to prevent.
	if (state.detail === 'addressesOnly') return { kind: 'unknown', ...blank, interfaceName: primary?.name ?? null };
	if (!primary) return { kind: 'none', ...blank };
	const interfaceName = primary.name;
	if (primary.medium === 'wireless') {
		const wifi = primary.wifi;
		// A soft/hard-killed radio is a state the OS genuinely reports and is not
		// the same as "associated with nothing" — the widget labels it separately.
		if (wifi?.radio === 'off') return { kind: 'wifiOff', ...blank, interfaceName };
		const connected = primary.link === 'up';
		return { kind: 'wifi', connected, signal: connected ? (wifi?.signal ?? null) : null, ssid: connected ? (wifi?.ssid ?? null) : null, interfaceName };
	}
	if (primary.link === 'unknown' || primary.medium === 'other') return { kind: 'unknown', ...blank, connected: primary.link === 'up', interfaceName };
	return { kind: 'wired', ...blank, connected: primary.link === 'up', interfaceName };
}

/**
 * True when an interface is worth offering the user as a primary pick.
 *
 * Real hardware always qualifies. A virtual device only qualifies once it either
 * carries the default route or holds an address the host can actually be reached
 * on — a link-local one (IPv6 fe80::/10, IPv4 APIPA) means the interface never
 * got a real address. Without that distinction a container host drowns the
 * picker: on a Docker node 111 of 137 interfaces are `veth*` pairs whose only
 * address is fe80::, and the two the user might actually choose are lost in them.
 */
export function isSelectableInterface(iface: NetInterfaceInfo): boolean {
	if (iface.medium !== 'other' || iface.defaultRoute) return true;
	return iface.addresses.some(a => !a.address.toLowerCase().startsWith('fe80') && !a.address.startsWith('169.254.'));
}

/**
 * True for a dotted-quad IPv4 literal: four octets, 0-255, no leading zeros.
 *
 * The type says `string`, but the values reaching this come from an RPC client,
 * so a non-string is answered with `false` rather than a `TypeError` thrown from
 * `.split` — the caller's job is to reject a bad address, not to crash on one.
 */
export function isIPv4(value: string): boolean {
	if (typeof value !== 'string') return false;
	const parts = value.split('.');
	if (parts.length !== 4) return false;
	return parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

/**
 * Validate a desired IPv4 configuration. Returns the name of the offending field,
 * or null when the whole config is usable.
 *
 * The strictness here is a security boundary rather than politeness: on Windows
 * these values are interpolated into a PowerShell script, so anything that is not
 * a plain IPv4 literal or a small integer must never get that far. Callers on
 * every platform validate before touching a child process.
 */
export function validateIPv4Config(config: NetIPv4Config): string | null {
	// The parameter is typed, but it arrives from an RPC client, so nothing about
	// its runtime SHAPE is guaranteed either. `null` used to reach the field reads
	// below and throw a TypeError out of the API dispatcher instead of being
	// answered as the bad request it is; an array has no usable mode, which is the
	// first thing missing from it and so what the user is pointed at.
	if (typeof config !== 'object' || config === null || Array.isArray(config)) return 'mode';
	if (config.mode !== 'dhcp' && config.mode !== 'static') return 'mode';
	const dns = config.dns ?? [];
	// A `dns` that is not a list would otherwise be iterated character by character
	// when it is a string, and throw when it is an object.
	if (!Array.isArray(dns)) return 'dns';
	for (const server of dns) if (!isIPv4(server)) return 'dns';
	if (config.mode === 'dhcp') return null;
	if (!config.address || !isIPv4(config.address)) return 'address';
	if (!Number.isInteger(config.prefixLength) || (config.prefixLength as number) < 1 || (config.prefixLength as number) > 32) return 'prefixLength';
	// An interface on an isolated segment legitimately has no gateway, so only a
	// present-but-malformed value is an error.
	if (config.gateway && !isIPv4(config.gateway)) return 'gateway';
	return null;
}

/**
 * Characters no join path can carry: NUL and the C0 controls XML 1.0 forbids.
 *
 * Tab, LF and CR are legal in XML and so are left alone; everything else below
 * U+0020 is not, and NUL is worse than merely invalid on every platform:
 *
 *  - Windows: `utf16z()` writes it verbatim, and a Win32 `LPCWSTR` stops there,
 *    so a profile asked for as "Home\0Evil" is created for "Home" instead.
 *  - Windows: the profile document is XML, and a raw NUL in it is not
 *    well-formed, so `WlanSetProfile` refuses it with an opaque reason code.
 *  - Linux: the runtime throws a bare `TypeError` out of `execFile` before
 *    nmcli ever starts, which surfaces as an internal error, not a bad request.
 *
 * This gate is for an SSID a USER supplied. Names coming back from a native scan
 * are not passed through it — they are what the radio actually saw.
 */
const SSID_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

/**
 * True for an SSID the 802.11 standard can actually carry AND every join path
 * can express: 1-32 octets once encoded as UTF-8, and no forbidden control
 * character. Length is counted in bytes, not characters, because a
 * 20-character name with accents already exceeds the field.
 */
export function isValidSSID(ssid: string): boolean {
	if (typeof ssid !== 'string' || SSID_FORBIDDEN.test(ssid)) return false;
	const length = new TextEncoder().encode(ssid).length;
	return length >= 1 && length <= 32;
}

/**
 * True when a Wi-Fi credential is a raw 256-bit pre-shared key rather than a
 * passphrase: exactly 64 hexadecimal digits.
 *
 * The distinction is not cosmetic. A WLAN profile has to declare which of the
 * two it carries — `<keyType>networkKey</keyType>` for this form and
 * `passPhrase` for the other — and a raw key announced as a passphrase is
 * hashed a second time, so it silently fails to authenticate.
 */
export function isWifiHexKey(key: string): boolean {
	return typeof key === 'string' && /^[0-9a-fA-F]{64}$/.test(key);
}

/**
 * True for a credential a WPA2/WPA3 personal network can actually accept.
 *
 * IEEE 802.11i, and the Microsoft WLAN profile schema with it, allow either a
 * passphrase of 8 to 63 characters or the 64-hex raw key above. Anything
 * shorter, longer or in between is refused here rather than by the supplicant:
 * on Windows the profile is written to disk BEFORE the association is
 * attempted, so a credential that could never work would replace a saved
 * network's real one on its way to failing.
 */
export function isValidWifiKey(key: string): boolean {
	if (typeof key !== 'string') return false;
	if (isWifiHexKey(key)) return true;
	return key.length >= 8 && key.length <= 63;
}

// Sanitize filename - remove invalid characters and normalize spaces
export function sanitizeFilename(filename: string): string {
	return filename
		.replace(/[<>:"/\\|?*]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}
