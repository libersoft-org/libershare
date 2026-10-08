import type { SystemTimeResult, SystemTimeChanges } from '@shared';
import { runOperations, type SystemOperation, type OperationOutcome } from '../../system-time-common.ts';
import { requireNativeMutationContext } from '../mutation-context.ts';
import { NativeWorkerChannel, NativeWorkerFailure } from '../worker-host.ts';
import { NativeMutationUnknown, type NativeMutationContext } from '../mutation-host.ts';
import { windowsSyncEnabled, windowsSyncIsOurs } from '../../system-time-windows.ts';
import { observeWindowsTimeRecovery, windowsClockMatches, type WindowsTimeRecovery, type WindowsTimeSnapshot, type WindowsTimeSnapshotRequest } from './time-state.ts';
import type { WindowsTimeWrite, WindowsTimeWriteResult } from './time-worker.ts';
import type { WindowsClockParts } from './time-zone.ts';
import { readWindowsTimeSnapshotAsync } from './time-reader.ts';

export interface WindowsTimeMutationDeps {
	readonly read: typeof readWindowsTimeSnapshotAsync;
	readonly writer: Pick<NativeWorkerChannel, 'call' | 'close'>;
}
const recoveryByContext = new WeakMap<NativeMutationContext, WindowsTimeRecovery>();
async function record(context: NativeMutationContext, update: WindowsTimeRecovery, inCall = false): Promise<void> {
	const metadata = { ...recoveryByContext.get(context), ...update };
	const recovery = { windowsTime: JSON.parse(JSON.stringify(metadata)) };
	if (inCall) await context.recordExecution({ kind: 'boot' }, recovery);
	else await context.recordRecovery(recovery);
	recoveryByContext.set(context, metadata);
}
const failure = (error: unknown, changed = false): OperationOutcome => ({ kind: 'failed', code: null, output: error instanceof Error ? error.message : String(error), stateMayHaveChanged: changed, changed });

