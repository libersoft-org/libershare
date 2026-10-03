import { lchmodSync, lchownSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isValidNtpServer, type OperationOutcome } from '../../system-time-common.ts';
import { DARWIN_LOCALTIME, prepareDarwinTimeZone, readDarwinTimeZone, type DarwinClockProof } from './time-state.ts';
import { darwinHostUptimeMs, notifyDarwinTimezone, openDarwinCoreTime, prepareDarwinClock, setDarwinClock, type DarwinClockParts } from './time-native.ts';
import { readDarwinNtpFile, syncDarwinTimeDirectory, writeDarwinNtpFile } from './time-files.ts';
import { getNativeBootId } from '../process-identity.ts';

export type DarwinTimeWrite =
	| { readonly kind: 'clock'; readonly clock: DarwinClockParts; readonly zoneFingerprint: string | null }
	| { readonly kind: 'timezone'; readonly timezone: string; readonly zoneFingerprint: string | null; readonly targetFingerprint: string }
	| { readonly kind: 'server'; readonly server: string; readonly fileFingerprint: string | null; readonly fileIdentity: string | null; readonly enabled: boolean }
	| { readonly kind: 'enabled'; readonly enabled: boolean };
export interface DarwinTimeWriteResult { readonly outcome: OperationOutcome; readonly clock?: DarwinClockProof }

const unknown = (): OperationOutcome => ({ kind: 'unknown', output: 'CoreTime has not confirmed the requested state', endRule: { kind: 'boot' } });

export async function refreshDarwinAutomaticTime(enabled: boolean, change: (enabled: boolean) => Promise<boolean>): Promise<OperationOutcome> {
	if (enabled && (!await change(false) || !await change(true))) return unknown();
	return { kind: 'ok', output: '' };
}

async function setAutomaticTime(enabled: boolean, coreTime: ReturnType<typeof openDarwinCoreTime>): Promise<boolean> {
	coreTime.symbols.TMSetAutomaticTimeEnabled(enabled);
	const deadline = performance.now() + 10000;
	while (coreTime.symbols.TMIsAutomaticTimeEnabled() !== enabled) {
		if (performance.now() >= deadline) return false;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return true;
}

/** Each request is enclosed by the caller's durable context.call, with no transport timeout. */
export async function executeDarwinTimeWrite(request: DarwinTimeWrite): Promise<DarwinTimeWriteResult> {
	if (process.platform !== 'darwin') return { outcome: { kind: 'missing' } };
	if (process.getuid?.() !== 0) return { outcome: { kind: 'denied', output: 'macOS time settings require administrator rights', stateMayHaveChanged: false } };
	let changed = false;
	try {
		if (request.kind === 'clock') {
			const zone = readDarwinTimeZone()?.zone;
			if (!zone || zone.fingerprint !== request.zoneFingerprint) throw new Error('The host timezone changed before the clock write');
			const coreTime = openDarwinCoreTime();
			try { if (coreTime.symbols.TMIsAutomaticTimeEnabled()) return { outcome: { kind: 'failed', code: null, output: 'Automatic time synchronization is enabled', outcome: 'auto-sync-enabled', stateMayHaveChanged: false } }; }
			finally { coreTime.close(); }
			const targetUtcMs = prepareDarwinClock(request.clock), hostUptimeMs = darwinHostUptimeMs(), bootId = getNativeBootId();
			if (!bootId) throw new Error('Cannot identify the host boot before setting its clock');
			const errno = setDarwinClock(targetUtcMs);
			if (errno) return { outcome: errno === 1 || errno === 13 ? { kind: 'denied', output: `settimeofday failed: errno ${errno}`, stateMayHaveChanged: false } : { kind: 'failed', code: errno, output: `settimeofday failed: errno ${errno}`, stateMayHaveChanged: false } };
			return { outcome: { kind: 'ok', output: '' }, clock: { targetUtcMs, hostUptimeMs, bootId } };
		}
		if (request.kind === 'timezone') {
			const before = readDarwinTimeZone()?.zone ?? null;
			if ((before?.fingerprint ?? null) !== request.zoneFingerprint) throw new Error('The timezone changed before writing');
			const target = prepareDarwinTimeZone(request.timezone, before);
			if (target.fingerprint !== request.targetFingerprint || !target.link) throw new Error('The target timezone changed before writing');
			const temporary = `${DARWIN_LOCALTIME}.lish-${randomUUID()}`;
			try {
				symlinkSync(target.link, temporary); lchownSync(temporary, target.uid, target.gid); lchmodSync(temporary, target.mode);
				if ((readDarwinTimeZone()?.zone.fingerprint ?? null) !== request.zoneFingerprint) throw new Error('The timezone changed during publication');
				renameSync(temporary, DARWIN_LOCALTIME); changed = true;
				syncDarwinTimeDirectory();
				if (notifyDarwinTimezone() !== 0) throw new Error('macOS did not accept the timezone notification');
			} finally { if (!changed) { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } } }
			return { outcome: { kind: 'ok', output: '' } };
		}
		const coreTime = openDarwinCoreTime();
		try {
			if (request.kind === 'enabled') {
				changed = true;
				return { outcome: await setAutomaticTime(request.enabled, coreTime) ? { kind: 'ok', output: '' } : unknown() };
			}
			if (!isValidNtpServer(request.server)) return { outcome: { kind: 'failed', code: null, output: 'Invalid NTP server', outcome: 'invalid-input', stateMayHaveChanged: false } };
			const before = readDarwinNtpFile();
			if ((before?.fingerprint ?? null) !== request.fileFingerprint || (before?.identity ?? null) !== request.fileIdentity || coreTime.symbols.TMIsAutomaticTimeEnabled() !== request.enabled) throw new Error('The time server or synchronization policy changed before writing');
			try { writeDarwinNtpFile(Buffer.from(`server ${request.server}\n`), before); changed = true; }
			catch (error) { changed = !!(error as { published?: boolean }).published; throw error; }
			return { outcome: await refreshDarwinAutomaticTime(request.enabled, enabled => setAutomaticTime(enabled, coreTime)) };
		} finally { coreTime.close(); }
	} catch (error) {
		const output = error instanceof Error ? error.message : String(error);
		const code = (error as NodeJS.ErrnoException).code;
		if (!changed && (code === 'EPERM' || code === 'EACCES')) return { outcome: { kind: 'denied', output, stateMayHaveChanged: false } };
		return { outcome: { kind: 'failed', code: null, output, stateMayHaveChanged: changed } };
	}
}
