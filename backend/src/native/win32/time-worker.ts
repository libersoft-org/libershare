import { isValidNtpServer, type OperationOutcome } from '../../system-time-common.ts';
import { windowsClockRefusal, windowsSyncIsOurs } from '../../system-time-windows.ts';
import { getNativeBootId } from '../process-identity.ts';
import { readWindowsTimeSnapshot, type WindowsClockProof } from './time-state.ts';
import { prepareWindowsClock, readWindowsNativeZone, windowsHostUptimeMs, writeWindowsClock, writeWindowsTimezone, type WindowsNativeZone, type WindowsClockParts } from './time-zone.ts';
import { resyncWindowsTime, TIME_CLIENT, TIME_PARAMETERS, WindowsTimeNativeError, writeTimeRegistry, writeWindowsTimeService, type WindowsTimeServiceWrite } from './time-native.ts';

export type WindowsTimeWrite = { readonly kind: 'clock'; readonly clock: WindowsClockParts; readonly target: WindowsClockProof & { readonly localDate: string }; readonly zoneHash: string } | { readonly kind: 'timezone'; readonly target: WindowsNativeZone; readonly zoneHash: string } | { readonly kind: 'server'; readonly value: string } | { readonly kind: 'client-enable' | 'manual-source' } | { readonly kind: 'service'; readonly operation: WindowsTimeServiceWrite } | { readonly kind: 'resync'; readonly allowStopped: boolean };
export interface WindowsTimeWriteResult {
	readonly outcome: OperationOutcome;
	readonly clock?: WindowsClockProof;
}

export function executeWindowsTimeWrite(request: WindowsTimeWrite): WindowsTimeWriteResult {
	let entered = false;
	try {
		if (request.kind === 'timezone') {
			if (readWindowsNativeZone().hash !== request.zoneHash) return { outcome: { kind: 'failed', outcome: 'stale', code: null, output: 'The Windows timezone changed before the write', stateMayHaveChanged: false } };
			entered = true;
			writeWindowsTimezone(request.target);
		} else {
			const before = readWindowsTimeSnapshot();
			if (request.kind === 'clock') {
				const refusal = windowsClockRefusal(before.mode);
				if (refusal) return { outcome: { kind: 'failed', outcome: 'auto-sync-enabled', code: null, output: refusal, stateMayHaveChanged: false } };
				const prepared = prepareWindowsClock(before.zone, request.clock);
				if (before.zone.hash !== request.zoneHash || !request.target.bootId || getNativeBootId() !== request.target.bootId || prepared.localDate !== request.target.localDate || prepared.targetUtcMs !== request.target.targetUtcMs) return { outcome: { kind: 'failed', outcome: 'stale', code: null, output: 'The host date or timezone changed before the clock write', stateMayHaveChanged: false } };
				const proof = { targetUtcMs: prepared.targetUtcMs, hostUptimeMs: windowsHostUptimeMs(), bootId: before.bootId };
				entered = true;
				writeWindowsClock(prepared.targetUtcMs);
				return { outcome: { kind: 'ok', output: '' }, clock: proof };
			}
			if (!windowsSyncIsOurs(before.mode.mode, before.mode.membership)) return { outcome: { kind: 'failed', outcome: 'unsupported', code: null, output: 'The Windows time source is managed or could not be determined', stateMayHaveChanged: false } };
			if (request.kind === 'server' && !isValidNtpServer(request.value)) throw new Error('Invalid NTP server');
			entered = true;
			switch (request.kind) {
				case 'server':
					writeTimeRegistry(TIME_PARAMETERS, 'NtpServer', `${request.value},0x8`);
					break;
				case 'client-enable':
					writeTimeRegistry(TIME_CLIENT, 'Enabled', 1);
					break;
				case 'manual-source':
					writeTimeRegistry(TIME_PARAMETERS, 'Type', 'NTP');
					break;
				case 'service':
					writeWindowsTimeService(request.operation);
					break;
				case 'resync':
					resyncWindowsTime(request.allowStopped);
					break;
			}
		}
		return { outcome: { kind: 'ok', output: '' } };
	} catch (error) {
		const output = error instanceof Error ? error.message : String(error);
		if (error instanceof WindowsTimeNativeError) {
			if (error.mayHaveRun) return { outcome: { kind: 'unknown', output, endRule: { kind: 'boot' } } };
			const code = error.code & 0xffff;
			return { outcome: [5, 1300, 1314].includes(code) ? { kind: 'denied', output, stateMayHaveChanged: false } : { kind: 'failed', code, output, stateMayHaveChanged: false } };
		}
		if (error instanceof Error && error.name === 'NativeLibraryUnavailable') return { outcome: { kind: 'missing' } };
		return { outcome: entered ? { kind: 'unknown', output, endRule: { kind: 'boot' } } : { kind: 'failed', code: null, output, stateMayHaveChanged: false } };
	}
}
