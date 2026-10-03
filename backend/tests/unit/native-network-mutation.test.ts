import { describe, expect, test } from 'bun:test';
import { applyNativeLinuxIPv4, updateNativeIPv4Settings, assertNativeIPv4Settings, nativeIPv4ProfileFingerprint, observeNativeLinuxIPv4Profile, type NativeNetworkSettings, type NativeNetworkMutationDeps, type NativeIPv4MutationOptions } from '../../src/native/linux/network-mutation.ts';
import { DBusError, DBusTransportError, variant, type DBusReply, type DBusVariant } from '../../src/native/linux/dbus.ts';
import { NativeMutationUnknown, type NativeMutationContext } from '../../src/native/mutation-host.ts';
import type { BoundDBusEndpoint } from '../../src/native/linux/dbus-worker.ts';

const NM = 'org.freedesktop.NetworkManager';
const ROOT = '/org/freedesktop/NetworkManager';
const DEVICE = `${ROOT}/Devices/1`,
	PROFILE = `${ROOT}/Settings/1`,
	ACTIVE = `${ROOT}/ActiveConnection/1`,
	CHECKPOINT = `${ROOT}/Checkpoint/1`;
const options: NativeIPv4MutationOptions = { addressingChanged: true, requireLease: true, readTimeoutMs: 5000, updateTimeoutMs: 5000, activationTimeoutMs: 95000, rollbackTimeoutMs: 95000, checkpointSafetyMs: 30000, checkpointTimeoutSeconds: 256 };

function settings(): NativeNetworkSettings {
	return { connection: { uuid: variant('s', '00000000-0000-4000-8000-000000000001'), type: variant('s', '802-3-ethernet'), 'interface-name': variant('s', 'eth0') }, ipv4: { method: variant('s', 'auto'), dns: variant('au', [0x350200c0]), 'ignore-auto-dns': variant('b', true) }, ipv6: { method: variant('s', 'auto'), dns: variant('aay', [Buffer.from('20010db8000000000000000000000053', 'hex')]), 'ignore-auto-dns': variant('b', true) }, '802-3-ethernet': { mtu: variant('u', 1500) } };
}

