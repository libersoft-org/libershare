import { randomBytes, randomUUID } from 'node:crypto';
import { isValidSSID, isValidWifiKey } from '../../../../shared/src/utils.ts';
import { CodedError, ErrorCodes } from '../../../../shared/src/errors.ts';
import { variant, type DBusReply } from './dbus.ts';
import { rollbackSettled, type NativeNetworkSettings } from './network-mutation.ts';
import type { NativeMutationContext } from '../mutation-host.ts';
import type { JournalValue } from '../mutation-journal.ts';
import { WifiSession, WIFI_NM as NM, WIFI_NM_PATH as ROOT, wifiCall, wifiObjectPath, type WifiMutationDeps, type WifiMutationOptions } from './wifi-client.ts';
import { decodeWifiAccessPoint, wifiDictionary, wifiNumber, wifiPaths, wifiPersonalSecurity, wifiProfileCompatible, wifiProfileFingerprint, wifiProfilePinsBssid, wifiSecretFingerprint, wifiString, wifiValue, type WifiAccessPoint, type WifiProperties } from './wifi-settings.ts';

export interface WifiRecoveryData {
	version: 1;
	operation: 'connect' | 'disconnect';
	device: string;
	originalActiveUuid: string | null;
	originalActiveFingerprint: string | null;
	originalBssid: string | null;
	originalAutoconnect: boolean;
	targetSsidHex: string | null;
	targetBssid: string | null;
	targetAuthentication: string | null;
	selectedProfileUuid: string | null;
	desiredProfileUuid: string | null;
	originalProfileFingerprint: string | null;
	desiredProfileFingerprint: string | null;
	secretSalt: string | null;
	oldSecretFingerprint: string | null;
	newSecretFingerprint: string | null;
	wasActive: boolean;
	credentialVerified: boolean;
	cloneId: string | null;
	cloneUuid: string | null;
	checkpointPath: string | null;
	phase: 'prepared' | 'clone-active' | 'commit' | 'committed' | 'rolled-back' | 'connected' | 'disconnecting' | 'disconnected';
}

export class StoredWifiSecretUnavailable extends Error {
	constructor() {
		super('The saved Wi-Fi password cannot be read completely; the profile was not changed');
		this.name = 'StoredWifiSecretUnavailable';
	}
}

export async function readWifiSecret(session: WifiSession, profilePath: string): Promise<string> {
	const reply = await session.read(wifiCall(profilePath, `${NM}.Settings.Connection`, 'GetSecrets', 's', ['802-11-wireless-security']));
	if (reply.signature !== 'a{sa{sv}}' || reply.values.length !== 1) throw new Error('Invalid NetworkManager secrets reply');
	const groups = wifiDictionary(reply.values[0]);
	const group = groups['802-11-wireless-security'];
	if (!group) throw new StoredWifiSecretUnavailable();
	const security = wifiDictionary(group) as WifiProperties;
	const psk = security['psk'];
	if (!psk) throw new StoredWifiSecretUnavailable();
	if (psk.sig !== 's' || typeof psk.value !== 'string') throw new Error('Invalid NetworkManager Wi-Fi secret');
	if (psk.value.length === 0) throw new StoredWifiSecretUnavailable();
	return psk.value;
}

async function devicePath(session: WifiSession, device: string): Promise<string> {
	const reply = await session.read(wifiCall(ROOT, NM, 'GetDeviceByIpIface', 's', [device]));
	if (reply.signature !== 'o') throw new Error('Invalid wireless device lookup');
	return wifiObjectPath(reply.values[0]);
}

