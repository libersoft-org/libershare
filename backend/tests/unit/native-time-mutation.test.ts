import { describe, expect, test } from 'bun:test';
import { DBusError, type DBusReply } from '../../src/native/linux/dbus.ts';
import { LinuxTimeMutations, type LinuxTimeMutationDeps } from '../../src/native/linux/time-mutation.ts';
import { NativeMutationUnknown, type NativeMutationContext } from '../../src/native/mutation-host.ts';
import { withNativeMutationContext } from '../../src/native/mutation-context.ts';
import { clockMatchesRecovery } from '../../src/native/time-changes.ts';
import { sameTimezoneSource, type LinuxTimeSnapshot, type LinuxTimeRecovery } from '../../src/native/linux/time-mutation-state.ts';
import { executeTimeAccessProbe, timeAccessProbeCommand, type TimeAccessSyscalls } from '../../src/native/linux/time-access-probe.ts';
import { runOperations, withSaveBudget, type SystemOperation } from '../../src/system-time-common.ts';
import type { BoundDBusEndpoint } from '../../src/native/linux/dbus-worker.ts';

const zone = { resolved: '/usr/share/zoneinfo/Etc/UTC', name: 'Etc/UTC', sha256: 'a'.repeat(64), symlink: true };
const otherZone = { resolved: '/usr/share/zoneinfo/Europe/Prague', name: 'Europe/Prague', sha256: 'b'.repeat(64), symlink: true };
const snapshot: LinuxTimeSnapshot = { utcMs: 100000, hostUptimeMs: 20000, bootId: 'boot-1', timezone: zone, offsetSeconds: 0, targetUtcMs: 110000, targetTimezone: otherZone };
const endpoint: BoundDBusEndpoint = { connectionId: 'connection', rule: { kind: 'dbus-process', destination: ':1.42', busId: 'a'.repeat(32), process: { pid: 42, started: 'linux-starttime:123' } } };
const reply: DBusReply = { type: 'method_return', sender: ':1.42', signature: '', values: [], errorName: null, errorMessage: null };

function fixture() {
	let time = 0;
	let reads = 0;
	const metadata: LinuxTimeRecovery[] = [];
	const sent: Parameters<LinuxTimeMutationDeps['synchronous']['call']>[3][] = [];
	let current = { ...snapshot, utcMs: 111000, hostUptimeMs: 21000 };
	let invoke: () => Promise<DBusReply> = async () => reply;
	const context: NativeMutationContext = {
		operationId: 'time-test',
		dataDirectory: '.',
		remainingMs: () => 10000 - time,
		async call(_rule, action) {
			const value = await action();
			if (!value.known) throw new NativeMutationUnknown();
			return value.value;
		},
		async pending() {
			throw new NativeMutationUnknown();
		},
		async recordExecution() {},
		async recordRecovery(value) {
			metadata.push(value['time'] as unknown as LinuxTimeRecovery);
		},
	};
	const api = new LinuxTimeMutations({
		synchronous: {
			async bind() {
				return endpoint;
			},
			async call(_context, _endpoint, _method, request) {
				sent.push(request);
				return invoke();
			},
			close() {
				return true;
			},
		},
		reader: {
			async call<T>(request: { args?: unknown }) {
				reads++;
				return ((request.args as { clock?: unknown; timezone?: unknown }).clock || (request.args as { timezone?: unknown }).timezone ? snapshot : current) as T;
			},
			close() {
				return true;
			},
		},
		jobs: {
			async call<T>() {
				throw new Error('Unexpected jobs call');
				return undefined as T;
			},
			close() {
				return true;
			},
		},
		now: () => time,
		pause: async ms => {
			time += ms;
		},
	});
	return {
		api,
		context,
		metadata,
		sent,
		reads: () => reads,
		now: () => time,
		setCurrent: (value: LinuxTimeSnapshot) => {
			current = value;
		},
		setInvoke: (value: typeof invoke) => {
			invoke = value;
		},
		run: (operation: SystemOperation) => withNativeMutationContext(context, () => operation.run(new AbortController().signal)),
	};
}

function refusal(name: string, message = '', sender = ':1.42'): DBusError {
	return new DBusError({ ...reply, type: 'error', sender, errorName: name, errorMessage: message });
}

describe('native time operations', () => {
	test('records UTC and boot/uptime before sending SetTime', async () => {
		const f = fixture();
		f.setInvoke(async () => {
			expect(f.metadata[0]?.clock).toEqual({ targetUtcMs: 110000, hostUptimeMs: 20000, bootId: 'boot-1' });
			return reply;
		});
		expect((await f.run(f.api.clock({ hours: 12, minutes: 0, seconds: 0 }))).kind).toBe('ok');
		expect(f.sent[0]?.args).toEqual([110000000n, false, false]);
	});

	test('retries only the authenticated previous-request refusal for at most five seconds', async () => {
		const f = fixture();
		f.setInvoke(async () => {
			throw refusal('org.freedesktop.timedate1.AutomaticTimeSyncEnabled', 'Previous request is not finished, refusing.');
		});
		expect(await f.run(f.api.clock({ hours: 12, minutes: 0, seconds: 0 }))).toMatchObject({ kind: 'failed', stateMayHaveChanged: false });
		expect(f.now()).toBe(5000);
		expect(f.sent).toHaveLength(51);
	});

	test.each([
		['org.freedesktop.timedate1.AutomaticTimeSyncEnabled', 'Automatic time synchronization is enabled'],
		['org.freedesktop.DBus.Error.AccessDenied', 'Previous request is not finished'],
	])('does not retry %s with %s', async (name, message) => {
		const f = fixture();
		f.setInvoke(async () => {
			throw refusal(name, message);
		});
		await f.run(f.api.clock({ hours: 12, minutes: 0, seconds: 0 }));
		expect(f.sent).toHaveLength(1);
	});

	test('timezone AccessDenied checks the physical file and forbids blind elevation', async () => {
		const f = fixture();
		f.setInvoke(async () => {
			throw refusal('org.freedesktop.DBus.Error.AccessDenied');
		});
		expect(await f.run(f.api.timezone('Europe/Prague'))).toMatchObject({ kind: 'denied', stateMayHaveChanged: true });
		expect(f.reads()).toBe(2);
		expect(f.sent).toHaveLength(1);
	});

	test('a successful reply cannot hide an unchanged physical timezone file', async () => {
		const f = fixture();
		expect(await f.run(f.api.timezone('Europe/Prague'))).toMatchObject({ kind: 'failed', stateMayHaveChanged: true });
		f.setCurrent({ ...snapshot, timezone: otherZone });
		expect((await f.run(f.api.timezone('Europe/Prague'))).kind).toBe('ok');
	});

	test('unknown SetTime stops before readback', async () => {
		const f = fixture();
		f.setInvoke(async () => {
			throw new NativeMutationUnknown();
		});
		await expect(f.run(f.api.clock({ hours: 12, minutes: 0, seconds: 0 }))).rejects.toBeInstanceOf(NativeMutationUnknown);
		expect(f.reads()).toBe(1);
	});
});

