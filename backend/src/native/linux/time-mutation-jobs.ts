import { SystemBus, DBusError, DBusTransportError, type DBusOptions, type DBusReply, type DBusSignal, type DBusValue } from './dbus.ts';
import { WorkerDBusConnections, type BoundDBusEndpoint, type DBusEndpointRequest } from './dbus-worker.ts';
import { nativeProcessIdentity } from '../process-identity.ts';
import { classifyDBusMutation, type NativeProcessIdentity } from '../mutation-proof.ts';
import { readNativeTimedatedEnvironment } from './time-reader.ts';
import { readNtpUnitsList } from '../../system-time-linux.ts';
import type { OperationOutcome } from '../../system-time-common.ts';

const SYSTEMD = 'org.freedesktop.systemd1';
const MANAGER = `${SYSTEMD}.Manager`;
const ROOT = '/org/freedesktop/systemd1';
const TIMEDATED = 'org.freedesktop.timedate1';
type JobBus = Pick<SystemBus, 'call' | 'close' | 'subscribe'>;
interface Provider {
	name: string;
	id: string;
	path: string | null;
	load: string;
	active: string;
}
interface RemovedJob {
	path: string;
	unit: string;
	result: string;
}

export interface NativeNtpState {
	readonly enabled: boolean | null;
	readonly selected: string | null;
	readonly providers: readonly { id: string; active: string }[];
}
export interface SetNativeNtpRequest {
	readonly timedated: BoundDBusEndpoint;
	readonly systemd: BoundDBusEndpoint;
	readonly enabled: boolean;
	readonly readTimeoutMs: number;
}
export interface RestartNativeTimeUnitRequest {
	readonly endpoint: BoundDBusEndpoint;
	readonly unit: string;
	readonly readTimeoutMs: number;
}

export function nativeNtpStateMatches(state: NativeNtpState, enabled: boolean): boolean {
	if (state.enabled !== enabled) return false;
	return enabled ? state.selected !== null && state.providers.some(unit => unit.id === state.selected && unit.active === 'active') && state.providers.every(unit => unit.id === state.selected || ['inactive', 'failed'].includes(unit.active)) : state.providers.every(unit => ['inactive', 'failed'].includes(unit.active));
}

function failed(error: unknown, changed: boolean): OperationOutcome {
	if (error instanceof DBusError && error.errorName === 'org.freedesktop.DBus.Error.InteractiveAuthorizationRequired') return { kind: 'denied', output: error.message, stateMayHaveChanged: false };
	return { kind: 'failed', code: null, output: error instanceof Error ? error.message : String(error), stateMayHaveChanged: changed };
}

/** One worker owns each bound bus, subscription and job wait until a terminal result. */
export class LinuxTimeJobWorker {
	private readonly connections: WorkerDBusConnections;
	private currentBus: JobBus | undefined;
	private readonly buses = new Map<string, JobBus>();
	private readonly providers: (timeoutMs: number) => Promise<string[] | null>;
	private readonly pause: (ms: number) => Promise<void>;
	constructor(open: (options: DBusOptions) => JobBus = options => new SystemBus(options), identity: (pid: number) => NativeProcessIdentity | null = nativeProcessIdentity, providers: (timeoutMs: number) => Promise<string[] | null> = async timeoutMs => readNtpUnitsList(await readNativeTimedatedEnvironment({ timeoutMs })), pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
		this.connections = new WorkerDBusConnections(options => {
			const bus = open(options);
			this.currentBus = bus;
			return bus;
		}, identity);
		this.providers = providers;
		this.pause = pause;
	}

	async bind(request: DBusEndpointRequest): Promise<BoundDBusEndpoint> {
		if (request.options.bus === 'user' || request.options.interactive) throw new Error('Time jobs require a non-interactive system connection');
		const endpoint = await this.connections.bind(request);
		this.buses.set(endpoint.connectionId, this.currentBus!);
		return endpoint;
	}

	private bus(endpoint: BoundDBusEndpoint): JobBus {
		const bus = this.buses.get(endpoint.connectionId);
		if (!bus) throw new DBusTransportError('The time operation connection is unavailable', 'before-send', false);
		return bus;
	}

	private async read(endpoint: BoundDBusEndpoint, path: string, iface: string, member: string, signature = '', args: DBusValue[] = [], timeoutMs = 5000): Promise<DBusReply> {
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid time job read timeout');
		const reply = await this.bus(endpoint).call({ kind: 'read', destination: endpoint.rule.destination, path, interface: iface, member, signature, args, timeoutUsec: BigInt(Math.max(1, Math.floor(timeoutMs * 1000))) });
		if (reply.sender !== endpoint.rule.destination) throw new Error('The time job read has no authenticated service response');
		if (reply.type === 'error') throw new DBusError(reply);
		return reply;
	}