export class WindowsTimeMutations {
	private readonly deps: WindowsTimeMutationDeps;
	constructor(deps?: WindowsTimeMutationDeps) {
		this.deps = deps ?? { read: readWindowsTimeSnapshotAsync, writer: new NativeWorkerChannel('mutation') };
	}
	private snapshot(context: NativeMutationContext, request: WindowsTimeSnapshotRequest = {}): Promise<WindowsTimeSnapshot> {
		return this.deps.read(request, Math.max(1, Math.min(10000, context.remainingMs())));
	}
	private async write(context: NativeMutationContext, request: WindowsTimeWrite): Promise<OperationOutcome> {
		return context.call({ kind: 'boot' }, async () => {
			const response = await this.deps.writer.call<WindowsTimeWriteResult>({ method: 'win32.time.write', args: request });
			if (response.outcome.kind === 'unknown') return { known: false };
			if (response.clock) await record(context, { clock: response.clock }, true);
			return { known: true, value: response.outcome };
		});
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
	clock(clock: WindowsClockParts): SystemOperation {
		return this.operation('SetSystemTime', async context => {
			const before = await this.snapshot(context, { clock });
			if (!before.targetClock || !before.bootId) return failure('Cannot establish the clock target and boot');
			await record(context, { clock: before.targetClock });
			const result = await this.write(context, { kind: 'clock', clock, target: before.targetClock, zoneHash: before.zone.hash });
			if (result.kind !== 'ok') return result;
			try {
				return windowsClockMatches(recoveryByContext.get(context)!.clock!, await this.snapshot(context)) ? result : failure('The host clock does not match the requested time', true);
			} catch (error) {
				return failure(error, true);
			}
		});
	}
	timezone(timezone: string): SystemOperation {
		return this.operation('SetDynamicTimeZoneInformation', async context => {
			const before = await this.snapshot(context, { timezone });
			if (!before.targetZone) return failure('Cannot prepare the Windows timezone');
			await record(context, { timezone: { before: before.zone, target: before.targetZone } });
			const result = await this.write(context, { kind: 'timezone', target: before.targetZone, zoneHash: before.zone.hash });
			if (result.kind !== 'ok') return result;
			try {
				return (await this.snapshot(context)).zone.hash === before.targetZone.hash ? result : failure('The Windows timezone does not match the requested timezone', true);
			} catch (error) {
				return failure(error, true);
			}
		});
	}
	server(server: string): SystemOperation {
		return this.operation('Set Windows NTP server', async context => {
			const before = await this.snapshot(context);
			if (!windowsSyncIsOurs(before.mode.mode, before.mode.membership)) return { kind: 'failed', outcome: 'unsupported', code: null, output: 'The Windows time source is managed', stateMayHaveChanged: false };
			await record(context, { server });
			const requests: WindowsTimeWrite[] = [
				{ kind: 'server', value: server },
				{ kind: 'service', operation: { kind: 'notify', timeoutMs: 0 } },
			];
			if (windowsSyncEnabled(before.mode.mode, before.mode.start, before.mode.ntpClientEnabled) === true) requests.push({ kind: 'resync', allowStopped: true });
			return this.sequence(context, requests, after => after.registry.server === `${server},0x8` && after.registry.type === before.registry.type);
		});
	}
	ntpEnabled(enabled: boolean): SystemOperation {
		return this.operation(`Set Windows time synchronization ${enabled}`, async context => {
			const before = await this.snapshot(context);
			if (!windowsSyncIsOurs(before.mode.mode, before.mode.membership)) return { kind: 'failed', outcome: 'unsupported', code: null, output: 'The Windows time source is managed', stateMayHaveChanged: false };
			await record(context, { enabled });
			const requests: WindowsTimeWrite[] = [];
			if (enabled) {
				if (before.registry.client === 0) requests.push({ kind: 'client-enable' });
				requests.push({ kind: 'service', operation: { kind: 'start-mode', value: 2 } }, { kind: 'service', operation: { kind: 'delayed-start', enabled: true } }, { kind: 'service', operation: { kind: 'start', timeoutMs: 15000 } });
				if (before.mode.mode === 'none') requests.push({ kind: 'manual-source' });
				if (before.mode.mode === 'none' || before.registry.client === 0) requests.push({ kind: 'service', operation: { kind: 'notify', timeoutMs: 0 } });
				requests.push({ kind: 'resync', allowStopped: false });
			} else requests.push({ kind: 'service', operation: { kind: 'stop', timeoutMs: 15000 } }, { kind: 'service', operation: { kind: 'start-mode', value: 4 } });
			return this.sequence(context, requests, after => (enabled ? after.registry.start === 2 && after.registry.delayed === 1 && after.mode.service === 'running' && windowsSyncEnabled(after.mode.mode, after.mode.start, after.mode.ntpClientEnabled) === true : after.registry.start === 4 && after.mode.service === 'stopped'));
		});
	}
	private async sequence(context: NativeMutationContext, requests: WindowsTimeWrite[], verify: (after: WindowsTimeSnapshot) => boolean): Promise<OperationOutcome> {
		let changed = false;
		try {
			for (const request of requests) {
				const bounded: WindowsTimeWrite = request.kind === 'service' && 'timeoutMs' in request.operation ? { ...request, operation: { ...request.operation, timeoutMs: Math.max(1, Math.min(request.operation.timeoutMs, context.remainingMs())) } } : request;
				const result = await this.write(context, bounded);
				if (result.kind !== 'ok') return result.kind === 'failed' || result.kind === 'denied' ? { ...result, changed, stateMayHaveChanged: changed || ('stateMayHaveChanged' in result && result.stateMayHaveChanged === true) } : result;
				changed = true;
			}
			return verify(await this.snapshot(context)) ? { kind: 'ok', output: '' } : failure('The Windows time configuration does not match the requested settings', changed);
		} catch (error) {
			if (error instanceof NativeMutationUnknown || (error instanceof NativeWorkerFailure && error.mayHaveRun)) throw error;
			return failure(error, changed);
		}
	}
	close(): void {
		this.deps.writer.close();
	}
}
export async function runWindowsTimeOperation(select: (mutations: WindowsTimeMutations) => SystemOperation): Promise<SystemTimeResult> {
	const mutations = new WindowsTimeMutations();
	try {
		return await runOperations('win32', [select(mutations)]);
	} finally {
		mutations.close();
	}
}
export async function observeNativeWindowsTime(original: WindowsTimeSnapshot, changes: SystemTimeChanges, recovery: WindowsTimeRecovery | undefined, timeoutMs: number): Promise<{ original: boolean; target: boolean }> {
	return observeWindowsTimeRecovery(original, changes, recovery, await readWindowsTimeSnapshotAsync({}, timeoutMs));
}
