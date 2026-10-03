import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { canonicalDnsServer, validateIPv4Config, type NetIPv4Config } from '@shared';
import { isWindowsInterfaceID } from '../../system-network-windows-wlan.ts';
import { readWindowsDnsPolicy, type WindowsDnsPolicy } from './dns.ts';
import { openWmiConnection, type WmiConnection } from './wmi.ts';
import type { WmiRow } from './wmi-values.ts';

export type WindowsPolicyStore = 'ActiveStore' | 'PersistentStore';
export const WINDOWS_POLICY_STORES: readonly WindowsPolicyStore[] = ['ActiveStore', 'PersistentStore'];
export const WINDOWS_INFINITE_LIFETIME = '99999999235959.000000:000';
export interface WindowsInterfaceIdentity {
	readonly guid: string;
	readonly index: number;
	readonly mac: string;
}
export interface WindowsIPv4Address {
	readonly path: string;
	readonly address: string;
	readonly prefixLength: number;
	readonly state: number;
	readonly prefixOrigin: number;
	readonly suffixOrigin: number;
	readonly type: number;
	readonly skipAsSource: boolean;
	readonly validLifetime: string;
	readonly preferredLifetime: string;
}
export interface WindowsIPv4Route {
	readonly path: string;
	readonly gateway: string;
	readonly metric: number;
	readonly protocol: number;
	readonly publish: number;
	readonly validLifetime: string;
}
export interface WindowsIPv4Store {
	readonly interfacePath: string;
	readonly dhcp: boolean | null;
	readonly addresses: WindowsIPv4Address[];
	readonly routes: WindowsIPv4Route[];
}
export interface WindowsIPv4Snapshot extends WindowsInterfaceIdentity {
	readonly stores: Record<WindowsPolicyStore, WindowsIPv4Store>;
	readonly dns: WindowsDnsPolicy[];
}
export interface WindowsIPv4Recovery {
	readonly snapshot: WindowsIPv4Snapshot;
	readonly fingerprint: string;
	readonly desired: NetIPv4Config;
	readonly addressingChanged: boolean;
	readonly requireLease: boolean;
}

