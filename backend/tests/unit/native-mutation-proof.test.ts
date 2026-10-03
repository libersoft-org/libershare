import { expect, test } from 'bun:test';
import { classifyDBusMutation, classifyWmiMutation, hasNativeExecutionEnded, type NativePendingExecution, type NativeEndObservation } from '../../src/native/mutation-proof.ts';

const executor = { pid: 101, started: 'instance-a' };
const service = { pid: 202, started: 'instance-b' };
const operation: NativePendingExecution = { bootId: 'boot-a', executor, executorReturned: false, endRule: { kind: 'dbus-process', busId: 'bus-a', destination: ':1.15', process: service } };
const stopped: NativeEndObservation = { bootId: 'boot-a', executor: { identity: executor, state: 'ended' }, busId: 'bus-a', service: { identity: service, state: 'ended' } };

test('helper completion proof belongs to the exact request and cannot interrupt a live caller', () => {
	const operationId = crypto.randomUUID();
	const requestHash = 'a'.repeat(64);
	const pending: NativePendingExecution = { ...operation, endRule: { kind: 'helper', operationId, requestHash, cancelPath: '/test/cancel', launcher: null } };
	const helper = { operationId, requestHash, state: 'ended' as const };
	expect(hasNativeExecutionEnded(pending, { ...stopped, helper })).toBe(true);
	expect(hasNativeExecutionEnded(pending, { ...stopped, helper: { ...helper, operationId: crypto.randomUUID() } })).toBe(false);
	expect(hasNativeExecutionEnded(pending, { ...stopped, helper: { ...helper, requestHash: 'b'.repeat(64) } })).toBe(false);
	expect(hasNativeExecutionEnded(pending, { ...stopped, helper: { ...helper, state: 'unknown' } })).toBe(false);
	expect(hasNativeExecutionEnded(pending, { ...stopped, helper, executor: { identity: executor, state: 'running' } })).toBe(false);
	expect(hasNativeExecutionEnded({ ...pending, executorReturned: true }, { ...stopped, helper, executor: { identity: executor, state: 'running' } })).toBe(true);
});

test('requires the recorded executor and endpoint to end on the same bus', () => {
	expect(hasNativeExecutionEnded(operation, stopped)).toBe(true);
	for (const evidence of [
		{ ...stopped, executor: { identity: executor, state: 'running' as const } },
		{ ...stopped, service: { identity: service, state: 'running' as const } },
		{ ...stopped, service: { identity: { ...service, started: 'another-instance' }, state: 'ended' as const } },
		{ ...stopped, busId: 'new-bus' },
		{ ...stopped, busId: undefined },
	])
		expect(hasNativeExecutionEnded(operation, evidence as NativeEndObservation)).toBe(false);
});

test('a new observed boot ends old work, but an unreadable boot does not', () => {
	const pending = { ...operation, endRule: { kind: 'boot' as const } };
	expect(hasNativeExecutionEnded(pending, stopped)).toBe(false);
	expect(hasNativeExecutionEnded(pending, { ...stopped, bootId: null })).toBe(false);
	expect(hasNativeExecutionEnded({ ...pending, bootId: null }, { ...stopped, bootId: 'boot-b' })).toBe(false);
	expect(hasNativeExecutionEnded(pending, { ...stopped, bootId: 'boot-b' })).toBe(true);
});

test('an unknown call that returned still waits for its service, not for the backend to exit', () => {
	const returned = { ...operation, executorReturned: true };
	const backendAlive = { ...stopped, executor: { identity: executor, state: 'running' as const } };
	expect(hasNativeExecutionEnded(returned, backendAlive)).toBe(true);
	expect(hasNativeExecutionEnded(returned, { ...backendAlive, service: { identity: service, state: 'running' } })).toBe(false);
});

test('process-only work still requires the correct executor identity', () => {
	const pending = { ...operation, endRule: { kind: 'executor' as const } };
	expect(hasNativeExecutionEnded(pending, stopped)).toBe(true);
	expect(hasNativeExecutionEnded(pending, { ...stopped, executor: { identity: { pid: 303, started: executor.started }, state: 'ended' } })).toBe(false);
});

test('only bus-originated non-delivery on a unique destination proves no change', () => {
	expect(classifyDBusMutation('nm', ':1.15', { type: 'error', sender: 'org.freedesktop.DBus', errorName: 'org.freedesktop.DBus.Error.ServiceUnknown' })).toEqual({ kind: 'not-applied' });
	expect(classifyDBusMutation('nm', ':1.15', { type: 'error', sender: ':1.99', errorName: 'org.freedesktop.DBus.Error.ServiceUnknown' }).kind).toBe('unknown');
	expect(() => classifyDBusMutation('nm', 'org.freedesktop.NetworkManager', null)).toThrow('unique D-Bus name');
});

test.each(['org.freedesktop.DBus.Error.NoReply', 'org.freedesktop.DBus.Error.Disconnected'])('transport failure %s does not release a mutation', errorName => {
	expect(classifyDBusMutation('nm', ':1.15', { type: 'error', sender: 'org.freedesktop.DBus', errorName })).toEqual({ kind: 'unknown', endRule: 'dbus-process' });
});

test('timedated AccessDenied requires host readback while authorization refusal proves no write', () => {
	expect(classifyDBusMutation('timedated.SetTimezone', ':1.15', { type: 'error', sender: ':1.15', errorName: 'org.freedesktop.DBus.Error.AccessDenied' })).toEqual({ kind: 'confirmed', success: false, followUp: 'state' });
	expect(classifyDBusMutation('timedated.SetTimezone', ':1.15', { type: 'error', sender: ':1.15', errorName: 'org.freedesktop.DBus.Error.InteractiveAuthorizationRequired' })).toEqual({ kind: 'not-applied' });
});

test.each(['org.freedesktop.DBus.Error.AccessDenied', 'org.freedesktop.DBus.Error.Timeout', 'org.freedesktop.DBus.Error.NoReply'])('authentic SetNTP error %s still needs reboot proof', errorName => {
	expect(classifyDBusMutation('timedated.SetNTP', ':1.15', { type: 'error', sender: ':1.15', errorName })).toEqual({ kind: 'unknown', endRule: 'boot' });
});

test('successful NTP and restart replies still need job completion and readback', () => {
	expect(classifyDBusMutation('timedated.SetNTP', ':1.15', { type: 'method_return', sender: ':1.15', errorName: null })).toEqual({ kind: 'confirmed', success: true, followUp: 'ntp-jobs' });
	expect(classifyDBusMutation('systemd.RestartUnit', ':1.15', { type: 'method_return', sender: ':1.15', errorName: null })).toEqual({ kind: 'confirmed', success: true, followUp: 'unit-job' });
});

test('WMI distinguishes method failure from transport uncertainty', () => {
	expect(classifyWmiMutation(0, null)).toBe('ok');
	expect(classifyWmiMutation(0, 0)).toBe('ok');
	expect(classifyWmiMutation(0, 5)).toBe('failed');
	expect(classifyWmiMutation(0x80041008, null)).toBe('rejected');
	expect(classifyWmiMutation(0x80041002 | 0, null)).toBe('rejected');
	for (const code of [0x800706ba, 0x80010108, 0x80041015, 0x80004005]) expect(classifyWmiMutation(code, null)).toBe('unknown');
	expect(classifyWmiMutation(Number.NaN, null)).toBe('unknown');
	expect(classifyWmiMutation(0, Number.POSITIVE_INFINITY)).toBe('unknown');
});