async function originalState(session: WifiSession, device: string, path: string): Promise<{ properties: WifiProperties; metadata: WifiRecoveryData }> {
	const properties = await session.all(path, `${NM}.Device`);
	if (wifiNumber(properties, 'DeviceType') !== 2 || wifiValue(properties, 'Managed', 'b') !== true) throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'NetworkManager does not manage this Wi-Fi device');
	const activePath = wifiString(properties, 'ActiveConnection', 'o');
	let uuid: string | null = null,
		fingerprint: string | null = null;
	if (activePath !== '/') {
		const active = await session.all(activePath, `${NM}.Connection.Active`);
		uuid = wifiString(active, 'Uuid');
		fingerprint = wifiProfileFingerprint(await session.settings(wifiString(active, 'Connection', 'o')));
	}
	const link = await session.link(device);
	const autoconnect = wifiValue(properties, 'Autoconnect', 'b');
	if (typeof autoconnect !== 'boolean') throw new Error('Invalid wireless autoconnect policy');
	return { properties, metadata: { version: 1, operation: 'connect', device, originalActiveUuid: uuid, originalActiveFingerprint: fingerprint, originalBssid: link.bssid?.toLowerCase() ?? null, originalAutoconnect: autoconnect, targetSsidHex: null, targetBssid: null, targetAuthentication: null, selectedProfileUuid: null, desiredProfileUuid: null, originalProfileFingerprint: null, desiredProfileFingerprint: null, secretSalt: null, oldSecretFingerprint: null, newSecretFingerprint: null, wasActive: false, credentialVerified: false, cloneId: null, cloneUuid: null, checkpointPath: null, phase: 'prepared' } };
}

/** Match the raw SSID bytes: a name that is not UTF-8 does not survive the trip through its display text. */
async function targetAccessPoint(session: WifiSession, devicePath: string, ssid: Buffer, bssid: string | null): Promise<WifiAccessPoint> {
	const wireless = await session.all(devicePath, `${NM}.Device.Wireless`);
	const matches: WifiAccessPoint[] = [];
	for (const path of wifiPaths(wireless, 'AccessPoints')) {
		const ap = decodeWifiAccessPoint(path, await session.all(path, `${NM}.AccessPoint`));
		if (Buffer.from(ap.ssid).equals(ssid) && (bssid === null || ap.bssid === bssid.toLowerCase())) matches.push(ap);
	}
	if (matches.length !== 1) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, matches.length ? 'Wi-Fi target is ambiguous; select its access point' : 'Wi-Fi network is no longer available');
	return matches[0]!;
}

function addedConnection(reply: DBusReply): { profilePath: string; activePath: string } {
	if (reply.signature !== 'ooa{sv}' || reply.values.length !== 3) throw new Error('Invalid AddAndActivateConnection2 reply');
	return { profilePath: wifiObjectPath(reply.values[0]), activePath: wifiObjectPath(reply.values[1]) };
}

/** Check the link joined the selected network, and its exact access point when the profile is bound to one. */
async function verifyAssociation(session: WifiSession, device: string, ap: WifiAccessPoint, pinned: boolean): Promise<void> {
	const actual = await session.link(device);
	if ((pinned && actual.bssid?.toLowerCase() !== ap.bssid) || actual.ssid !== Buffer.from(ap.ssid).toString('utf8')) throw new Error('NetworkManager did not connect to the selected Wi-Fi access point');
}

async function activate(session: WifiSession, profilePath: string, uuid: string, device: string, path: string, ap: WifiAccessPoint, pinned: boolean): Promise<void> {
	const deadline = session.deps.now() + session.options.activationTimeoutMs;
	const reply = await session.write(wifiCall(ROOT, NM, 'ActivateConnection', 'ooo', [profilePath, path, ap.path]), session.options.activationTimeoutMs);
	if (reply.signature !== 'o') throw new Error('Invalid Wi-Fi activation reply');
	await session.waitActive(wifiObjectPath(reply.values[0]), profilePath, uuid, path, deadline);
	await verifyAssociation(session, device, ap, pinned);
}

async function assertProfile(session: WifiSession, profilePath: string, metadata: WifiRecoveryData): Promise<void> {
	const current = await session.settings(profilePath);
	if (wifiString(current['connection']!, 'uuid') !== metadata.desiredProfileUuid || wifiProfileFingerprint(current) !== metadata.desiredProfileFingerprint) throw new Error('Saved Wi-Fi profile changed during activation');
	if (metadata.newSecretFingerprint && metadata.secretSalt && wifiSecretFingerprint(metadata.secretSalt, await readWifiSecret(session, profilePath)) !== metadata.newSecretFingerprint) throw new Error('NetworkManager did not preserve the verified Wi-Fi password');
	if (metadata.cloneUuid && (await session.profileByUuid(metadata.cloneUuid)) !== null) throw new Error('Temporary Wi-Fi profile is still present');
}

/** The personal security method a saved profile actually uses. */
function savedAuthentication(settings: NativeNetworkSettings): 'open' | 'wpa-psk' | 'sae' {
	const security = settings['802-11-wireless-security'];
	if (!security) return 'open';
	const key = wifiString(security, 'key-mgmt', 's', '');
	if (key === 'wpa-psk' || key === 'sae') return key;
	throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'This Wi-Fi authentication method is not supported');
}

