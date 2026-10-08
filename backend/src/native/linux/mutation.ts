import { DBusError, type DBusReply, type DBusRequest } from './dbus.ts';
import { type BoundDBusEndpoint, type DBusEndpointRequest } from './dbus-worker.ts';
import { classifyDBusMutation, type DBusMutationMethod, type NativeProcessObservation } from '../mutation-proof.ts';
import type { NativeMutationContext } from '../mutation-host.ts';
import { NativeWorkerChannel, type NativeWorkerRequest } from '../worker-host.ts';
import type { WifiSecretScope } from './wifi-secret-agent.ts';

type SynchronousDBusMethod = Exclude<DBusMutationMethod, 'timedated.SetNTP' | 'systemd.RestartUnit'>;
type MutationRequest = Omit<Extract<DBusRequest, { kind: 'mutation' }>, 'kind' | 'destination'>;
const retainedWifiMutations = new Set<NativeDBusMutation>();

export class NativeDBusMutation {
	private readonly channel = new NativeWorkerChannel('mutation', undefined, { onExit: () => this.releaseRetention() });
	private retainedReceiver: BoundDBusEndpoint | undefined;
	private retentionTimer: ReturnType<typeof setTimeout> | undefined;

	bind(request: DBusEndpointRequest): Promise<BoundDBusEndpoint> {
		return this.channel.call({ method: 'linux.dbus.bind', args: request });
	}

	async call(context: NativeMutationContext, endpoint: BoundDBusEndpoint, method: SynchronousDBusMethod, request: MutationRequest): Promise<DBusReply> {
		return this.invoke(context, endpoint, method, { method: 'linux.dbus.call', args: { endpoint, request: { ...request, kind: 'mutation', destination: endpoint.rule.destination } } });
	}

	provideWifiSecret(context: NativeMutationContext, endpoint: BoundDBusEndpoint, scope: WifiSecretScope): Promise<DBusReply> {
		return this.invoke(context, endpoint, 'nm', { method: 'linux.wifi.agent.provide', args: { endpoint, scope } });
	}

	releaseWifiSecret(context: NativeMutationContext, endpoint: BoundDBusEndpoint): Promise<DBusReply> {
		return this.invoke(context, endpoint, 'nm', { method: 'linux.wifi.agent.release', args: endpoint });
	}

	private async invoke(context: NativeMutationContext, endpoint: BoundDBusEndpoint, method: SynchronousDBusMethod, request: NativeWorkerRequest): Promise<DBusReply> {
		const reply = await context.call(endpoint.rule, async () => {
			const reply = await this.channel.call<DBusReply>(request);
			return classifyDBusMutation(method, endpoint.rule.destination, reply).kind === 'unknown' ? { known: false } : { known: true, value: reply };
		});
		if (reply.type === 'error') throw new DBusError(reply);
		return reply;
	}

	close(): boolean {
		const closed = this.channel.close();
		if (closed) this.releaseRetention();
		return closed;
	}

	/** An expired caller budget does not end the receiver's asynchronous authentication. */
	retainUntilReceiverEnds(endpoint: BoundDBusEndpoint): void {
		if (this.retainedReceiver) return;
		this.retainedReceiver = endpoint;
		retainedWifiMutations.add(this);
		const observe = async (): Promise<void> => {
			if (!this.retainedReceiver) return;
			try {
				const result = await this.channel.call<{ process: NativeProcessObservation }>({ method: 'identity.observe', args: this.retainedReceiver.rule.process });
				if (result.process.state === 'ended' && this.close()) return;
			} catch {
				// Failure to read identity is not proof that the receiver stopped.
			}
			if (this.retainedReceiver) this.retentionTimer = setTimeout(observe, 1000);
		};
		this.retentionTimer = setTimeout(observe, 1000);
	}

	private releaseRetention(): void {
		clearTimeout(this.retentionTimer);
		this.retentionTimer = undefined;
		this.retainedReceiver = undefined;
		retainedWifiMutations.delete(this);
	}
}
