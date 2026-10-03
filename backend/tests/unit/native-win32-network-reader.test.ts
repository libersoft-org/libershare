import { expect, test } from 'bun:test';
import { readWindowsNetworkDocument } from '../../src/native/win32/network-reader.ts';
import type { WmiConnection, WmiContext } from '../../src/native/win32/wmi.ts';
import type { WmiRow, WmiScalar } from '../../src/native/win32/wmi-values.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NativeWorkerChannel } from '../../src/native/worker-host.ts';
import { parseWindowsNetworkState, readWindowsWifi } from '../../src/system-network-windows.ts';
import { windowsPowerShellPath, windowsSystemEnvironment } from '../../src/network-helper-windows.ts';
import { WINDOWS_STATE_COMMAND, WINDOWS_ELEVATION_COMMAND } from '../helpers/windows-network-oracle.ts';

const forever = '99999999235959.000000:000';

function row(values: Record<string, WmiScalar | WmiScalar[]>): WmiRow {
	return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { variantType: 0, cimType: 0, value }]));
}

function fixture(): { connection: Pick<WmiConnection, 'query'>; calls: { wql: string; context?: WmiContext }[]; data: Record<string, WmiRow[]> } {
	const data: Record<string, WmiRow[]> = {
		adapter: [row({ InterfaceIndex: 7, Name: 'Ethernet', InterfaceGuid: '{11111111-2222-3333-4444-555555555555}', NetworkAddresses: ['02005E100001', '02005E100002'], PermanentAddress: '02005E100099', Virtual: false, InterfaceDescription: 'Network adapter', NdisPhysicalMedium: 14, InterfaceType: 6, Hidden: false, MediaConnectState: 1, InterfaceOperationalStatus: 1 })],
		activeAddress: [row({ InterfaceIndex: 7, AddressFamily: 2, IPAddress: '192.0.2.10', PrefixLength: 24, AddressState: 4, PrefixOrigin: 1, SuffixOrigin: 1, Type: 1, SkipAsSource: false, ValidLifetime: forever, PreferredLifetime: forever })],
		persistentAddress: [],
		interface: [row({ InterfaceIndex: 7, InterfaceAlias: 'Ethernet', AddressFamily: 2, ConnectionState: 1, Dhcp: 0, InterfaceMetric: 25 }), row({ InterfaceIndex: 7, InterfaceAlias: 'Ethernet', AddressFamily: 23, ConnectionState: 1, Dhcp: 1, InterfaceMetric: 5 })],
		activeRoute: [row({ InterfaceIndex: 7, AddressFamily: 23, DestinationPrefix: '::/0', NextHop: '2001:db8::1', RouteMetric: 10, Protocol: 3, Publish: 0, ValidLifetime: forever })],
		persistentRoute: [],
		dns: [row({ InterfaceIndex: 7, ServerAddresses: ['192.0.2.53', '2001:db8::53'] })],
	};
	const calls: { wql: string; context?: WmiContext }[] = [];
	const connection = {
		query(wql: string, _properties: readonly string[], context?: WmiContext): WmiRow[] {
			calls.push({ wql, ...(context ? { context } : {}) });
			if (wql.includes('MSFT_NetAdapter')) return data['adapter']!;
			if (wql.includes('MSFT_NetIPAddress')) return data[context?.['PolicyStore'] === 'PersistentStore' ? 'persistentAddress' : 'activeAddress']!;
			if (wql.includes('MSFT_NetIPInterface')) return data['interface']!;
			if (wql.includes('MSFT_NetRoute')) return data[context?.['PolicyStore'] === 'PersistentStore' ? 'persistentRoute' : 'activeRoute']!;
			if (wql.includes('MSFT_DNSClientServerAddress')) return data['dns']!;
			throw new Error('Unexpected WMI class');
		},
	};
	return { connection, calls, data };
}

test('uses the first current network address and keeps both Windows policy stores separate', () => {
	const f = fixture();
	const result = readWindowsNetworkDocument(f.connection);
	expect(result.adapters[0]).toMatchObject({ MacAddress: '02-00-5E-10-00-01', Hidden: 0, State: 1 });
	expect(result.addresses).toHaveLength(1);
	expect(result.persistentAddresses).toEqual([]);
	expect(f.calls[0]!.context).toEqual({ IncludeHidden: true });
	expect(f.calls.filter(value => value.context?.['PolicyStore'] === 'PersistentStore')).toHaveLength(2);
});

test('IPv6 default routes use IPv6 interface metrics even when IPv4 has a different metric', () => {
	const result = readWindowsNetworkDocument(fixture().connection);
	expect(result.routes).toEqual([]);
	expect(result.routes6).toEqual([{ ifIndex: 7, RouteMetric: 10, InterfaceMetric: 5 }]);
	expect(result.dns).toEqual([{ InterfaceIndex: 7, Servers: '192.0.2.53,2001:db8::53' }]);
});

test('a finite preferred lifetime prevents the address from being restorable as permanent', () => {
	const f = fixture();
	f.data['activeAddress']![0]!['PreferredLifetime'] = { variantType: 8, cimType: 101, value: '00000000000100.000000:000' };
	expect(readWindowsNetworkDocument(f.connection).addresses[0]!['Infinite']).toBe(false);
});

test('a failed final query rejects the entire snapshot instead of returning partial state', () => {
	const f = fixture();
	const query = f.connection.query;
	f.connection.query = (wql, properties, context) => {
		if (wql.includes('MSFT_DNSClientServerAddress')) throw new Error('WMI provider unavailable');
		return query(wql, properties, context);
	};
	expect(() => readWindowsNetworkDocument(f.connection)).toThrow('WMI provider unavailable');
});

test('a successful empty default route query is a valid snapshot', () => {
	const f = fixture();
	f.data['activeRoute'] = [];
	const result = readWindowsNetworkDocument(f.connection);
	expect(result.routes).toEqual([]);
	expect(result.routes6).toEqual([]);
	expect(result.adapters).toHaveLength(1);
});

test.skipIf(process.platform !== 'win32')(
	'the native Windows worker agrees with NetTCPIP and token role queries',
	async () => {
		const worker = new NativeWorkerChannel('read');
		const run = (script: string) => promisify(execFile)(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024, env: windowsSystemEnvironment() });
		try {
			const expected = parseWindowsNetworkState((await run(WINDOWS_STATE_COMMAND)).stdout, readWindowsWifi());
			const actual = await worker.call<typeof expected>({ method: 'win32.network.snapshot' }, 15000);
			const normalize = (rows: typeof expected): unknown => rows.map(row => ({ ...row, addresses: [...row.addresses].sort((a, b) => a.address.localeCompare(b.address)), dns: [...row.dns].sort(), ...(row.wifi ? { wifi: { ...row.wifi, signal: null } } : {}) })).sort((a, b) => a.id.localeCompare(b.id));
			expect(normalize(actual)).toEqual(normalize(expected));
			const capabilities = await worker.call<{ elevated: boolean }>({ method: 'win32.network.capabilities' }, 15000);
			expect(capabilities.elevated).toBe((await run(WINDOWS_ELEVATION_COMMAND)).stdout.trim().toLowerCase() === 'true');
		} finally {
			worker.close();
		}
	},
	30000
);
