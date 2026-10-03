import { isIPv4, isIPv6, canonicalDnsServer, validateIPv4Config } from '../../../../shared/src/utils.ts';
import { createHash } from 'node:crypto';
import type { NetIPv4Config } from '../../../../shared/src/index.ts';
import { CodedError, ErrorCodes } from '../../../../shared/src/errors.ts';
import { DBusError, DBusTransportError, variant, type DBusReply, type DBusRequest, type DBusValue, type DBusVariant } from './dbus.ts';
import type { BoundDBusEndpoint, DBusEndpointRequest } from './dbus-worker.ts';
import { NativeDBusMutation } from './mutation.ts';
import { NativeMutationStopped, type NativeMutationContext } from '../mutation-host.ts';
import { NativeWorkerChannel, NativeWorkerFailure } from '../worker-host.ts';
import { parseNativeIPv4Profile, parseNativeNameservers } from './network-reader.ts';
import { formatNetlinkAddress } from './netlink-wire.ts';
import type { LinuxNetlinkState } from './netlink.ts';

const NM = 'org.freedesktop.NetworkManager';
const NM_PATH = '/org/freedesktop/NetworkManager';
type Properties = Record<string, DBusVariant>;
export type NativeNetworkSettings = Record<string, Properties>;
type MutationRequest = Omit<Extract<DBusRequest, { kind: 'mutation' }>, 'kind' | 'destination'>;

export interface NativeIPv4MutationOptions {
	readonly addressingChanged: boolean;
	readonly requireLease: boolean;
	readonly readTimeoutMs: number;
	readonly updateTimeoutMs: number;
	readonly activationTimeoutMs: number;
	readonly rollbackTimeoutMs: number;
	readonly checkpointSafetyMs: number;
	readonly checkpointTimeoutSeconds: number;
}

export interface NativeNetworkMutationDeps {
	readonly bind: (request: DBusEndpointRequest) => Promise<BoundDBusEndpoint>;
	readonly mutate: (context: NativeMutationContext, endpoint: BoundDBusEndpoint, request: MutationRequest) => Promise<DBusReply>;
	readonly read: (endpoint: BoundDBusEndpoint, request: MutationRequest, timeoutMs: number) => Promise<DBusReply>;
	readonly kernel: (timeoutMs: number) => Promise<LinuxNetlinkState>;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly close: () => void;
}

export interface NativeIPv4ProfileObservationOptions {
	readonly profilePath: string;
	readonly profileUuid: string;
	readonly addressingChanged: boolean;
	readonly requireLease: boolean;
	readonly timeoutMs: number;
}
export interface NativeIPv4ProfileObservation {
	readonly exists: boolean;
	readonly appliesToDevice: boolean;
	readonly fingerprint: string | null;
	readonly matchesDesired: boolean;
}

const reader = new NativeWorkerChannel('read');

function nativeDependencies(): NativeNetworkMutationDeps {
	const mutation = new NativeDBusMutation();
	return {
		bind: request => mutation.bind(request),
		mutate: (context, endpoint, request) => mutation.call(context, endpoint, 'nm', request),
		read: (endpoint, request, timeoutMs) => reader.call({ method: 'linux.dbus', args: { options: { bus: 'system' }, request: { ...request, kind: 'read', destination: endpoint.rule.destination, timeoutUsec: BigInt(Math.max(1, Math.floor(timeoutMs * 1000))) } } }, timeoutMs),
		kernel: timeoutMs => reader.call({ method: 'linux.netlink', args: { timeoutMs } }, timeoutMs),
		now: () => performance.now(),
		sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
		close: () => {
			mutation.close();
		},
	};
}

function record(value: unknown): Record<string, DBusValue> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array || value instanceof Map) throw new Error('Invalid NetworkManager dictionary');
	return value as Record<string, DBusValue>;
}