function text(row: WmiRow, key: string): string {
	const value = row[key]?.value;
	if (typeof value !== 'string') throw new Error(`Invalid IPv4 property ${key}`);
	return value;
}
function number(row: WmiRow, key: string): number {
	const value = row[key]?.value;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid IPv4 property ${key}`);
	return value;
}

export function readWindowsInterfaceIdentity(connection: Pick<WmiConnection, 'query'>, guid: string): WindowsInterfaceIdentity {
	if (!isWindowsInterfaceID(guid)) throw new Error('Invalid interface GUID');
	const rows = connection.query(`SELECT * FROM MSFT_NetAdapter WHERE InterfaceGuid = '${guid}'`, ['InterfaceIndex', 'InterfaceGuid', 'NetworkAddresses'], { IncludeHidden: true });
	if (rows.length !== 1) throw new Error('Interface not found');
	const row = rows[0]!,
		addresses = row['NetworkAddresses']?.value;
	if (!Array.isArray(addresses) || typeof addresses[0] !== 'string') throw new Error('Interface MAC is unavailable');
	return { guid: text(row, 'InterfaceGuid').toUpperCase(), index: number(row, 'InterfaceIndex'), mac: addresses[0].replace(/[-:]/g, '').toUpperCase() };
}

export function sameWindowsInterface(a: WindowsInterfaceIdentity, b: WindowsInterfaceIdentity): boolean {
	return a.guid.toUpperCase() === b.guid.toUpperCase() && a.index === b.index && a.mac === b.mac;
}

export function readWindowsIPv4Snapshot(guid: string, supplied?: WmiConnection): WindowsIPv4Snapshot {
	const connection = supplied ?? openWmiConnection();
	try {
		const identity = readWindowsInterfaceIdentity(connection, guid);
		const stores = {} as Record<WindowsPolicyStore, WindowsIPv4Store>;
		const filter = `InterfaceIndex = ${identity.index} AND AddressFamily = 2`;
		for (const store of WINDOWS_POLICY_STORES) {
			const context = { PolicyStore: store };
			const interfaces = connection.query(`SELECT * FROM MSFT_NetIPInterface WHERE ${filter}`, ['__RELPATH', 'Dhcp'], context);
			if (interfaces.length !== 1) throw new Error('IPv4 interface policy is incomplete');
			const dhcp = interfaces[0]!['Dhcp']?.value;
			if (dhcp !== 0 && dhcp !== 1 && !(store === 'PersistentStore' && dhcp === null)) throw new Error('Invalid DHCP policy');
			const addresses = connection.query(`SELECT * FROM MSFT_NetIPAddress WHERE ${filter}`, ['__RELPATH', 'IPAddress', 'PrefixLength', 'AddressState', 'PrefixOrigin', 'SuffixOrigin', 'Type', 'SkipAsSource', 'ValidLifetime', 'PreferredLifetime'], context).map(row => {
				const address = text(row, 'IPAddress'),
					prefixLength = number(row, 'PrefixLength'),
					skipAsSource = row['SkipAsSource']?.value;
				if (isIP(address) !== 4 || prefixLength > 32 || typeof skipAsSource !== 'boolean') throw new Error('Invalid IPv4 address policy');
				return { path: text(row, '__RELPATH'), address, prefixLength, state: number(row, 'AddressState'), prefixOrigin: number(row, 'PrefixOrigin'), suffixOrigin: number(row, 'SuffixOrigin'), type: number(row, 'Type'), skipAsSource, validLifetime: text(row, 'ValidLifetime'), preferredLifetime: text(row, 'PreferredLifetime') };
			});
			const routes = connection.query(`SELECT * FROM MSFT_NetRoute WHERE ${filter} AND DestinationPrefix = '0.0.0.0/0'`, ['__RELPATH', 'NextHop', 'RouteMetric', 'Protocol', 'Publish', 'ValidLifetime'], context).map(row => {
				const gateway = text(row, 'NextHop');
				if (isIP(gateway) !== 4) throw new Error('Invalid default route');
				return { path: text(row, '__RELPATH'), gateway, metric: number(row, 'RouteMetric'), protocol: number(row, 'Protocol'), publish: number(row, 'Publish'), validLifetime: text(row, 'ValidLifetime') };
			});
			stores[store] = { interfacePath: text(interfaces[0]!, '__RELPATH'), dhcp: dhcp === null ? null : dhcp === 1, addresses, routes };
		}
		return { ...identity, stores, dns: readWindowsDnsPolicy(connection, identity.index, identity.guid) };
	} finally {
		if (!supplied) connection.close();
	}
}

export function usableWindowsAddress(address: WindowsIPv4Address): boolean {
	return address.state === 4 && !address.address.startsWith('169.254.') && !address.address.startsWith('127.');
}

export function assertRestorableWindowsIPv4(snapshot: WindowsIPv4Snapshot): void {
	const active = snapshot.stores.ActiveStore,
		persistent = snapshot.stores.PersistentStore;
	if (persistent.dhcp !== null && active.dhcp !== persistent.dhcp) throw new Error('DHCP policy stores disagree');
	if (active.dhcp) {
		if (persistent.addresses.length || persistent.routes.length || active.addresses.some(row => row.prefixOrigin === 1 || row.suffixOrigin === 1)) throw new Error('DHCP policy contains manual addressing');
		return;
	}
	const addressKey = (row: WindowsIPv4Address): string => `${row.address}/${row.prefixLength}`;
	const routeKey = (row: WindowsIPv4Route): string => `${row.gateway}/${row.metric}`;
	for (const store of [active, persistent]) {
		if (store.addresses.length !== 1 || store.routes.length > 1 || store.addresses.some(row => row.prefixOrigin !== 1 || row.suffixOrigin !== 1 || row.type !== 1 || row.skipAsSource || row.validLifetime !== WINDOWS_INFINITE_LIFETIME || row.preferredLifetime !== WINDOWS_INFINITE_LIFETIME) || store.routes.some(row => row.protocol !== 3 || row.publish !== 0 || row.validLifetime !== WINDOWS_INFINITE_LIFETIME)) throw new Error('IPv4 policy cannot be restored exactly');
	}
	if (!usableWindowsAddress(active.addresses[0]!) || addressKey(active.addresses[0]!) !== addressKey(persistent.addresses[0]!) || active.routes.length !== persistent.routes.length || active.routes.some((row, index) => routeKey(row) !== routeKey(persistent.routes[index]!))) throw new Error('IPv4 policy stores disagree');
}

const dnsKey = (values: readonly string[]): string => [...new Set(values.map(canonicalDnsServer))].sort().join(',');

export function windowsIPv4Fingerprint(snapshot: WindowsIPv4Snapshot): string {
	const stores = WINDOWS_POLICY_STORES.map(store => ({
		store,
		dhcp: snapshot.stores[store].dhcp,
		addresses: snapshot.stores[store].addresses.map(({ path: _path, state: _state, validLifetime, preferredLifetime, ...row }) => ({ ...row, infinite: validLifetime === WINDOWS_INFINITE_LIFETIME && preferredLifetime === WINDOWS_INFINITE_LIFETIME })).sort((a, b) => a.address.localeCompare(b.address)),
		routes: snapshot.stores[store].routes.map(({ path: _path, validLifetime, ...row }) => ({ ...row, infinite: validLifetime === WINDOWS_INFINITE_LIFETIME })).sort((a, b) => a.gateway.localeCompare(b.gateway)),
	}));
	return createHash('sha256')
		.update(JSON.stringify({ guid: snapshot.guid, mac: snapshot.mac, stores, dns: snapshot.dns.map(policy => ({ family: policy.family, automatic: policy.automatic, servers: dnsKey(policy.servers) })) }))
		.digest('hex');
}

export function assertWindowsIPv4Target(current: WindowsIPv4Snapshot, saved: WindowsIPv4Recovery): void {
	if (!sameWindowsInterface(current, saved.snapshot)) throw new Error('Interface identity changed');
	const desired = saved.desired;
	if (saved.addressingChanged) {
		for (const store of WINDOWS_POLICY_STORES) {
			const policy = current.stores[store];
			if (policy.dhcp !== null && policy.dhcp !== (desired.mode === 'dhcp')) throw new Error('DHCP apply did not preserve the requested mode');
			if (desired.mode === 'static') {
				if (policy.addresses.length !== 1 || policy.addresses[0]!.address !== desired.address || policy.addresses[0]!.prefixLength !== desired.prefixLength || (store === 'ActiveStore' && !usableWindowsAddress(policy.addresses[0]!))) throw new Error('IPv4 apply did not preserve the requested address');
				if (policy.routes.length !== (desired.gateway ? 1 : 0) || (desired.gateway && policy.routes[0]!.gateway !== desired.gateway)) throw new Error('IPv4 apply did not preserve the requested gateway');
				const oldMetric = saved.snapshot.stores.ActiveStore.routes[0]?.metric;
				if (desired.gateway && oldMetric !== undefined && policy.routes[0]!.metric !== oldMetric) throw new Error('IPv4 apply changed the route metric');
			} else if (store === 'PersistentStore' && (policy.addresses.length || policy.routes.length)) throw new Error('DHCP apply left persistent static policy');
		}
		if (desired.mode === 'dhcp' && saved.requireLease && !current.stores.ActiveStore.addresses.some(usableWindowsAddress)) throw new Error('DHCP apply did not obtain a usable lease');
	} else {
		const originalAddressing = { ...saved.snapshot, dns: current.dns };
		if (windowsIPv4Fingerprint(current) !== windowsIPv4Fingerprint(originalAddressing)) throw new Error('DNS-only apply changed addressing');
	}
	if (desired.dns === undefined) return;
	if (!desired.dns.length) {
		if (current.dns.some(policy => !policy.automatic)) throw new Error('DNS apply did not restore automatic policy');
	} else if (current.dns.every(policy => policy.automatic) || dnsKey(current.dns.flatMap(policy => policy.servers)) !== dnsKey(desired.dns)) throw new Error('DNS apply did not set the requested servers');
}

export function isWindowsIPv4Recovery(value: unknown): value is WindowsIPv4Recovery {
	try {
		const saved = value as WindowsIPv4Recovery;
		return !!saved && typeof saved.addressingChanged === 'boolean' && typeof saved.requireLease === 'boolean' && !validateIPv4Config(saved.desired) && /^[a-f0-9]{64}$/.test(saved.fingerprint) && windowsIPv4Fingerprint(saved.snapshot) === saved.fingerprint && isWindowsInterfaceID(saved.snapshot.guid);
	} catch {
		return false;
	}
}
