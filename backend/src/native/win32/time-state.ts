import type { SystemTimeChanges } from '@shared';
import { parseWindowsSyncMode, probeDomainMembership, readWindowsPolicyManaged, readWindowsTimeServiceState, windowsSyncEnabled, type WindowsModeState } from '../../system-time-windows.ts';
import { getNativeBootId } from '../process-identity.ts';
import { readTimeRegistry, timeRegistryDword, timeRegistryString, TIME_CLIENT, TIME_PARAMETERS, TIME_SERVICE, windowsTimeSyncStatus } from './time-native.ts';
import { prepareWindowsClock, readWindowsNativeZone, windowsHostUptimeMs, windowsTimezoneTarget, type WindowsNativeZone, type WindowsClockParts } from './time-zone.ts';

export interface WindowsTimeSnapshotRequest {
	readonly timezone?: string;
	readonly clock?: WindowsClockParts;
	readonly synchronization?: boolean;
}
export interface WindowsClockProof {
	readonly targetUtcMs: number;
	readonly hostUptimeMs: number;
	readonly bootId: string | null;
}
export interface WindowsTimeSnapshot {
	readonly utcMs: number;
	readonly hostUptimeMs: number;
	readonly bootId: string | null;
	readonly zone: WindowsNativeZone;
	readonly targetZone?: WindowsNativeZone;
	readonly targetClock?: WindowsClockProof & { readonly localDate: string };
	readonly mode: WindowsModeState;
	readonly policyManaged: boolean;
	readonly registry: { readonly type: string | null; readonly server: string | null; readonly start: number | null; readonly delayed: number | null; readonly client: number | null };
	readonly synchronized: boolean | null;
}
export interface WindowsTimeRecovery {
	readonly clock?: WindowsClockProof;
	readonly timezone?: { readonly before: WindowsNativeZone; readonly target: WindowsNativeZone };
	readonly server?: string;
	readonly enabled?: boolean;
}

export function readWindowsTimeSnapshot(request: WindowsTimeSnapshotRequest = {}): WindowsTimeSnapshot {
	const registry = { type: timeRegistryString(readTimeRegistry(TIME_PARAMETERS, 'Type')), server: timeRegistryString(readTimeRegistry(TIME_PARAMETERS, 'NtpServer')), start: timeRegistryDword(readTimeRegistry(TIME_SERVICE, 'Start')), delayed: timeRegistryDword(readTimeRegistry(TIME_SERVICE, 'DelayedAutostart')), client: timeRegistryDword(readTimeRegistry(TIME_CLIENT, 'Enabled')) };
	const policyManaged = readWindowsPolicyManaged(),
		membership = probeDomainMembership();
	const mode: WindowsModeState = { mode: parseWindowsSyncMode(registry.type, policyManaged), start: registry.start === 4 ? 'disabled' : registry.start === 3 ? 'on-demand' : registry.start !== null && registry.start <= 2 ? 'automatic' : 'unknown', ntpClientEnabled: registry.client !== 0, membership, service: readWindowsTimeServiceState() };
	const zone = readWindowsNativeZone(),
		targetZone = request.timezone ? windowsTimezoneTarget(request.timezone, zone.daylightDisabled) : undefined;
	const target = request.clock ? prepareWindowsClock(zone, request.clock) : undefined;
	const synchronized = request.synchronization ? windowsTimeSyncStatus() : null;
	const hostUptimeMs = windowsHostUptimeMs(),
		bootId = getNativeBootId(),
		utcMs = Date.now();
	return { registry, policyManaged, mode, zone, utcMs, hostUptimeMs, bootId, synchronized, ...(targetZone ? { targetZone } : {}), ...(target ? { targetClock: { ...target, hostUptimeMs, bootId } } : {}) };
}
export function windowsClockMatches(proof: WindowsClockProof, current: WindowsTimeSnapshot): boolean {
	return !!proof.bootId && proof.bootId === current.bootId && Number.isFinite(proof.targetUtcMs) && Number.isFinite(proof.hostUptimeMs) && current.hostUptimeMs >= proof.hostUptimeMs && Math.abs(current.utcMs - (proof.targetUtcMs + current.hostUptimeMs - proof.hostUptimeMs)) <= 2000;
}
export function observeWindowsTimeRecovery(original: WindowsTimeSnapshot, changes: SystemTimeChanges, recovery: WindowsTimeRecovery | undefined, current: WindowsTimeSnapshot): { original: boolean; target: boolean } {
	const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
	const oldClock = !changes.clock || windowsClockMatches({ targetUtcMs: original.utcMs, hostUptimeMs: original.hostUptimeMs, bootId: original.bootId }, current);
	const oldZone = current.zone.hash === original.zone.hash;
	const oldSettings = same(current.registry, original.registry) && current.mode.service === original.mode.service && current.policyManaged === original.policyManaged && current.mode.membership === original.mode.membership;
	const targetClock = !changes.clock || (!!recovery?.clock && windowsClockMatches(recovery.clock, current));
	const targetZone = changes.timezone === undefined ? oldZone : !!recovery?.timezone && current.zone.hash === recovery.timezone.target.hash;
	const server = changes.ntpServer === undefined ? current.registry.server === original.registry.server : recovery?.server === changes.ntpServer && current.registry.server === `${changes.ntpServer},0x8`;
	const enabled = changes.ntpEnabled === undefined ? current.registry.start === original.registry.start && current.registry.delayed === original.registry.delayed && current.registry.type === original.registry.type && current.registry.client === original.registry.client : recovery?.enabled === changes.ntpEnabled && windowsSyncEnabled(current.mode.mode, current.mode.start, current.mode.ntpClientEnabled) === changes.ntpEnabled && (changes.ntpEnabled ? current.mode.service === 'running' && current.registry.start === 2 && current.registry.delayed === 1 : current.mode.service === 'stopped' && current.registry.start === 4);
	return { original: oldClock && oldZone && oldSettings, target: targetClock && targetZone && server && enabled && current.policyManaged === original.policyManaged && current.mode.membership === original.mode.membership };
}
