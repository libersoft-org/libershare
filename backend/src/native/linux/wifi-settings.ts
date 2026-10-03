import { createHash } from 'node:crypto';
import type { DBusValue, DBusVariant } from './dbus.ts';
import type { NativeNetworkSettings } from './network-mutation.ts';

export type WifiProperties = Record<string, DBusVariant>;
export interface WifiAccessPoint {
	path: string;
	ssid: Uint8Array;
	bssid: string;
	mode: number;
	frequency: number;
	flags: number;
	wpa: number;
	rsn: number;
}

export function wifiDictionary(value: unknown): Record<string, DBusValue> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array || value instanceof Map) throw new Error('Invalid NetworkManager dictionary');
	return value as Record<string, DBusValue>;
}

export function wifiValue(properties: WifiProperties, name: string, signature: string, fallback?: DBusValue): DBusValue {
	const entry = properties[name];
	if (entry === undefined && fallback !== undefined) return fallback;
	if (!entry || entry.sig !== signature) throw new Error(`Invalid NetworkManager ${name}`);
	return entry.value;
}

export function wifiString(properties: WifiProperties, name: string, signature = 's', fallback?: string): string {
	const value = wifiValue(properties, name, signature, fallback);
	if (typeof value !== 'string') throw new Error(`Invalid NetworkManager ${name}`);
	return value;
}

export function wifiNumber(properties: WifiProperties, name: string, fallback?: number): number {
	const value = wifiValue(properties, name, 'u', fallback);
	if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`Invalid NetworkManager ${name}`);
	return value;
}

export function wifiPaths(properties: WifiProperties, name: string): string[] {
	const value = wifiValue(properties, name, 'ao');
	if (!Array.isArray(value) || value.some(path => typeof path !== 'string' || !/^\/(?:[A-Za-z0-9_]+\/?)*$/.test(path))) throw new Error(`Invalid NetworkManager ${name}`);
	return value as string[];
}

export function decodeWifiAccessPoint(path: string, properties: WifiProperties): WifiAccessPoint {
	const ssid = wifiValue(properties, 'Ssid', 'ay');
	const bssid = wifiString(properties, 'HwAddress');
	if (!(ssid instanceof Uint8Array) || ssid.length > 32 || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(bssid)) throw new Error('Invalid access point identity');
	return { path, ssid, bssid: bssid.toLowerCase(), mode: wifiNumber(properties, 'Mode'), frequency: wifiNumber(properties, 'Frequency'), flags: wifiNumber(properties, 'Flags'), wpa: wifiNumber(properties, 'WpaFlags'), rsn: wifiNumber(properties, 'RsnFlags') };
}

export function wifiPersonalSecurity(ap: WifiAccessPoint): 'open' | 'wpa-psk' | 'sae' | null {
	const flags = ap.wpa | ap.rsn;
	if (!(ap.flags & 1) && flags === 0) return 'open';
	if (flags & (0x200 | 0x800 | 0x1000 | 0x2000)) return null;
	// NM 1.46 completes a new WPA2/WPA3 transition profile as PSK unless SAE was already selected.
	if (flags & 0x100) return 'wpa-psk';
	return flags & 0x400 ? 'sae' : null;
}

function frequencyChannel(frequency: number): number {
	if (frequency === 2484) return 14;
	if (frequency >= 2412 && frequency <= 2472 && (frequency - 2412) % 5 === 0) return 1 + (frequency - 2412) / 5;
	const channels = [7, 8, 9, 11, 12, 16, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 56, 58, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 149, 152, 153, 157, 160, 161, 165];
	const channel = (frequency - 5000) / 5;
	if (channels.includes(channel)) return channel;
	return ({ 4915: 183, 4920: 184, 4925: 185, 4935: 187, 4945: 188, 4960: 192, 4980: 196 } as Record<number, number>)[frequency] ?? 0;
}

