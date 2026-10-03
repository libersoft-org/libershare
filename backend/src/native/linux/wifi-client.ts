import { DBusError, DBusTransportError, type DBusReply, type DBusRequest } from './dbus.ts';
import type { BoundDBusEndpoint, DBusEndpointRequest } from './dbus-worker.ts';
import { NativeDBusMutation } from './mutation.ts';
import { NativeMutationStopped, type NativeMutationContext } from '../mutation-host.ts';
import { NativeWorkerChannel, NativeWorkerFailure } from '../worker-host.ts';
import type { NativeNetworkSettings } from './network-mutation.ts';
import type { LinuxNetlinkState } from './netlink.ts';
import type { Nl80211Link } from './nl80211.ts';
import { wifiDictionary, wifiNumber, wifiPaths, wifiString, type WifiProperties } from './wifi-settings.ts';

export const WIFI_NM: string = 'org.freedesktop.NetworkManager';
export const WIFI_NM_PATH: string = '/org/freedesktop/NetworkManager';
export type WifiCall = Omit<Extract<DBusRequest, { kind: 'mutation' }>, 'kind' | 'destination'>;
export interface WifiMutationOptions {
	readonly readTimeoutMs: number;
	readonly scanTimeoutMs: number;
	readonly updateTimeoutMs: number;
	readonly activationTimeoutMs: number;
	readonly rollbackTimeoutMs: number;
	readonly checkpointSafetyMs: number;
	readonly checkpointTimeoutSeconds: number;
}
export interface WifiMutationDeps {
	readonly bind: (request: DBusEndpointRequest) => Promise<BoundDBusEndpoint>;
	readonly read: (endpoint: BoundDBusEndpoint, request: WifiCall, timeoutMs: number) => Promise<DBusReply>;
	readonly mutate: (context: NativeMutationContext, endpoint: BoundDBusEndpoint, request: WifiCall) => Promise<DBusReply>;
	readonly scan: (device: string, timeoutMs: number) => Promise<unknown>;
	readonly link: (device: string, timeoutMs: number) => Promise<Nl80211Link>;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly close: () => void;
}

function nativeDeps(): WifiMutationDeps {
	const mutation = new NativeDBusMutation(),
		reader = new NativeWorkerChannel('read');
	return {
		bind: request => mutation.bind(request),
		read: (endpoint, request, timeoutMs) => reader.call({ method: 'linux.dbus', args: { options: { bus: 'system' }, request: { ...request, kind: 'read', destination: endpoint.rule.destination, timeoutUsec: BigInt(Math.max(1, Math.floor(timeoutMs * 1000))) } } }, timeoutMs),
		mutate: (context, endpoint, request) => mutation.call(context, endpoint, 'nm', request),
		scan: (device, timeoutMs) => reader.call({ method: 'linux.network.scan', args: { device, timeoutMs } }, timeoutMs),
		link: async (device, timeoutMs) => {
			const deadline = performance.now() + timeoutMs;
			const kernel = await reader.call<LinuxNetlinkState>({ method: 'linux.netlink', args: { timeoutMs } }, timeoutMs);
			const index = kernel.links.find(link => link.ifname === device)?.ifindex;
			if (index === undefined) throw new Error('Wireless interface disappeared');
			const remaining = deadline - performance.now();
			if (remaining <= 0) throw new Error('Wireless association read timed out');
			return reader.call({ method: 'linux.wifi.link', args: { index, timeoutMs: remaining } }, remaining);
		},
		now: () => performance.now(),
		sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
		close: () => {
			reader.close();
			mutation.close();
		},
	};
}

export function wifiCall(path: string, iface: string, member: string, signature = '', args: NonNullable<WifiCall['args']> = []): WifiCall {
	return { path, interface: iface, member, signature, args };
}

export function wifiObjectPath(value: unknown): string {
	if (typeof value !== 'string' || !/^\/org\/freedesktop\/NetworkManager\/[A-Za-z0-9_/]+$/.test(value)) throw new Error('Invalid NetworkManager object path');
	return value;
}

