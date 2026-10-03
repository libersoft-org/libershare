import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import type { SystemTimeChanges } from '@shared';
import { parseTzif, tzifOffsetAt } from '../tzif.ts';
import { getNativeBootId } from '../process-identity.ts';
import { darwinHostUptimeMs, openDarwinCoreTime, type DarwinClockParts } from './time-native.ts';
import { prepareDarwinClockSafely } from './time-clock-probe.ts';
import { darwinNtpFingerprint, readDarwinNtpFile } from './time-files.ts';
import { parseNtpConfServer, parseZoneinfoLink } from '../../system-time-macos.ts';

export const DARWIN_LOCALTIME: string = '/private/etc/localtime';
export interface DarwinTimeZone {
	readonly link: string | null;
	readonly resolved: string;
	readonly name: string | null;
	readonly sha256: string;
	readonly uid: number;
	readonly gid: number;
	readonly mode: number;
	readonly fingerprint: string;
}
export interface DarwinClockProof { readonly targetUtcMs: number; readonly hostUptimeMs: number; readonly bootId: string | null }
export interface DarwinTimeSnapshot {
	readonly utcMs: number;
	readonly hostUptimeMs: number;
	readonly bootId: string | null;
	readonly zone: DarwinTimeZone | null;
	readonly offsetMinutes: number | null;
	readonly ntpEnabled: boolean;
	readonly ntpServer: string | null;
	readonly ntpFingerprint: string | null;
	readonly ntpIdentity: string | null;
	readonly targetZone?: DarwinTimeZone;
	readonly targetClock?: DarwinClockProof;
	readonly targetNtpFingerprint?: string;
}
export interface DarwinTimeSnapshotRequest { readonly clock?: DarwinClockParts; readonly timezone?: string; readonly server?: string }
export interface DarwinTimeRecovery {
	clock?: DarwinClockProof;
	timezone?: { before: DarwinTimeZone | null; target: DarwinTimeZone };
	server?: { server: string; beforeFingerprint: string | null; targetFingerprint: string };
	enabled?: boolean;
}

function zoneFingerprint(source: Omit<DarwinTimeZone, 'fingerprint'>): DarwinTimeZone {
	return { ...source, fingerprint: createHash('sha256').update(JSON.stringify(source)).digest('hex') };
}
export function readDarwinTimeZone(): { zone: DarwinTimeZone; bytes: Buffer } | null {
	try {
		const stat = lstatSync(DARWIN_LOCALTIME), resolved = realpathSync(DARWIN_LOCALTIME), bytes = readFileSync(DARWIN_LOCALTIME);
		parseTzif(bytes);
		const link = stat.isSymbolicLink() ? readlinkSync(DARWIN_LOCALTIME) : null;
		return { bytes, zone: zoneFingerprint({ link, resolved, name: parseZoneinfoLink(link ?? resolved), sha256: createHash('sha256').update(bytes).digest('hex'), uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 }) };
	} catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function prepareDarwinTimeZone(name: string, previous: DarwinTimeZone | null): DarwinTimeZone {
	if (!/^[A-Za-z0-9_+./-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid macOS timezone');
	const link = `/var/db/timezone/zoneinfo/${name}`, resolved = realpathSync(link), bytes = readFileSync(link);
	parseTzif(bytes);
	return zoneFingerprint({ link, resolved, name, sha256: createHash('sha256').update(bytes).digest('hex'), uid: previous?.uid ?? 0, gid: previous?.gid ?? 0, mode: previous?.mode ?? 0o755 });
}
export function darwinClockMatches(proof: DarwinClockProof, current: DarwinTimeSnapshot): boolean {
	return !!proof.bootId && proof.bootId === current.bootId && Number.isFinite(proof.targetUtcMs) && Number.isFinite(proof.hostUptimeMs) && current.hostUptimeMs >= proof.hostUptimeMs && Math.abs(current.utcMs - (proof.targetUtcMs + current.hostUptimeMs - proof.hostUptimeMs)) <= 2000;
}

/** Worker-only metadata; contents and xattrs never leave this process in a recovery receipt. */
export async function readDarwinTimeSnapshot(request: DarwinTimeSnapshotRequest = {}): Promise<DarwinTimeSnapshot> {
	const local = readDarwinTimeZone(),
		file = readDarwinNtpFile(),
		coreTime = openDarwinCoreTime();
	try {
		const conversion = request.clock ? await prepareDarwinClockSafely(request.clock) : undefined;
		const utcMs = Date.now(),
			hostUptimeMs = darwinHostUptimeMs(),
			bootId = getNativeBootId();
		if (conversion && (conversion.reference.bootId !== bootId || readDarwinTimeZone()?.zone.fingerprint !== local?.zone.fingerprint)) throw new Error('The host timezone or boot changed during clock preparation');
		const targetUtcMs = conversion?.targetUtcMs;
		const targetNtpFingerprint = request.server === undefined ? undefined : darwinNtpFingerprint({ content: Buffer.from(`server ${request.server}\n`).toString('base64'), uid: file?.uid ?? 0, gid: file?.gid ?? 0, mode: file?.mode ?? 0o644, xattrs: file?.xattrs ?? {} })!;
		return { utcMs, hostUptimeMs, bootId, zone: local?.zone ?? null, offsetMinutes: local ? tzifOffsetAt(parseTzif(local.bytes), Math.floor(utcMs / 1000)) / 60 : null, ntpEnabled: coreTime.symbols.TMIsAutomaticTimeEnabled(), ntpServer: file ? parseNtpConfServer(Buffer.from(file.content, 'base64').toString('utf8')) : null, ntpFingerprint: file?.fingerprint ?? null, ntpIdentity: file?.identity ?? null, ...(request.timezone ? { targetZone: prepareDarwinTimeZone(request.timezone, local?.zone ?? null) } : {}), ...(targetUtcMs === undefined ? {} : { targetClock: { targetUtcMs, hostUptimeMs, bootId } }), ...(targetNtpFingerprint ? { targetNtpFingerprint } : {}) };
	} finally {
		coreTime.close();
	}
}

export function observeDarwinTimeRecovery(original: DarwinTimeSnapshot, changes: SystemTimeChanges, recovery: DarwinTimeRecovery | undefined, current: DarwinTimeSnapshot): { original: boolean; target: boolean } {
	const originalZone = current.zone?.fingerprint === original.zone?.fingerprint;
	const oldClock = !changes.clock || darwinClockMatches({ targetUtcMs: original.utcMs, hostUptimeMs: original.hostUptimeMs, bootId: original.bootId }, current);
	const originalSettings = current.ntpEnabled === original.ntpEnabled && current.ntpFingerprint === original.ntpFingerprint;
	const targetClock = !changes.clock || (!!recovery?.clock && darwinClockMatches(recovery.clock, current));
	const targetZone = changes.timezone === undefined ? originalZone : !!recovery?.timezone && current.zone?.fingerprint === recovery.timezone.target.fingerprint;
	const targetServer = changes.ntpServer === undefined ? current.ntpFingerprint === original.ntpFingerprint : recovery?.server?.server === changes.ntpServer && current.ntpServer === changes.ntpServer && current.ntpFingerprint === recovery.server.targetFingerprint;
	const targetEnabled = current.ntpEnabled === (changes.ntpEnabled ?? original.ntpEnabled);
	return { original: oldClock && originalZone && originalSettings, target: targetClock && targetZone && targetServer && targetEnabled };
}
