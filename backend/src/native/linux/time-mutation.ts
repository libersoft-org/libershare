import { NativeDBusMutation } from './mutation.ts';
import { DBusError, DBusTransportError } from './dbus.ts';
import { NativeWorkerChannel, NativeWorkerFailure } from '../worker-host.ts';
import { NativeMutationUnknown, type NativeMutationContext } from '../mutation-host.ts';
import { requireNativeMutationContext } from '../mutation-context.ts';
import { recordLinuxTimeRecovery, sameTimezoneSource, type LinuxTimeSnapshot, type LinuxTimeSnapshotRequest } from './time-mutation-state.ts';
import type { BoundDBusEndpoint, DBusEndpointRequest } from './dbus-worker.ts';
import { runOperations, type OperationOutcome, type SystemOperation } from '../../system-time-common.ts';
import type { SystemTimeResult } from '../../../../shared/src/index.ts';

const TIMEDATED = 'org.freedesktop.timedate1';
const SYSTEMD = 'org.freedesktop.systemd1';
const CLOCK_TOLERANCE_MS = 2000;
const reader = new NativeWorkerChannel('read');

export interface LinuxTimeMutationDeps {
	readonly synchronous: Pick<NativeDBusMutation, 'bind' | 'call' | 'close'>;
	readonly reader: Pick<NativeWorkerChannel, 'call' | 'close'>;
	readonly jobs: Pick<NativeWorkerChannel, 'call' | 'close'>;
	readonly now: () => number;
	readonly pause: (ms: number) => Promise<void>;
}

function unknownWrite(error: unknown): boolean {
	return error instanceof NativeMutationUnknown || (error instanceof NativeWorkerFailure && error.mayHaveRun) || (error instanceof DBusTransportError && error.mayHaveBeenSent);
}

function failure(error: unknown, changed: boolean): OperationOutcome {
	const output = error instanceof Error ? error.message : String(error);
	if (error instanceof Error && error.name === 'NativeLibraryUnavailable') return { kind: 'missing' };
	if (error instanceof DBusError) {
		if (error.reply.sender === 'org.freedesktop.DBus' && ['org.freedesktop.DBus.Error.ServiceUnknown', 'org.freedesktop.DBus.Error.NameHasNoOwner'].includes(error.errorName)) return { kind: 'failed', code: null, output, stateMayHaveChanged: false };
		if (error.errorName === 'org.freedesktop.DBus.Error.InteractiveAuthorizationRequired') return { kind: 'denied', output, stateMayHaveChanged: false };
		if (error.errorName === 'org.freedesktop.DBus.Error.InvalidArgs') return { kind: 'failed', code: null, output, outcome: 'invalid-input', stateMayHaveChanged: false };
		if (error.errorName === 'org.freedesktop.DBus.Error.AccessDenied') return { kind: 'denied', output, stateMayHaveChanged: changed };
		if (error.errorName === `${TIMEDATED}.AutomaticTimeSyncEnabled`) return { kind: 'failed', code: null, output, outcome: 'auto-sync-enabled', stateMayHaveChanged: changed };
	}
	return { kind: 'failed', code: null, output, stateMayHaveChanged: changed };
}

export class LinuxTimeMutations {
	private readonly deps: LinuxTimeMutationDeps;
	constructor(deps?: LinuxTimeMutationDeps) {
		this.deps = deps ?? { synchronous: new NativeDBusMutation(), reader, jobs: new NativeWorkerChannel('mutation'), now: () => performance.now(), pause: ms => new Promise(resolve => setTimeout(resolve, ms)) };
	}

	private timeout(context: NativeMutationContext): number {
		return Math.max(1, Math.min(5000, context.remainingMs()));
	}
	private snapshot(context: NativeMutationContext, request: LinuxTimeSnapshotRequest = {}): Promise<LinuxTimeSnapshot> {
		return this.deps.reader.call({ method: 'linux.time.snapshot', args: request }, this.timeout(context));
	}
	private endpoint(destination: typeof TIMEDATED | typeof SYSTEMD, timeoutMs: number): DBusEndpointRequest {
		return { options: { bus: 'system' }, destination, path: destination === TIMEDATED ? '/org/freedesktop/timedate1' : '/org/freedesktop/systemd1', interface: destination === TIMEDATED ? TIMEDATED : `${SYSTEMD}.Manager`, timeoutMs };
	}

	clock(clock: NonNullable<LinuxTimeSnapshotRequest['clock']>): SystemOperation {
		return {
			describe: `timedate1.SetTime ${clock.hours}:${clock.minutes}:${clock.seconds}`,
			run: async signal => {
				const context = requireNativeMutationContext();
				let endpoint: BoundDBusEndpoint;
				try {
					signal.throwIfAborted();
					endpoint = await this.deps.synchronous.bind(this.endpoint(TIMEDATED, this.timeout(context)));
				} catch (error) {
					return failure(error, false);
				}
				const retryDeadline = this.deps.now() + 5000;
				while (true) {
					let before: LinuxTimeSnapshot;
					try {
						before = await this.snapshot(context, { clock });
						if (!Number.isFinite(before.targetUtcMs)) throw new Error('The host clock target is unavailable');
						await recordLinuxTimeRecovery(context, { clock: { targetUtcMs: before.targetUtcMs!, hostUptimeMs: before.hostUptimeMs, bootId: before.bootId }, endpoints: { timedated: endpoint.rule } });
					} catch (error) {
						return failure(error, false);
					}
					try {
						await this.deps.synchronous.call(context, endpoint, 'timedated.SetTime', { path: '/org/freedesktop/timedate1', interface: TIMEDATED, member: 'SetTime', signature: 'xbb', args: [BigInt(before.targetUtcMs!) * 1000n, false, false] });
					} catch (error) {
						if (unknownWrite(error)) throw error;
						const notStarted = error instanceof DBusError && error.reply.sender === endpoint.rule.destination && error.errorName === `${TIMEDATED}.AutomaticTimeSyncEnabled` && error.reply.errorMessage?.startsWith('Previous request is not finished');
						if (notStarted && this.deps.now() < retryDeadline && context.remainingMs() > 100) {
							await this.deps.pause(100);
							continue;
						}
						const unsent = (error instanceof DBusTransportError && !error.mayHaveBeenSent) || (error instanceof NativeWorkerFailure && !error.mayHaveRun);
						return failure(error, !notStarted && !unsent);
					}
					try {
						const after = await this.snapshot(context);
						const expected = before.targetUtcMs! + after.hostUptimeMs - before.hostUptimeMs;
						if (!before.bootId || after.bootId !== before.bootId || Math.abs(after.utcMs - expected) > CLOCK_TOLERANCE_MS) return { kind: 'failed', code: null, output: 'The host clock does not match the requested time', stateMayHaveChanged: true };
						return { kind: 'ok', output: '' };
					} catch (error) {
						return failure(error, true);
					}
				}
			},
		};
	}

