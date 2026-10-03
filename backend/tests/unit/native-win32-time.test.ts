import { expect, test } from 'bun:test';
import { WindowsTimeMutations, type WindowsTimeMutationDeps } from '../../src/native/win32/time-mutation.ts';
import { observeWindowsTimeRecovery, windowsClockMatches, type WindowsTimeSnapshot } from '../../src/native/win32/time-state.ts';
import { systemTimeFromMs, windowsLocalClockToUtc, windowsTimezoneTarget } from '../../src/native/win32/time-zone.ts';
import { NativeMutationUnknown, type NativeMutationContext } from '../../src/native/mutation-host.ts';
import { withNativeMutationContext } from '../../src/native/mutation-context.ts';
import { runOperations, type SystemOperation } from '../../src/system-time-common.ts';
import type { WindowsTimeWrite, WindowsTimeWriteResult } from '../../src/native/win32/time-worker.ts';
import { getSystemTimeStatus, setSystemClock, setSystemNtpEnabled, setSystemNtpServer } from '../../src/system-time.ts';

type Writable<T> = { -readonly [K in keyof T]: Writable<T[K]> };
function snapshot(): Writable<WindowsTimeSnapshot> {
	return { utcMs: 100000, hostUptimeMs: 5000, bootId: 'boot-test', zone: { windowsId: 'UTC', utcOffsetMinutes: 0, daylightDisabled: false, hash: 'a'.repeat(64), bytes: '' }, mode: { mode: 'manual', start: 'disabled', membership: 'standalone', service: 'stopped', ntpClientEnabled: false }, policyManaged: false, registry: { type: 'NTP', server: 'time.example.org,0x8', start: 4, delayed: 0, client: 0 }, synchronized: false };
}
test.skipIf(process.platform !== 'win32')('Windows writers never fall back to an injected command runner', async () => {
	const status = await getSystemTimeStatus(async () => ({ timezone: 'UTC', ntpEnabled: false, ntpSynchronized: false, ntpServer: 'time.example.org', capabilities: { setClock: true, setTimezone: true, setNtpServer: true, setNtpEnabled: true } }));
	let commands = 0;
	const exec = async () => {
		commands++;
		return { kind: 'ok' as const, output: '' };
	};
	const mode = async () => snapshot().mode;
	const results = [await setSystemClock(1, 2, 3, async () => status, exec, mode), await setSystemNtpServer('time.example.org', async () => status, mode, exec), await setSystemNtpEnabled(false, async () => status, exec, mode)];
	expect(results.every(result => result.success === false)).toBe(true);
	expect(commands).toBe(0);
});
function fixture(answer: (request: WindowsTimeWrite, index: number) => WindowsTimeWriteResult, state: WindowsTimeSnapshot = snapshot()) {
	const calls: WindowsTimeWrite[] = [];
	const metadata: Record<string, unknown> = {};
	const context: NativeMutationContext = {
		operationId: crypto.randomUUID(),
		dataDirectory: process.cwd(),
		remainingMs: () => 30000,
		recordRecovery: async value => {
			Object.assign(metadata, value);
		},
		recordExecution: async (_rule, value) => {
			Object.assign(metadata, value);
		},
		pending: async () => {
			throw new NativeMutationUnknown();
		},
		call: async (rule, invoke) => {
			expect(rule).toEqual({ kind: 'boot' });
			const value = await invoke();
			if (!value.known) throw new NativeMutationUnknown();
			return value.value;
		},
	};
	const deps: WindowsTimeMutationDeps = {
		read: async () => structuredClone(state),
		writer: {
			call: async <T>(request: import('../../src/native/worker-host.ts').NativeWorkerRequest) => {
				calls.push(request.args as WindowsTimeWrite);
				return answer(request.args as WindowsTimeWrite, calls.length) as T;
			},
			close: () => true,
		},
	};
	const api = new WindowsTimeMutations(deps);
	return { calls, metadata, state, run: (operation: SystemOperation) => withNativeMutationContext(context, () => runOperations('win32', [operation])), api };
}
test('a native denial before the first change stays unchanged and requests permission', async () => {
	const f = fixture(() => ({ outcome: { kind: 'denied', output: 'Access denied', stateMayHaveChanged: false } }));
	const result = await f.run(f.api.ntpEnabled(true));
	expect(result).toMatchObject({ outcome: 'permission-denied', changed: false, stateMayHaveChanged: false });
	expect(f.calls).toHaveLength(1);
});
test('a confirmed later denial preserves partial-change flags and stops the sequence', async () => {
	const f = fixture((_request, index) => ({ outcome: index === 4 ? { kind: 'denied', output: 'Access denied', stateMayHaveChanged: false } : { kind: 'ok', output: '' } }));
	const result = await f.run(f.api.ntpEnabled(true));
	expect(result).toMatchObject({ outcome: 'permission-denied', changed: true, stateMayHaveChanged: true });
	expect(f.calls).toHaveLength(4);
	expect(f.calls.some(row => row.kind === 'resync')).toBe(false);
});
test('an unknown service RPC leaves boot-only ownership and never runs the next step', async () => {
	const f = fixture((_request, index) => ({ outcome: index === 4 ? { kind: 'unknown', output: 'RPC disconnected', endRule: { kind: 'boot' } } : { kind: 'ok', output: '' } }));
	await expect(f.run(f.api.ntpEnabled(true))).rejects.toBeInstanceOf(NativeMutationUnknown);
	expect(f.calls).toHaveLength(4);
});
test('domain and policy-managed sources are refused before any native write', async () => {
	for (const patch of [{ membership: 'domain' as const }, { mode: 'managed' as const }]) {
		const state = snapshot();
		state.mode = { ...state.mode, ...patch };
		const f = fixture(() => {
			throw new Error('must not write');
		}, state);
		expect((await f.run(f.api.ntpEnabled(false))).outcome).toBe('unsupported');
		expect(f.calls).toHaveLength(0);
	}
});
test('editing an inactive NTP peer notifies the service without enabling or syncing it', async () => {
	const state = snapshot();
	const f = fixture(request => {
		if (request.kind === 'server') state.registry = { ...state.registry, server: `${request.value},0x8` };
		return { outcome: { kind: 'ok', output: '' } };
	}, state);
	expect((await f.run(f.api.server('new.example.org'))).success).toBe(true);
	expect(f.calls.map(row => row.kind)).toEqual(['server', 'service']);
	expect(state.registry.type).toBe('NTP');
});
test('enabling the NTP client preserves an existing source and only initializes NoSync', async () => {
	for (const initialMode of ['none', 'manual'] as const) {
		const state = snapshot();
		state.mode.mode = initialMode;
		state.registry.type = initialMode === 'none' ? 'NoSync' : 'NTP';
		const f = fixture(request => {
			if (request.kind === 'client-enable') {
				state.registry.client = 1;
				state.mode.ntpClientEnabled = true;
			}
			if (request.kind === 'manual-source') {
				state.registry.type = 'NTP';
				state.mode.mode = 'manual';
			}
			if (request.kind === 'service') {
				if (request.operation.kind === 'start-mode') {
					state.registry.start = request.operation.value;
					state.mode.start = 'automatic';
				}
				if (request.operation.kind === 'delayed-start') state.registry.delayed = request.operation.enabled ? 1 : 0;
				if (request.operation.kind === 'start') state.mode.service = 'running';
			}
			return { outcome: { kind: 'ok', output: '' } };
		}, state);
		expect((await f.run(f.api.ntpEnabled(true))).success).toBe(true);
		expect(f.calls.filter(request => request.kind === 'manual-source')).toHaveLength(initialMode === 'none' ? 1 : 0);
		expect(f.calls.filter(request => request.kind === 'service' && request.operation.kind === 'notify')).toHaveLength(1);
		expect(f.calls[f.calls.length - 1]?.kind).toBe('resync');
		expect(state.registry.server).toBe('time.example.org,0x8');
	}
});
test('a timezone change retains the physical disabled-DST preference', async () => {
	const state = snapshot();
	state.zone = { ...state.zone, daylightDisabled: true };
	state.targetZone = { ...state.zone, windowsId: 'Tokyo Standard Time', hash: 'b'.repeat(64) };
	const f = fixture(request => {
		expect(request.kind).toBe('timezone');
		if (request.kind === 'timezone') {
			expect(request.target.daylightDisabled).toBe(true);
			state.zone = { ...request.target };
		}
		return { outcome: { kind: 'ok', output: '' } };
	}, state);
	expect((await f.run(f.api.timezone('Asia/Tokyo'))).success).toBe(true);
});
test('clock metadata uses the executor timestamp and carries no caller-supplied date', async () => {
	const state = snapshot();
	state.targetClock = { targetUtcMs: 120000, hostUptimeMs: 5000, bootId: state.bootId, localDate: '2026-10-3' };
	const proof = { targetUtcMs: 120000, hostUptimeMs: 5100, bootId: state.bootId };
	const f = fixture(request => {
		if (request.kind !== 'clock') throw new Error('Wrong request');
		expect(request.clock).toEqual({ hours: 1, minutes: 2, seconds: 3 });
		state.utcMs = 120300;
		state.hostUptimeMs = 5400;
		return { outcome: { kind: 'ok', output: '' }, clock: proof };
	}, state);
	expect((await f.run(f.api.clock({ hours: 1, minutes: 2, seconds: 3 }))).success).toBe(true);
	expect(f.metadata['windowsTime']).toMatchObject({ clock: proof });
});
test('clock proof binds the target to boot and monotonic uptime', () => {
	const current = snapshot(),
		proof = { targetUtcMs: 99000, hostUptimeMs: 4000, bootId: 'boot-test' };
	expect(windowsClockMatches(proof, current)).toBe(true);
	expect(windowsClockMatches({ ...proof, bootId: 'other' }, current)).toBe(false);
	expect(windowsClockMatches({ ...proof, targetUtcMs: 90000 }, current)).toBe(false);
	const changed = { ...current, utcMs: 120000 };
	expect(observeWindowsTimeRecovery(current, { clock: { hours: 1, minutes: 0, seconds: 0 } }, undefined, changed)).toEqual({ original: false, target: false });
});
test.skipIf(process.platform !== 'win32')('native Windows fold, gap and disabled-DST conversion matches the .NET oracle', () => {
	const cases: [string, string, string, boolean?][] = [
		['Europe/Prague', '2026-03-29T02:30:00Z', '2026-03-29T01:30:00Z'],
		['Europe/Prague', '2026-10-25T02:30:00Z', '2026-10-25T01:30:00Z'],
		['Europe/Prague', '2026-10-25T01:30:00Z', '2026-10-24T23:30:00Z'],
		['Europe/Prague', '2026-07-01T12:00:00Z', '2026-07-01T10:00:00Z'],
		['Australia/Lord_Howe', '2026-04-05T01:45:00Z', '2026-04-04T15:15:00Z'],
		['Australia/Lord_Howe', '2026-10-04T02:15:00Z', '2026-10-03T15:45:00Z'],
		['Australia/Lord_Howe', '2026-07-01T12:00:00Z', '2026-07-01T01:30:00Z'],
		['Australia/Sydney', '2026-04-05T02:30:00Z', '2026-04-04T16:30:00Z'],
		['Australia/Sydney', '2026-10-04T02:30:00Z', '2026-10-03T16:30:00Z'],
		['Australia/Sydney', '2026-01-15T12:00:00Z', '2026-01-15T01:00:00Z'],
		['Europe/Prague', '2026-07-01T12:00:00Z', '2026-07-01T11:00:00Z', true],
		['Europe/Prague', '2026-10-25T02:30:00Z', '2026-10-25T01:30:00Z', true],
	];
	for (const [zone, local, expected, disabled] of cases) {
		const value = windowsTimezoneTarget(zone, disabled ?? false);
		expect(windowsLocalClockToUtc(Buffer.from(value.bytes, 'base64'), systemTimeFromMs(Date.parse(local)))).toBe(Date.parse(expected));
	}
});
