import { DBusError, variant, type DBusReply } from '../../../src/native/linux/dbus.ts';
import { NativeMutationUnknown, type NativeMutationContext } from '../../../src/native/mutation-host.ts';
import type { NativeNetworkSettings } from '../../../src/native/linux/network-mutation.ts';
import type { WifiCall, WifiMutationDeps, WifiMutationOptions } from '../../../src/native/linux/wifi-client.ts';
import type { WifiRecoveryData } from '../../../src/native/linux/wifi-mutation.ts';
import type { JournalValue } from '../../../src/native/mutation-journal.ts';
import type { WifiSecretScope } from '../../../src/native/linux/wifi-secret-agent.ts';

export const NM: string = 'org.freedesktop.NetworkManager';
export const ROOT: string = '/org/freedesktop/NetworkManager';
export const DEVICE: string = `${ROOT}/Devices/1`;
export const PROFILE: string = `${ROOT}/Settings/1`;
export const AP: string = `${ROOT}/AccessPoint/1`;
export const UUID: string = '00000000-0000-4000-8000-000000000001';
export const CLONE_UUID: string = '00000000-0000-4000-8000-000000000099';
export const OLD_PASSWORD: string = 'old-demo-password';
export const NEW_PASSWORD: string = 'new-demo-password';
export const BSSID: string = '02:00:00:00:00:01';
export const wifiOptions: WifiMutationOptions = { readTimeoutMs: 5000, scanTimeoutMs: 30000, updateTimeoutMs: 5000, activationTimeoutMs: 95000, rollbackTimeoutMs: 95000, checkpointSafetyMs: 30000, checkpointTimeoutSeconds: 356 };

export function wifiSettings(uuid: string = UUID, pskFlags: number = 0, open = false): NativeNetworkSettings {
	return { connection: { uuid: variant('s', uuid), type: variant('s', '802-11-wireless'), id: variant('s', 'Demo') }, '802-11-wireless': { ssid: variant('ay', Buffer.from('Demo')), mode: variant('s', 'infrastructure') }, ...(open ? {} : { '802-11-wireless-security': { 'key-mgmt': variant('s', 'wpa-psk'), 'psk-flags': variant('u', pskFlags) } }), ipv4: { method: variant('s', 'auto') }, ipv6: { method: variant('s', 'auto') } };
}

export interface WifiFixture {
	context: NativeMutationContext;
	deps: WifiMutationDeps;
	profiles: Map<string, NativeNetworkSettings>;
	secrets: Map<string, string>;
	writes: WifiCall[];
	reads: WifiCall[];
	records: WifiRecoveryData[];
	agentScopes: WifiSecretScope[];
	state: { active: string | null; autoconnect: boolean; candidates: string[]; flags: number; wpa: number; rsn: number; failure: string; unknown: string; failSecrets: boolean; expireAtCommit: boolean; remaining: number; clock: number; closed: boolean; pending: boolean; secretAgent: boolean; retained: boolean; rollbackBusy: number; linkBssid: string | null };
	autoRollback(): void;
}

