import type { NetWifiNetwork } from '@shared';

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


export function assertLinuxWifiConnected(networks: NetWifiNetwork[], ssid: string, bssid: string | null): void {
	const active = networks.find(network => network.active && network.ssid === ssid && (bssid === null || network.bssid?.toLowerCase() === bssid.toLowerCase()));
	if (!active) throw new Error('NetworkManager did not connect to the requested Wi-Fi access point');
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


/** Build the public part of a Wi-Fi connect command; the secret is never an argument. */
export function nmcliWifiConnectArgs(device: string, ssid: string, askForPassword: boolean, bssid: string | null = null): string[] {
	return [...(askForPassword ? ['--ask'] : []), 'device', 'wifi', 'connect', ssid, ...(bssid ? ['bssid', bssid] : []), 'ifname', device];
}