	timezone(timezone: string): SystemOperation {
		return {
			describe: `timedate1.SetTimezone ${timezone}`,
			run: async signal => {
				const context = requireNativeMutationContext();
				let endpoint: BoundDBusEndpoint;
				let before: LinuxTimeSnapshot;
				try {
					signal.throwIfAborted();
					endpoint = await this.deps.synchronous.bind(this.endpoint(TIMEDATED, this.timeout(context)));
					before = await this.snapshot(context, { timezone });
					if (!before.targetTimezone) throw new Error('The requested timezone has no physical zone file');
					await recordLinuxTimeRecovery(context, { timezone: { before: before.timezone, target: before.targetTimezone }, endpoints: { timedated: endpoint.rule } });
				} catch (error) {
					return failure(error, false);
				}
				let refusal: unknown;
				try {
					await this.deps.synchronous.call(context, endpoint, 'timedated.SetTimezone', { path: '/org/freedesktop/timedate1', interface: TIMEDATED, member: 'SetTimezone', signature: 'sb', args: [timezone, false] });
				} catch (error) {
					if (unknownWrite(error)) throw error;
					refusal = error;
				}
				try {
					const after = await this.snapshot(context);
					if (refusal) {
						const unsent = (refusal instanceof DBusTransportError && !refusal.mayHaveBeenSent) || (refusal instanceof NativeWorkerFailure && !refusal.mayHaveRun);
						return failure(refusal, !unsent);
					}
					return sameTimezoneSource(after.timezone, before.targetTimezone!) ? { kind: 'ok', output: '' } : { kind: 'failed', code: null, output: 'The host timezone file does not match the requested timezone', stateMayHaveChanged: true };
				} catch (error) {
					return failure(refusal ?? error, true);
				}
			},
		};
	}

	ntpEnabled(enabled: boolean): SystemOperation {
		return {
			describe: `timedate1.SetNTP ${enabled}`,
			run: async signal => {
				const context = requireNativeMutationContext();
				let timedated: BoundDBusEndpoint;
				let systemd: BoundDBusEndpoint;
				try {
					signal.throwIfAborted();
					timedated = await this.deps.jobs.call({ method: 'linux.time.jobs.bind', args: this.endpoint(TIMEDATED, this.timeout(context)) });
					systemd = await this.deps.jobs.call({ method: 'linux.time.jobs.bind', args: this.endpoint(SYSTEMD, this.timeout(context)) });
					await recordLinuxTimeRecovery(context, { ntpEnabled: enabled, endpoints: { timedated: timedated.rule, systemd: systemd.rule } });
				} catch (error) {
					return failure(error, false);
				}
				return context.call({ kind: 'boot' }, async () => {
					const value = await this.deps.jobs.call<OperationOutcome>({ method: 'linux.time.jobs.set-ntp', args: { timedated, systemd, enabled, readTimeoutMs: this.timeout(context) } });
					return value.kind === 'unknown' ? { known: false } : { known: true, value };
				});
			},
		};
	}

	restartTimesyncd(): SystemOperation {
		return {
			describe: 'systemd1.RestartUnit systemd-timesyncd.service',
			run: async signal => {
				const context = requireNativeMutationContext();
				let endpoint: BoundDBusEndpoint;
				try {
					signal.throwIfAborted();
					endpoint = await this.deps.jobs.call({ method: 'linux.time.jobs.bind', args: this.endpoint(SYSTEMD, this.timeout(context)) });
					await recordLinuxTimeRecovery(context, { endpoints: { systemd: endpoint.rule } });
				} catch (error) {
					return failure(error, false);
				}
				return context.call({ kind: 'boot' }, async () => {
					const value = await this.deps.jobs.call<OperationOutcome>({ method: 'linux.time.jobs.restart', args: { endpoint, unit: 'systemd-timesyncd.service', readTimeoutMs: this.timeout(context) } });
					return value.kind === 'unknown' ? { known: false } : { known: true, value };
				});
			},
		};
	}

	close(): void {
		this.deps.synchronous.close();
		if (this.deps.reader !== reader) this.deps.reader.close();
		this.deps.jobs.close();
	}
}

export async function runLinuxTimeOperation(select: (mutations: LinuxTimeMutations) => SystemOperation): Promise<SystemTimeResult> {
	const mutations = new LinuxTimeMutations();
	try {
		return await runOperations('linux', [select(mutations)]);
	} finally {
		mutations.close();
	}
}