function value(properties: Properties, key: string, signature: string, fallback?: DBusValue): DBusValue {
	const entry = properties[key];
	if (!entry && fallback !== undefined) return fallback;
	if (!entry || entry.sig !== signature) throw new Error(`Invalid NetworkManager ${key}`);
	return entry.value;
}

function text(properties: Properties, key: string, signature = 's'): string {
	const result = value(properties, key, signature);
	if (typeof result !== 'string') throw new Error(`Invalid NetworkManager ${key}`);
	return result;
}

function objectPath(reply: DBusReply): string {
	const path = reply.values[0];
	if (reply.signature !== 'o' || reply.values.length !== 1 || typeof path !== 'string' || !/^\/org\/freedesktop\/NetworkManager\/[A-Za-z0-9_/]+$/.test(path)) throw new Error('Invalid NetworkManager object path');
	return path;
}

async function readSettings(deps: NativeNetworkMutationDeps, endpoint: BoundDBusEndpoint, path: string, timeoutMs: number): Promise<NativeNetworkSettings> {
	const reply = await deps.read(endpoint, { path, interface: `${NM}.Settings.Connection`, member: 'GetSettings' }, timeoutMs);
	if (reply.type === 'error') throw new DBusError(reply);
	if (reply.sender !== endpoint.rule.destination || reply.signature !== 'a{sa{sv}}' || reply.values.length !== 1) throw new Error('Invalid NetworkManager settings');
	return record(reply.values[0]) as NativeNetworkSettings;
}

/** NM device states between "prepare" and "secondaries", plus "deactivating". */
function deviceInTransition(state: number): boolean {
	return (state >= 40 && state <= 90) || state === 110;
}

/**
 * A successful CheckpointRollback reply only says NetworkManager accepted the rollback: it may
 * still be reactivating the device. Wait until the device and its active connection go quiet,
 * and report whether that happened before `deadline`. Until it does, the outcome is unknown, not
 * interrupted, so nobody may acknowledge it while NetworkManager is still restoring.
 * ponytail: "quiet" is two idle reads 500 ms apart, as NM signals no end of a rollback.
 */
export async function rollbackSettled(readDevice: () => Promise<Record<string, DBusVariant>>, readActive: (path: string) => Promise<Record<string, DBusVariant>>, now: () => number, sleep: (ms: number) => Promise<void>, deadline: number): Promise<boolean> {
	let idleSince: number | null = null;
	while (true) {
		const device = await readDevice();
		const state = device['State']?.value;
		const activePath = device['ActiveConnection']?.value;
		let busy = typeof state !== 'number' || deviceInTransition(state);
		if (!busy && typeof activePath === 'string' && activePath !== '/') {
			try {
				const activeState = (await readActive(activePath))['State']?.value;
				busy = activeState === 1 || activeState === 3;
			} catch (error) {
				// The active connection vanished between the two reads: the device is still moving.
				if (!(error instanceof DBusError)) throw error;
				busy = true;
			}
		}
		if (busy) idleSince = null;
		else if (idleSince === null) idleSince = now();
		else if (now() - idleSince >= 500) return true;
		if (now() >= deadline) return false;
		await sleep(Math.min(100, deadline - now()));
	}
}

export function nativeIPv4ProfileFingerprint(settings: NativeNetworkSettings): string {
	const canonical = (entry: unknown): unknown => {
		if (typeof entry === 'bigint') return { bigint: entry.toString() };
		if (entry instanceof Uint8Array) return { bytes: Buffer.from(entry).toString('hex') };
		if (Array.isArray(entry)) return entry.map(canonical);
		if (entry instanceof Map) return { map: [...entry].map(([key, item]) => [canonical(key), canonical(item)]) };
		if (entry && typeof entry === 'object')
			return Object.fromEntries(
				Object.entries(entry)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([key, item]) => [key, canonical(item)])
			);
		return entry;
	};
	const identity = Object.fromEntries(['uuid', 'type', 'interface-name', 'multi-connect', 'controller', 'port-type', 'master', 'slave-type'].filter(key => settings['connection']?.[key] !== undefined).map(key => [key, settings['connection']![key]]));
	return createHash('sha256')
		.update(JSON.stringify(canonical({ connection: identity, ipv4: settings['ipv4'], ipv6: settings['ipv6'] })))
		.digest('hex');
}

