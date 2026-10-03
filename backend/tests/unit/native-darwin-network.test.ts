import { describe, expect, test } from 'bun:test';
import { buildDarwinNetworkState, type DarwinNetworkSources } from '../../src/native/darwin/network-reader.ts';
import { darwinAddress, darwinHasPeer, parseDarwinDefaultRoutes } from '../../src/native/darwin/routes.ts';
import { applyNativeDarwinIPv4, type DarwinIPv4MutationDeps } from '../../src/native/darwin/network-mutation.ts';
import { NativeMutationUnknown, type NativeMutationContext } from '../../src/native/mutation-host.ts';
import { withMacRollback } from '../../src/system-network-macos.ts';
import { darwinStaticStateMatches, type DarwinIPv4Recovery } from '../../src/native/darwin/network-mutation-state.ts';

function source(): DarwinNetworkSources {
	return {
		interfaces: [{ device: 'en7', index: 7, loopback: false, mac: '02:00:00:00:00:07', addresses: [] }], routes: [],
		services: [{ id: 'service-id', name: 'Renamed adapter', enabled: true, device: 'en7', port: 'Ethernet', type: 'Ethernet', ipv4: { ConfigMethod: 'DHCP' }, dns: null }],
		ports: new Map([['en7', { name: 'Ethernet', type: 'Ethernet' }]]), values: new Map([['State:/Network/Interface/en7/Link', { Active: false }]]),
	};
}

describe('typed macOS network composition', () => {
	test('a renamed single enabled service is configurable without a carrier', () => {
		expect(buildDarwinNetworkState(source())[0]).toMatchObject({ name: 'Renamed adapter', link: 'down', ipv4Mode: 'dhcp', ipv4Configurable: true });
	});
	test('multiple enabled services and multiple default routes block editing', () => {
		const sources = source();
		expect(buildDarwinNetworkState({ ...sources, services: [...sources.services, { ...sources.services[0]!, id: 'second' }] })[0]?.ipv4Configurable).toBe(false);
		const route = { device: 'en7', index: 7, family: 'ipv4' as const, scoped: false, usable: true, gateway: '192.0.2.1' };
		expect(buildDarwinNetworkState({ ...sources, routes: [route, { ...route, scoped: true }] })[0]?.ipv4Configurable).toBe(false);
	});
	test('a disconnected manual service retains its stored address and DNS', () => {
		const sources = source();
		const services = [{ ...sources.services[0]!, ipv4: { ConfigMethod: 'Manual', Addresses: ['192.0.2.20'], SubnetMasks: ['255.255.255.0'], Router: '192.0.2.1' }, dns: { ServerAddresses: ['2001:db8::53'] } }];
		expect(buildDarwinNetworkState({ ...sources, services })[0]).toMatchObject({ addresses: [{ family: 'ipv4', address: '192.0.2.20', prefixLength: 24 }], dns: ['2001:db8::53'], gateway: '192.0.2.1', ipv4Configurable: true });
	});
	test('DHCP DNS falls back from dynamic DNS to packet option 6', () => {
		const sources = source(), values = new Map(sources.values);
		values.set('State:/Network/Service/service-id/DHCP', { Option_6: Buffer.from([192, 0, 2, 53]) });
		expect(buildDarwinNetworkState({ ...sources, values })[0]?.dns).toEqual(['192.0.2.53']);
		values.set('State:/Network/Service/service-id/DNS', { ServerAddresses: ['fe80::53%en7'] });
		expect(buildDarwinNetworkState({ ...sources, values })[0]?.dns).toEqual(['fe80::53%en7']);
	});
});

describe('Darwin route ABI', () => {
	function route(): Buffer {
		const buffer = Buffer.alloc(128);
		buffer.writeUInt16LE(buffer.length, 0); buffer[2] = 5; buffer.writeUInt16LE(7, 4); buffer.writeUInt32LE(0x1000003, 8); buffer.writeUInt32LE(7, 12);
		buffer[92] = 16; buffer[93] = 2; buffer[108] = 16; buffer[109] = 2;
		Buffer.from([192, 0, 2, 1]).copy(buffer, 112);
		return buffer;
	}
	test('retains interface-scoped default routes in the edit guard count', () => {
		expect(parseDarwinDefaultRoutes(route(), 2, index => `en${index}`)).toEqual([{ family: 'ipv4', index: 7, device: 'en7', gateway: '192.0.2.1', scoped: true, usable: true }]);
	});
	test('rejects truncated and zero-length route messages', () => {
		expect(() => parseDarwinDefaultRoutes(route().subarray(0, 100), 2, () => 'en7')).toThrow();
		const invalid = route(); invalid.writeUInt16LE(0, 0);
		expect(() => parseDarwinDefaultRoutes(invalid, 2, () => 'en7')).toThrow();
	});
	test('clears the embedded KAME scope from IPv6 addresses', () => {
		const bytes = Buffer.from('fe800007000000000000000000000001', 'hex');
		expect(darwinAddress(bytes, 30)).toBe('fe80::1');
	});
	test('keeps point-to-point IPv6 when its destination is unspecified', () => {
		const destination = Buffer.alloc(28); destination[0] = 28; destination[1] = 30;
		expect(darwinHasPeer(0x10, 30, destination)).toBe(false);
		destination[23] = 1;
		expect(darwinHasPeer(0x10, 30, destination)).toBe(true);
	});
});

