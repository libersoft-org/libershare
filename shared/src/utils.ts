import { CodedError, ErrorCodes } from './errors.ts';
import type { ConnectionStatus, NetCapabilities, NetInterfaceInfo, NetworkStateInfo } from './index.ts';

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
	return iface.addresses.some(a => !isIPv6LinkLocal(a.address) && !a.address.startsWith('169.254.'));
}

/** True for the IPv6 link-local block fe80::/10. */
function isIPv6LinkLocal(value: string): boolean {
	const first = value.split(':', 1)[0];
	if (!first || !/^[0-9a-f]{1,4}$/i.test(first)) return false;
	const group = parseInt(first, 16);
	return group >= 0xfe80 && group <= 0xfebf;
}

/** True for a dotted-quad IPv4 literal: four octets, 0-255, no leading zeros. */
export function isIPv4(value: string): boolean {
	const parts = value.split('.');
	if (parts.length !== 4) return false;
	return parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

/** True for an IPv6 literal without a zone/scope suffix. */
export function isIPv6(value: string): boolean {
	// URL is a convenient standards-compliant IPv6 parser, but it must never be
	// allowed to reinterpret trailing input as a path, query, or credentials.
	// DNS values reach an elevated PowerShell writer on Windows, so accept only
	// characters that can occur in an IPv6 literal before asking URL to parse it.
	if (!value.includes(':') || !/^[0-9a-f:.]+$/i.test(value)) return false;
	try {
		const parsed = new URL(`http://[${value}]/`);
		return parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']') && parsed.host === parsed.hostname && parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
	} catch {
		return false;
	}
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
export function validateIPv4Config(value: unknown, capabilities?: Pick<NetCapabilities, 'staticGatewayRequired'>): string | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return 'mode';
	const config = value as { mode?: unknown; dns?: unknown; address?: unknown; prefixLength?: unknown; gateway?: unknown };
	if (config.mode !== 'dhcp' && config.mode !== 'static') return 'mode';
	if (config.dns !== undefined && !Array.isArray(config.dns)) return 'dns';
	for (const server of config.dns ?? []) if (typeof server !== 'string' || (!isIPv4(server) && !isIPv6(server))) return 'dns';
	if (config.mode === 'dhcp') return null;
	if (typeof config.address !== 'string' || !isIPv4(config.address)) return 'address';
	if (!Number.isInteger(config.prefixLength) || (config.prefixLength as number) < 1 || (config.prefixLength as number) > 32) return 'prefixLength';
	// An interface on an isolated segment legitimately has no gateway, so only a
	// present-but-malformed value is an error.
	if (config.gateway !== undefined && (typeof config.gateway !== 'string' || (config.gateway !== '' && !isIPv4(config.gateway)))) return 'gateway';
	if (capabilities?.staticGatewayRequired && !config.gateway) return 'gateway';
	return null;
}

/**
 * True for an SSID the 802.11 standard can actually carry: 1-32 octets once
 * encoded as UTF-8. Length is counted in bytes, not characters, because a
 * 20-character name with accents already exceeds the field.
 */
export function isValidSSID(ssid: unknown): ssid is string {
	if (typeof ssid !== 'string' || ssid.includes('\0')) return false;
	const length = new TextEncoder().encode(ssid).length;
	return length >= 1 && length <= 32;
}

/**
 * Strip characters a file name may not contain and normalise whitespace.
 *
 * The control range goes too: a NUL truncates the path at the system-call
 * boundary, so a name containing one can address a different file than the one
 * it appears to name, and the rest of C0 makes for names that cannot be typed,
 * listed or deleted through ordinary tools.
 */
export function sanitizeFilename(filename: string): string {
	return filename
		.replace(/[<>:"/\\|?*]/g, '')
		.replace(/\p{Cc}/gu, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Keep at most `maxBytes` UTF-8 bytes from the end of `value`, never splitting a
 * character. Byte length is what a filesystem limits — the usual cap is 255
 * bytes per path component — while `String.length` counts UTF-16 units, so a
 * hundred emoji or CJK characters measure as well within a hundred-character
 * budget and still overflow the real one several times over.
 */
export function truncateUTF8End(value: string, maxBytes: number): string {
	const bytes = new TextEncoder().encode(value);
	if (bytes.byteLength <= maxBytes) return value;
	let start = bytes.byteLength - maxBytes;
	// Walk forward off any continuation byte, so the slice begins on a character.
	while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++;
	return new TextDecoder().decode(bytes.subarray(start));
}
