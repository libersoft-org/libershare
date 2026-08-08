import { CodedError, ErrorCodes } from './errors.ts';
import type { ConnectionStatus, NetworkStateInfo } from './index.ts';

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

// Sanitize filename - remove invalid characters and normalize spaces
export function sanitizeFilename(filename: string): string {
	return filename
		.replace(/[<>:"/\\|?*]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}
