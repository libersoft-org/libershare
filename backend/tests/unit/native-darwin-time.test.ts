import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { darwinNtpFingerprint, readDarwinNtpFile, writeDarwinNtpFile } from '../../src/native/darwin/time-files.ts';
import { darwinClockMatches, observeDarwinTimeRecovery, type DarwinTimeSnapshot } from '../../src/native/darwin/time-state.ts';
import { DarwinTimeMutations } from '../../src/native/darwin/time-mutation.ts';
import { prepareDarwinClock } from '../../src/native/darwin/time-native.ts';
import { NativeMutationUnknown, type NativeMutationContext } from '../../src/native/mutation-host.ts';
import { withNativeMutationContext } from '../../src/native/mutation-context.ts';
import { refreshDarwinAutomaticTime, type DarwinTimeWrite, type DarwinTimeWriteResult } from '../../src/native/darwin/time-worker.ts';

const zone = { link: '/var/db/timezone/zoneinfo/Etc/UTC', resolved: '/var/db/timezone/zoneinfo/Etc/UTC', name: 'Etc/UTC', sha256: 'a'.repeat(64), uid: 0, gid: 0, mode: 0o755, fingerprint: 'b'.repeat(64) };
const snapshot: DarwinTimeSnapshot = { utcMs: 100000, hostUptimeMs: 20000, bootId: 'boot-1', zone, offsetMinutes: 0, ntpEnabled: false, ntpServer: 'ntp.example.org', ntpFingerprint: 'c'.repeat(64), ntpIdentity: 'file-identity' };

test('Darwin clock recovery rejects a new boot or a missing monotonic reference', () => {
	const proof = { targetUtcMs: 100000, hostUptimeMs: 20000, bootId: 'boot-1' };
	expect(darwinClockMatches(proof, { ...snapshot, utcMs: 101000, hostUptimeMs: 21000 })).toBe(true);
	expect(darwinClockMatches(proof, { ...snapshot, bootId: 'boot-2' })).toBe(false);
	expect(darwinClockMatches({ ...proof, bootId: null }, snapshot)).toBe(false);
});

test('the clock conversion refuses a process-local TZ before loading native code', () => {
	const original = process.env['TZ'];
	try {
		process.env['TZ'] = 'Etc/UTC';
		expect(() => prepareDarwinClock({ hours: 12, minutes: 0, seconds: 0 })).toThrow('without TZ');
	} finally {
		if (original === undefined) delete process.env['TZ'];
		else process.env['TZ'] = original;
	}
});

test('time recovery requires the symlink fingerprint, file metadata and preserved NTP state', () => {
	expect(observeDarwinTimeRecovery(snapshot, { timezone: 'Etc/UTC' }, undefined, snapshot).original).toBe(true);
	const current = { ...snapshot, zone: { ...zone, fingerprint: 'd'.repeat(64) } };
	expect(observeDarwinTimeRecovery(snapshot, { timezone: 'Etc/UTC' }, undefined, current)).toEqual({ original: false, target: false });
	expect(observeDarwinTimeRecovery(snapshot, { ntpServer: 'new.example.org' }, { server: { server: 'new.example.org', beforeFingerprint: snapshot.ntpFingerprint, targetFingerprint: 'e'.repeat(64) } }, { ...snapshot, ntpServer: 'new.example.org', ntpFingerprint: 'e'.repeat(64), ntpEnabled: true }).target).toBe(false);
});

test('the NTP fingerprint includes metadata and xattrs but ignores attribute order', () => {
	const file = { content: 'c2VydmVyCg==', uid: 0, gid: 0, mode: 0o644, xattrs: { a: 'AA==', b: 'AQ==' } };
	expect(darwinNtpFingerprint(file)).toBe(darwinNtpFingerprint({ ...file, xattrs: { b: 'AQ==', a: 'AA==' } }));
	expect(darwinNtpFingerprint(file)).not.toBe(darwinNtpFingerprint({ ...file, mode: 0o600 }));
	expect(darwinNtpFingerprint(file)).not.toBe(darwinNtpFingerprint({ ...file, xattrs: { a: 'AA==' } }));
});

