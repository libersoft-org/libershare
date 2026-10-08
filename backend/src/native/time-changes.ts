import { createHash } from 'node:crypto';
import { CodedError, ErrorCodes, type SystemTimeChanges, type SystemTimeResult, type SystemTimeStatus } from '@shared';
import { NativeMutationHost, type NativeMutationState, type NativeSettlement } from './mutation-host.ts';
import { NativeMutationBusy, type JournalValue, type NativeMutationRecord } from './mutation-journal.ts';
import { withNativeMutationContext } from './mutation-context.ts';
import { NativeWorkerChannel } from './worker-host.ts';
import { sameTimezoneSource, type LinuxTimeRecovery, type LinuxTimeSnapshot, type LinuxTimezoneSource } from './linux/time-mutation-state.ts';
import { nativeNtpStateMatches, type NativeNtpState } from './linux/time-mutation-jobs.ts';
import { validateSystemTimeChanges } from '../system-time.ts';
import { result, SAVE_BUDGET_MS, FOLLOW_UP_BUDGET_MS } from '../system-time-common.ts';
import { verifyTimesyncdServer } from '../system-time-linux.ts';
import { observeNativeWindowsTime } from './win32/time-mutation.ts';
import type { WindowsTimeSnapshot, WindowsTimeRecovery } from './win32/time-state.ts';
import { observeNativeDarwinTime } from './darwin/time-mutation.ts';
import type { DarwinTimeSnapshot, DarwinTimeRecovery } from './darwin/time-state.ts';

interface TimeRecovery {
	kind: 'time';
	changes: SystemTimeChanges;
	original: { timezone: string; ntpEnabled: boolean | null; ntpServer: string | null };
	physical: LinuxTimeSnapshot;
	time?: LinuxTimeRecovery;
}

interface WindowsTimeRecoveryData {
	kind: 'time';
	platform: 'win32';
	changes: SystemTimeChanges;
	physical: WindowsTimeSnapshot;
	windowsTime?: WindowsTimeRecovery;
}

interface DarwinTimeRecoveryData {
	kind: 'time';
	platform: 'darwin';
	changes: SystemTimeChanges;
	physical: DarwinTimeSnapshot;
	darwinTime?: DarwinTimeRecovery;
}

function timezoneSource(value: unknown): value is LinuxTimezoneSource | null {
	if (value === null) return true;
	if (!value || typeof value !== 'object') return false;
	const source = value as LinuxTimezoneSource;
	return typeof source.resolved === 'string' && source.resolved.startsWith('/') && typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/.test(source.sha256) && typeof source.symlink === 'boolean' && (source.name === null || typeof source.name === 'string');
}

export function clockMatchesRecovery(reference: { targetUtcMs: number; hostUptimeMs: number; bootId: string | null }, current: LinuxTimeSnapshot): boolean {
	return !!reference.bootId && reference.bootId === current.bootId && Number.isFinite(reference.targetUtcMs) && Number.isFinite(reference.hostUptimeMs) && current.hostUptimeMs >= reference.hostUptimeMs && Math.abs(current.utcMs - (reference.targetUtcMs + current.hostUptimeMs - reference.hostUptimeMs)) <= 2000;
}

/** Recovery compares physical host state with the snapshot saved before the native write. */
export class NativeTimeChanges {
	private readonly host: NativeMutationHost;
	private readonly read: () => Promise<SystemTimeStatus>;
	private readonly reader: Pick<NativeWorkerChannel, 'call' | 'close'>;
	private recovery: Promise<void> | null = null;
	private stopping = false;

	constructor(host: NativeMutationHost, read: () => Promise<SystemTimeStatus>, reader: Pick<NativeWorkerChannel, 'call' | 'close'> = new NativeWorkerChannel('read')) {
		this.host = host;
		this.read = read;
		this.reader = reader;
	}

	async assertIdle(): Promise<void> {
		if (await this.host.state('time')) throw new CodedError(ErrorCodes.SYSTEM_TIME_BUSY);
	}
	state(): Promise<NativeMutationState | undefined> {
		return this.host.state('time');
	}

	async acknowledge(operationId: string): Promise<SystemTimeStatus> {
		try {
			await this.host.acknowledge('time', operationId);
		} catch (error) {
			this.rethrowBusy(error);
			throw error;
		}
		return this.read();
	}

