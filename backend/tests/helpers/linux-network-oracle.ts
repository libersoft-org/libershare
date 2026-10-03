import { isIPv4, validateIPv4Config, type NetWifiNetwork } from '@shared';
import type { NmcliIPv4Profile } from '../../src/system-network-linux.ts';

/**
 * Split one `nmcli -t` output line into fields.
 *
 * Terse mode separates with `:` and backslash-escapes any `:` or backslash inside
 * a value, so a naive `split(':')` tears apart every SSID containing a colon and
 * every IPv6 address. Values are unescaped as they are split.
 */
export function splitNmcliFields(line: string): string[] {
	const fields: string[] = [];
	let current = '';
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '\\' && i + 1 < line.length) {
			current += line[++i];
			continue;
		}
		if (char === ':') {
			fields.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	fields.push(current);
	return fields;
}

/**
 * Parse `nmcli -t -f SSID,BSSID,SIGNAL,SECURITY,IN-USE device wifi list`.
 *
 * Hidden networks report an empty SSID and are dropped: they cannot be joined by
 * name, so offering an unnamed row would be offering something that fails.
 * Every BSSID stays distinct so equal SSIDs with different security cannot be
 * mistaken for the same network.
 */
export function parseNmcliWifiList(text: string): NetWifiNetwork[] {
	const networks = new Map<string, NetWifiNetwork>();
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		const [ssid, rawBssid, signal, security, inUse] = splitNmcliFields(line);
		if (!ssid) continue;
		const bssid = rawBssid && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(rawBssid) ? rawBssid.toUpperCase() : null;
		const parsed = signal ? parseInt(signal, 10) : NaN;
		const securityName = security?.trim() ?? '';
		const enterprise = /(?:802\.1X|ENTERPRISE|EAP)/i.test(securityName);
		const obsolete = /\bWEP\b/i.test(securityName);
		const entry: NetWifiNetwork = {
			ssid,
			bssid,
			signal: Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : null,
			// nmcli leaves SECURITY empty for an open network and prints the key
			// management (WPA2, WPA3, WEP, 802.1X) otherwise.
			secured: securityName.length > 0,
			security: securityName,
			supported: securityName.length === 0 || (/\bWPA\d*\b/i.test(securityName) && !enterprise && !obsolete),
			active: inUse?.trim() === '*',
		};
		const key = `${ssid}\0${bssid ?? ''}\0${securityName}`;
		const previous = networks.get(key);
		if (!previous) networks.set(key, entry);
		else if ((entry.signal ?? -1) > (previous.signal ?? -1)) networks.set(key, { ...entry, active: previous.active || entry.active });
		else if (entry.active && !previous.active) networks.set(key, { ...previous, active: true });
	}
	return [...networks.values()].sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1));
}

/** Accept only a plain profile the editor can replace without preserving hidden routing policy. */
export function parseNmcliIPv4Profile(text: string, expectedDevice: string, activeInstances: number): NmcliIPv4Profile {
	const values = new Map<string, string>();
	for (const line of text.split('\n')) {
		const fields = splitNmcliFields(line.trim());
		const key = fields[0]?.toLowerCase();
		if (key) values.set(key, fields.slice(1).join(':').trim());
	}
	const method = values.get('ipv4.method') ?? '';
	const gatewayText = values.get('ipv4.gateway') ?? '';
	const addresses = values.get('ipv4.addresses') ?? '';
	const interfaceName = values.get('connection.interface-name') || null;
	const multiConnectMatch = (values.get('connection.multi-connect') ?? '').match(/^-?\d+/);
	const multiConnect = multiConnectMatch ? Number(multiConnectMatch[0]) : null;
	const addressMatch = addresses.match(/^([^/]+)\/(\d{1,2})$/);
	const simpleManualAddress = !!addressMatch && validateIPv4Config({ mode: 'static', address: addressMatch[1] ?? '', prefixLength: Number(addressMatch[2]), gateway: gatewayText }) === null;
	const knownMethod = method === 'auto' || method === 'manual';
	const boundOnce = interfaceName === expectedDevice && (multiConnect === 0 || multiConnect === 1) && activeInstances === 1;
	const safe = boundOnce && knownMethod && values.get('ipv4.never-default') === 'no' && (values.get('ipv4.routes') ?? '') === '' && ['', '0'].includes(values.get('ipv4.route-table') ?? '') && (values.get('ipv4.routing-rules') ?? '') === '' && (gatewayText === '' || isIPv4(gatewayText)) && (method === 'auto' ? addresses === '' && gatewayText === '' : simpleManualAddress);
	return { method, gateway: gatewayText || null, address: simpleManualAddress ? (addressMatch?.[1] ?? null) : null, prefixLength: simpleManualAddress && addressMatch ? Number(addressMatch[2]) : null, safe };
}