/** Reads saved policy, including automatic DNS, without activating a connection. */
export async function observeNativeLinuxIPv4Profile(device: string, desired: NetIPv4Config, options: NativeIPv4ProfileObservationOptions, dependencies?: NativeNetworkMutationDeps): Promise<NativeIPv4ProfileObservation> {
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('Invalid profile observation timeout');
	const deps = dependencies ?? nativeDependencies();
	const deadline = deps.now() + options.timeoutMs;
	try {
		const endpoint = await deps.bind({ options: { bus: 'system' }, destination: NM, path: NM_PATH, interface: NM, timeoutMs: options.timeoutMs });
		const remaining = (): number => {
			const ms = deadline - deps.now();
			if (ms <= 0) throw new Error('Profile observation timed out');
			return ms;
		};
		const resolved = await deps.read(endpoint, { path: `${NM_PATH}/Settings`, interface: `${NM}.Settings`, member: 'GetConnectionByUuid', signature: 's', args: [options.profileUuid] }, remaining());
		if (resolved.sender !== endpoint.rule.destination) throw new Error('Profile observation owner changed');
		if (resolved.type === 'error') {
			if (resolved.errorName === `${NM}.Settings.InvalidConnection`) return { exists: false, appliesToDevice: false, fingerprint: null, matchesDesired: false };
			throw new DBusError(resolved);
		}
		const profilePath = objectPath(resolved);
		const saved = await readSettings(deps, endpoint, profilePath, remaining());
		if (text(saved['connection']!, 'uuid') !== options.profileUuid || text(saved['connection']!, 'interface-name') !== device) throw new Error('Profile observation identity changed');
		let appliesToDevice = !options.requireLease && desired.mode === 'dhcp';
		if (!appliesToDevice) {
			const read = async (request: MutationRequest): Promise<DBusReply> => {
				const reply = await deps.read(endpoint, request, remaining());
				if (reply.type === 'error') throw new DBusError(reply);
				if (reply.sender !== endpoint.rule.destination) throw new Error('Profile observation owner changed');
				return reply;
			};
			const all = async (path: string, iface: string): Promise<Properties> => {
				const reply = await read({ path, interface: 'org.freedesktop.DBus.Properties', member: 'GetAll', signature: 's', args: [iface] });
				if (reply.signature !== 'a{sv}' || reply.values.length !== 1) throw new Error('Invalid profile device properties');
				return record(reply.values[0]) as Properties;
			};
			const devicePath = objectPath(await read({ path: NM_PATH, interface: NM, member: 'GetDeviceByIpIface', signature: 's', args: [device] }));
			const activePath = text(await all(devicePath, `${NM}.Device`), 'ActiveConnection', 'o');
			if (activePath !== '/') {
				const active = await all(activePath, `${NM}.Connection.Active`);
				const devices = value(active, 'Devices', 'ao');
				appliesToDevice = text(active, 'Uuid') === options.profileUuid && text(active, 'Connection', 'o') === profilePath && Array.isArray(devices) && devices.length === 1 && devices[0] === devicePath;
			}
		}
		let matchesDesired = true;
		try {
			assertNativeIPv4Settings(saved, desired, device, options.addressingChanged);
		} catch {
			matchesDesired = false;
		}
		if (matchesDesired && appliesToDevice && !(!options.requireLease && desired.mode === 'dhcp')) {
			const kernel = await deps.kernel(remaining());
			try {
				assertKernelIPv4(kernel, device, desired, options.requireLease);
			} catch {
				matchesDesired = false;
			}
		}
		return { exists: true, appliesToDevice, fingerprint: nativeIPv4ProfileFingerprint(saved), matchesDesired };
	} finally {
		deps.close();
	}
}

