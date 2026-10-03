import { readFileSync } from 'node:fs';
import type { PlatformStatus } from '../../system-time-common.ts';
import { parseNtpConfServer } from '../../system-time-macos.ts';
import { NativeWorkerChannel } from '../worker-host.ts';
import { parseTzif, tzifOffsetAt } from '../tzif.ts';
import { DARWIN_NTP_PATH } from './time-files.ts';
import { readDarwinTimeZone, type DarwinTimeSnapshot, type DarwinTimeSnapshotRequest } from './time-state.ts';
import { openDarwinCoreTime } from './time-native.ts';

const reader = new NativeWorkerChannel('read');
export function readDarwinTimeSnapshotAsync(request: DarwinTimeSnapshotRequest = {}, timeoutMs = 15000): Promise<DarwinTimeSnapshot> {
	return reader.call({ method: 'darwin.time.snapshot', args: request }, timeoutMs);
}
export function readDarwinTimeStatusAsync(): Promise<PlatformStatus> { return reader.call({ method: 'darwin.time.status' }, 15000); }

/** Native worker entry; the offset comes from the host TZif even when the caller sets TZ. */
export function readNativeDarwinTimeStatus(): PlatformStatus {
	const coreTime = openDarwinCoreTime();
	try {
		const local = readDarwinTimeZone();
		let server: string | null = null;
		try { server = parseNtpConfServer(readFileSync(DARWIN_NTP_PATH, 'utf8')); }
		catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
		return { timezone: local?.zone.name ?? null, ...(local ? { utcOffsetMinutes: tzifOffsetAt(parseTzif(local.bytes), Math.floor(Date.now() / 1000)) / 60 } : {}), ntpEnabled: coreTime.symbols.TMIsAutomaticTimeEnabled(), ntpSynchronized: null, ntpServer: server, capabilities: { setClock: true, setTimezone: true, setNtpServer: true, setNtpEnabled: true } };
	} finally { coreTime.close(); }
}
