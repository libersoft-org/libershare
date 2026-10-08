import { createHash } from 'node:crypto';
import { readFile, realpath, readlink } from 'node:fs/promises';
import { posix } from 'node:path';
import { parseTzif, tzifLocalToUtc, tzifOffsetAt } from '../tzif.ts';
import { getNativeBootId } from '../process-identity.ts';
import type { NativeMutationContext } from '../mutation-host.ts';
import type { NativeEndRule } from '../mutation-proof.ts';
import type { JournalValue } from '../mutation-journal.ts';
import { TIMESYNCD_DROPIN_PATH } from '../../system-time-linux.ts';
import { readTimesyncdConfiguration } from './systemd-files.ts';

const ZONEINFO = '/usr/share/zoneinfo';

export interface LinuxTimezoneSource {
	readonly resolved: string;
	readonly sha256: string;
	readonly name: string | null;
	readonly symlink: boolean;
}

export interface LinuxTimeSnapshot {
	readonly utcMs: number;
	readonly hostUptimeMs: number;
	readonly bootId: string | null;
	readonly timezone: LinuxTimezoneSource | null;
	readonly offsetSeconds: number | null;
	readonly dropinHash?: string | null;
	readonly configurationHash?: string;
	readonly targetTimezone?: LinuxTimezoneSource;
	readonly targetUtcMs?: number;
}

export interface LinuxTimeSnapshotRequest {
	readonly timezone?: string;
	readonly clock?: { readonly hours: number; readonly minutes: number; readonly seconds: number };
	readonly dropin?: boolean;
}

export interface LinuxTimeRecovery {
	clock?: { targetUtcMs: number; hostUptimeMs: number; bootId: string | null };
	timezone?: { before: LinuxTimezoneSource | null; target: LinuxTimezoneSource };
	ntpEnabled?: boolean;
	ntpServer?: string;
	dropin?: { beforeHash: string | null; targetHash: string };
	endpoints?: Record<string, NativeEndRule>;
}

const recovery = new WeakMap<NativeMutationContext, LinuxTimeRecovery>();

export async function recordLinuxTimeRecovery(context: NativeMutationContext, patch: LinuxTimeRecovery): Promise<void> {
	const previous = recovery.get(context);
	const value = { ...previous, ...patch, ...(patch.endpoints ? { endpoints: { ...previous?.endpoints, ...patch.endpoints } } : {}) };
	await context.recordRecovery({ time: value as unknown as JournalValue });
	recovery.set(context, value);
}

export function sameTimezoneSource(actual: LinuxTimezoneSource | null, expected: LinuxTimezoneSource | null): boolean {
	if (actual === null || expected === null) return actual === expected;
	return actual.sha256 === expected.sha256 && (!actual.symlink || actual.resolved === expected.resolved);
}

async function timezoneSource(path: string): Promise<{ source: LinuxTimezoneSource; bytes: Buffer }> {
	const resolved = await realpath(path);
	const bytes = await readFile(path);
	parseTzif(bytes);
	let symlink = true;
	try {
		await readlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EINVAL') throw error;
		symlink = false;
	}
	return { bytes, source: { resolved, sha256: createHash('sha256').update(bytes).digest('hex'), name: resolved.startsWith(`${ZONEINFO}/`) ? resolved.slice(ZONEINFO.length + 1) : null, symlink } };
}

/** Worker-only host reference; uptime remains comparable when SetTime moves CLOCK_REALTIME. */
export async function readLinuxTimeSnapshot(request: LinuxTimeSnapshotRequest = {}): Promise<LinuxTimeSnapshot> {
	const local = await timezoneSource('/etc/localtime').catch(error => {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	});
	let targetTimezone: LinuxTimezoneSource | undefined;
	if (request.timezone !== undefined) {
		const parts = request.timezone.split('/');
		if (!request.timezone || parts.some(part => !part || part === '.' || part === '..') || !/^[A-Za-z0-9_+./-]+$/.test(request.timezone)) throw new Error('Invalid timezone path');
		targetTimezone = (await timezoneSource(posix.join(ZONEINFO, request.timezone))).source;
	}
	const hostUptimeMs = Number((await readFile('/proc/uptime', 'utf8')).split(' ')[0]) * 1000;
	if (!Number.isFinite(hostUptimeMs) || hostUptimeMs < 0) throw new Error('Host uptime is unavailable');
	const utcMs = Date.now();
	const zone = local ? parseTzif(local.bytes) : null;
	let files: { dropinHash: string | null; configurationHash: string } | undefined;
	if (request.dropin) {
		const content = await readFile(TIMESYNCD_DROPIN_PATH).catch(error => {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		});
		files = {
			dropinHash: content === null ? null : createHash('sha256').update(content).digest('hex'),
			configurationHash: createHash('sha256')
				.update(await readTimesyncdConfiguration())
				.digest('hex'),
		};
	}
	const snapshot: LinuxTimeSnapshot = { utcMs, hostUptimeMs, bootId: getNativeBootId(), timezone: local?.source ?? null, offsetSeconds: zone ? tzifOffsetAt(zone, Math.floor(utcMs / 1000)) : null, ...files, ...(targetTimezone ? { targetTimezone } : {}) };
	if (!request.clock) return snapshot;
	if (!zone) throw new Error('The host timezone file is unavailable for a clock write');
	const today = new Date(utcMs + tzifOffsetAt(zone, Math.floor(utcMs / 1000)) * 1000);
	const targetUtcMs = tzifLocalToUtc(zone, { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1, day: today.getUTCDate(), hour: request.clock.hours, minute: request.clock.minutes, second: request.clock.seconds }) * 1000;
	return { ...snapshot, targetUtcMs };
}