function ipv4Bytes(address: string): number {
	return Buffer.from(address.split('.').map(Number)).readUInt32LE();
}

function ipv6Bytes(address: string): Uint8Array {
	const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
	const [left = '', right = ''] = normalized.split('::');
	const head = left ? left.split(':') : [];
	const tail = right ? right.split(':') : [];
	const groups = normalized.includes('::') ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail] : head;
	const bytes = Buffer.alloc(16);
	groups.forEach((group, index) => bytes.writeUInt16BE(parseInt(group, 16), index * 2));
	return bytes;
}

export function updateNativeIPv4Settings(settings: NativeNetworkSettings, config: NetIPv4Config, addressingChanged: boolean): NativeNetworkSettings {
	if (validateIPv4Config(config)) throw new Error('Invalid IPv4 configuration');
	const result = structuredClone(settings);
	const ipv4 = result['ipv4'];
	if (!ipv4) throw new Error('NetworkManager profile has no IPv4 section');
	if (addressingChanged) {
		ipv4['method'] = variant('s', config.mode === 'dhcp' ? 'auto' : 'manual');
		delete ipv4['addresses'];
		ipv4['address-data'] = variant('aa{sv}', config.mode === 'dhcp' ? [] : [{ address: variant('s', config.address!), prefix: variant('u', config.prefixLength!) }]);
		if (config.mode === 'static' && config.gateway) ipv4['gateway'] = variant('s', config.gateway);
		else delete ipv4['gateway'];
	}
	if (config.dns !== undefined) {
		const ipv6 = result['ipv6'];
		if (config.dns.some(isIPv6) && (!ipv6 || ['disabled', 'ignore'].includes(text(ipv6, 'method')))) throw new CodedError(ErrorCodes.NETCONFIG_UNSUPPORTED, 'IPv6 resolvers need IPv6 enabled on this profile');
		delete ipv4['dns-data'];
		ipv4['dns'] = variant('au', config.dns.filter(isIPv4).map(ipv4Bytes));
		ipv4['ignore-auto-dns'] = variant('b', config.dns.length > 0);
		if (ipv6) {
			delete ipv6['dns-data'];
			ipv6['dns'] = variant('aay', config.dns.filter(isIPv6).map(ipv6Bytes));
			ipv6['ignore-auto-dns'] = variant('b', config.dns.length > 0);
		}
	}
	return result;
}

function settingsDns(settings: NativeNetworkSettings, family: 4 | 6): string[] {
	const ip = settings[`ipv${family}`] ?? {};
	const modern = ip['dns-data'];
	if (modern) {
		if (modern.sig !== 'as' || !Array.isArray(modern.value) || modern.value.some(item => typeof item !== 'string')) throw new Error('Invalid saved DNS data');
		return modern.value as string[];
	}
	const values = value(ip, 'dns', family === 4 ? 'au' : 'aay', []);
	if (!Array.isArray(values)) throw new Error('Invalid saved DNS');
	return values.map(entry => {
		if (family === 4) {
			if (typeof entry !== 'number') throw new Error('Invalid saved IPv4 resolver');
			const bytes = Buffer.alloc(4);
			bytes.writeUInt32LE(entry);
			return formatNetlinkAddress(bytes, 2);
		}
		if (!(entry instanceof Uint8Array)) throw new Error('Invalid saved IPv6 resolver');
		return formatNetlinkAddress(Buffer.from(entry), 10);
	});
}

function sameDns(actual: string[], expected: readonly string[]): boolean {
	const normalize = (servers: readonly string[]): string[] => [...new Set(servers.map(server => (isIPv6(server) ? new URL(`http://[${server}]/`).hostname : canonicalDnsServer(server))))].sort();
	return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}

