import { DBusError } from './dbus.ts';
import { WifiSession, WIFI_NM as NM, WIFI_NM_PATH as ROOT, wifiCall, wifiObjectPath, type WifiMutationDeps } from './wifi-client.ts';
import { readWifiSecret, StoredWifiSecretUnavailable, type WifiRecoveryData } from './wifi-mutation.ts';
import { wifiNumber, wifiPaths, wifiProfileFingerprint, wifiProfilePinsBssid, wifiSecretFingerprint, wifiString, wifiValue } from './wifi-settings.ts';
import type { NativeNetworkSettings } from './network-mutation.ts';

export interface NativeWifiObservation {
	outcome: 'original' | 'target' | 'password-committed' | 'different';
	originalMatches: boolean;
	targetMatches: boolean;
	secretState: 'old' | 'new' | 'other' | 'none';
	cloneExists: boolean;
}

export function isWifiRecoveryData(value: unknown): value is WifiRecoveryData {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const data = value as Record<string, unknown>;
	if (data['version'] !== 1 || !['connect', 'disconnect'].includes(String(data['operation'])) || typeof data['device'] !== 'string' || !data['device'] || Buffer.byteLength(data['device']) > 15 || /[/\0]/.test(data['device']) || typeof data['wasActive'] !== 'boolean' || typeof data['credentialVerified'] !== 'boolean' || typeof data['originalAutoconnect'] !== 'boolean') return false;
	if (!['prepared', 'clone-active', 'commit', 'committed', 'rolled-back', 'connected', 'disconnecting', 'disconnected'].includes(String(data['phase']))) return false;
	for (const key of ['originalActiveUuid', 'selectedProfileUuid', 'desiredProfileUuid', 'cloneUuid']) if (data[key] !== null && (typeof data[key] !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(data[key] as string))) return false;
	for (const key of ['originalActiveFingerprint', 'originalProfileFingerprint', 'desiredProfileFingerprint', 'secretSalt', 'oldSecretFingerprint', 'newSecretFingerprint']) if (data[key] !== null && (typeof data[key] !== 'string' || !/^[0-9a-f]{64}$/.test(data[key] as string))) return false;
	for (const key of ['originalBssid', 'targetBssid']) if (data[key] !== null && (typeof data[key] !== 'string' || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(data[key] as string))) return false;
	if (data['targetSsidHex'] !== null && (typeof data['targetSsidHex'] !== 'string' || !/^(?:[0-9a-f]{2}){1,32}$/.test(data['targetSsidHex']))) return false;
	if (data['targetAuthentication'] !== null && !['open', 'wpa-psk', 'sae'].includes(String(data['targetAuthentication']))) return false;
	if (data['cloneId'] !== null && (typeof data['cloneId'] !== 'string' || !/^libershare-verify-[A-Za-z0-9-]+$/.test(data['cloneId']))) return false;
	if (data['checkpointPath'] !== null && (typeof data['checkpointPath'] !== 'string' || !/^\/org\/freedesktop\/NetworkManager\/Checkpoint\/\d+$/.test(data['checkpointPath']))) return false;
	if ((data['oldSecretFingerprint'] !== null || data['newSecretFingerprint'] !== null) && data['secretSalt'] === null) return false;
	if ((data['originalActiveUuid'] === null) !== (data['originalActiveFingerprint'] === null)) return false;
	if (data['cloneUuid'] !== null && data['cloneId'] === null) return false;
	if (data['cloneId'] !== null && (data['selectedProfileUuid'] === null || data['oldSecretFingerprint'] === null || data['newSecretFingerprint'] === null)) return false;
	if (data['operation'] === 'disconnect') return ['disconnecting', 'disconnected'].includes(String(data['phase'])) && ['targetSsidHex', 'targetBssid', 'targetAuthentication', 'selectedProfileUuid', 'desiredProfileUuid', 'originalProfileFingerprint', 'desiredProfileFingerprint', 'secretSalt', 'oldSecretFingerprint', 'newSecretFingerprint', 'cloneId', 'cloneUuid', 'checkpointPath'].every(key => data[key] === null) && data['credentialVerified'] === false && data['wasActive'] === false;
	if (['disconnecting', 'disconnected'].includes(String(data['phase']))) return false;
	if (data['selectedProfileUuid'] !== null && (data['desiredProfileUuid'] !== data['selectedProfileUuid'] || data['originalProfileFingerprint'] === null || data['desiredProfileFingerprint'] === null)) return false;
	return data['targetSsidHex'] !== null && data['targetBssid'] !== null && data['desiredProfileUuid'] !== null && data['targetAuthentication'] !== null;
}