describe('SystemOperation sequencing', () => {
	test('reports completed steps when a later step is denied', async () => {
		const outcome = await runOperations('linux', [
			{ describe: 'first', run: async () => ({ kind: 'ok', output: '' }) },
			{ describe: 'second', run: async () => ({ kind: 'denied', output: 'denied', stateMayHaveChanged: false }) },
		]);
		expect(outcome).toMatchObject({
			success: false,
			changed: true,
			stateMayHaveChanged: true,
			steps: [
				{ command: 'first', ok: true },
				{ command: 'second', ok: false },
			],
		});
	});

	test('budget expiration prevents the next dispatch without aborting the in-flight call', async () => {
		let time = 0;
		let next = false;
		const outcome = await withSaveBudget(
			() =>
				runOperations(
					'linux',
					[
						{
							describe: 'first',
							run: async signal => {
								time = 20;
								expect(signal.aborted).toBe(false);
								return { kind: 'ok', output: '' };
							},
						},
						{
							describe: 'second',
							run: async () => {
								next = true;
								return { kind: 'ok', output: '' };
							},
						},
					],
					() => time
				),
			() => time,
			10
		);
		expect(outcome.changed).toBe(true);
		expect(next).toBe(false);
	});

	test('unknown prevents the following operation', async () => {
		const f = fixture();
		let next = false;
		await expect(
			withNativeMutationContext(f.context, () =>
				runOperations('linux', [
					{ describe: 'first', run: async () => ({ kind: 'unknown', output: '', endRule: { kind: 'boot' } }) },
					{
						describe: 'second',
						run: async () => {
							next = true;
							return { kind: 'ok', output: '' };
						},
					},
				])
			)
		).rejects.toBeInstanceOf(NativeMutationUnknown);
		expect(next).toBe(false);
	});
});

describe('time recovery references', () => {
	test('projects the target with host uptime only inside the recorded boot', () => {
		const reference = { targetUtcMs: 100000, hostUptimeMs: 20000, bootId: 'boot-1' };
		expect(clockMatchesRecovery(reference, { ...snapshot, utcMs: 110000, hostUptimeMs: 30000 })).toBe(true);
		expect(clockMatchesRecovery(reference, { ...snapshot, utcMs: 110000, hostUptimeMs: 30000, bootId: 'boot-2' })).toBe(false);
		expect(clockMatchesRecovery({ ...reference, bootId: null }, snapshot)).toBe(false);
		expect(clockMatchesRecovery(reference, { ...snapshot, hostUptimeMs: 19000 })).toBe(false);
	});

	test('regular localtime copies match by bytes but symlinks also require the target', () => {
		expect(sameTimezoneSource({ ...zone, resolved: '/etc/localtime', symlink: false }, zone)).toBe(true);
		expect(sameTimezoneSource({ ...zone, resolved: '/usr/share/zoneinfo/Etc/GMT' }, zone)).toBe(false);
		expect(sameTimezoneSource(null, null)).toBe(true);
		expect(sameTimezoneSource(null, zone)).toBe(false);
	});
});

describe('dedicated access probe', () => {
	const request = { uid: 123, gid: 124, groups: [124, 125], path: '/etc/systemd/timesyncd.conf.d', mode: 'x' as const };
	test.each(['setgroups', 'setresgid', 'setresuid', 'none'])('drops groups, gid and uid before access; stops on %s failure', failure => {
		const calls: string[] = [];
		const step = (name: string) => {
			calls.push(name);
			return name === failure ? -1 : 0;
		};
		const syscalls: TimeAccessSyscalls = {
			setgroups: () => step('setgroups'),
			setresgid: () => step('setresgid'),
			setresuid: () => step('setresuid'),
			access: () => {
				calls.push('access');
				return { result: 0, errno: 0 };
			},
		};
		expect(executeTimeAccessProbe(request, syscalls)).toBe(failure === 'none' ? 0 : 3);
		const all = ['setgroups', 'setresgid', 'setresuid', 'access'];
		expect(calls).toEqual(failure === 'none' ? all : all.slice(0, all.indexOf(failure) + 1));
	});
	test('source mode launches the real app entry, never the test entry', () => {
		const command = timeAccessProbeCommand(request);
		expect(command[1]?.replaceAll('\\', '/')).toEndWith('/backend/src/app.ts');
		expect(command[2]).toBe('--access-probe');
	});
});