export function assertNativeIPv4Settings(settings: NativeNetworkSettings, config: NetIPv4Config, device: string, addressingChanged: boolean): void {
	if (addressingChanged) {
		const profile = parseNativeIPv4Profile(settings, device, 1);
		if (profile.method !== (config.mode === 'dhcp' ? 'auto' : 'manual')) throw new Error('NetworkManager did not preserve the requested IPv4 method');
		if (config.mode === 'static' && (profile.address !== config.address || profile.prefixLength !== config.prefixLength || profile.gateway !== (config.gateway || null))) throw new Error('NetworkManager did not preserve the requested static address');
		if (config.mode === 'dhcp' && (profile.address !== null || profile.gateway !== null)) throw new Error('NetworkManager kept manual fields in the DHCP profile');
	}
	if (config.dns !== undefined)
		for (const family of [4, 6] as const) {
			if (family === 6 && !settings['ipv6'] && !config.dns.some(isIPv6)) continue;
			const ip = settings[`ipv${family}`] ?? {};
			if (value(ip, 'ignore-auto-dns', 'b', false) !== config.dns.length > 0 || !sameDns(settingsDns(settings, family), config.dns.filter(family === 4 ? isIPv4 : isIPv6))) throw new Error('NetworkManager did not preserve the requested DNS policy');
		}
}

function assertKernelIPv4(state: LinuxNetlinkState, device: string, config: NetIPv4Config, requireLease: boolean): void {
	const index = state.links.find(link => link.ifname === device)?.ifindex;
	if (index === undefined) throw new Error('Network interface disappeared');
	const addresses = state.addresses.filter(address => address.index === index && address.family === 'inet');
	if (config.mode === 'dhcp') {
		if (requireLease && !addresses.some(address => (address.dynamic || address.valid_life_time !== 0xffffffff) && address.local !== '0.0.0.0' && !address.local.startsWith('169.254.') && address.scope !== 'host')) throw new Error('NetworkManager did not obtain a usable IPv4 lease');
		return;
	}
	if (addresses.length !== 1 || addresses[0]!.local !== config.address || addresses[0]!.prefixlen !== config.prefixLength) throw new Error('NetworkManager did not apply the requested IPv4 address');
	const routes = state.routes4.filter(route => route.dev === device);
	if (config.gateway ? routes.length !== 1 || routes[0]!.gateway !== config.gateway : routes.length !== 0) throw new Error('NetworkManager did not apply the requested IPv4 gateway');
}