	private async property(endpoint: BoundDBusEndpoint, path: string, iface: string, name: string, type: string, timeoutMs: number): Promise<DBusValue> {
		const reply = await this.read(endpoint, path, 'org.freedesktop.DBus.Properties', 'Get', 'ss', [iface, name], timeoutMs);
		const value = reply.values[0];
		if (reply.signature !== 'v' || !value || typeof value !== 'object' || !('sig' in value) || value.sig !== type || !('value' in value)) throw new Error(`Invalid time service property ${name}`);
		return value.value;
	}

	private async provider(endpoint: BoundDBusEndpoint, name: string, timeoutMs: number): Promise<Provider> {
		let loaded: DBusReply;
		try {
			loaded = await this.read(endpoint, ROOT, MANAGER, 'LoadUnit', 's', [name], timeoutMs);
		} catch (error) {
			if (error instanceof DBusError && error.errorName === `${SYSTEMD}.NoSuchUnit`) return { name, id: name, path: null, load: 'not-found', active: 'inactive' };
			throw error;
		}
		const path = loaded.values[0];
		if (loaded.signature !== 'o' || typeof path !== 'string' || !path.startsWith(`${ROOT}/unit/`)) throw new Error('Invalid time provider path');
		const [id, load, active] = await Promise.all(['Id', 'LoadState', 'ActiveState'].map(property => this.property(endpoint, path, `${SYSTEMD}.Unit`, property, 's', timeoutMs)));
		if (typeof id !== 'string' || !id || typeof load !== 'string' || typeof active !== 'string' || !active) throw new Error('Invalid time provider state');
		return { name, id, path, load, active };
	}

	private async state(timedated: BoundDBusEndpoint, systemd: BoundDBusEndpoint, names: readonly string[], timeoutMs: number): Promise<NativeNtpState> {
		const providers = await Promise.all(names.map(name => this.provider(systemd, name, timeoutMs)));
		const enabled = await this.property(timedated, '/org/freedesktop/timedate1', TIMEDATED, 'NTP', 'b', timeoutMs);
		return { enabled: typeof enabled === 'boolean' ? enabled : null, selected: providers.find(unit => unit.load === 'loaded')?.id ?? null, providers: providers.map(({ id, active }) => ({ id, active })) };
	}

	async readNtpState(timeoutMs: number): Promise<NativeNtpState> {
		const options = { bus: 'system' as const };
		const timedated = await this.bind({ options, destination: TIMEDATED, path: '/org/freedesktop/timedate1', interface: TIMEDATED, timeoutMs });
		const systemd = await this.bind({ options, destination: SYSTEMD, path: ROOT, interface: MANAGER, timeoutMs });
		const names = await this.providers(timeoutMs);
		if (names === null) throw new Error('NTP provider ordering is unknown');
		return this.state(timedated, systemd, names, timeoutMs);
	}

