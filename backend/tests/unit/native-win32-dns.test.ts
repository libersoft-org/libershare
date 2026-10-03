import { expect, test } from 'bun:test';
import { readWindowsDnsPolicy, writeWindowsDnsPolicy, windowsDnsChanges, type WindowsDnsPolicy } from '../../src/native/win32/dns.ts';
import { readLocalMachineString } from '../../src/native/win32/registry.ts';
import type { WmiRow } from '../../src/native/win32/wmi-values.ts';

const policies: WindowsDnsPolicy[] = [
	{ family: 2, path: 'v4', automatic: true, servers: ['192.0.2.1'] },
	{ family: 23, path: 'v6', automatic: false, servers: ['2001:db8::1'] },
];

test('an omitted DNS family is preserved while an empty list resets both families', () => {
	expect(windowsDnsChanges(policies, undefined)).toEqual([]);
	expect(windowsDnsChanges(policies, ['192.0.2.53'])).toEqual([{ policy: policies[0]!, servers: ['192.0.2.53'] }]);
	expect(windowsDnsChanges(policies, ['2001:db8::53'])).toEqual([{ policy: policies[1]!, servers: ['2001:db8::53'] }]);
	expect(windowsDnsChanges(policies, [])).toEqual([{ policy: policies[0]!, servers: null }]);
});

test('all sixteen manual and automatic DNS transitions follow the cmdlet family rule', () => {
	for (const automatic4 of [false, true])
		for (const automatic6 of [false, true]) {
			const before = [
				{ ...policies[0]!, automatic: automatic4 },
				{ ...policies[1]!, automatic: automatic6 },
			];
			for (const requested of [[], ['198.51.100.53'], ['2001:db8::53'], ['198.51.100.53', '2001:db8::53']]) {
				const changes = windowsDnsChanges(before, requested);
				let actual = before;
				for (const change of changes) actual = actual.map(policy => (change.servers === null ? { ...policy, automatic: true, servers: [] } : policy.family === change.policy.family ? { ...policy, automatic: false, servers: [...change.servers] } : policy));
				for (const policy of actual) {
					const familyServers = requested.filter(server => server.includes(':') === (policy.family === 23));
					if (!requested.length) expect(policy.automatic).toBe(true);
					else if (familyServers.length) expect([policy.automatic, policy.servers]).toEqual([false, familyServers]);
					else expect(policy).toEqual(before.find(value => value.family === policy.family)!);
				}
			}
		}
});

test('DNS mutation uses typed CIM options for manual servers and a global reset', () => {
	const calls: unknown[] = [];
	const connection = {
		put: (...args: unknown[]) => {
			calls.push(args);
			return { hresult: 0, returnValue: null, outcome: 'ok' as const };
		},
	};
	writeWindowsDnsPolicy(connection, policies[0]!, ['192.0.2.53']);
	writeWindowsDnsPolicy(connection, policies[1]!, null);
	expect(calls).toEqual([
		['v4', {}, { ServerAddresses: ['192.0.2.53'], Validate: false }],
		['v6', {}, { ResetServerAddresses: true }],
	]);
	expect(() => writeWindowsDnsPolicy(connection, policies[0]!, ['2001:db8::53'])).toThrow('family');
	expect(calls).toHaveLength(2);
});

test('an unreadable DNS policy is not treated as automatic', () => {
	const rows: WmiRow[] = policies.map(policy => Object.fromEntries(Object.entries({ AddressFamily: policy.family, __RELPATH: policy.path, ServerAddresses: policy.servers }).map(([name, value]) => [name, { value, variantType: 0, cimType: 0 }])));
	const connection = { query: () => rows };
	const guid = '{11111111-2222-3333-4444-555555555555}';
	expect(() =>
		readWindowsDnsPolicy(connection, 1, guid, () => {
			throw new Error('Registry denied');
		})
	).toThrow('Registry denied');
	expect(readWindowsDnsPolicy(connection, 1, guid, key => (key.includes('Tcpip6') ? '2001:db8::1' : null))).toEqual(policies);
});

test.skipIf(process.platform !== 'win32')('native registry reads distinguish a missing value and a real string', () => {
	expect(readLocalMachineString('SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', 'SystemRoot')).toMatch(/^[A-Z]:\\/i);
	expect(readLocalMachineString(`SOFTWARE\\LiberShare\\${crypto.randomUUID()}`, 'Missing')).toBeNull();
});
