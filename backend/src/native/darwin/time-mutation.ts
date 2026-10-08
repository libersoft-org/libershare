import type { SystemTimeChanges, SystemTimeResult } from '@shared';
import { runOperations, type OperationOutcome, type SystemOperation } from '../../system-time-common.ts';
import { requireNativeMutationContext } from '../mutation-context.ts';
import { NativeMutationUnknown, type NativeMutationContext } from '../mutation-host.ts';
import { NativeWorkerChannel, NativeWorkerFailure } from '../worker-host.ts';
import { darwinClockMatches, observeDarwinTimeRecovery, type DarwinTimeSnapshot, type DarwinTimeRecovery, type DarwinTimeSnapshotRequest } from './time-state.ts';
import { readDarwinTimeSnapshotAsync } from './time-reader.ts';
import type { DarwinClockParts } from './time-native.ts';
import type { DarwinTimeWrite, DarwinTimeWriteResult } from './time-worker.ts';

export interface DarwinTimeMutationDeps {
	readonly read: typeof readDarwinTimeSnapshotAsync;
	readonly writer: Pick<NativeWorkerChannel, 'call' | 'close'>;
}
const recoveryByContext = new WeakMap<NativeMutationContext, DarwinTimeRecovery>();
const failure = (error: unknown, changed = false): OperationOutcome => ({ kind: 'failed', code: null, output: error instanceof Error ? error.message : String(error), stateMayHaveChanged: changed, changed });

async function record(context: NativeMutationContext, patch: DarwinTimeRecovery, inCall = false): Promise<void> {
	const value = { ...recoveryByContext.get(context), ...patch };
	const metadata = { darwinTime: JSON.parse(JSON.stringify(value)) };
	if (inCall) await context.recordExecution({ kind: 'boot' }, metadata);
	else await context.recordRecovery(metadata);
	recoveryByContext.set(context, value);
}

export class DarwinTimeMutations {
	private readonly deps: DarwinTimeMutationDeps;
	constructor(deps?: DarwinTimeMutationDeps) {
		this.deps = deps ?? { read: readDarwinTimeSnapshotAsync, writer: new NativeWorkerChannel('mutation') };
	}
	private snapshot(context: NativeMutationContext, request: DarwinTimeSnapshotRequest = {}): Promise<DarwinTimeSnapshot> {
		return this.deps.read(request, Math.max(1, Math.min(15000, context.remainingMs())));
	}
	private operation(describe: string, action: (context: NativeMutationContext) => Promise<OperationOutcome>): SystemOperation {
		return {
			describe,
			run: async signal => {
				signal.throwIfAborted();
				try {
					return await action(requireNativeMutationContext());
				} catch (error) {
					if (error instanceof NativeMutationUnknown || (error instanceof NativeWorkerFailure && error.mayHaveRun)) throw error;
					return failure(error);
				}
			},
		};
	}
	private write(context: NativeMutationContext, request: DarwinTimeWrite): Promise<OperationOutcome> {
		return context.call({ kind: 'boot' }, async () => {
			const result = await this.deps.writer.call<DarwinTimeWriteResult>({ method: 'darwin.time.write', args: request });
			if (result.outcome.kind === 'unknown') return { known: false };
			if (result.clock) await record(context, { clock: result.clock }, true);
			return { known: true, value: result.outcome };
		});
	}
	clock(clock: DarwinClockParts): SystemOperation {
		return this.operation('settimeofday', async context => {
			const before = await this.snapshot(context, { clock });
			if (!before.zone || !before.targetClock?.bootId) return failure('The host clock reference is unavailable');
			await record(context, { clock: before.targetClock });
			const outcome = await this.write(context, { kind: 'clock', clock, zoneFingerprint: before.zone.fingerprint });
			if (outcome.kind !== 'ok') return outcome;
			try {
				return darwinClockMatches(recoveryByContext.get(context)!.clock!, await this.snapshot(context)) ? outcome : failure('The host clock does not match the requested time', true);
			} catch (error) {
				return failure(error, true);
			}
		});
	}
	timezone(timezone: string): SystemOperation {
		return this.operation('Update host timezone symlink', async context => {
			const before = await this.snapshot(context, { timezone });
			if (!before.targetZone) return failure('The target timezone is unavailable');
			await record(context, { timezone: { before: before.zone, target: before.targetZone } });
			const outcome = await this.write(context, { kind: 'timezone', timezone, zoneFingerprint: before.zone?.fingerprint ?? null, targetFingerprint: before.targetZone.fingerprint });
			if (outcome.kind !== 'ok') return outcome;
			try {
				return (await this.snapshot(context)).zone?.fingerprint === before.targetZone.fingerprint ? outcome : failure('The host timezone symlink does not match the requested timezone', true);
			} catch (error) {
				return failure(error, true);
			}
		});
	}
	server(server: string): SystemOperation {
		return this.operation('Update macOS NTP server', async context => {
			const before = await this.snapshot(context, { server });
			if (!before.targetNtpFingerprint) return failure('The time server file snapshot is unavailable');
			await record(context, { server: { server, beforeFingerprint: before.ntpFingerprint, targetFingerprint: before.targetNtpFingerprint } });
			const outcome = await this.write(context, { kind: 'server', server, fileFingerprint: before.ntpFingerprint, fileIdentity: before.ntpIdentity, enabled: before.ntpEnabled });
			if (outcome.kind !== 'ok') return outcome;
			try {
				const after = await this.snapshot(context);
				return after.ntpFingerprint === before.targetNtpFingerprint && after.ntpServer === server && after.ntpEnabled === before.ntpEnabled ? outcome : failure('The NTP file or synchronization state does not match the requested setting', true);
			} catch (error) {
				return failure(error, true);
			}
		});
	}
	enabled(enabled: boolean): SystemOperation {
		return this.operation(`CoreTime automatic time ${enabled}`, async context => {
			await record(context, { enabled });
			return this.write(context, { kind: 'enabled', enabled });
		});
	}
	close(): void {
		this.deps.writer.close();
	}
}

export async function runDarwinTimeOperation(select: (mutations: DarwinTimeMutations) => SystemOperation): Promise<SystemTimeResult> {
	const mutations = new DarwinTimeMutations();
	try {
		return await runOperations('darwin', [select(mutations)]);
	} finally {
		mutations.close();
	}
}

export async function observeNativeDarwinTime(original: DarwinTimeSnapshot, changes: SystemTimeChanges, recovery: DarwinTimeRecovery | undefined, timeoutMs: number): Promise<{ original: boolean; target: boolean }> {
	return observeDarwinTimeRecovery(original, changes, recovery, await readDarwinTimeSnapshotAsync({}, timeoutMs));
}
