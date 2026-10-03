import { createHelperCancellation, helperCancellationExists, HelperResultStore, type HelperResultRecord } from './helper-results-store.ts';
import { getNativeBootId, observeNativeProcess } from './process-identity.ts';
import { hasNativeExecutionEnded, type NativeProcessIdentity, type NativeProcessObservation } from './mutation-proof.ts';
import { NativeWorkerChannel } from './worker-host.ts';
import type { DBusReply } from './linux/dbus.ts';

export { HelperResultStore, helperRequestHash, helperResultsDirectory, createHelperCancellation } from './helper-results-store.ts';
export type { HelperResultRecord } from './helper-results-store.ts';

export interface HelperOperationRule {
	readonly kind: 'helper';
	readonly operationId: string;
	readonly requestHash: string;
	readonly cancelPath: string;
	readonly launcher: NativeProcessIdentity | null;
}
export interface HelperOperationObservation {
	readonly operationId: string;
	readonly requestHash: string;
	readonly state: 'ended' | 'pending' | 'unknown';
}
export interface HelperObservationDeps {
	readonly read: (operationId: string) => Promise<HelperResultRecord | null>;
	readonly cancel: (path: string) => Promise<void>;
	readonly bootId: () => string | null;
	readonly process: (identity: NativeProcessIdentity) => NativeProcessObservation;
	readonly busId: () => Promise<string | null>;
	readonly cancelled?: (path: string) => Promise<boolean>;
}

async function currentBusId(): Promise<string | null> {
	const reader = new NativeWorkerChannel('read');
	try {
		const reply = await reader.call<DBusReply>({ method: 'linux.dbus', args: { options: { bus: 'system' }, request: { kind: 'read', destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'GetId', timeoutUsec: 3000000n } } }, 4000);
		return reply.type === 'method_return' && reply.signature === 's' && typeof reply.values[0] === 'string' ? reply.values[0] : null;
	} catch {
		return null;
	} finally {
		reader.close();
	}
}

export function nativeHelperObservationDeps(): HelperObservationDeps {
	const store = new HelperResultStore();
	return { read: id => store.read(id), cancel: createHelperCancellation, bootId: getNativeBootId, process: observeNativeProcess, busId: currentBusId, cancelled: helperCancellationExists };
}

export async function readTrustedHelperResult(rule: Pick<HelperOperationRule, 'operationId' | 'requestHash'> & { readonly expectedBootId?: string | null }, store: HelperResultStore = new HelperResultStore()): Promise<HelperResultRecord | null> {
	const record = await store.read(rule.operationId);
	if (!record) return null;
	const bootId = rule.expectedBootId === undefined ? getNativeBootId() : rule.expectedBootId;
	if (!bootId || record.bootId !== bootId || record.operationId !== rule.operationId || record.requestHash !== rule.requestHash) throw new Error('Helper result does not match this operation and boot');
	return record;
}

export async function helperRecordHasEnded(record: HelperResultRecord, deps: HelperObservationDeps): Promise<boolean> {
	const bootId = deps.bootId();
	if (record.bootId && bootId && record.bootId !== bootId) return true;
	if (record.phase === 'cancelled' || (record.phase === 'finished' && record.result?.outcome === 'known')) return true;
	const identity = { pid: record.pid, started: record.processStart };
	const executor = deps.process(identity);
	if (record.phase === 'started' && executor.state !== 'ended') return false;
	const base = { bootId, executor };
	if (record.endRule.kind === 'dbus-process') {
		const busId = await deps.busId();
		return busId !== null && hasNativeExecutionEnded({ ...record, executor: identity }, { ...base, busId, service: deps.process(record.endRule.process) });
	}
	return hasNativeExecutionEnded({ ...record, executor: identity }, base);
}

export async function observeHelperOperation(rule: HelperOperationRule, supplied?: HelperObservationDeps): Promise<HelperOperationObservation> {
	const result = (state: HelperOperationObservation['state']): HelperOperationObservation => ({ operationId: rule.operationId, requestHash: rule.requestHash, state });
	try {
		const deps = supplied ?? nativeHelperObservationDeps();
		const launcher = rule.launcher ? deps.process(rule.launcher).state : 'ended';
		// Cancellation must be durable before looking for started, including after a backend crash.
		let cancelled = false;
		if (launcher === 'ended') {
			await deps.cancel(rule.cancelPath);
			cancelled = true;
		} else cancelled = (await deps.cancelled?.(rule.cancelPath)) ?? false;
		const record = await deps.read(rule.operationId);
		if (!record) return result(cancelled ? 'ended' : launcher === 'running' ? 'pending' : 'unknown');
		const bootId = deps.bootId();
		if (!bootId || record.bootId !== bootId || record.operationId !== rule.operationId || record.requestHash !== rule.requestHash) return result('unknown');
		return result((await helperRecordHasEnded(record, deps)) ? 'ended' : 'pending');
	} catch {
		return result('unknown');
	}
}