/** Context ownership is mandatory; every mutating message is journaled before dispatch. */
export async function applyNativeLinuxIPv4(context: NativeMutationContext, device: string, config: NetIPv4Config, options: NativeIPv4MutationOptions, dependencies?: NativeNetworkMutationDeps): Promise<void> {
	if (validateIPv4Config(config)) throw new Error('Invalid IPv4 configuration');
	const deps = dependencies ?? nativeDependencies();
	let checkpoint: string | undefined;
	let checkpointDevice: string | undefined;
	let checkpointMayExist = false;
	let checkpointDeadline = Infinity;
	let unknown = false;
	let endpoint: BoundDBusEndpoint | undefined;
	const available = (): number => Math.min(context.remainingMs(), checkpointDeadline - deps.now());
	const requireBudget = (stepMs: number, reserve = true): void => {
		if (available() < stepMs + (reserve ? options.rollbackTimeoutMs + options.checkpointSafetyMs : 0)) throw new NativeMutationStopped();
	};
	const request = (path: string, iface: string, member: string, signature = '', args: DBusValue[] = []): MutationRequest => ({ path, interface: iface, member, signature, args });
	const read = async (call: MutationRequest): Promise<DBusReply> => {
		requireBudget(options.readTimeoutMs);
		const reply = await deps.read(endpoint!, call, Math.min(options.readTimeoutMs, available()));
		if (reply.type === 'error') throw new DBusError(reply);
		if (reply.sender !== endpoint!.rule.destination) throw new Error('NetworkManager read owner changed');
		return reply;
	};
	const all = async (path: string, iface: string): Promise<Properties> => {
		const reply = await read(request(path, 'org.freedesktop.DBus.Properties', 'GetAll', 's', [iface]));
		if (reply.signature !== 'a{sv}' || reply.values.length !== 1) throw new Error('Invalid NetworkManager properties');
		return record(reply.values[0]) as Properties;
	};
	const settings = async (path: string): Promise<NativeNetworkSettings> => {
		requireBudget(options.readTimeoutMs);
		return readSettings(deps, endpoint!, path, Math.min(options.readTimeoutMs, available()));
	};
	const activeInstances = async (uuid: string, knownPath: string, known: Properties): Promise<number> => {
		const activePaths = value(await all(NM_PATH, NM), 'ActiveConnections', 'ao');
		if (!Array.isArray(activePaths) || activePaths.some(path => typeof path !== 'string')) throw new Error('Invalid active connection list');
		let count = 0;
		for (let start = 0; start < activePaths.length; start += 16) {
			const batch = await Promise.all((activePaths.slice(start, start + 16) as string[]).map(path => (path === knownPath ? known : all(path, `${NM}.Connection.Active`))));
			for (const active of batch)
				if (text(active, 'Uuid') === uuid) {
					const devices = value(active, 'Devices', 'ao');
					if (!Array.isArray(devices)) throw new Error('Invalid active device list');
					count += devices.length;
				}
		}
		return count;
	};
	const write = async (call: MutationRequest, stepMs: number, reserve = true): Promise<DBusReply> => {
		requireBudget(stepMs, reserve);
		try {
			return await deps.mutate(context, endpoint!, call);
		} catch (error) {
			unknown = !(error instanceof DBusError || error instanceof NativeMutationStopped || (error instanceof DBusTransportError && !error.mayHaveBeenSent) || (error instanceof NativeWorkerFailure && !error.mayHaveRun));
			throw error;
		}
	};
	try {
		requireBudget(options.readTimeoutMs);
		endpoint = await deps.bind({ options: { bus: 'system' }, destination: NM, path: NM_PATH, interface: NM, timeoutMs: options.readTimeoutMs });
		const devicePath = objectPath(await read(request(NM_PATH, NM, 'GetDeviceByIpIface', 's', [device])));
		checkpointDevice = devicePath;
		const deviceProperties = await all(devicePath, `${NM}.Device`);
		if (value(deviceProperties, 'Managed', 'b') !== true) throw new Error('NetworkManager does not manage this device');
		const activePath = text(deviceProperties, 'ActiveConnection', 'o');
		if (activePath === '/') throw new Error('No NetworkManager profile is active on this device');
		const active = await all(activePath, `${NM}.Connection.Active`);
		const uuid = text(active, 'Uuid');
		const profilePath = text(active, 'Connection', 'o');
		const activeDevices = value(active, 'Devices', 'ao');
		if (!Array.isArray(activeDevices) || activeDevices.length !== 1 || activeDevices[0] !== devicePath) throw new Error('NetworkManager profile is active on multiple devices');
		const original = await settings(profilePath);
		if (text(original['connection']!, 'uuid') !== uuid || !parseNativeIPv4Profile(original, device, await activeInstances(uuid, activePath, active)).safe) throw new Error('NetworkManager profile is not bound exclusively to this device');
		const updated = updateNativeIPv4Settings(original, config, options.addressingChanged);
		await context.recordRecovery({ device, profilePath, profileUuid: uuid, originalProfileFingerprint: nativeIPv4ProfileFingerprint(original) });
		checkpointDeadline = deps.now() + options.checkpointTimeoutSeconds * 1000;
		const created = await write(request(NM_PATH, NM, 'CheckpointCreate', 'aouu', [[devicePath], options.checkpointTimeoutSeconds, 2]), options.updateTimeoutMs);
		checkpointMayExist = true;
		checkpoint = objectPath(created);
		await context.recordRecovery({ checkpointPath: checkpoint });
		await write(request(profilePath, `${NM}.Settings.Connection`, 'Update2', 'a{sa{sv}}ua{sv}', [updated, 1, {}]), options.updateTimeoutMs);
		const offlineDhcp = !options.requireLease && config.mode === 'dhcp';
		if (!offlineDhcp) {
			if (options.addressingChanged) {
				const activated = objectPath(await write(request(NM_PATH, NM, 'ActivateConnection', 'ooo', [profilePath, devicePath, '/']), options.activationTimeoutMs));
				const activationDeadline = deps.now() + options.activationTimeoutMs;
				while (true) {
					const properties = await all(activated, `${NM}.Connection.Active`);
					const state = value(properties, 'State', 'u');
					if (state === 2) break;
					if (state !== 1 || deps.now() >= activationDeadline) throw new Error('NetworkManager activation failed');
					await deps.sleep(Math.min(100, activationDeadline - deps.now()));
				}
			} else await write(request(devicePath, `${NM}.Device`, 'Reapply', 'a{sa{sv}}tu', [{}, 0n, 0]), options.activationTimeoutMs);
			const currentDevice = await all(devicePath, `${NM}.Device`);
			const currentActivePath = text(currentDevice, 'ActiveConnection', 'o');
			const currentActive = await all(currentActivePath, `${NM}.Connection.Active`);
			const currentDevices = value(currentActive, 'Devices', 'ao');
			if (text(currentActive, 'Uuid') !== uuid || !Array.isArray(currentDevices) || currentDevices.length !== 1 || currentDevices[0] !== devicePath || (await activeInstances(uuid, currentActivePath, currentActive)) !== 1) throw new Error('NetworkManager activated a different profile');
			if (options.addressingChanged) {
				requireBudget(options.readTimeoutMs);
				assertKernelIPv4(await deps.kernel(options.readTimeoutMs), device, config, options.requireLease);
			}
			if (config.dns?.length) {
				const liveDns: string[] = [];
				for (const family of [4, 6] as const) {
					const ipPath = text(currentDevice, `Ip${family}Config`, 'o');
					if (ipPath !== '/') liveDns.push(...parseNativeNameservers(await all(ipPath, `${NM}.IP${family}Config`), family));
				}
				if (!sameDns(liveDns, config.dns)) throw new Error('NetworkManager did not apply the requested DNS servers');
			}
		}
		const saved = await settings(profilePath);
		if (text(saved['connection']!, 'uuid') !== uuid) throw new Error('NetworkManager profile identity changed');
		assertNativeIPv4Settings(saved, config, device, options.addressingChanged);
		await write(request(NM_PATH, NM, 'CheckpointDestroy', 'o', [checkpoint]), options.updateTimeoutMs);
		checkpointMayExist = false;
	} catch (error) {
		if (unknown) throw error;
		if (checkpointMayExist) {
			if (!checkpoint || available() < options.rollbackTimeoutMs + options.checkpointSafetyMs) return await context.pending(endpoint!.rule);
			const rollbackDeadline = deps.now() + options.rollbackTimeoutMs;
			try {
				const reply = await write(request(NM_PATH, NM, 'CheckpointRollback', 'o', [checkpoint]), options.rollbackTimeoutMs, false);
				const result = record(reply.values[0]);
				if (reply.signature !== 'a{su}' || result[checkpointDevice!] !== 0 || Object.values(result).some(code => code !== 0)) throw new Error('NetworkManager failed to roll back the checkpoint');
			} catch (rollbackError) {
				if (unknown) throw rollbackError;
				throw new AggregateError([error, rollbackError], 'Network mutation failed and rollback also failed');
			}
			let settled = false;
			try {
				settled = await rollbackSettled(
					() => all(checkpointDevice!, `${NM}.Device`),
					path => all(path, `${NM}.Connection.Active`),
					() => deps.now(),
					ms => deps.sleep(ms),
					rollbackDeadline
				);
			} catch {
				// A failed read leaves the rollback just as unconfirmed as a timeout does.
			}
			if (!settled) return await context.pending(endpoint!.rule);
		}
		throw error;
	} finally {
		deps.close();
	}
}