function fixture() {
	const endpoint: BoundDBusEndpoint = { connectionId: 'connection-1', rule: { kind: 'dbus-process', busId: 'a'.repeat(32), destination: ':1.42', process: { pid: 42, started: '1234' } } };
	const original = settings();
	const state = { saved: structuredClone(original), applied: structuredClone(original), remaining: 255000, clock: 0, pending: false, closed: false, duplicate: false, unknown: '', failure: '', activationState: 2, expireAfterUpdate: false, wrongDns: false, rollbackWrongDevice: false, rollbackBusyReads: 0, rollbackBusy: 0 };
	const writes: Parameters<NativeNetworkMutationDeps['mutate']>[2][] = [];
	const reads: Parameters<NativeNetworkMutationDeps['read']>[1][] = [];
	const recovery: unknown[] = [];
	const reply = (signature: string, ...values: DBusReply['values']): DBusReply => ({ type: 'method_return', sender: ':1.42', signature, values, errorName: null, errorMessage: null });
	const rejected = (): DBusError => new DBusError({ type: 'error', sender: ':1.42', signature: '', values: [], errorName: `${NM}.Failed`, errorMessage: 'Rejected' });
	const context: NativeMutationContext = {
		dataDirectory: '/tmp/native-network-mutation-test',
		recordExecution: async () => {
			throw new Error('The direct NetworkManager adapter cannot start another executor');
		},
		operationId: 'operation-1',
		remainingMs: () => state.remaining,
		recordRecovery: async data => {
			recovery.push(data);
		},
		pending: async rule => {
			expect(rule).toEqual(endpoint.rule);
			state.pending = true;
			throw new NativeMutationUnknown();
		},
		call: async (_rule, invoke) => {
			const result = await invoke();
			if (!result.known) {
				state.pending = true;
				throw new NativeMutationUnknown();
			}
			return result.value;
		},
	};
	const deps: NativeNetworkMutationDeps = {
		bind: async () => endpoint,
		read: async (_endpoint, request) => {
			reads.push(request);
			if (request.member === 'GetDeviceByIpIface') return reply('o', DEVICE);
			if (request.member === 'GetConnectionByUuid') return reply('o', PROFILE);
			if (request.member === 'GetSettings') return reply('a{sa{sv}}', structuredClone(state.saved));
			if (request.member !== 'GetAll') throw new Error(`Unexpected read ${request.member}`);
			if (request.path === ROOT) return reply('a{sv}', { ActiveConnections: variant('ao', state.duplicate ? [ACTIVE, `${ACTIVE}2`] : [ACTIVE]) });
			if (request.path === DEVICE) {
				// After a rollback NetworkManager is still reactivating for `rollbackBusyReads` reads.
				const restoring = state.rollbackBusyReads > 0;
				if (restoring) state.rollbackBusyReads--;
				return reply('a{sv}', { Managed: variant('b', true), State: variant('u', restoring ? 70 : 100), ActiveConnection: variant('o', ACTIVE), Ip4Config: variant('o', `${ROOT}/IP4Config/1`), Ip6Config: variant('o', `${ROOT}/IP6Config/1`) });
			}
			if (request.path.startsWith(ACTIVE)) return reply('a{sv}', { Uuid: original['connection']!['uuid']!, Connection: variant('o', PROFILE), Devices: variant('ao', [DEVICE]), State: variant('u', state.activationState) });
			if (request.path.includes('/IP')) {
				const family = request.path.includes('/IP4') ? 4 : 6;
				const ip = state.applied[`ipv${family}`]!;
				if (state.wrongDns) return reply('a{sv}', { NameserverData: variant('aa{sv}', []) });
				return reply('a{sv}', { Nameservers: ip['dns'] ?? variant(family === 4 ? 'au' : 'aay', []) });
			}
			throw new Error('Unexpected read path');
		},
		mutate: async (_context, _endpoint, request) => {
			writes.push(request);
			if (request.member === 'Update2') state.saved = structuredClone(request.args![0]) as NativeNetworkSettings;
			if (request.member === state.unknown) {
				state.pending = true;
				throw new NativeMutationUnknown();
			}
			if (request.member === state.failure) throw rejected();
			if (request.member === 'CheckpointCreate') return reply('o', CHECKPOINT);
			if (request.member === 'Update2') {
				if (state.expireAfterUpdate) state.remaining = 0;
				return reply('a{sv}', {});
			}
			if (request.member === 'ActivateConnection' || request.member === 'Reapply') {
				state.applied = structuredClone(state.saved);
				return request.member === 'ActivateConnection' ? reply('o', ACTIVE) : reply('');
			}
			if (request.member === 'CheckpointDestroy') return reply('');
			if (request.member === 'CheckpointRollback') {
				state.rollbackBusyReads = state.rollbackBusy;
				state.saved = structuredClone(original);
				state.applied = structuredClone(original);
				return reply('a{su}', { [state.rollbackWrongDevice ? `${DEVICE}2` : DEVICE]: 0 });
			}
			throw new Error(`Unexpected mutation ${request.member}`);
		},
		kernel: async () => {
			const ip = state.applied['ipv4']!;
			const manual = ip['method']?.value === 'manual';
			const data = ip['address-data']?.value as Record<string, DBusVariant>[] | undefined;
			return { links: [{ ifname: 'eth0', ifindex: 2, flags: ['UP'], operstate: 'UP', link_type: 'ether' }], addresses: [{ index: 2, family: 'inet', local: manual ? String(data![0]!['address']!.value) : '192.0.2.20', prefixlen: manual ? Number(data![0]!['prefix']!.value) : 24, flags: 0, scope: 'global', dynamic: !manual, tentative: false, deprecated: false, dadfailed: false, valid_life_time: manual ? 0xffffffff : 3600 }], routes4: ip['gateway'] ? [{ dst: 'default', dev: 'eth0', gateway: String(ip['gateway'].value), protocol: 'static', flags: [] }] : [], routes6: [] };
		},
		now: () => state.clock,
		sleep: async ms => {
			state.clock += ms;
			state.remaining -= ms;
		},
		close: () => {
			state.closed = true;
		},
	};
	return { context, deps, writes, reads, recovery, state, original };
}