export async function connectNativeLinuxWifi(context: NativeMutationContext, device: string, ssid: string, password: string, bssid: string | null, options: WifiMutationOptions, deps?: WifiMutationDeps, ssidHex: string | null = null): Promise<void> {
	if (!isValidSSID(ssid) || (bssid !== null && !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(bssid)) || (ssidHex !== null && !/^(?:[0-9a-f]{2}){1,32}$/i.test(ssidHex))) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'Invalid Wi-Fi target');
	const ssidBytes = ssidHex === null ? Buffer.from(ssid) : Buffer.from(ssidHex, 'hex');
	const session = new WifiSession(options, context, deps);
	let metadata: WifiRecoveryData | undefined;
	let path: string | undefined;
	let selectedPath: string | null = null;
	let originalWithSecret: NativeNetworkSettings | undefined;
	let originalMayHaveChanged = false;
	const record = async (patch: Partial<WifiRecoveryData> = {}): Promise<void> => {
		Object.assign(metadata!, patch);
		await context.recordRecovery({ wifi: { ...metadata! } as unknown as JournalValue });
	};
	try {
		await session.bind();
		path = await devicePath(session, device);
		const initial = await originalState(session, device, path);
		metadata = initial.metadata;
		session.ensureBudget(options.scanTimeoutMs, true);
		await session.deps.scan(device, Math.min(options.scanTimeoutMs, session.remainingMs()));
		const ap = await targetAccessPoint(session, path, ssidBytes, bssid);
		const offered = wifiPersonalSecurity(ap);
		if (offered === null) throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'This Wi-Fi authentication method is not supported');
		if (offered === 'open' ? password !== '' : !isValidWifiKey((ap.wpa | ap.rsn) & 0x400 ? 'WPA3' : 'WPA2', password)) throw new CodedError(ErrorCodes.NETCONFIG_INVALID, 'Invalid Wi-Fi password');
		metadata.targetSsidHex = Buffer.from(ap.ssid).toString('hex');
		metadata.targetBssid = ap.bssid;
		const currentDevice = await session.all(path, `${NM}.Device`);
		let selected: NativeNetworkSettings | undefined;
		for (const candidate of wifiPaths(currentDevice, 'AvailableConnections')) {
			const settings = await session.settings(candidate);
			if (wifiProfileCompatible(settings, ap)) {
				selectedPath = candidate;
				selected = settings;
				break;
			}
		}
		// What the AP offers only picks the method for a new profile; a saved one keeps its own,
		// e.g. SAE on a WPA2/WPA3 transition network, and the secret agent must be told that one.
		const authentication = selected ? savedAuthentication(selected) : offered;
		metadata.targetAuthentication = authentication;
		let pskFlags: number | null = null;
		if (selected) {
			metadata.selectedProfileUuid = wifiString(selected['connection']!, 'uuid');
			metadata.desiredProfileUuid = metadata.selectedProfileUuid;
			metadata.wasActive = metadata.originalActiveUuid === metadata.selectedProfileUuid;
			metadata.originalProfileFingerprint = wifiProfileFingerprint(selected);
			metadata.desiredProfileFingerprint = metadata.originalProfileFingerprint;
			if (authentication !== 'open') {
				pskFlags = wifiNumber(selected['802-11-wireless-security']!, 'psk-flags', 0);
				if (pskFlags === 0) {
					const oldSecret = await readWifiSecret(session, selectedPath!);
					metadata.secretSalt = randomBytes(32).toString('hex');
					metadata.oldSecretFingerprint = wifiSecretFingerprint(metadata.secretSalt, oldSecret);
					metadata.newSecretFingerprint = wifiSecretFingerprint(metadata.secretSalt, password);
					originalWithSecret = structuredClone(selected);
					originalWithSecret['802-11-wireless-security']!['psk'] = variant('s', oldSecret);
					metadata.cloneId = `libershare-verify-${context.operationId}`;
				}
			}
		} else {
			metadata.desiredProfileUuid = randomUUID();
			if (authentication !== 'open') {
				metadata.secretSalt = randomBytes(32).toString('hex');
				metadata.newSecretFingerprint = wifiSecretFingerprint(metadata.secretSalt, password);
			}
		}
		await record();
		if (selectedPath && pskFlags !== null && pskFlags !== 0 && authentication !== 'open') await session.provideSecret({ profilePath: selectedPath, uuid: metadata.selectedProfileUuid!, ssidHex: metadata.targetSsidHex!, authentication, password });
		await session.checkpoint(path);
		await record({ checkpointPath: session.checkpointPath });
		if (!selected) {
			const settings: NativeNetworkSettings = { connection: { uuid: variant('s', metadata.desiredProfileUuid!), type: variant('s', '802-11-wireless') }, '802-11-wireless': { ssid: variant('ay', ap.ssid), ...(bssid ? { bssid: variant('ay', Buffer.from(ap.bssid.replaceAll(':', ''), 'hex')) } : {}) } };
			if (authentication !== 'open') settings['802-11-wireless-security'] = { 'key-mgmt': variant('s', authentication), psk: variant('s', password) };
			const deadline = session.deps.now() + options.activationTimeoutMs;
			const added = addedConnection(await session.write(wifiCall(ROOT, NM, 'AddAndActivateConnection2', 'a{sa{sv}}ooa{sv}', [settings, path, ap.path, {}]), options.activationTimeoutMs));
			selectedPath = added.profilePath;
			const created = await session.settings(added.profilePath);
			if (wifiString(created['connection']!, 'uuid') !== metadata.desiredProfileUuid) throw new Error('NetworkManager created an unexpected profile');
			const createdSecurity = created['802-11-wireless-security'];
			if ((createdSecurity ? wifiString(createdSecurity, 'key-mgmt') : 'open') !== authentication) throw new Error('Wi-Fi authentication changed during connection creation');
			await record({ desiredProfileFingerprint: wifiProfileFingerprint(created) });
			await session.waitActive(added.activePath, added.profilePath, metadata.desiredProfileUuid!, path, deadline);
			// The new profile carries the BSSID exactly when one was selected.
			await verifyAssociation(session, device, ap, bssid !== null);
			await record({ credentialVerified: true });
		} else if (authentication === 'open') {
			await activate(session, selectedPath!, metadata.desiredProfileUuid!, device, path, ap, wifiProfilePinsBssid(selected!));
		} else if (pskFlags !== 0) {
			const updated = structuredClone(selected);
			updated['802-11-wireless-security']!['psk'] = variant('s', password);
			await session.write(wifiCall(selectedPath!, `${NM}.Settings.Connection`, 'Update2', 'a{sa{sv}}ua{sv}', [updated, 0x20, {}]), options.updateTimeoutMs);
			await record({ phase: 'committed' });
			await activate(session, selectedPath!, metadata.desiredProfileUuid!, device, path, ap, wifiProfilePinsBssid(selected!));
		} else {
			const clone = structuredClone(selected);
			delete clone['connection']!['uuid'];
			clone['connection']!['id'] = variant('s', metadata.cloneId!);
			clone['connection']!['autoconnect'] = variant('b', false);
			clone['802-11-wireless-security']!['psk'] = variant('s', password);
			clone['802-11-wireless-security']!['psk-flags'] = variant('u', 0);
			const deadline = session.deps.now() + options.activationTimeoutMs;
			const added = addedConnection(await session.write(wifiCall(ROOT, NM, 'AddAndActivateConnection2', 'a{sa{sv}}ooa{sv}', [clone, path, ap.path, { persist: variant('s', 'volatile') }]), options.activationTimeoutMs));
			const cloneUuid = wifiString((await session.settings(added.profilePath))['connection']!, 'uuid');
			await record({ cloneUuid });
			await session.waitActive(added.activePath, added.profilePath, cloneUuid, path, deadline);
			await verifyAssociation(session, device, ap, wifiProfilePinsBssid(selected));
			await record({ phase: 'clone-active', credentialVerified: true });
			const updated = structuredClone(selected);
			updated['802-11-wireless-security']!['psk'] = variant('s', password);
			session.compensationReserveMs = options.updateTimeoutMs;
			await record({ phase: 'commit' });
			originalMayHaveChanged = true;
			await session.write(wifiCall(selectedPath!, `${NM}.Settings.Connection`, 'Update2', 'a{sa{sv}}ua{sv}', [updated, 0x20, {}]), options.updateTimeoutMs);
			await record({ phase: 'committed' });
			await activate(session, selectedPath!, metadata.desiredProfileUuid!, device, path, ap, wifiProfilePinsBssid(selected!));
		}
		await assertProfile(session, selectedPath!, metadata);
		await session.finish();
		await record({ phase: 'connected', checkpointPath: null, credentialVerified: true });
	} catch (error) {
		if (session.unknown) throw error;
		if (session.checkpointPath) {
			const compensationMs = originalMayHaveChanged ? options.updateTimeoutMs : 0;
			if (session.remainingMs() < options.rollbackTimeoutMs + options.checkpointSafetyMs + compensationMs + session.secretCleanupBudgetMs()) return await context.pending(session.endpoint!.rule);
			try {
				await session.releaseSecret();
			} catch (failure) {
				if (session.unknown) throw failure;
				return await context.pending(session.endpoint!.rule);
			}
			let compensationError: unknown;
			if (originalMayHaveChanged && originalWithSecret) {
				try {
					await session.write(wifiCall(selectedPath!, `${NM}.Settings.Connection`, 'Update2', 'a{sa{sv}}ua{sv}', [originalWithSecret, 0x20, {}]), options.updateTimeoutMs);
				} catch (failure) {
					if (session.unknown) throw failure;
					compensationError = failure;
				}
			}
			try {
				const rollbackDeadline = session.deps.now() + options.rollbackTimeoutMs;
				await session.rollback(path!);
				if (
					!(await rollbackSettled(
						() => session.all(path!, `${NM}.Device`),
						activePath => session.all(activePath, `${NM}.Connection.Active`),
						() => session.deps.now(),
						ms => session.deps.sleep(ms),
						rollbackDeadline
					))
				)
					throw new Error('Wi-Fi rollback did not settle');
				// NM checkpoint rollback clears a prior manual-disconnect autoconnect block.
				const rolledBack = await session.all(path!, `${NM}.Device`);
				if (wifiValue(rolledBack, 'Autoconnect', 'b') !== metadata!.originalAutoconnect) {
					await session.write(wifiCall(path!, 'org.freedesktop.DBus.Properties', 'Set', 'ssv', [`${NM}.Device`, 'Autoconnect', variant('b', metadata!.originalAutoconnect)]), options.updateTimeoutMs, false);
					if (wifiValue(await session.all(path!, `${NM}.Device`), 'Autoconnect', 'b') !== metadata!.originalAutoconnect) throw new Error('Original Wi-Fi autoconnect policy was not restored');
				}
			} catch (failure) {
				if (session.unknown) throw failure;
				return await context.pending(session.endpoint!.rule);
			}
			if (context.remainingMs() > 0) await record({ phase: 'rolled-back', checkpointPath: null });
			if (compensationError) throw new AggregateError([error, compensationError], 'Wi-Fi activation and password restoration failed');
		}
		throw error;
	} finally {
		originalWithSecret = undefined;
		session.close();
	}
}

