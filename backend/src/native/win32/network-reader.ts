import { windowsProcessElevated } from '../../system-time-windows.ts';
import { openWmiConnection, type WmiConnection } from './wmi.ts';
import type { WmiRow, WmiScalar } from './wmi-values.ts';
import { parseWindowsNetworkState, readWindowsWifi, isWindowsWifiConfigurable } from '../../system-network-windows.ts';
import type { NetInterfaceInfo } from '@shared';

type Row = Record<string, string | number | boolean | null>;
export interface WindowsNetworkDocument {
	adapters: Row[];
	addresses: Row[];
	persistentAddresses: Row[];
	interfaces: Row[];
	routes: Row[];
	routes6: Row[];
	persistentRoutes: Row[];
	dns: Row[];
}

const INFINITE_INTERVAL = '99999999235959.000000:000';
const ADAPTER = ['InterfaceIndex', 'Name', 'InterfaceGuid', 'NetworkAddresses', 'Virtual', 'InterfaceDescription', 'NdisPhysicalMedium', 'InterfaceType', 'Hidden', 'MediaConnectState', 'InterfaceOperationalStatus'];
const ADDRESS = ['InterfaceIndex', 'AddressFamily', 'IPAddress', 'PrefixLength', 'AddressState', 'PrefixOrigin', 'SuffixOrigin', 'Type', 'SkipAsSource', 'ValidLifetime', 'PreferredLifetime'];
const INTERFACE = ['InterfaceIndex', 'InterfaceAlias', 'AddressFamily', 'ConnectionState', 'Dhcp', 'InterfaceMetric'];
const ROUTE = ['InterfaceIndex', 'AddressFamily', 'DestinationPrefix', 'NextHop', 'RouteMetric', 'Protocol', 'Publish', 'ValidLifetime'];

function scalar(row: WmiRow, name: string): WmiScalar {
	const property = row[name];
	if (!property || Array.isArray(property.value)) throw new Error(`Invalid network property ${name}`);
	return property.value as WmiScalar;
}

