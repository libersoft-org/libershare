import { DBusError, DBusTransportError, SystemBus, isUniqueDBusName, type DBusOptions, type DBusReply, type DBusRequest } from './dbus.ts';
import { nativeProcessIdentity } from '../process-identity.ts';
import type { NativeEndRule, NativeProcessIdentity } from '../mutation-proof.ts';
import { classifyDBusMutation } from '../mutation-proof.ts';
import { WifiSecretAgent, type WifiSecretScope } from './wifi-secret-agent.ts';

export interface BoundDBusEndpoint {
	readonly connectionId: string;
	readonly rule: Extract<NativeEndRule, { kind: 'dbus-process' }>;
}

export interface DBusEndpointRequest {
	readonly options: DBusOptions;
	readonly destination: string;
	readonly path: string;
	readonly interface: string;
	readonly timeoutMs: number;
}

type Bus = Pick<SystemBus, 'call' | 'close'> & Partial<Pick<SystemBus, 'exportObject'>>;
interface Connection {
	readonly bus: Bus;
	readonly id: string;
	agent?: WifiSecretAgent;
}

export class WorkerDBusConnections {
	private readonly connections = new Map<string, Connection>();
	private readonly open: (options: DBusOptions) => Bus;
	private readonly identity: (pid: number) => NativeProcessIdentity | null;
	constructor(open: (options: DBusOptions) => Bus = options => new SystemBus(options), identity: (pid: number) => NativeProcessIdentity | null = nativeProcessIdentity) {
		this.open = open;
		this.identity = identity;
	}

	private connection(options: DBusOptions): Connection {
		const key = `${options.bus ?? 'system'}:${options.interactive ?? false}`;
		let connection = this.connections.get(key);
		if (!connection) {
			connection = { bus: this.open(options), id: crypto.randomUUID() };
			this.connections.set(key, connection);
		}
		return connection;
	}

	private async send(connection: Connection, request: DBusRequest): Promise<DBusReply> {
		try {
			return await connection.bus.call(request);
		} catch (error) {
			if (error instanceof DBusTransportError) {
				connection.agent?.close();
				connection.bus.close();
				for (const [key, value] of this.connections) if (value === connection) this.connections.delete(key);
			}
			throw error;
		}
	}

	read(options: DBusOptions, request: DBusRequest): Promise<DBusReply> {
		if (request.kind !== 'read') throw new DBusTransportError('Unbound mutation is forbidden', 'before-send', false);
		return this.send(this.connection(options), request);
	}

	async bind(request: DBusEndpointRequest): Promise<BoundDBusEndpoint> {
		if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw new DBusTransportError('Endpoint read budget expired', 'before-send', false);
		const deadline = performance.now() + request.timeoutMs;
		const connection = this.connection(request.options);
		const call = async (destination: string, path: string, iface: string, member: string, signature = '', args: string[] = []): Promise<DBusReply> => {
			const remaining = deadline - performance.now();
			if (remaining <= 0) throw new DBusTransportError('Endpoint read budget expired', 'before-send', false);
			const reply = await this.send(connection, { kind: 'read', destination, path, interface: iface, member, signature, args, timeoutUsec: BigInt(Math.max(1, Math.floor(remaining * 1000))) });
			if (reply.type === 'error') throw new DBusError(reply);
			return reply;
		};
		await call(request.destination, request.path, 'org.freedesktop.DBus.Properties', 'GetAll', 's', [request.interface]);
		const busPath = '/org/freedesktop/DBus';
		const busName = 'org.freedesktop.DBus';
		const owner = await call(busName, busPath, busName, 'GetNameOwner', 's', [request.destination]);
		const destination = owner.values[0];
		if (owner.signature !== 's' || !isUniqueDBusName(destination)) throw new Error('Invalid D-Bus owner');
		const busId = await call(busName, busPath, busName, 'GetId');
		if (busId.signature !== 's' || typeof busId.values[0] !== 'string' || !/^[a-f0-9]{32}$/i.test(busId.values[0])) throw new Error('Invalid D-Bus identity');
		const pid = await call(busName, busPath, busName, 'GetConnectionUnixProcessID', 's', [destination]);
		if (pid.signature !== 'u' || typeof pid.values[0] !== 'number') throw new Error('Invalid D-Bus process identity');
		const process = this.identity(pid.values[0]);
		if (!process) throw new Error('Cannot establish D-Bus receiver identity');
		return { connectionId: connection.id, rule: { kind: 'dbus-process', busId: busId.values[0], destination, process } };
	}

	async call(endpoint: BoundDBusEndpoint, request: DBusRequest): Promise<DBusReply> {
		const connection = [...this.connections.values()].find(value => value.id === endpoint.connectionId);
		if (!connection || request.kind !== 'mutation' || request.destination !== endpoint.rule.destination) throw new DBusTransportError('Bound D-Bus connection is no longer available', 'before-send', false);
		return this.send(connection, request);
	}

	async provideWifiSecret(endpoint: BoundDBusEndpoint, scope: WifiSecretScope): Promise<DBusReply> {
		const connection = [...this.connections.values()].find(value => value.id === endpoint.connectionId);
		if (!connection?.bus.exportObject || connection.agent) throw new DBusTransportError('The bound Wi-Fi agent connection is unavailable', 'before-send', false);
		const agent = new WifiSecretAgent({ call: request => this.send(connection, request), exportObject: connection.bus.exportObject.bind(connection.bus) }, endpoint.rule.destination, scope);
		connection.agent = agent;
		const reply = await agent.register();
		if (classifyDBusMutation('nm', endpoint.rule.destination, reply).kind !== 'unknown' && reply.type === 'error') {
			agent.close();
			delete connection.agent;
		}
		return reply;
	}

	async releaseWifiSecret(endpoint: BoundDBusEndpoint): Promise<DBusReply> {
		const connection = [...this.connections.values()].find(value => value.id === endpoint.connectionId);
		if (!connection?.agent) throw new DBusTransportError('The bound Wi-Fi agent is unavailable', 'before-send', false);
		const reply = await connection.agent.unregister();
		if (classifyDBusMutation('nm', endpoint.rule.destination, reply).kind !== 'unknown') {
			connection.agent.close();
			delete connection.agent;
		}
		return reply;
	}

	close(): void {
		for (const { bus, agent } of this.connections.values()) {
			agent?.close();
			bus.close();
		}
		this.connections.clear();
	}
}