function fixture(reply: DarwinTimeWriteResult) {
	const records: unknown[] = [],
		writes: DarwinTimeWrite[] = [];
	let reads = 0;
	const actual = { ...snapshot, utcMs: 111000, hostUptimeMs: 21000 };
	const context: NativeMutationContext = {
		operationId: 'test',
		dataDirectory: '.',
		remainingMs: () => 30000,
		async call(_rule, action) {
			const value = await action();
			if (!value.known) throw new NativeMutationUnknown();
			return value.value;
		},
		async pending() {
			throw new NativeMutationUnknown();
		},
		async recordRecovery(value) {
			records.push(value);
		},
		async recordExecution(_rule, value) {
			records.push(value);
		},
	};
	const mutations = new DarwinTimeMutations({
		read: async request => {
			reads++;
			return request?.clock ? { ...snapshot, targetClock: { targetUtcMs: 110000, hostUptimeMs: 20000, bootId: 'boot-1' } } : actual;
		},
		writer: {
			async call<T>(request: { args?: unknown }) {
				writes.push(request.args as DarwinTimeWrite);
				return reply as T;
			},
			close() {
				return true;
			},
		},
	});
	return { records, writes, reads: () => reads, clock: () => withNativeMutationContext(context, () => mutations.clock({ hours: 12, minutes: 0, seconds: 0 }).run(new AbortController().signal)) };
}

test('the actual worker mktime reference is retained before final clock verification', async () => {
	const clock = { targetUtcMs: 110500, hostUptimeMs: 20500, bootId: 'boot-1' };
	const f = fixture({ outcome: { kind: 'ok', output: '' }, clock });
	expect((await f.clock()).kind).toBe('ok');
	expect(f.records).toHaveLength(2);
	expect(f.records[1]).toEqual({ darwinTime: { clock } });
	expect(f.writes[0]).toMatchObject({ kind: 'clock', zoneFingerprint: zone.fingerprint });
});

test('unknown macOS clock work stops before readback', async () => {
	const f = fixture({ outcome: { kind: 'unknown', output: 'unknown', endRule: { kind: 'boot' } } });
	await expect(f.clock()).rejects.toBeInstanceOf(NativeMutationUnknown);
	expect(f.reads()).toBe(1);
});

test('a server change does not enable disabled synchronization', async () => {
	const calls: boolean[] = [];
	expect(
		(
			await refreshDarwinAutomaticTime(false, async enabled => {
				calls.push(enabled);
				return true;
			})
		).kind
	).toBe('ok');
	expect(calls).toEqual([]);
});

test('an unconfirmed CoreTime off forbids the following on request', async () => {
	const calls: boolean[] = [];
	expect(
		await refreshDarwinAutomaticTime(true, async enabled => {
			calls.push(enabled);
			return false;
		})
	).toMatchObject({ kind: 'unknown', endRule: { kind: 'boot' } });
	expect(calls).toEqual([false]);
});

test('an unconfirmed CoreTime on remains unknown after the confirmed off', async () => {
	const calls: boolean[] = [];
	expect(
		await refreshDarwinAutomaticTime(true, async enabled => {
			calls.push(enabled);
			return !enabled;
		})
	).toMatchObject({ kind: 'unknown', endRule: { kind: 'boot' } });
	expect(calls).toEqual([false, true]);
});

describe.skipIf(process.platform !== 'darwin')('atomic macOS NTP files', () => {
	test('preserves ownership, mode and every xattr through publication', () => {
		const directory = mkdtempSync(join(tmpdir(), 'lish-ntp-file-')),
			path = join(directory, 'ntp.conf');
		try {
			writeFileSync(path, 'server old.example.org\n');
			chmodSync(path, 0o640);
			execFileSync('/usr/bin/xattr', ['-wx', 'com.libershare.fixture', '00ff7f', path]);
			const original = readDarwinNtpFile(path)!;
			writeDarwinNtpFile(Buffer.from('server new.example.org\n'), original, path);
			const current = readDarwinNtpFile(path)!;
			expect({ uid: current.uid, gid: current.gid, mode: current.mode, xattrs: current.xattrs }).toEqual({ uid: original.uid, gid: original.gid, mode: original.mode, xattrs: original.xattrs });
			expect(readFileSync(path, 'utf8')).toBe('server new.example.org\n');
			expect(readdirSync(directory)).toEqual(['ntp.conf']);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test('a concurrent edit is not overwritten and staging files are removed', () => {
		const directory = mkdtempSync(join(tmpdir(), 'lish-ntp-race-')),
			path = join(directory, 'ntp.conf');
		try {
			writeFileSync(path, 'server old.example.org\n');
			const original = readDarwinNtpFile(path)!;
			writeFileSync(path, 'server administrator.example.org\n');
			expect(() => writeDarwinNtpFile(Buffer.from('server requested.example.org\n'), original, path)).toThrow('changed before publication');
			expect(readFileSync(path, 'utf8')).toBe('server administrator.example.org\n');
			expect(readdirSync(directory)).toEqual(['ntp.conf']);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
