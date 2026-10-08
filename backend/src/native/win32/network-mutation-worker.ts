import { openWmiConnection, type WmiConnection, type WmiMutationResult } from './wmi.ts';
import { writeWindowsDnsPolicy, type WindowsDnsPolicy } from './dns.ts';
import { readWindowsInterfaceIdentity, sameWindowsInterface, type WindowsInterfaceIdentity, type WindowsPolicyStore } from './network-mutation-state.ts';
import type { WmiInput } from './wmi-values.ts';

type Step = { readonly kind: 'delete'; readonly path: string; readonly store: WindowsPolicyStore } | { readonly kind: 'dhcp'; readonly path: string; readonly store: WindowsPolicyStore; readonly enabled: boolean } | { readonly kind: 'address'; readonly address: string; readonly prefixLength: number } | { readonly kind: 'route'; readonly gateway: string; readonly metric?: number } | { readonly kind: 'dns'; readonly policy: WindowsDnsPolicy; readonly servers: readonly string[] | null };
export type WindowsIPv4Write = { readonly identity: WindowsInterfaceIdentity; readonly step: Step };
export type WindowsIPv4WriteResult = { readonly sent: false; readonly error: string } | { readonly sent: true; readonly result: WmiMutationResult } | { readonly sent: true; readonly error: string };

/** Each worker request owns one provider write, so its return is the journal's end proof. */
export function executeWindowsIPv4Write(request: WindowsIPv4Write, connect: () => WmiConnection = openWmiConnection): WindowsIPv4WriteResult {
	let connection: WmiConnection | undefined;
	let entered = false;
	try {
		connection = connect();
		const identity = readWindowsInterfaceIdentity(connection, request.identity.guid);
		if (!sameWindowsInterface(identity, request.identity)) throw new Error('Interface identity changed before applying IPv4');
		const { step } = request;
		// CIM_UINT32 method parameters require VT_I4, including values with the high bit set.
		const parameters: Record<string, WmiInput> = { InterfaceIndex: { type: 'sint32', value: identity.index | 0 }, AddressFamily: { type: 'sint32', value: 2 } };
		entered = true;
		let result: WmiMutationResult;
		switch (step.kind) {
			case 'delete':
				result = connection.delete(step.path, { PolicyStore: step.store });
				break;
			case 'dhcp':
				result = connection.put(step.path, { Dhcp: { type: 'uint8', value: step.enabled ? 1 : 0 } }, step.store === 'ActiveStore' ? {} : { PolicyStore: step.store });
				break;
			case 'address':
				result = connection.execMethod('MSFT_NetIPAddress', 'Create', { ...parameters, IPAddress: { type: 'string', value: step.address }, PrefixLength: { type: 'uint8', value: step.prefixLength } });
				break;
			case 'route':
				result = connection.execMethod('MSFT_NetRoute', 'Create', { ...parameters, DestinationPrefix: { type: 'string', value: '0.0.0.0/0' }, NextHop: { type: 'string', value: step.gateway }, ...(step.metric === undefined ? {} : { RouteMetric: { type: 'sint32', value: step.metric | 0 } as WmiInput }) });
				break;
			case 'dns':
				result = writeWindowsDnsPolicy(connection, step.policy, step.servers);
				break;
		}
		return { sent: true, result };
	} catch (error) {
		const notSent = !entered || (error && typeof error === 'object' && 'mayHaveRun' in error && error.mayHaveRun === false);
		const message = error instanceof Error ? error.message : String(error);
		return notSent ? { sent: false, error: message } : { sent: true, error: message };
	} finally {
		connection?.close();
	}
}