function number(row: WmiRow, name: string): number {
	const value = scalar(row, name);
	if (value === null) return 0;
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Invalid network number ${name}`);
	return value;
}

function string(row: WmiRow, name: string): string {
	const value = scalar(row, name);
	if (value === null) return '';
	if (typeof value !== 'string') throw new Error(`Invalid network string ${name}`);
	return value;
}

function boolean(row: WmiRow, name: string): boolean {
	const value = scalar(row, name);
	if (value === null) return false;
	if (typeof value !== 'boolean') throw new Error(`Invalid network flag ${name}`);
	return value;
}

function strings(row: WmiRow, name: string): string[] {
	const value = row[name]?.value;
	if (value === null) return [];
	if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`Invalid network list ${name}`);
	return value as string[];
}

function address(row: WmiRow): Row {
	return { ifIndex: number(row, 'InterfaceIndex'), Family: number(row, 'AddressFamily'), IPAddress: string(row, 'IPAddress'), PrefixLength: number(row, 'PrefixLength'), State: number(row, 'AddressState'), PrefixOrigin: number(row, 'PrefixOrigin'), SuffixOrigin: number(row, 'SuffixOrigin'), Type: number(row, 'Type'), SkipAsSource: boolean(row, 'SkipAsSource'), Infinite: scalar(row, 'ValidLifetime') === INFINITE_INTERVAL && scalar(row, 'PreferredLifetime') === INFINITE_INTERVAL };
}

/** Uses the same CIM policy stores and property aliases as the Windows NetTCPIP cmdlets. */
export function readWindowsNetworkDocument(connection: Pick<WmiConnection, 'query'>): WindowsNetworkDocument {
	const adapters = connection.query('SELECT * FROM MSFT_NetAdapter', ADAPTER, { IncludeHidden: true });
	const addresses = connection.query('SELECT * FROM MSFT_NetIPAddress', ADDRESS, { PolicyStore: 'ActiveStore' });
	const persistentAddresses = connection.query('SELECT * FROM MSFT_NetIPAddress WHERE AddressFamily = 2', ADDRESS, { PolicyStore: 'PersistentStore' });
	const interfaces = connection.query('SELECT * FROM MSFT_NetIPInterface', INTERFACE);
	const routes = connection.query("SELECT * FROM MSFT_NetRoute WHERE DestinationPrefix = '0.0.0.0/0' OR DestinationPrefix = '::/0'", ROUTE, { PolicyStore: 'ActiveStore' });
	const persistentRoutes = connection.query("SELECT * FROM MSFT_NetRoute WHERE AddressFamily = 2 AND DestinationPrefix = '0.0.0.0/0'", ROUTE, { PolicyStore: 'PersistentStore' });
	const dns = connection.query('SELECT * FROM MSFT_DNSClientServerAddress', ['InterfaceIndex', 'ServerAddresses']);
	const interfaceMetrics = new Map(interfaces.map(row => [`${number(row, 'InterfaceIndex')}:${number(row, 'AddressFamily')}`, number(row, 'InterfaceMetric')]));
	const route = (row: WmiRow, persistent = false): Row => ({ ifIndex: number(row, 'InterfaceIndex'), NextHop: string(row, 'NextHop'), RouteMetric: number(row, 'RouteMetric'), InterfaceMetric: persistent ? null : (interfaceMetrics.get(`${number(row, 'InterfaceIndex')}:${number(row, 'AddressFamily')}`) ?? null), Protocol: number(row, 'Protocol'), Publish: number(row, 'Publish'), Infinite: scalar(row, 'ValidLifetime') === INFINITE_INTERVAL });
	return {
		adapters: adapters.map(row => {
			const mac = strings(row, 'NetworkAddresses')[0] ?? '';
			return { ifIndex: number(row, 'InterfaceIndex'), Name: string(row, 'Name'), InterfaceGuid: string(row, 'InterfaceGuid'), MacAddress: mac.replace(/(..)(?=.)/g, '$1-'), Virtual: boolean(row, 'Virtual'), InterfaceDescription: string(row, 'InterfaceDescription'), Media: number(row, 'NdisPhysicalMedium'), IfType: number(row, 'InterfaceType'), Hidden: boolean(row, 'Hidden') ? 1 : 0, State: number(row, 'MediaConnectState'), OperationalState: number(row, 'InterfaceOperationalStatus') };
		}),
		addresses: addresses.map(address),
		persistentAddresses: persistentAddresses.map(address),
		interfaces: interfaces.map(row => ({ ifIndex: number(row, 'InterfaceIndex'), InterfaceAlias: string(row, 'InterfaceAlias'), Family: number(row, 'AddressFamily'), ConnectionState: number(row, 'ConnectionState'), Dhcp: number(row, 'Dhcp') })),
		routes: routes.filter(row => number(row, 'AddressFamily') === 2).map(row => route(row)),
		routes6: routes.filter(row => number(row, 'AddressFamily') === 23).map(row => ({ ifIndex: number(row, 'InterfaceIndex'), RouteMetric: number(row, 'RouteMetric'), InterfaceMetric: interfaceMetrics.get(`${number(row, 'InterfaceIndex')}:23`) ?? null })),
		persistentRoutes: persistentRoutes.map(row => route(row, true)),
		dns: dns.map(row => ({ InterfaceIndex: number(row, 'InterfaceIndex'), Servers: strings(row, 'ServerAddresses').join(',') })),
	};
}

export function readNativeWindowsNetwork(): NetInterfaceInfo[] {
	const connection = openWmiConnection();
	try {
		return parseWindowsNetworkState(JSON.stringify(readWindowsNetworkDocument(connection)), readWindowsWifi());
	} finally {
		connection.close();
	}
}

export function readNativeWindowsNetworkCapabilities(): { elevated: boolean; wifi: boolean } {
	return { elevated: windowsProcessElevated(), wifi: isWindowsWifiConfigurable() };
}
