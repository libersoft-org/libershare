import { describe, expect, test } from 'bun:test';
import { applyNativeWindowsIPv4, observeNativeWindowsIPv4, type WindowsIPv4MutationDeps } from '../../src/native/win32/network-mutation.ts';
import { WINDOWS_INFINITE_LIFETIME, windowsIPv4Fingerprint, type WindowsIPv4Address, type WindowsIPv4Recovery, type WindowsIPv4Snapshot } from '../../src/native/win32/network-mutation-state.ts';
import { executeWindowsIPv4Write, type WindowsIPv4Write, type WindowsIPv4WriteResult } from '../../src/native/win32/network-mutation-worker.ts';
import { NativeMutationUnknown, type NativeMutationContext } from '../../src/native/mutation-host.ts';
import type { WmiConnection } from '../../src/native/win32/wmi.ts';
import type { NetIPv4Config } from '@shared';

const guid = '{11111111-2222-3333-4444-555555555555}';
const staticConfig: NetIPv4Config = { mode: 'static', address: '198.51.100.10', prefixLength: 24, gateway: '198.51.100.1' };
const address = (ip: string, dhcp = false): WindowsIPv4Address => ({ path: `address:${ip}`, address: ip, prefixLength: 24, state: 4, prefixOrigin: dhcp ? 3 : 1, suffixOrigin: dhcp ? 3 : 1, type: 1, skipAsSource: false, validLifetime: WINDOWS_INFINITE_LIFETIME, preferredLifetime: WINDOWS_INFINITE_LIFETIME });
type Writable<T> = { -readonly [K in keyof T]: Writable<T[K]> };
function initial(): Writable<WindowsIPv4Snapshot> {
	const store = () => ({ interfacePath: 'ipinterface', dhcp: false, addresses: [address('192.0.2.10')], routes: [{ path: 'route:192.0.2.1', gateway: '192.0.2.1', metric: 77, protocol: 3, publish: 0, validLifetime: WINDOWS_INFINITE_LIFETIME }] });
	return {
		guid,
		index: 4,
		mac: '001122334455',
		stores: { ActiveStore: store(), PersistentStore: store() },
		dns: [
			{ family: 2, path: 'dns4', automatic: false, servers: ['192.0.2.53'] },
			{ family: 23, path: 'dns6', automatic: false, servers: ['2001:db8::53'] },
		],
	};
}
function fixture(start = initial()) {
	let current = structuredClone(start),
		clock = 0,
		unknown = false;
	let saved: WindowsIPv4Recovery | undefined;
	const calls: WindowsIPv4Write[] = [];
	let fail: ((request: WindowsIPv4Write) => WindowsIPv4WriteResult | undefined) | undefined;
	const context: NativeMutationContext = {
		operationId: crypto.randomUUID(),
		dataDirectory: process.cwd(),
		remainingMs: () => 60000 - clock,
		recordRecovery: async data => {
			saved = data['windowsIPv4'] as unknown as WindowsIPv4Recovery;
		},
		recordExecution: async () => {},
		pending: async () => {
			throw new NativeMutationUnknown();
		},
		call: async (rule, invoke) => {
			expect(rule).toEqual({ kind: 'boot' });
			if (unknown) throw new NativeMutationUnknown();
			const reply = await invoke();
			if (!reply.known) {
				unknown = true;
				throw new NativeMutationUnknown();
			}
			return reply.value;
		},
	};
	const deps: WindowsIPv4MutationDeps = {
		read: async () => structuredClone(current),
		now: () => clock,
		sleep: async ms => {
			clock += ms;
		},
		close: () => {},
		write: async request => {
			expect(saved?.fingerprint).toBe(windowsIPv4Fingerprint(start));
			calls.push(structuredClone(request));
			const failed = fail?.(request);
			if (failed) return failed;
			const step = request.step;
			if (step.kind === 'delete') {
				for (const store of step.store === 'PersistentStore' ? (['ActiveStore', 'PersistentStore'] as const) : (['ActiveStore'] as const)) {
					current.stores[store].addresses = current.stores[store].addresses.filter(row => row.path !== step.path);
					current.stores[store].routes = current.stores[store].routes.filter(row => row.path !== step.path);
				}
			} else if (step.kind === 'dhcp') {
				current.stores[step.store].dhcp = step.enabled;
				if (step.enabled && step.store === 'ActiveStore') {
					current.stores.ActiveStore.addresses = [address('192.0.2.20', true)];
					current.stores.ActiveStore.routes = [{ path: 'dhcp-route', gateway: '192.0.2.1', metric: 77, protocol: 16, publish: 0, validLifetime: WINDOWS_INFINITE_LIFETIME }];
				}
			} else if (step.kind === 'address') {
				for (const store of Object.values(current.stores)) store.addresses.push({ ...address(step.address), prefixLength: step.prefixLength });
			} else if (step.kind === 'route') {
				for (const store of Object.values(current.stores)) store.routes.push({ path: `route:${step.gateway}`, gateway: step.gateway, metric: step.metric ?? 256, protocol: 3, publish: 0, validLifetime: WINDOWS_INFINITE_LIFETIME });
			} else {
				const policy = current.dns.find(policy => policy.family === step.policy.family)!;
				current.dns = current.dns.map(row => (step.servers === null ? { ...row, automatic: true, servers: [] } : row === policy ? { ...row, automatic: false, servers: [...step.servers] } : row));
			}
			return { sent: true, result: { outcome: 'ok', hresult: 0, returnValue: null } };
		},
	};
	return {
		context,
		deps,
		calls,
		current: () => current,
		replace: (next: Writable<WindowsIPv4Snapshot>) => {
			current = next;
		},
		saved: () => saved!,
		fail: (fn: typeof fail) => {
			fail = fn;
		},
		clock: () => clock,
	};
}

