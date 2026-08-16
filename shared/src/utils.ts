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
 * True for an SSID the 802.11 standard can actually carry: 1-32 octets once
 * encoded as UTF-8. Length is counted in bytes, not characters, because a
 * 20-character name with accents already exceeds the field.
 */
export function isValidSSID(ssid: string): boolean {
	const length = new TextEncoder().encode(ssid).length;
	return length >= 1 && length <= 32;
}

// Sanitize filename - remove invalid characters and normalize spaces
export function sanitizeFilename(filename: string): string {
	return filename
		.replace(/[<>:"/\\|?*]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}