/** NetworkManager 1.46 nm_access_point_connection_valid; AvailableConnections already filters device compatibility. */
export function wifiProfileCompatible(settings: NativeNetworkSettings, ap: WifiAccessPoint): boolean {
	const connection = settings['connection'],
		wireless = settings['802-11-wireless'];
	if (!connection || !wireless || wifiString(connection, 'type') !== '802-11-wireless') return false;
	const ssid = wifiValue(wireless, 'ssid', 'ay');
	if (!(ssid instanceof Uint8Array) || !Buffer.from(ssid).equals(ap.ssid)) return false;
	const bssid = wireless['bssid'];
	if (bssid) {
		const stored = bssid.sig === 'ay' && bssid.value instanceof Uint8Array ? [...bssid.value].map(byte => byte.toString(16).padStart(2, '0')).join(':') : bssid.sig === 's' && typeof bssid.value === 'string' ? bssid.value.toLowerCase() : '';
		if (stored !== ap.bssid) return false;
	}
	const mode = wifiString(wireless, 'mode', 's', '');
	if (ap.mode === 0 || mode === 'ap' || (mode === 'infrastructure' && ap.mode !== 2) || (mode === 'adhoc' && ap.mode !== 1)) return false;
	if (ap.frequency) {
		const band = wifiString(wireless, 'band', 's', '');
		if ((band === 'a' && (ap.frequency < 4915 || ap.frequency > 5825)) || (band === 'bg' && (ap.frequency < 2412 || ap.frequency > 2484))) return false;
		const channel = wifiNumber(wireless, 'channel', 0);
		if (channel && channel !== frequencyChannel(ap.frequency)) return false;
	}
	const security = settings['802-11-wireless-security'];
	if (!security) return ap.wpa === 0x1000 || ap.rsn === 0x1000 || (!(ap.flags & 1) && ap.wpa === 0 && ap.rsn === 0);
	const key = wifiString(security, 'key-mgmt', 's', '');
	if (key === 'none') return !!(ap.flags & 1) && ap.wpa === 0 && ap.rsn === 0;
	if (ap.mode === 1 && (key !== 'wpa-psk' || !(ap.rsn & 0x100))) return false;
	const flags = ap.wpa | ap.rsn;
	const compatibleCiphers = (name: string, bits: Record<string, number>, capabilities = flags): boolean => {
		const list = wifiValue(security, name, 'as', []);
		if (!Array.isArray(list) || list.some(cipher => typeof cipher !== 'string')) throw new Error('Invalid Wi-Fi cipher list');
		return list.length === 0 || list.some(cipher => capabilities & (bits[cipher as string] ?? 0));
	};
	if (key === 'ieee8021x') return !!(ap.flags & 1) && (ap.wpa === 0 || (!!(ap.wpa & 0x200) && !!(ap.wpa & 3) && !!(ap.wpa & 0x30) && compatibleCiphers('pairwise', { wep40: 1, wep104: 2 }, ap.wpa) && compatibleCiphers('group', { wep40: 0x10, wep104: 0x20 }, ap.wpa)));
	if (key === 'wpa-eap-suite-b-192') return !!(ap.rsn & 0x2000);
	const capability = ({ 'wpa-psk': 0x100, 'wpa-eap': 0x200, sae: 0x400, owe: 0x1800 } as Record<string, number>)[key];
	// NM's compatibility check deliberately does not constrain proto to the advertised IE.
	return capability !== undefined && !!(flags & capability) && compatibleCiphers('pairwise', { tkip: 4, ccmp: 8 }) && compatibleCiphers('group', { wep40: 0x10, wep104: 0x20, tkip: 0x40, ccmp: 0x80 });
}

export function wifiSecretFingerprint(salt: string, secret: string): string {
	return createHash('sha256').update(`libershare-wifi\0${salt}\0`).update(secret).digest('hex');
}

export function wifiProfileFingerprint(settings: NativeNetworkSettings): string {
	const copy = structuredClone(settings);
	if (copy['connection']) delete copy['connection']['timestamp'];
	if (copy['802-11-wireless']) delete copy['802-11-wireless']['seen-bssids'];
	for (const key of ['psk', 'leap-password', 'wep-key0', 'wep-key1', 'wep-key2', 'wep-key3']) if (copy['802-11-wireless-security']) delete copy['802-11-wireless-security'][key];
	const canonical = (value: unknown): unknown => {
		if (typeof value === 'bigint') return { bigint: value.toString() };
		if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('hex') };
		if (Array.isArray(value)) return value.map(canonical);
		if (value && typeof value === 'object')
			return Object.fromEntries(
				Object.entries(value)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([key, item]) => [key, canonical(item)])
			);
		return value;
	};
	return createHash('sha256')
		.update(JSON.stringify(canonical(copy)))
		.digest('hex');
}
