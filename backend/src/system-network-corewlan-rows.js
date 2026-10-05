/** Pure CoreWLAN data rules shared by the in-process worker and the desktop app bridge. */

/** Mixed CoreWLAN enums also match a single constituent; inspect WPA versions individually. */
export function coreWlanSecurityType(supported) {
	if ([1, 6, 7, 9, 12, 14, 15].some(type => supported.includes(type))) return -1;
	if (supported.includes(11)) return supported.includes(4) ? 13 : 11;
	if (supported.includes(4)) return supported.includes(2) ? 3 : 4;
	if (supported.includes(2)) return 2;
	return supported.includes(0) ? 0 : -1;
}

/** Reject every ambiguous scan before choosing the strongest access point of the requested network. */
export function selectCoreWlanTarget(networks, ssidHex, securityType, bssid = null) {
	const targets = bssid === null ? networks : networks.filter(network => network.bssid?.toLowerCase() === bssid.toLowerCase());
	if (!targets.length) throw new Error('macOS Wi-Fi network is no longer available');
	if (bssid !== null && targets.length !== 1) throw new Error('macOS Wi-Fi access point identity is ambiguous');
	for (const network of targets) {
		if (network.ssidHex !== ssidHex) throw new Error('macOS cannot identify the requested Wi-Fi network');
		if (network.securityType !== securityType) throw new Error('macOS Wi-Fi security changed or the network name is ambiguous');
	}
	return targets.reduce((best, item) => (item.signal > best.signal ? item : best)).network;
}

/** CoreWLAN's returned bytes prove access in this bundle; helper CoreLocation status can describe a different identity. */
export function coreWlanNamesVisible(current, networks = []) {
	return current.powerOn && (!!current.ssidHex || networks.some(network => !!network.ssidHex));
}

/** Mixed scan modes permit either secured constituent, never a downgrade to open. */
export function coreWlanAssociationMatches(actual, ssidHex, bssid, securityType) {
	const allowed = securityType === 3 ? [2, 3, 4] : securityType === 13 ? [4, 11, 13] : [securityType];
	return actual.ssidHex === ssidHex && (bssid === null || actual.bssid === bssid) && allowed.includes(actual.securityType);
}

const SECURITY_LABELS = { 0: '', 2: 'WPA Personal', 3: 'WPA/WPA2 Personal', 4: 'WPA2 Personal', 11: 'WPA3 Personal', 13: 'WPA2/WPA3 Personal' };

/** Hidden SSIDs alone cannot prove disconnection; station mode must also have ended. */
export function coreWlanDisconnected(current) {
	return current.interfaceMode === 0 && !current.ssidHex && !current.bssid;
}

function signalQuality(rssi) {
	return rssi === 0 ? null : Math.max(0, Math.min(100, 2 * (rssi + 100)));
}

export function coreWlanInterfaceState(snapshot, namesVisible) {
	return {
		device: snapshot.device,
		configurable: namesVisible && snapshot.powerOn,
		wifi: {
			ssid: namesVisible && snapshot.powerOn && snapshot.ssidHex ? Buffer.from(snapshot.ssidHex, 'hex').toString('utf8') : null,
			signal: snapshot.powerOn ? signalQuality(snapshot.signal) : null,
			radio: snapshot.powerOn ? 'on' : 'off',
		},
	};
}

/** Retain raw identities and never offer a join that the current-SSID guard must reject. */
export function coreWlanScanRows(networks, current) {
	return networks
		.filter(network => network.ssidHex)
		.map(network => {
			const ssid = Buffer.from(network.ssidHex, 'hex').toString('utf8');
			const alreadyJoined = network.ssidHex === current.ssidHex;
			const active = network.bssid === current.bssid && coreWlanAssociationMatches(current, network.ssidHex, network.bssid, network.securityType);
			const unsupportedName = ssid.includes('\0');
			return {
				ssid,
				ssidHex: network.ssidHex,
				bssid: network.bssid,
				signal: signalQuality(network.signal),
				secured: network.securityType !== 0,
				security: SECURITY_LABELS[network.securityType] ?? 'Unsupported',
				supported: network.securityType >= 0,
				connectable: !alreadyJoined && !unsupportedName,
				...(alreadyJoined ? { unavailableReason: 'This interface is already connected to this SSID' } : unsupportedName ? { unavailableReason: 'This SSID contains a NUL character and cannot be selected' } : {}),
				active,
			};
		})
		.sort((left, right) => (right.signal ?? -1) - (left.signal ?? -1));
}