describe('typed IPv4 profile updates', () => {
	test('DNS undefined leaves both policies and unrelated variants untouched', () => {
		const original = settings();
		const updated = updateNativeIPv4Settings(original, { mode: 'static', address: '192.0.2.10', prefixLength: 24 }, true);
		expect(updated['ipv4']!['dns']).toEqual(original['ipv4']!['dns']);
		expect(updated['ipv6']).toEqual(original['ipv6']);
		expect(updated['802-3-ethernet']).toEqual(original['802-3-ethernet']);
		expect(original['ipv4']!['method']!.value).toBe('auto');
	});
	test('DNS-only changes preserve methods, addresses, gateway and route policy', () => {
		const original = updateNativeIPv4Settings(settings(), { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' }, true);
		original['ipv4']!['route-metric'] = variant('x', 200n);
		const updated = updateNativeIPv4Settings(original, { mode: 'dhcp', dns: ['198.51.100.53', '2001:db8::54'] }, false);
		for (const key of ['method', 'address-data', 'gateway', 'route-metric']) expect(updated['ipv4']![key]).toEqual(original['ipv4']![key]);
		expect(updated['ipv6']!['method']).toEqual(original['ipv6']!['method']);
		assertNativeIPv4Settings(updated, { mode: 'dhcp', dns: ['198.51.100.53', '2001:db8::54'] }, 'eth0', false);
	});
	test('automatic DNS clears both families and manual DHCP fields are removed', () => {
		const original = updateNativeIPv4Settings(settings(), { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' }, true);
		original['ipv4']!['addresses'] = variant('aau', [[0x0a0200c0, 24, 0x010200c0]]);
		const updated = updateNativeIPv4Settings(original, { mode: 'dhcp', dns: [] }, true);
		expect(updated['ipv4']!['addresses']).toBeUndefined();
		expect(updated['ipv4']!['gateway']).toBeUndefined();
		for (const family of [4, 6]) {
			expect(updated[`ipv${family}`]!['dns']!.value).toEqual([]);
			expect(updated[`ipv${family}`]!['ignore-auto-dns']!.value).toBe(false);
		}
		assertNativeIPv4Settings(updated, { mode: 'dhcp', dns: [] }, 'eth0', true);
	});
	test('DNS-only does not create IPv6 and IPv6 DNS is rejected when disabled', () => {
		const original = settings();
		delete original['ipv6'];
		expect(updateNativeIPv4Settings(original, { mode: 'dhcp', dns: ['192.0.2.53'] }, false)['ipv6']).toBeUndefined();
		expect(() => updateNativeIPv4Settings(original, { mode: 'dhcp', dns: ['2001:db8::53'] }, false)).toThrow('IPv6 enabled');
		original['ipv6'] = { method: variant('s', 'disabled') };
		expect(() => updateNativeIPv4Settings(original, { mode: 'dhcp', dns: ['2001:db8::53'] }, false)).toThrow('IPv6 enabled');
	});
});

describe('journaled NetworkManager IPv4 transaction', () => {
	test('writes the complete typed profile to disk, activates and destroys a verified checkpoint', async () => {
		const f = fixture();
		await applyNativeLinuxIPv4(f.context, 'eth0', { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.53', '2001:db8::53'] }, options, f.deps);
		expect(f.writes.map(call => call.member)).toEqual(['CheckpointCreate', 'Update2', 'ActivateConnection', 'CheckpointDestroy']);
		expect(f.writes[0]!.args).toEqual([[DEVICE], 256, 2]);
		expect(f.writes[1]!.args?.slice(1)).toEqual([1, {}]);
		expect(f.recovery).toEqual([{ device: 'eth0', profilePath: PROFILE, profileUuid: '00000000-0000-4000-8000-000000000001', originalProfileFingerprint: nativeIPv4ProfileFingerprint(f.original) }, { checkpointPath: CHECKPOINT }]);
		expect(f.state.closed).toBe(true);
	});
	test('DHCP without a cable verifies only the saved profile and never activates or reapplies', async () => {
		const f = fixture();
		await applyNativeLinuxIPv4(f.context, 'eth0', { mode: 'dhcp', dns: [] }, { ...options, requireLease: false }, f.deps);
		expect(f.writes.map(call => call.member)).toEqual(['CheckpointCreate', 'Update2', 'CheckpointDestroy']);
		expect(f.state.applied).toEqual(f.original);
	});
	test('DNS-only uses Device.Reapply and retains the address fields', async () => {
		const f = fixture();
		await applyNativeLinuxIPv4(f.context, 'eth0', { mode: 'dhcp', dns: ['198.51.100.53'] }, { ...options, addressingChanged: false }, f.deps);
		expect(f.writes.map(call => call.member)).toEqual(['CheckpointCreate', 'Update2', 'Reapply', 'CheckpointDestroy']);
		expect(f.writes[2]!.args).toEqual([{}, 0n, 0]);
	});
	test('known failure after a partial update rolls back before rejecting', async () => {
		const f = fixture();
		f.state.failure = 'Update2';
		await expect(applyNativeLinuxIPv4(f.context, 'eth0', { mode: 'dhcp', dns: [] }, options, f.deps)).rejects.toBeInstanceOf(DBusError);
		expect(f.writes.map(call => call.member)).toEqual(['CheckpointCreate', 'Update2', 'CheckpointRollback']);
		expect(f.state.saved).toEqual(f.original);
	});
	test('a rollback still reactivating is pending until NetworkManager goes quiet', async () => {
		const settles = fixture();
		settles.state.failure = 'Update2';
		settles.state.rollbackBusy = 20;
		await expect(applyNativeLinuxIPv4(settles.context, 'eth0', { mode: 'dhcp', dns: [] }, options, settles.deps)).rejects.toBeInstanceOf(DBusError);
		expect(settles.state.rollbackBusyReads).toBe(0);
		expect(settles.state.pending).toBe(false);
		const stuck = fixture();
		stuck.state.failure = 'Update2';
		stuck.state.rollbackBusy = Number.MAX_SAFE_INTEGER;
		await expect(applyNativeLinuxIPv4(stuck.context, 'eth0', { mode: 'dhcp', dns: [] }, options, stuck.deps)).rejects.toBeInstanceOf(NativeMutationUnknown);
		expect(stuck.state.pending).toBe(true);
		expect(stuck.writes[stuck.writes.length - 1]!.member).toBe('CheckpointRollback');
	});
	test('unknown update or activation never triggers rollback or retry', async () => {
		for (const member of ['Update2', 'ActivateConnection']) {
			const f = fixture();
			f.state.unknown = member;
			await expect(applyNativeLinuxIPv4(f.context, 'eth0', { mode: 'dhcp' }, options, f.deps)).rejects.toBeInstanceOf(NativeMutationUnknown);
			expect(f.writes[f.writes.length - 1]!.member).toBe(member);
			expect(f.writes.filter(call => call.member === member)).toHaveLength(1);
			expect(f.state.pending).toBe(true);
		}
	});
	test('transport loss after send leaves the checkpoint pending', async () => {
		const f = fixture();
		const mutate = f.deps.mutate;
		await expect(
			applyNativeLinuxIPv4(f.context, 'eth0', { mode: 'dhcp' }, options, {
				...f.deps,
				mutate: async (context, endpoint, request) => {
					if (request.member === 'Update2') throw new DBusTransportError('Lost reply', 'process', true);
					return mutate(context, endpoint, request);
				},
			})
		).rejects.toBeInstanceOf(DBusTransportError);
		expect(f.writes.map(call => call.member)).toEqual(['CheckpointCreate']);
	});
	test('an expired budget with a live checkpoint marks pending without another write', async () => {
		const f = fixture();
		f.state.expireAfterUpdate = true;
		await expect(applyNativeLinuxIPv4(f.context, 'eth0', { mode: 'dhcp' }, options, f.deps)).rejects.toBeInstanceOf(NativeMutationUnknown);
		expect(f.writes.map(call => call.member)).toEqual(['CheckpointCreate', 'Update2']);
		expect(f.state.pending).toBe(true);
	});
	test('duplicate profile instances and malformed settings fail before checkpoint creation', async () => {
		for (const failure of ['duplicate', 'incomplete', 'unbound']) {
			const f = fixture();
			if (failure === 'duplicate') f.state.duplicate = true;
			else if (failure === 'incomplete') delete f.state.saved['ipv4']!['method'];
			else delete f.state.saved['connection']!['interface-name'];
			await expect(applyNativeLinuxIPv4(f.context, 'eth0', { mode: 'dhcp' }, options, f.deps)).rejects.toThrow();
			expect(f.writes).toHaveLength(0);
		}
	});
	test('IPv6 DNS on an IPv4-only profile is rejected before the first mutation', async () => {
		const f = fixture();
		delete f.state.saved['ipv6'];
		await expect(applyNativeLinuxIPv4(f.context, 'eth0', { mode: 'dhcp', dns: ['2001:db8::53'] }, options, f.deps)).rejects.toThrow('IPv6 enabled');
		expect(f.writes).toHaveLength(0);
	});
	test('read-back mismatch rolls back and a result for the wrong device is rejected', async () => {
		const f = fixture();
		f.state.wrongDns = true;
		f.state.rollbackWrongDevice = true;
		await expect(applyNativeLinuxIPv4(f.context, 'eth0', { mode: 'dhcp', dns: ['198.51.100.53'] }, options, f.deps)).rejects.toBeInstanceOf(AggregateError);
		expect(f.writes[f.writes.length - 1]!.member).toBe('CheckpointRollback');
	});
});

describe('saved profile recovery evidence', () => {
	test('DHCP completion requires a usable kernel lease while an offline save does not', async () => {
		const f = fixture();
		const options = { profilePath: PROFILE, profileUuid: '00000000-0000-4000-8000-000000000001', addressingChanged: true, requireLease: true, timeoutMs: 5000 };
		for (const failure of ['static', 'link-local']) {
			const deps: NativeNetworkMutationDeps = {
				...f.deps,
				kernel: async timeoutMs => {
					const state = await f.deps.kernel(timeoutMs);
					const address = state.addresses[0]!;
					if (failure === 'static') {
						address.dynamic = false;
						address.valid_life_time = 0xffffffff;
					} else address.local = '169.254.1.2';
					return state;
				},
			};
			expect((await observeNativeLinuxIPv4Profile('eth0', { mode: 'dhcp' }, options, deps)).matchesDesired).toBe(false);
			expect((await observeNativeLinuxIPv4Profile('eth0', { mode: 'dhcp' }, { ...options, requireLease: false }, deps)).matchesDesired).toBe(true);
		}
		await expect(
			observeNativeLinuxIPv4Profile('eth0', { mode: 'dhcp' }, options, {
				...f.deps,
				kernel: async () => {
					throw new Error('Kernel read failed');
				},
			})
		).rejects.toThrow('Kernel read failed');
	});
	test('an identical saved profile cannot prove that a different active profile applies to the device', async () => {
		const f = fixture();
		const read = f.deps.read;
		const deps: NativeNetworkMutationDeps = {
			...f.deps,
			read: async (endpoint, request, timeoutMs) => {
				const reply = await read(endpoint, request, timeoutMs);
				if (request.path === ACTIVE) (reply.values[0] as Record<string, DBusVariant>)['Uuid'] = variant('s', '00000000-0000-4000-8000-000000000002');
				return reply;
			},
		};
		const options = { profilePath: PROFILE, profileUuid: '00000000-0000-4000-8000-000000000001', addressingChanged: false, requireLease: true, timeoutMs: 5000 };
		const active = await observeNativeLinuxIPv4Profile('eth0', { mode: 'dhcp' }, options, deps);
		expect(active.fingerprint).toBe(nativeIPv4ProfileFingerprint(f.original));
		expect(active.matchesDesired).toBe(true);
		expect(active.appliesToDevice).toBe(false);
		const offline = await observeNativeLinuxIPv4Profile('eth0', { mode: 'dhcp' }, { ...options, requireLease: false }, deps);
		expect(offline.appliesToDevice).toBe(true);
		expect(f.writes).toHaveLength(0);
	});
	test('re-resolves UUID after object paths change and reports a deleted profile as missing', async () => {
		const f = fixture();
		const options = { profilePath: `${PROFILE}99`, profileUuid: '00000000-0000-4000-8000-000000000001', addressingChanged: false, requireLease: true, timeoutMs: 5000 };
		const found = await observeNativeLinuxIPv4Profile('eth0', { mode: 'dhcp' }, options, f.deps);
		expect(found.exists).toBe(true);
		expect(f.reads.find(request => request.member === 'GetSettings')?.path).toBe(PROFILE);
		const missing = await observeNativeLinuxIPv4Profile('eth0', { mode: 'dhcp' }, options, { ...f.deps, read: async () => ({ type: 'error', sender: ':1.42', signature: '', values: [], errorName: `${NM}.Settings.InvalidConnection`, errorMessage: 'No connection with the UUID was found' }) });
		expect(missing).toEqual({ exists: false, appliesToDevice: false, fingerprint: null, matchesDesired: false });
		expect(f.writes).toHaveLength(0);
	});
	test('automatic DNS is not proven by an unchanged live address', async () => {
		const f = fixture();
		const options = { profilePath: PROFILE, profileUuid: '00000000-0000-4000-8000-000000000001', addressingChanged: false, requireLease: true, timeoutMs: 5000 };
		const original = await observeNativeLinuxIPv4Profile('eth0', { mode: 'dhcp', dns: [] }, options, f.deps);
		expect(original.matchesDesired).toBe(false);
		expect(original.fingerprint).toBe(nativeIPv4ProfileFingerprint(f.original));
		f.state.saved = updateNativeIPv4Settings(f.original, { mode: 'dhcp', dns: [] }, false);
		const updated = await observeNativeLinuxIPv4Profile('eth0', { mode: 'dhcp', dns: [] }, options, f.deps);
		expect(updated.matchesDesired).toBe(true);
		expect(updated.fingerprint).not.toBe(original.fingerprint);
		expect(f.writes).toHaveLength(0);
	});
	test('fingerprints ignore activation timestamps but retain all IPv4 and IPv6 policy', () => {
		const original = settings(),
			copy = structuredClone(original);
		copy['connection']!['timestamp'] = variant('t', 200n);
		expect(nativeIPv4ProfileFingerprint(copy)).toBe(nativeIPv4ProfileFingerprint(original));
		copy['ipv6']!['route-metric'] = variant('x', 30n);
		expect(nativeIPv4ProfileFingerprint(copy)).not.toBe(nativeIPv4ProfileFingerprint(original));
	});
});