	private rethrowBusy(error: unknown): void {
		if (error instanceof NativeMutationBusy || (error instanceof Error && error.name === 'NativeMutationBusy')) throw new CodedError(ErrorCodes.SYSTEM_TIME_BUSY);
	}

	startRecovery(): void {
		if (this.stopping || !['linux', 'win32', 'darwin'].includes(process.platform) || this.recovery) return;
		this.recovery = this.host
			.recover(
				'time',
				record => this.host.observe(record),
				record => this.verify(record)
			)
			.catch(error => {
				console.warn('[system-time] Cannot verify interrupted native change:', error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				this.recovery = null;
			});
	}

	async apply(changes: SystemTimeChanges, action: () => Promise<SystemTimeResult>): Promise<SystemTimeResult> {
		if (!['linux', 'win32', 'darwin'].includes(process.platform)) return result('unsupported', 'This host has no native time mutation adapter');
		const invalid = validateSystemTimeChanges(changes);
		if (invalid) return invalid;
		await this.assertIdle();
		const original = await this.read();
		if (!original.supported || original.stale) return result('stale', 'Current system time settings could not be read');
		let data: TimeRecovery | WindowsTimeRecoveryData | DarwinTimeRecoveryData;
		if (process.platform === 'win32') {
			data = { kind: 'time', platform: 'win32', changes, physical: await this.reader.call<WindowsTimeSnapshot>({ method: 'win32.time.snapshot' }, 25000) };
		} else if (process.platform === 'darwin') {
			const physical = await this.reader.call<DarwinTimeSnapshot>({ method: 'darwin.time.snapshot', args: { ...(changes.clock && changes.expectedTimezone ? { timezone: changes.expectedTimezone } : {}), ...(changes.clock && process.getuid?.() === 0 ? { clock: changes.clock } : {}) } }, 25000);
			if (changes.clock && ((physical.targetZone && (physical.zone?.resolved !== physical.targetZone.resolved || physical.zone?.sha256 !== physical.targetZone.sha256)) || (changes.expectedOffsetMinutes !== undefined && physical.offsetMinutes !== changes.expectedOffsetMinutes))) return result('stale', 'The host timezone file changed since the clock was read');
			data = { kind: 'time', platform: 'darwin', changes, physical };
		} else {
			const physical = await this.reader.call<LinuxTimeSnapshot>({ method: 'linux.time.snapshot', args: { ...(changes.clock && changes.expectedTimezone ? { timezone: changes.expectedTimezone } : {}), dropin: changes.ntpServer !== undefined } }, 25000);
			if (changes.clock && ((physical.targetTimezone && !sameTimezoneSource(physical.timezone, physical.targetTimezone)) || (changes.expectedOffsetMinutes !== undefined && physical.offsetSeconds !== changes.expectedOffsetMinutes * 60))) return result('stale', 'The host timezone file changed since the clock was read');
			data = { kind: 'time', changes, original: { timezone: original.timezone, ntpEnabled: original.ntpEnabled, ntpServer: original.ntpServer }, physical };
		}
		const encoded = JSON.stringify(data);
		try {
			let outcome: SystemTimeResult | undefined;
			const completed = await this.host.run(
				{ domain: 'time', operation: 'applySystemTime', requestHash: createHash('sha256').update(encoded).digest('hex'), recoveryData: JSON.parse(encoded) as JournalValue, timeoutMs: SAVE_BUDGET_MS + FOLLOW_UP_BUDGET_MS },
				context =>
					withNativeMutationContext(context, async () => {
						outcome = await action();
						return outcome;
					}),
				record => (outcome && !outcome.success && !outcome.changed && !outcome.stateMayHaveChanged ? Promise.resolve('completed') : this.verify(record))
			);
			return completed.state === 'completed' ? completed.value : { ...result('error', 'The system time change is still pending; no further change can start yet'), stateMayHaveChanged: true };
		} catch (error) {
			this.rethrowBusy(error);
			throw error;
		}
	}

	private async verify(record: NativeMutationRecord): Promise<NativeSettlement> {
		if ((record.recoveryData as { platform?: string } | null)?.platform === 'darwin') {
			const data = record.recoveryData as unknown as DarwinTimeRecoveryData;
			if (data.kind !== 'time' || !data.changes || validateSystemTimeChanges(data.changes) || !data.physical || typeof data.physical.ntpEnabled !== 'boolean') return 'interrupted';
			const observed = await observeNativeDarwinTime(data.physical, data.changes, data.darwinTime, 15000);
			return observed.original || observed.target ? 'completed' : 'interrupted';
		}
		if ((record.recoveryData as { platform?: string } | null)?.platform === 'win32') {
			const data = record.recoveryData as unknown as WindowsTimeRecoveryData;
			if (data.kind !== 'time' || !data.changes || validateSystemTimeChanges(data.changes) || !data.physical?.zone || !data.physical.mode || !data.physical.registry) return 'interrupted';
			const observed = await observeNativeWindowsTime(data.physical, data.changes, data.windowsTime, 15000);
			return observed.original || observed.target ? 'completed' : 'interrupted';
		}
		const data = record.recoveryData as unknown as TimeRecovery;
		if (!data || data.kind !== 'time' || !data.changes || typeof data.changes !== 'object' || Array.isArray(data.changes) || !data.original || typeof data.original.timezone !== 'string' || (data.original.ntpEnabled !== null && typeof data.original.ntpEnabled !== 'boolean') || (data.original.ntpServer !== null && typeof data.original.ntpServer !== 'string') || !data.physical || !timezoneSource(data.physical.timezone) || !Number.isFinite(data.physical.utcMs) || !Number.isFinite(data.physical.hostUptimeMs)) return 'interrupted';
		const metadata = data.time;
		const changes = data.changes;
		if (validateSystemTimeChanges(changes) || (changes.ntpEnabled !== undefined && typeof changes.ntpEnabled !== 'boolean')) return 'interrupted';
		const hash = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
		if (changes.ntpServer !== undefined && (!hash(data.physical.configurationHash) || (data.physical.dropinHash !== null && !hash(data.physical.dropinHash)))) return 'interrupted';
		if (metadata && (typeof metadata !== 'object' || Array.isArray(metadata))) return 'interrupted';
		const current = await this.reader.call<LinuxTimeSnapshot>({ method: 'linux.time.snapshot', args: { dropin: changes.ntpServer !== undefined } }, 25000);
		const status = await this.read();
		if (!status.supported || status.stale) throw new Error('Current time settings are unavailable for recovery');
		let ntp: NativeNtpState | undefined;
		const checkNtp = changes.ntpEnabled !== undefined || changes.ntpServer !== undefined;
		if (checkNtp) ntp = await this.reader.call({ method: 'linux.time.jobs.state', args: { timeoutMs: 10000 } }, 15000);
		const originalClock = !changes.clock || clockMatchesRecovery({ targetUtcMs: data.physical.utcMs, hostUptimeMs: data.physical.hostUptimeMs, bootId: data.physical.bootId }, current);
		const originalZone = sameTimezoneSource(current.timezone, data.physical.timezone);
		const originalNtp = !checkNtp || (data.original.ntpEnabled !== null && nativeNtpStateMatches(ntp!, data.original.ntpEnabled));
		const originalServer = changes.ntpServer === undefined || (current.dropinHash === data.physical.dropinHash && current.configurationHash === data.physical.configurationHash && status.ntpServer === data.original.ntpServer);
		if (originalClock && originalZone && originalNtp && originalServer) return 'completed';
		if (changes.clock && (!metadata?.clock || !clockMatchesRecovery(metadata.clock, current))) return 'interrupted';
		if (changes.timezone !== undefined) {
			if (!metadata?.timezone?.target || !timezoneSource(metadata.timezone.target) || !sameTimezoneSource(current.timezone, metadata.timezone.target)) return 'interrupted';
		} else if (!originalZone) return 'interrupted';
		const desiredNtp = changes.ntpEnabled ?? data.original.ntpEnabled;
		if (checkNtp && (desiredNtp === null || !nativeNtpStateMatches(ntp!, desiredNtp))) return 'interrupted';
		if (changes.ntpServer !== undefined && (!metadata?.dropin || !hash(metadata.dropin.targetHash) || current.dropinHash !== metadata.dropin.targetHash || (await verifyTimesyncdServer(changes.ntpServer)) !== null)) return 'interrupted';
		return 'completed';
	}

	async close(): Promise<boolean> {
		this.stopping = true;
		await this.recovery;
		return this.reader.close();
	}
}