export async function disconnectNativeLinuxWifi(context: NativeMutationContext, device: string, options: WifiMutationOptions, deps?: WifiMutationDeps): Promise<void> {
	const session = new WifiSession(options, context, deps);
	let requested = false;
	let verified = false;
	try {
		await session.bind();
		const path = await devicePath(session, device);
		const { metadata } = await originalState(session, device, path);
		metadata.operation = 'disconnect';
		metadata.phase = 'disconnecting';
		await context.recordRecovery({ wifi: { ...metadata } as unknown as JournalValue });
		const deadline = session.deps.now() + options.activationTimeoutMs;
		await session.write(wifiCall(path, `${NM}.Device`, 'Disconnect'), options.activationTimeoutMs, false);
		requested = true;
		while (true) {
			const state = await session.all(path, `${NM}.Device`);
			if (wifiNumber(state, 'State') === 30 && wifiString(state, 'ActiveConnection', 'o') === '/') break;
			if (session.deps.now() >= deadline) return await context.pending(session.endpoint!.rule);
			await session.deps.sleep(Math.min(100, deadline - session.deps.now()));
		}
		if ((await session.link(device)).bssid !== null) throw new Error('Wi-Fi association remains after disconnect');
		verified = true;
		metadata.phase = 'disconnected';
		await context.recordRecovery({ wifi: { ...metadata } as unknown as JournalValue });
	} catch (error) {
		if (requested && !verified && !session.unknown) return await context.pending(session.endpoint!.rule);
		throw error;
	} finally {
		session.close();
	}
}
