import { DBusError, type DBusReply, type DBusRequest } from './dbus.ts';
import { type BoundDBusEndpoint, type DBusEndpointRequest } from './dbus-worker.ts';
import { classifyDBusMutation, type DBusMutationMethod } from '../mutation-proof.ts';
import type { NativeMutationContext } from '../mutation-host.ts';
import { NativeWorkerChannel } from '../worker-host.ts';

type SynchronousDBusMethod = Exclude<DBusMutationMethod, 'timedated.SetNTP' | 'systemd.RestartUnit'>;
type MutationRequest = Omit<Extract<DBusRequest, { kind: 'mutation' }>, 'kind' | 'destination'>;

export class NativeDBusMutation {
	private readonly channel = new NativeWorkerChannel('mutation');

	bind(request: DBusEndpointRequest): Promise<BoundDBusEndpoint> {
		return this.channel.call({ method: 'linux.dbus.bind', args: request });
	}

	async call(context: NativeMutationContext, endpoint: BoundDBusEndpoint, method: SynchronousDBusMethod, request: MutationRequest): Promise<DBusReply> {
		const reply = await context.call(endpoint.rule, async () => {
			const reply = await this.channel.call<DBusReply>({ method: 'linux.dbus.call', args: { endpoint, request: { ...request, kind: 'mutation', destination: endpoint.rule.destination } } });
			return classifyDBusMutation(method, endpoint.rule.destination, reply).kind === 'unknown' ? { known: false } : { known: true, value: reply };
		});
		if (reply.type === 'error') throw new DBusError(reply);
		return reply;
	}

	close(): boolean {
		return this.channel.close();
	}
}