describe('native Windows IPv4 transaction', () => {
	test('DNS-only writes preserve all addressing and the unrequested DNS family', async () => {
		const f = fixture();
		await applyNativeWindowsIPv4(f.context, guid, { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['198.51.100.53', '2001:db8::53'] }, { addressingChanged: false, requireLease: true }, f.deps);
		expect(f.calls.every(call => call.step.kind === 'dns')).toBe(true);
		expect(f.current().stores).toEqual(initial().stores);
		expect((await observeNativeWindowsIPv4(f.saved(), 1000, f.deps)).target).toBe(true);
	});
	test('static apply replaces both stores, waits for Preferred and preserves the route metric', async () => {
		const f = fixture();
		await applyNativeWindowsIPv4(f.context, guid, staticConfig, { addressingChanged: true, requireLease: true }, f.deps);
		for (const store of Object.values(f.current().stores)) {
			expect(store.addresses.map(row => row.address)).toEqual(['198.51.100.10']);
			expect(store.routes.map(row => [row.gateway, row.metric])).toEqual([['198.51.100.1', 77]]);
		}
		expect(f.calls.some(call => call.step.kind === 'dns')).toBe(false);
	});
	test('switching to DHCP removes static policy from both stores and obtains a lease', async () => {
		const f = fixture();
		await applyNativeWindowsIPv4(f.context, guid, { mode: 'dhcp', dns: [] }, { addressingChanged: true, requireLease: true }, f.deps);
		expect(f.current().stores.PersistentStore.addresses).toHaveLength(0);
		expect(f.current().stores.PersistentStore.routes).toHaveLength(0);
		expect(f.current().stores.ActiveStore.addresses[0]?.address).toBe('192.0.2.20');
		expect(f.current().dns.every(policy => policy.automatic)).toBe(true);
	});
	test('does not create a route while the new address remains tentative', async () => {
		const f = fixture();
		const write = f.deps.write,
			read = f.deps.read;
		let readyAt = Infinity;
		f.deps.write = async request => {
			if (request.step.kind === 'route') expect(f.clock()).toBeGreaterThanOrEqual(readyAt);
			const result = await write(request);
			if (request.step.kind === 'address') readyAt = f.clock() + 300;
			return result;
		};
		f.deps.read = async (id, timeout) => {
			const value = await read(id, timeout);
			if (f.clock() < readyAt && value.stores.ActiveStore.addresses[0]?.address === staticConfig.address) return { ...value, stores: { ...value.stores, ActiveStore: { ...value.stores.ActiveStore, addresses: value.stores.ActiveStore.addresses.map(row => ({ ...row, state: 1 })) } } };
			return value;
		};
		await applyNativeWindowsIPv4(f.context, guid, staticConfig, { addressingChanged: true, requireLease: true }, f.deps);
		expect(f.clock()).toBe(300);
	});
	test('APIPA never satisfies the 20 second DHCP lease wait', async () => {
		const f = fixture();
		const read = f.deps.read;
		f.deps.read = async (id, timeout) => {
			const value = await read(id, timeout);
			if (value.stores.ActiveStore.dhcp) return { ...value, stores: { ...value.stores, ActiveStore: { ...value.stores.ActiveStore, addresses: [address('169.254.1.2', true)] } } };
			return value;
		};
		await expect(applyNativeWindowsIPv4(f.context, guid, { mode: 'dhcp' }, { addressingChanged: true, requireLease: true }, f.deps)).rejects.toThrow('usable lease');
		expect(f.clock()).toBe(20000);
		expect(f.current().stores.ActiveStore.dhcp).toBe(false);
	});
	test('a confirmed route failure restores both stores without touching DNS', async () => {
		const f = fixture();
		let failed = false;
		f.fail(request => {
			if (request.step.kind !== 'route' || failed) return;
			failed = true;
			return { sent: true, result: { hresult: 0, returnValue: 5, outcome: 'failed' } };
		});
		await expect(applyNativeWindowsIPv4(f.context, guid, staticConfig, { addressingChanged: true, requireLease: true }, f.deps)).rejects.toThrow('ReturnValue 5');
		expect(windowsIPv4Fingerprint(f.current())).toBe(windowsIPv4Fingerprint(initial()));
		expect(f.calls.some(call => call.step.kind === 'dns')).toBe(false);
	});
	test('an unknown route result forbids rollback and every later write', async () => {
		const f = fixture();
		f.fail(request => (request.step.kind === 'route' ? { sent: true, result: { hresult: 0x800706ba, returnValue: null, outcome: 'unknown' } } : undefined));
		await expect(applyNativeWindowsIPv4(f.context, guid, staticConfig, { addressingChanged: true, requireLease: true }, f.deps)).rejects.toBeInstanceOf(NativeMutationUnknown);
		expect(f.calls[f.calls.length - 1]?.step.kind).toBe('route');
		expect(f.current().stores.ActiveStore.addresses[0]?.address).toBe(staticConfig.address);
	});
	test('a preparation failure before the first write does not trigger rollback', async () => {
		const f = fixture();
		f.fail(() => ({ sent: false, error: 'Cannot prepare WMI input' }));
		await expect(applyNativeWindowsIPv4(f.context, guid, staticConfig, { addressingChanged: true, requireLease: true }, f.deps)).rejects.toThrow('prepare');
		expect(f.calls).toHaveLength(1);
		expect(f.current()).toEqual(initial());
	});
	test('a DNS failure restores each original family policy without address writes', async () => {
		const f = fixture();
		let writes = 0;
		f.fail(request => (request.step.kind === 'dns' && ++writes === 2 ? { sent: true, result: { hresult: 0, returnValue: 5, outcome: 'failed' } } : undefined));
		await expect(applyNativeWindowsIPv4(f.context, guid, { ...staticConfig, dns: ['198.51.100.53', '2001:db8::54'] }, { addressingChanged: false, requireLease: true }, f.deps)).rejects.toThrow('ReturnValue 5');
		expect(f.current()).toEqual(initial());
		expect(f.calls.every(call => call.step.kind === 'dns')).toBe(true);
	});
	test.each([2, 23])('rollback restores manual family %i after the global automatic reset', async manualFamily => {
		const start = initial();
		start.dns = start.dns.map(policy => (policy.family === manualFamily ? policy : { ...policy, automatic: true, servers: [] }));
		const f = fixture(start);
		let writes = 0;
		f.fail(request => (request.step.kind === 'dns' && ++writes === 2 ? { sent: true, result: { hresult: 0, returnValue: 5, outcome: 'failed' } } : undefined));
		await expect(applyNativeWindowsIPv4(f.context, guid, { ...staticConfig, dns: ['198.51.100.53', '2001:db8::54'] }, { addressingChanged: false, requireLease: true }, f.deps)).rejects.toThrow('ReturnValue 5');
		expect(f.current()).toEqual(start);
		expect(f.calls.slice(-2).map(call => call.step)).toEqual([
			{ kind: 'dns', policy: start.dns[0]!, servers: null },
			{ kind: 'dns', policy: start.dns.find(policy => policy.family === manualFamily)!, servers: start.dns.find(policy => policy.family === manualFamily)!.servers },
		]);
	});
	test('an incomplete snapshot is refused before destructive writes', async () => {
		const start = initial();
		start.stores.PersistentStore.addresses = [];
		const f = fixture(start);
		await expect(applyNativeWindowsIPv4(f.context, guid, staticConfig, { addressingChanged: true, requireLease: true }, f.deps)).rejects.toThrow('restored exactly');
		expect(f.calls).toHaveLength(0);
	});
	test('an unspecified persistent DHCP flag is preserved while enabling DHCP', async () => {
		const start = initial();
		start.stores.PersistentStore.dhcp = null;
		const f = fixture(start);
		await applyNativeWindowsIPv4(f.context, guid, { mode: 'dhcp' }, { addressingChanged: true, requireLease: true }, f.deps);
		expect(f.current().stores.PersistentStore.dhcp).toBeNull();
		expect(f.current().stores.ActiveStore.dhcp).toBe(true);
	});
});

test('worker refuses adapter replacement and keeps preparation errors unsent', () => {
	const identity = initial();
	const connection = {
		query: () => [{ InterfaceGuid: { value: guid }, InterfaceIndex: { value: 4 }, NetworkAddresses: { value: ['001122334455'] } }],
		put: () => {
			throw Object.assign(new Error('bad input'), { mayHaveRun: false });
		},
		close: () => {},
	} as unknown as WmiConnection;
	const request: WindowsIPv4Write = { identity, step: { kind: 'dhcp', path: 'interface', store: 'ActiveStore', enabled: true } };
	expect(executeWindowsIPv4Write({ ...request, identity: { ...identity, mac: 'FFFFFFFFFFFF' } }, () => connection)).toMatchObject({ sent: false, error: 'Interface identity changed before applying IPv4' });
	expect(executeWindowsIPv4Write(request, () => connection)).toEqual({ sent: false, error: 'bad input' });
	expect(executeWindowsIPv4Write({ identity, step: { kind: 'dns', policy: identity.dns[0]!, servers: ['2001:db8::53'] } }, () => connection)).toEqual({ sent: false, error: 'DNS server family does not match the target' });
});