function mutationFixture() {
	const saved: DarwinIPv4Recovery = { device: 'en7', serviceId: 'service-id', interfaceIndex: 7, mac: '02:00:00:00:00:07', original: { ipv4: 'AAAA', dns: null, hadLease: false, linkActive: false }, target: { ipv4: 'BBBB', dns: null }, desired: { mode: 'dhcp' }, addressingChanged: true, requireLease: false };
	const events: string[] = [];
	let time = 0, target = true;
	let write: DarwinIPv4MutationDeps['write'] = async () => ({ ok: true });
	const context: NativeMutationContext = {
		operationId: 'test', dataDirectory: '.', remainingMs: () => 60000 - time,
		async call(_rule, action) { const result = await action(); if (!result.known) throw new NativeMutationUnknown(); return result.value; },
		async recordRecovery() { events.push('journal'); }, async recordExecution() {}, async pending() { throw new NativeMutationUnknown(); },
	};
	const deps: DarwinIPv4MutationDeps = {
		async prepare() { events.push('prepare'); return { token: 'token', recovery: saved }; },
		async write(request) { events.push(request.restore ? 'restore' : 'apply'); return write(request); },
		async observe() { return { original: true, target }; }, async release() { events.push('release'); },
		now: () => time, sleep: async ms => { time += ms; }, close() { events.push('close'); },
	};
	return { events, run: () => applyNativeDarwinIPv4(context, 'en7', saved.desired, { addressingChanged: true, requireLease: false }, deps), setWrite: (fn: typeof write) => { write = fn; }, failVerification: () => { target = false; } };
}

describe('macOS preferences transaction', () => {
	test('the legacy rollback boundary also preserves unknown outcomes', async () => {
		let restored = false;
		await expect(withMacRollback(async () => { throw new NativeMutationUnknown(); }, async () => { restored = true; })).rejects.toBeInstanceOf(NativeMutationUnknown);
		expect(restored).toBe(false);
	});
	test('restored static policy requires its original kernel address and exact route', () => {
		const configuration = { Addresses: ['192.0.2.20'], SubnetMasks: ['255.255.255.0'], Router: '192.0.2.1' };
		const address = { family: 'ipv4' as const, address: '192.0.2.20', prefixLength: 24 };
		const route = { family: 'ipv4' as const, index: 7, device: 'en7', gateway: '192.0.2.1', scoped: false, usable: true };
		expect(darwinStaticStateMatches(configuration, configuration, [address], [route])).toBe(true);
		expect(darwinStaticStateMatches(configuration, configuration, [{ ...address, address: '192.0.2.30' }], [route])).toBe(false);
		expect(darwinStaticStateMatches(configuration, configuration, [address], [])).toBe(false);
		expect(darwinStaticStateMatches(configuration, configuration, [address], [{ ...route, gateway: '192.0.2.2' }])).toBe(false);
		expect(darwinStaticStateMatches(configuration, configuration, [address], [route, route])).toBe(false);
	});
	test('persists the deep-copy recovery before committing and releases after verification', async () => {
		const f = mutationFixture(); await f.run(); expect(f.events).toEqual(['prepare', 'journal', 'apply', 'release', 'close']);
	});
	test('a known Apply failure restores the snapshot with another Commit/Apply', async () => {
		const f = mutationFixture(); f.setWrite(async request => request.restore ? { ok: true } : { ok: false, commitAttempted: true, error: 'Apply failed' });
		await expect(f.run()).rejects.toThrow('Apply failed'); expect(f.events).toContain('restore');
	});
	test('failed readback restores the snapshot without extending the write timeout', async () => {
		const f = mutationFixture(); f.failVerification();
		await expect(f.run()).rejects.toThrow('did not apply'); expect(f.events).toContain('restore');
	});
	test('unknown results forbid rollback and any following worker operation', async () => {
		const f = mutationFixture(); f.setWrite(async () => { throw new NativeMutationUnknown(); });
		await expect(f.run()).rejects.toBeInstanceOf(NativeMutationUnknown);
		expect(f.events).toEqual(['prepare', 'journal', 'apply', 'close']);
	});
	test('a staging refusal does not publish a compensating write', async () => {
		const f = mutationFixture(); f.setWrite(async () => ({ ok: false, commitAttempted: false, error: 'SetConfiguration failed' }));
		await expect(f.run()).rejects.toThrow('SetConfiguration failed'); expect(f.events).not.toContain('restore');
	});
});