/** Synthetic NM model: checkpoint rollback restores active secrets but not an inactive profile's password. */
export function wifiFixture(options: { existing?: boolean; flags?: number; open?: boolean; active?: boolean } = {}): WifiFixture {
	const profiles = new Map<string, NativeNetworkSettings>();
	const secrets = new Map<string, string>();
	if (options.existing !== false) {
		profiles.set(PROFILE, wifiSettings(UUID, options.flags ?? 0, options.open));
		if (!options.open && !options.flags) secrets.set(PROFILE, OLD_PASSWORD);
	}
	const originalActive = options.active ? PROFILE : null;
	const state = { active: originalActive, autoconnect: !!options.active, candidates: [...profiles.keys()], flags: options.open ? 0 : 1, wpa: 0, rsn: options.open ? 0 : 0x188, failure: '', unknown: '', failSecrets: false, expireAtCommit: false, remaining: 355000, clock: 0, closed: false, pending: false, secretAgent: false, retained: false, rollbackBusy: 0, linkBssid: null };
	const agentScopes: WifiSecretScope[] = [];
	const writes: WifiCall[] = [],
		reads: WifiCall[] = [],
		records: WifiRecoveryData[] = [];
	const volatile = new Set<string>();
	let checkpointProfiles = new Set<string>(),
		checkpointSecret: string | undefined;
	const activePath = (): string => (state.active === null ? '/' : `${ROOT}/ActiveConnection/${state.active.split('/').pop()}`);
	const endpoint = { connectionId: 'connection-1', rule: { kind: 'dbus-process' as const, busId: 'a'.repeat(32), destination: ':1.42', process: { pid: 42, started: '1234' } } };
	const reply = (signature: string, ...values: DBusReply['values']): DBusReply => ({ type: 'method_return', sender: ':1.42', signature, values, errorName: null, errorMessage: null });
	const error = (name = `${NM}.Failed`): DBusError => new DBusError({ type: 'error', sender: ':1.42', signature: '', values: [], errorName: name, errorMessage: 'Rejected' });
	const autoRollback = (): void => {
		for (const path of profiles.keys())
			if (!checkpointProfiles.has(path)) {
				profiles.delete(path);
				secrets.delete(path);
				volatile.delete(path);
			}
		state.active = originalActive;
		state.autoconnect = true;
		if (originalActive && checkpointSecret !== undefined) secrets.set(originalActive, checkpointSecret);
	};
	const context: NativeMutationContext = {
		operationId: 'operation-1',
		dataDirectory: '/tmp/native-wifi-test',
		remainingMs: () => state.remaining,
		recordExecution: async () => {
			throw new Error('Unexpected helper executor');
		},
		recordRecovery: async data => {
			const record = structuredClone(data['wifi']) as unknown as WifiRecoveryData;
			records.push(record);
			if (record.phase === 'commit' && state.expireAtCommit) state.remaining = 0;
		},
		pending: async () => {
			state.pending = true;
			throw new NativeMutationUnknown();
		},
		call: async (_rule, invoke) => {
			const result = await invoke();
			if (!result.known) throw new NativeMutationUnknown();
			return result.value;
		},
	};
	const consumeSettings = (path: string, input: NativeNetworkSettings): void => {
		const settings = structuredClone(input);
		const security = settings['802-11-wireless-security'];
		const flags = security?.['psk-flags']?.value ?? 0;
		if (security?.['psk'] && flags === 0) secrets.set(path, String(security['psk'].value));
		if (security) delete security['psk'];
		profiles.set(path, settings);
	};
	const deps: WifiMutationDeps = {
		bind: async () => endpoint,
		provideSecret: async (_context, _endpoint, scope) => {
			if (state.failure === 'secret-agent') throw error();
			agentScopes.push(scope);
			state.secretAgent = true;
			return reply('');
		},
		releaseSecret: async () => {
			state.secretAgent = false;
			return reply('');
		},
		scan: async () => [],
		link: async () => ({ ssid: state.active ? 'Demo' : null, bssid: state.active ? (state.linkBssid ?? BSSID) : null, signal: state.active ? -38 : null }),
		read: async (_endpoint, request) => {
			reads.push(request);
			if (request.member === 'GetDeviceByIpIface') return reply('o', DEVICE);
			if (request.member === 'GetConnectionByUuid') {
				const found = [...profiles].find(([, settings]) => settings['connection']!['uuid']!.value === request.args?.[0]);
				if (!found) return error(`${NM}.Settings.InvalidConnection`).reply;
				return reply('o', found[0]);
			}
			if (request.member === 'ListConnections') return reply('ao', [...profiles.keys()]);
			if (request.member === 'GetSettings') {
				const settings = profiles.get(request.path);
				if (!settings) throw error(`${NM}.Settings.InvalidConnection`);
				return reply('a{sa{sv}}', structuredClone(settings));
			}
			if (request.member === 'GetSecrets') {
				if (state.failSecrets) throw error('org.freedesktop.DBus.Error.AccessDenied');
				return reply('a{sa{sv}}', { '802-11-wireless-security': secrets.has(request.path) ? { psk: variant('s', secrets.get(request.path)!) } : {} });
			}
			if (request.member !== 'GetAll') throw new Error(`Unexpected read ${request.member}`);
			if (request.path === DEVICE && request.args?.[0] === `${NM}.Device`) return reply('a{sv}', { DeviceType: variant('u', 2), Managed: variant('b', true), State: variant('u', state.rollbackBusy > 0 && state.rollbackBusy-- ? 70 : state.active ? 100 : 30), Autoconnect: variant('b', state.autoconnect), ActiveConnection: variant('o', activePath()), AvailableConnections: variant('ao', state.candidates) });
			if (request.path === DEVICE) return reply('a{sv}', { AccessPoints: variant('ao', [AP]) });
			if (request.path === AP) return reply('a{sv}', { Ssid: variant('ay', Buffer.from('Demo')), HwAddress: variant('s', BSSID), Mode: variant('u', 2), Frequency: variant('u', 2412), Flags: variant('u', state.flags), WpaFlags: variant('u', state.wpa), RsnFlags: variant('u', state.rsn) });
			if (request.path.includes('/ActiveConnection/')) {
				const path = `${ROOT}/Settings/${request.path.split('/').pop()}`;
				const settings = profiles.get(path)!;
				const failed = (path === PROFILE && state.failure === 'original-activation') || (volatile.has(path) && state.failure === 'clone-activation');
				return reply('a{sv}', { Uuid: settings['connection']!['uuid']!, Connection: variant('o', path), Devices: variant('ao', [DEVICE]), State: variant('u', failed ? 4 : 2) });
			}
			throw new Error('Unexpected Wi-Fi read path');
		},
		mutate: async (_context, _endpoint, request) => {
			writes.push(request);
			if (request.member === 'CheckpointCreate') {
				checkpointProfiles = new Set(profiles.keys());
				checkpointSecret = originalActive ? secrets.get(originalActive) : undefined;
				return reply('o', `${ROOT}/Checkpoint/1`);
			}
			if (request.member === 'AddAndActivateConnection2') {
				const settings = structuredClone(request.args![0]) as NativeNetworkSettings;
				const path = `${ROOT}/Settings/99`;
				settings['connection']!['uuid'] ??= variant('s', CLONE_UUID);
				consumeSettings(path, settings);
				state.active = path;
				state.autoconnect = true;
				if ((request.args?.[3] as Record<string, { value: JournalValue }> | undefined)?.['persist']?.value === 'volatile') volatile.add(path);
				if (state.unknown === 'AddAndActivateConnection2') {
					state.pending = true;
					throw new NativeMutationUnknown();
				}
				return reply('ooa{sv}', path, activePath(), {});
			}
			if (request.member === 'Update2') {
				consumeSettings(request.path, request.args![0] as NativeNetworkSettings);
				const compensation = (request.args![0] as NativeNetworkSettings)['802-11-wireless-security']?.['psk']?.value === OLD_PASSWORD;
				if (state.unknown === 'Update2' || (compensation && state.unknown === 'compensation')) {
					state.pending = true;
					throw new NativeMutationUnknown();
				}
				if (!compensation && state.failure === 'commit') throw error();
				return reply('a{sv}', {});
			}
			if (request.member === 'ActivateConnection') {
				// The real agent answers only for the exact profile, key management included.
				const agentScope = agentScopes[agentScopes.length - 1];
				if (options.flags && (!state.secretAgent || agentScope?.authentication !== profiles.get(String(request.args![0]))?.['802-11-wireless-security']?.['key-mgmt']?.value)) throw error(`${NM}.NoSecrets`);
				for (const path of volatile) {
					profiles.delete(path);
					secrets.delete(path);
				}
				volatile.clear();
				state.active = String(request.args![0]);
				state.autoconnect = true;
				if (state.unknown === 'ActivateConnection') {
					state.pending = true;
					throw new NativeMutationUnknown();
				}
				return reply('o', activePath());
			}
			if (request.member === 'CheckpointRollback') {
				if (state.secretAgent) throw new Error('Interactive credentials must not override checkpoint restoration');
				autoRollback();
				return reply('a{su}', { [DEVICE]: 0 });
			}
			if (request.member === 'CheckpointDestroy') return reply('');
			if (request.member === 'Set') {
				state.autoconnect = Boolean((request.args![2] as { value: boolean }).value);
				return reply('');
			}
			if (request.member === 'Disconnect') {
				state.active = null;
				state.autoconnect = false;
				if (state.unknown === 'Disconnect') {
					state.pending = true;
					throw new NativeMutationUnknown();
				}
				return reply('');
			}
			throw new Error(`Unexpected mutation ${request.member}`);
		},
		now: () => state.clock,
		sleep: async ms => {
			state.clock += ms;
			state.remaining -= ms;
		},
		close: retainReceiver => {
			state.retained = !!retainReceiver;
			state.closed = !retainReceiver;
			if (!retainReceiver) state.secretAgent = false;
		},
	};
	return { context, deps, profiles, secrets, writes, reads, records, state, agentScopes, autoRollback };
}
