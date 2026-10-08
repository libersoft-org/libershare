import { isUniqueDBusName, type DBusReply } from './linux/dbus.ts';
export interface NativeProcessIdentity {
	readonly pid: number;
	readonly started: string;
}

export type NativeEndRule = { readonly kind: 'executor' } | { readonly kind: 'boot' } | { readonly kind: 'helper'; readonly operationId: string; readonly requestHash: string; readonly cancelPath: string; readonly launcher: NativeProcessIdentity | null } | { readonly kind: 'dbus-process'; readonly busId: string; readonly destination: string; readonly process: NativeProcessIdentity };

export interface NativeProcessObservation {
	readonly identity: NativeProcessIdentity;
	readonly state: 'running' | 'ended' | 'unknown';
}

export interface NativeEndObservation {
	readonly bootId: string | null;
	readonly executor: NativeProcessObservation;
	readonly busId?: string;
	readonly service?: NativeProcessObservation;
	readonly helper?: { readonly operationId: string; readonly requestHash: string; readonly state: 'ended' | 'pending' | 'unknown' };
}

export interface NativePendingExecution {
	readonly bootId: string | null;
	readonly executor: NativeProcessIdentity;
	readonly executorReturned: boolean;
	readonly endRule: NativeEndRule;
}

function hasEnded(identity: NativeProcessIdentity, observation: NativeProcessObservation | undefined): boolean {
	return observation?.state === 'ended' && observation.identity.pid === identity.pid && observation.identity.started === identity.started;
}

/** Used only after an unknown result; normal completion is authenticated by the executor's response. */
export function hasNativeExecutionEnded(execution: NativePendingExecution, observation: NativeEndObservation): boolean {
	if (execution.bootId && observation.bootId && execution.bootId !== observation.bootId) return true;
	if (!execution.executorReturned && !hasEnded(execution.executor, observation.executor)) return false;
	if (execution.endRule.kind === 'executor') return true;
	if (execution.endRule.kind === 'boot') return false;
	if (execution.endRule.kind === 'helper') return observation.helper?.state === 'ended' && observation.helper.operationId === execution.endRule.operationId && observation.helper.requestHash === execution.endRule.requestHash;
	return execution.endRule.busId === observation.busId && hasEnded(execution.endRule.process, observation.service);
}

export type DBusMutationMethod = 'nm' | 'timedated.SetTime' | 'timedated.SetTimezone' | 'timedated.SetLocalRTC' | 'timedated.SetNTP' | 'systemd.RestartUnit';
export type DBusMutationReply = Pick<DBusReply, 'type' | 'sender' | 'errorName'>;

export type NativeCallDecision = { readonly kind: 'not-applied' } | { readonly kind: 'confirmed'; readonly success: boolean; readonly followUp: 'state' | 'ntp-jobs' | 'unit-job' } | { readonly kind: 'unknown'; readonly endRule: 'dbus-process' | 'boot' };

const NOT_DELIVERED = new Set(['org.freedesktop.DBus.Error.ServiceUnknown', 'org.freedesktop.DBus.Error.NameHasNoOwner']);
const BEFORE_TIMEDATED_WRITE = new Set(['org.freedesktop.DBus.Error.InvalidArgs', 'org.freedesktop.DBus.Error.InteractiveAuthorizationRequired']);

export function classifyDBusMutation(method: DBusMutationMethod, destination: string, reply: DBusMutationReply | null): NativeCallDecision {
	if (!isUniqueDBusName(destination)) throw new Error('A mutation must address a unique D-Bus name');
	const endRule = method === 'timedated.SetNTP' || method === 'systemd.RestartUnit' ? 'boot' : 'dbus-process';
	if (!reply) return { kind: 'unknown', endRule };
	if (reply.type === 'error' && reply.sender === 'org.freedesktop.DBus' && NOT_DELIVERED.has(reply.errorName ?? '')) return { kind: 'not-applied' };
	if (reply.sender !== destination) return { kind: 'unknown', endRule };
	if (reply.type === 'error') {
		if (!reply.errorName) return { kind: 'unknown', endRule };
		if (method.startsWith('timedated.') && BEFORE_TIMEDATED_WRITE.has(reply.errorName ?? '')) return { kind: 'not-applied' };
		// SetNTP can report a downstream timeout after forwarding a change to systemd.
		if (method === 'timedated.SetNTP') return { kind: 'unknown', endRule: 'boot' };
		return { kind: 'confirmed', success: false, followUp: 'state' };
	}
	return { kind: 'confirmed', success: true, followUp: method === 'timedated.SetNTP' ? 'ntp-jobs' : method === 'systemd.RestartUnit' ? 'unit-job' : 'state' };
}

export function classifyWmiMutation(hresult: number, returnValue: number | null): 'ok' | 'rejected' | 'failed' | 'unknown' {
	if (!Number.isInteger(hresult) || hresult < -0x80000000 || hresult > 0xffffffff || (returnValue !== null && (!Number.isSafeInteger(returnValue) || returnValue < 0 || returnValue > 0xffffffff))) return 'unknown';
	const code = hresult >>> 0;
	if (code === 0) return returnValue === null || returnValue === 0 ? 'ok' : 'failed';
	if (code === 0x80041008 || code === 0x80041002) return 'rejected';
	return 'unknown';
}