/** Called only after durable execution-end proof; reading matching state alone never releases a running mutation. */
export async function observeNativeLinuxWifi(value: unknown, timeoutMs: number, deps?: WifiMutationDeps): Promise<NativeWifiObservation> {
	if (!isWifiRecoveryData(value) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid Wi-Fi recovery metadata');
	const metadata = value;
	const session = new WifiSession({ readTimeoutMs: timeoutMs, scanTimeoutMs: timeoutMs, updateTimeoutMs: 0, activationTimeoutMs: 0, rollbackTimeoutMs: 0, checkpointSafetyMs: 0, checkpointTimeoutSeconds: 0 }, undefined, deps);
	try {
		await session.bind();
		let devicePath: string;
		try {
			const reply = await session.read(wifiCall(ROOT, NM, 'GetDeviceByIpIface', 's', [metadata.device]));
			if (reply.signature !== 'o') throw new Error('Invalid Wi-Fi device lookup');
			devicePath = wifiObjectPath(reply.values[0]);
		} catch (error) {
			if (error instanceof DBusError && error.reply.sender === session.endpoint!.rule.destination && error.errorName === `${NM}.UnknownDevice`) return { outcome: 'different', originalMatches: false, targetMatches: false, secretState: 'none', cloneExists: false };
			throw error;
		}
		const device = await session.all(devicePath, `${NM}.Device`);
		const link = await session.link(metadata.device);
		const activePath = wifiString(device, 'ActiveConnection', 'o');
		let activeUuid: string | null = null;
		let activeProfilePath: string | null = null;
		let activeValid = false;
		if (activePath !== '/') {
			const active = await session.all(activePath, `${NM}.Connection.Active`);
			activeUuid = wifiString(active, 'Uuid');
			activeProfilePath = wifiString(active, 'Connection', 'o');
			activeValid = wifiNumber(active, 'State') === 2 && wifiPaths(active, 'Devices').includes(devicePath);
		}
		const profiles = new Map<string, { path: string; settings: NativeNetworkSettings; fingerprint: string }>();
		for (const uuid of new Set([metadata.originalActiveUuid, metadata.selectedProfileUuid, metadata.desiredProfileUuid].filter((uuid): uuid is string => uuid !== null))) {
			const path = await session.profileByUuid(uuid);
			if (!path) continue;
			const settings = await session.settings(path);
			if (wifiString(settings['connection']!, 'uuid') !== uuid) throw new Error('Wi-Fi profile identity changed');
			profiles.set(uuid, { path, settings, fingerprint: wifiProfileFingerprint(settings) });
		}
		let cloneExists = false;
		if (metadata.cloneUuid) cloneExists = (await session.profileByUuid(metadata.cloneUuid)) !== null;
		else if (metadata.cloneId) {
			const reply = await session.read(wifiCall(`${ROOT}/Settings`, `${NM}.Settings`, 'ListConnections'));
			if (reply.signature !== 'ao' || !Array.isArray(reply.values[0])) throw new Error('Invalid profile listing');
			for (const path of reply.values[0]) if (wifiString((await session.settings(wifiObjectPath(path)))['connection']!, 'id') === metadata.cloneId) cloneExists = true;
		}
		const selected = metadata.selectedProfileUuid ? profiles.get(metadata.selectedProfileUuid) : undefined;
		const desired = metadata.desiredProfileUuid ? profiles.get(metadata.desiredProfileUuid) : undefined;
		let secretState: NativeWifiObservation['secretState'] = 'none';
		let oldSecretMatches = metadata.oldSecretFingerprint === null;
		let newSecretMatches = metadata.newSecretFingerprint === null;
		if (metadata.secretSalt && (selected || desired)) {
			let secret: string | null;
			try {
				secret = await readWifiSecret(session, (selected ?? desired)!.path);
			} catch (error) {
				if (!(error instanceof StoredWifiSecretUnavailable)) throw error;
				secret = null;
			}
			const fingerprint = secret === null ? null : wifiSecretFingerprint(metadata.secretSalt, secret);
			oldSecretMatches = fingerprint !== null && fingerprint === metadata.oldSecretFingerprint;
			newSecretMatches = fingerprint !== null && fingerprint === metadata.newSecretFingerprint;
			secretState = oldSecretMatches ? 'old' : newSecretMatches ? 'new' : 'other';
		}
		const originalSaved = metadata.originalActiveUuid ? profiles.get(metadata.originalActiveUuid) : undefined;
		// An unbound profile may come back on another access point of the same network.
		const originalLink = activeUuid !== null && originalSaved && !wifiProfilePinsBssid(originalSaved.settings) ? link.bssid !== null : (link.bssid?.toLowerCase() ?? null) === metadata.originalBssid;
		const originalAssociation = activeUuid === metadata.originalActiveUuid && originalLink && wifiValue(device, 'Autoconnect', 'b') === metadata.originalAutoconnect && (activeUuid === null ? wifiNumber(device, 'State') === 30 : activeValid && originalSaved?.path === activeProfilePath && originalSaved.fingerprint === metadata.originalActiveFingerprint);
		const selectedRestored = metadata.selectedProfileUuid ? selected?.fingerprint === metadata.originalProfileFingerprint && oldSecretMatches : !desired;
		const originalMatches = !cloneExists && originalAssociation && selectedRestored;
		let desiredProfileMatches = false;
		if (desired) {
			const wireless = desired.settings['802-11-wireless'];
			const ssid = wireless ? wifiValue(wireless, 'ssid', 'ay') : null;
			const security = desired.settings['802-11-wireless-security'];
			const authentication = security ? wifiString(security, 'key-mgmt') : 'open';
			desiredProfileMatches = metadata.desiredProfileFingerprint ? desired.fingerprint === metadata.desiredProfileFingerprint : ssid instanceof Uint8Array && Buffer.from(ssid).toString('hex') === metadata.targetSsidHex && authentication === metadata.targetAuthentication;
		}
		const targetMatches = metadata.operation === 'disconnect' ? activeUuid === null && link.bssid === null && wifiNumber(device, 'State') === 30 && wifiValue(device, 'Autoconnect', 'b') === false && (!metadata.originalActiveUuid || originalSaved?.fingerprint === metadata.originalActiveFingerprint) : !cloneExists && activeValid && activeUuid === metadata.desiredProfileUuid && desired?.path === activeProfilePath && (wifiProfilePinsBssid(desired.settings) ? link.bssid?.toLowerCase() === metadata.targetBssid : link.bssid !== null) && link.ssid !== null && Buffer.from(link.ssid).toString('hex') === metadata.targetSsidHex && desiredProfileMatches && newSecretMatches;
		const partial = !cloneExists && metadata.credentialVerified && secretState === 'new' && desiredProfileMatches;
		return { outcome: targetMatches ? 'target' : originalMatches ? 'original' : partial ? 'password-committed' : 'different', originalMatches, targetMatches, secretState, cloneExists };
	} finally {
		session.close();
	}
}