	async setNtp(request: SetNativeNtpRequest): Promise<OperationOutcome> {
		let dispatched = false;
		let answered = false;
		let ended = false;
		try {
			const names = await this.providers(request.readTimeoutMs);
			if (names === null || !names.length) return { kind: 'failed', code: null, output: 'The NTP provider list is unavailable', stateMayHaveChanged: false };
			const before = await Promise.all(names.map(name => this.provider(request.systemd, name, request.readTimeoutMs)));
			dispatched = true;
			const reply = await this.connections.call(request.timedated, { kind: 'mutation', destination: request.timedated.rule.destination, path: '/org/freedesktop/timedate1', interface: TIMEDATED, member: 'SetNTP', signature: 'bb', args: [request.enabled, false] });
			answered = true;
			const decision = classifyDBusMutation('timedated.SetNTP', request.timedated.rule.destination, reply);
			if (decision.kind === 'unknown') return { kind: 'unknown', endRule: { kind: 'boot' }, output: reply.errorMessage ?? 'The NTP result is unknown' };
			if (reply.type === 'error') return failed(new DBusError(reply), false);
			const after = await Promise.all(names.map(name => this.provider(request.systemd, name, request.readTimeoutMs)));
			const providerIds = new Set([...before, ...after].flatMap(unit => [unit.name, unit.id]));
			while (true) {
				const jobs = await this.read(request.systemd, ROOT, MANAGER, 'ListJobs', '', [], request.readTimeoutMs);
				const rows = jobs.values[0];
				if (jobs.signature !== 'a(usssoo)' || !Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== 6 || typeof row[1] !== 'string')) throw new Error('Invalid systemd job list');
				if (!rows.some(row => providerIds.has((row as DBusValue[])[1] as string))) break;
				await this.pause(100);
			}
			ended = true;
			const state = await this.state(request.timedated, request.systemd, names, request.readTimeoutMs);
			return nativeNtpStateMatches(state, request.enabled) ? { kind: 'ok', output: '' } : { kind: 'failed', code: null, output: 'The NTP provider jobs ended, but the requested service state was not reached', stateMayHaveChanged: true };
		} catch (error) {
			if (!dispatched || ended || (!answered && error instanceof DBusTransportError && !error.mayHaveBeenSent)) return failed(error, ended);
			return { kind: 'unknown', endRule: { kind: 'boot' }, output: 'The NTP operation may still have work in systemd' };
		}
	}

	async restart(request: RestartNativeTimeUnitRequest): Promise<OperationOutcome> {
		if (request.unit !== 'systemd-timesyncd.service') return { kind: 'failed', code: null, output: 'Unsupported time service unit', stateMayHaveChanged: false };
		let dispatched = false;
		let answered = false;
		let ended = false;
		let subscription: ReturnType<JobBus['subscribe']> | undefined;
		let signalError: Error | undefined;
		let jobPath: string | undefined;
		const removed = new Map<string, RemovedJob>();
		let wake: (() => void) | undefined;
		try {
			const provider = await this.provider(request.endpoint, request.unit, request.readTimeoutMs);
			if (!provider.path || provider.load !== 'loaded') return { kind: 'missing' };
			const onSignal = (signal: DBusSignal): void => {
				if (signal.sender !== request.endpoint.rule.destination || signal.signature !== 'uoss') throw new Error('Unauthenticated systemd job signal');
				const [, path, unit, result] = signal.values;
				if (typeof path !== 'string' || typeof unit !== 'string' || typeof result !== 'string') throw new Error('Invalid systemd job signal');
				if (jobPath && path !== jobPath) return;
				if (removed.size >= 1024) throw new Error('Too many early systemd job signals');
				removed.set(path, { path, unit, result });
				wake?.();
			};
			subscription = this.bus(request.endpoint).subscribe({ sender: request.endpoint.rule.destination, path: ROOT, interface: MANAGER, member: 'JobRemoved' }, onSignal, error => {
				signalError = error;
				wake?.();
			});
			await this.read(request.endpoint, ROOT, MANAGER, 'Subscribe', '', [], request.readTimeoutMs);
			dispatched = true;
			const reply = await this.connections.call(request.endpoint, { kind: 'mutation', destination: request.endpoint.rule.destination, path: ROOT, interface: MANAGER, member: 'RestartUnit', signature: 'ss', args: [request.unit, 'replace'] });
			answered = true;
			const decision = classifyDBusMutation('systemd.RestartUnit', request.endpoint.rule.destination, reply);
			if (decision.kind === 'unknown') return { kind: 'unknown', endRule: { kind: 'boot' }, output: 'The restart request has no confirmed answer' };
			if (reply.type === 'error') return failed(new DBusError(reply), decision.kind !== 'not-applied');
			const path = reply.values[0];
			if (reply.signature !== 'o' || typeof path !== 'string' || !/^\/org\/freedesktop\/systemd1\/job\/\d+$/.test(path)) throw new Error('Invalid restart job path');
			jobPath = path;
			while (!removed.has(jobPath)) {
				if (signalError) throw signalError;
				await new Promise<void>(resolve => {
					wake = resolve;
				});
				wake = undefined;
			}
			const job = removed.get(jobPath)!;
			if (job.unit !== provider.id) throw new Error('The restart job belongs to another unit');
			ended = true;
			if (job.result !== 'done') return { kind: 'failed', code: null, output: `The time service restart ended with ${job.result}`, stateMayHaveChanged: true };
			const [active, result] = await Promise.all([this.property(request.endpoint, provider.path, `${SYSTEMD}.Unit`, 'ActiveState', 's', request.readTimeoutMs), this.property(request.endpoint, provider.path, `${SYSTEMD}.Service`, 'Result', 's', request.readTimeoutMs)]);
			return active === 'active' && result === 'success' ? { kind: 'ok', output: '' } : { kind: 'failed', code: null, output: 'The restart job completed but the time service is not healthy', stateMayHaveChanged: true };
		} catch (error) {
			if (!dispatched || ended || (!answered && error instanceof DBusTransportError && !error.mayHaveBeenSent)) return failed(error, ended);
			return { kind: 'unknown', endRule: { kind: 'boot' }, output: 'The time service restart may still be running' };
		} finally {
			subscription?.close();
		}
	}

	close(): void {
		this.connections.close();
		this.buses.clear();
	}
}