/** Each mutation needs the durable context; a context-free session only permits reads. */
export class WifiSession {
	readonly options: WifiMutationOptions;
	readonly deps: WifiMutationDeps;
	readonly context: NativeMutationContext | undefined;
	endpoint: BoundDBusEndpoint | undefined;
	checkpointPath: string | null = null;
	unknown = false;
	compensationReserveMs = 0;
	private checkpointDeadline = Infinity;
	private readonly readDeadline: number;
	constructor(options: WifiMutationOptions, context?: NativeMutationContext, deps: WifiMutationDeps = nativeDeps()) {
		this.options = options;
		this.context = context;
		this.deps = deps;
		this.readDeadline = deps.now() + options.readTimeoutMs;
	}
	remainingMs(): number {
		return Math.min(this.context?.remainingMs() ?? this.readDeadline - this.deps.now(), this.checkpointDeadline - this.deps.now());
	}
	ensureBudget(step: number, reserve: boolean = this.checkpointPath !== null): void {
		if (this.remainingMs() < step + (reserve ? this.options.rollbackTimeoutMs + this.options.checkpointSafetyMs + this.compensationReserveMs : 0)) throw new NativeMutationStopped();
	}
	async bind(): Promise<void> {
		const timeoutMs = Math.min(this.options.readTimeoutMs, this.remainingMs());
		if (timeoutMs <= 0) throw new NativeMutationStopped();
		this.endpoint = await this.deps.bind({ options: { bus: 'system' }, destination: WIFI_NM, path: WIFI_NM_PATH, interface: WIFI_NM, timeoutMs });
	}
	async read(request: WifiCall): Promise<DBusReply> {
		if (this.checkpointPath) this.ensureBudget(this.options.readTimeoutMs);
		const timeout = Math.min(this.options.readTimeoutMs, this.remainingMs());
		if (timeout <= 0) throw new NativeMutationStopped();
		const reply = await this.deps.read(this.endpoint!, request, timeout);
		if (reply.type === 'error') throw new DBusError(reply);
		if (reply.sender !== this.endpoint!.rule.destination) throw new Error('NetworkManager reply owner changed');
		return reply;
	}
	async all(path: string, iface: string): Promise<WifiProperties> {
		const reply = await this.read(wifiCall(path, 'org.freedesktop.DBus.Properties', 'GetAll', 's', [iface]));
		if (reply.signature !== 'a{sv}' || reply.values.length !== 1) throw new Error('Invalid NetworkManager properties');
		return wifiDictionary(reply.values[0]) as WifiProperties;
	}
	async settings(path: string): Promise<NativeNetworkSettings> {
		const reply = await this.read(wifiCall(path, `${WIFI_NM}.Settings.Connection`, 'GetSettings'));
		if (reply.signature !== 'a{sa{sv}}' || reply.values.length !== 1) throw new Error('Invalid NetworkManager settings');
		return wifiDictionary(reply.values[0]) as NativeNetworkSettings;
	}
	async profileByUuid(uuid: string): Promise<string | null> {
		try {
			const reply = await this.read(wifiCall(`${WIFI_NM_PATH}/Settings`, `${WIFI_NM}.Settings`, 'GetConnectionByUuid', 's', [uuid]));
			if (reply.signature !== 'o') throw new Error('Invalid profile UUID lookup');
			return wifiObjectPath(reply.values[0]);
		} catch (error) {
			if (error instanceof DBusError && error.reply.sender === this.endpoint!.rule.destination && error.errorName === `${WIFI_NM}.Settings.InvalidConnection`) return null;
			throw error;
		}
	}
	async write(request: WifiCall, budgetMs: number, reserve = true): Promise<DBusReply> {
		if (!this.context) throw new Error('Wi-Fi mutation requires durable ownership');
		if (this.unknown) return this.context.pending(this.endpoint!.rule);
		this.ensureBudget(budgetMs, reserve);
		try {
			return await this.deps.mutate(this.context, this.endpoint!, request);
		} catch (error) {
			this.unknown = !(error instanceof DBusError || error instanceof NativeMutationStopped || (error instanceof DBusTransportError && !error.mayHaveBeenSent) || (error instanceof NativeWorkerFailure && !error.mayHaveRun));
			throw error;
		}
	}
	async checkpoint(devicePath: string): Promise<void> {
		this.checkpointDeadline = this.deps.now() + this.options.checkpointTimeoutSeconds * 1000;
		const reply = await this.write(wifiCall(WIFI_NM_PATH, WIFI_NM, 'CheckpointCreate', 'aouu', [[devicePath], this.options.checkpointTimeoutSeconds, 2]), this.options.updateTimeoutMs);
		try {
			if (reply.signature !== 'o') throw new Error('Invalid checkpoint reply');
			this.checkpointPath = wifiObjectPath(reply.values[0]);
		} catch {
			await this.context!.pending(this.endpoint!.rule);
		}
	}
	async finish(): Promise<void> {
		await this.write(wifiCall(WIFI_NM_PATH, WIFI_NM, 'CheckpointDestroy', 'o', [this.checkpointPath!]), this.options.updateTimeoutMs);
		this.checkpointPath = null;
	}
	async rollback(devicePath: string): Promise<void> {
		const reply = await this.write(wifiCall(WIFI_NM_PATH, WIFI_NM, 'CheckpointRollback', 'o', [this.checkpointPath!]), this.options.rollbackTimeoutMs, false);
		const results = wifiDictionary(reply.values[0]);
		if (reply.signature !== 'a{su}' || results[devicePath] !== 0 || Object.values(results).some(result => result !== 0)) throw new Error('NetworkManager failed to roll back Wi-Fi');
		this.checkpointPath = null;
	}
	async waitActive(activePath: string, profilePath: string, uuid: string, devicePath: string, deadline: number): Promise<void> {
		while (true) {
			const active = await this.all(activePath, `${WIFI_NM}.Connection.Active`);
			const state = wifiNumber(active, 'State');
			if (state === 2) {
				if (wifiString(active, 'Uuid') !== uuid || wifiString(active, 'Connection', 'o') !== profilePath || !wifiPaths(active, 'Devices').includes(devicePath) || wifiString(await this.all(devicePath, `${WIFI_NM}.Device`), 'ActiveConnection', 'o') !== activePath) throw new Error('NetworkManager activated a different Wi-Fi profile');
				return;
			}
			if (state !== 1 || this.deps.now() >= deadline) throw new Error('Wi-Fi activation failed');
			await this.deps.sleep(Math.min(100, deadline - this.deps.now()));
		}
	}
	async link(device: string): Promise<Nl80211Link> {
		if (this.checkpointPath) this.ensureBudget(this.options.readTimeoutMs);
		const timeout = Math.min(this.options.readTimeoutMs, this.remainingMs());
		if (timeout <= 0) throw new NativeMutationStopped();
		return this.deps.link(device, timeout);
	}
	close(): void {
		this.deps.close();
	}
}
