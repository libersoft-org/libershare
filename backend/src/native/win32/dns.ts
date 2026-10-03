import { isIP } from 'node:net';
import { isWindowsInterfaceID } from '../../system-network-windows.ts';
import { readLocalMachineString } from './registry.ts';
import type { WmiConnection, WmiMutationResult } from './wmi.ts';

export interface WindowsDnsPolicy {
	readonly family: 2 | 23;
	readonly path: string;
	readonly automatic: boolean;
	readonly servers: string[];
}

export function readWindowsDnsPolicy(connection: Pick<WmiConnection, 'query'>, index: number, guid: string, registry: typeof readLocalMachineString = readLocalMachineString): WindowsDnsPolicy[] {
	if (!Number.isInteger(index) || index <= 0 || !isWindowsInterfaceID(guid)) throw new Error('Invalid DNS interface identity');
	const rows = connection.query(`SELECT * FROM MSFT_DNSClientServerAddress WHERE InterfaceIndex = ${index}`, ['__RELPATH', 'AddressFamily', 'ServerAddresses']);
	return ([2, 23] as const).map(family => {
		const matches = rows.filter(row => row['AddressFamily']?.value === family);
		if (matches.length !== 1) throw new Error('DNS state is incomplete');
		const row = matches[0]!;
		const path = row['__RELPATH']?.value;
		const servers = row['ServerAddresses']?.value;
		if (typeof path !== 'string' || !path || !Array.isArray(servers) || servers.some(value => typeof value !== 'string' || isIP(value) !== (family === 2 ? 4 : 6))) throw new Error('Invalid DNS state');
		const value = registry(`SYSTEM\\CurrentControlSet\\Services\\${family === 2 ? 'Tcpip' : 'Tcpip6'}\\Parameters\\Interfaces\\${guid}`, 'NameServer');
		if (value?.trim() && servers.length === 0) throw new Error('Manual DNS policy cannot be restored');
		return { family, path, automatic: !value?.trim(), servers: [...servers] as string[] };
	});
}

/** The DnsClient CDXML uses ModifyInstance with these operation options. */
export function writeWindowsDnsPolicy(connection: Pick<WmiConnection, 'put'>, policy: WindowsDnsPolicy, servers: readonly string[] | null): WmiMutationResult {
	if (servers !== null && (!servers.length || servers.some(server => isIP(server) !== (policy.family === 2 ? 4 : 6)))) throw Object.assign(new Error('DNS server family does not match the target'), { mayHaveRun: false });
	return connection.put(policy.path, {}, servers === null ? { ResetServerAddresses: true } : { ServerAddresses: servers, Validate: false });
}

export function windowsDnsChanges(policies: readonly WindowsDnsPolicy[], requested: readonly string[] | undefined): { policy: WindowsDnsPolicy; servers: readonly string[] | null }[] {
	if (requested === undefined) return [];
	if (requested.some(server => !isIP(server))) throw new Error('Invalid DNS server');
	if (!requested.length) return policies.map(policy => ({ policy, servers: null }));
	return policies.flatMap(policy => {
		const servers = requested.filter(value => isIP(value) === (policy.family === 2 ? 4 : 6));
		return servers.length ? [{ policy, servers }] : [];
	});
}
