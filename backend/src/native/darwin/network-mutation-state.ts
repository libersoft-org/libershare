import { validateIPv4Config, type NetIPv4Config, type NetAddress } from '@shared';
import { DarwinNetworkSession, darwinDictionary, type DarwinDictionary } from './network-framework.ts';
import { darwinIPv4Mode, darwinIPv4Addresses, darwinRouter } from './network-reader.ts';
import { readDarwinKernelNetwork, type DarwinDefaultRoute } from './routes.ts';
import type { CFRef } from './cf.ts';

export interface DarwinIPv4Recovery {
	readonly device: string;
	readonly serviceId: string;
	readonly interfaceIndex: number;
	readonly mac: string | null;
	readonly original: { readonly ipv4: string | null; readonly dns: string | null; readonly hadLease: boolean; readonly linkActive: boolean };
	readonly target: { readonly ipv4: string | null; readonly dns: string | null };
	readonly desired: NetIPv4Config;
	readonly addressingChanged: boolean;
	readonly requireLease: boolean;
}
export interface DarwinIPv4Observation { readonly original: boolean; readonly target: boolean }

export function isDarwinIPv4Recovery(value: unknown): value is DarwinIPv4Recovery {
	if (!value || typeof value !== 'object') return false;
	const data = value as DarwinIPv4Recovery;
	const plist = (value: unknown): boolean => value === null || (typeof value === 'string' && value.length <= 8 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(value));
	return typeof data.device === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(data.device) && typeof data.serviceId === 'string' && !!data.serviceId && Number.isSafeInteger(data.interfaceIndex) && data.interfaceIndex > 0 && (data.mac === null || typeof data.mac === 'string') && !!data.original && !!data.target && plist(data.original.ipv4) && plist(data.original.dns) && plist(data.target.ipv4) && plist(data.target.dns) && typeof data.original.hadLease === 'boolean' && typeof data.original.linkActive === 'boolean' && typeof data.addressingChanged === 'boolean' && typeof data.requireLease === 'boolean' && !!data.desired && validateIPv4Config(data.desired, { staticGatewayRequired: true }) === null;
}

export function usableDarwinAddress(address: string): boolean { return address !== '0.0.0.0' && !address.startsWith('169.254.') && !address.startsWith('127.'); }

export function darwinStaticStateMatches(configuration: DarwinDictionary | null, live: DarwinDictionary | null, addresses: readonly NetAddress[], routes: readonly DarwinDefaultRoute[]): boolean {
	const expected = darwinIPv4Addresses(configuration), state = darwinIPv4Addresses(live), gateway = darwinRouter(configuration);
	const matching = (list: readonly NetAddress[]): boolean => expected.length === 1 && list.length === 1 && list[0]!.address === expected[0]!.address && list[0]!.prefixLength === expected[0]!.prefixLength;
	return matching(addresses) && matching(state) && darwinRouter(live) === gateway && routes.length === (gateway ? 1 : 0) && routes.every(route => route.gateway === gateway && route.usable);
}

/** Read-only worker entry; full CF equality includes keys that the UI does not expose. */
export function observeDarwinIPv4(saved: DarwinIPv4Recovery): DarwinIPv4Observation {
	if (!isDarwinIPv4Recovery(saved)) throw new Error('Invalid macOS IPv4 recovery snapshot');
	const session = new DarwinNetworkSession();
	try {
		const service = session.services().find(service => service.id === saved.serviceId && service.device === saved.device && service.enabled);
		const kernel = readDarwinKernelNetwork(), iface = kernel.interfaces.find(iface => iface.device === saved.device);
		if (!service || !iface || iface.index !== saved.interfaceIndex || iface.mac !== saved.mac) return { original: false, target: false };
		const ipv4 = session.protocol(service.ref, 'IPv4'), dns = session.protocol(service.ref, 'DNS');
		const actual4 = ipv4 ? session.sc.SCNetworkProtocolGetConfiguration(ipv4) : 0n, actualDns = dns ? session.sc.SCNetworkProtocolGetConfiguration(dns) : 0n;
		const equal = (actual: CFRef, encoded: string | null): boolean => {
			const expected = session.cf.deserialize(encoded);
			return !actual || !expected ? actual === expected : session.cf.symbols.CFEqual(actual, expected);
		};
		const addresses = iface.addresses.filter(address => address.family === 'ipv4');
		const hasLease = addresses.some(address => usableDarwinAddress(address.address));
		const live = session.value(`State:/Network/Service/${saved.serviceId}/IPv4`);
		const routes = kernel.routes.filter(route => route.family === 'ipv4' && route.device === saved.device);
		const staticMatches = (configuration: DarwinDictionary | null): boolean => darwinStaticStateMatches(configuration, live, addresses, routes);
		const originalConfiguration = darwinDictionary(session.cf.toJS(session.cf.deserialize(saved.original.ipv4)));
		const originalLive = darwinIPv4Mode(originalConfiguration) === 'static' && saved.original.linkActive ? staticMatches(originalConfiguration) : !saved.original.hadLease || hasLease;
		const original = equal(actual4, saved.original.ipv4) && equal(actualDns, saved.original.dns) && originalLive;
		let liveTarget = true;
		if (saved.addressingChanged) {
			if (saved.desired.mode === 'dhcp') liveTarget = !saved.requireLease || hasLease;
			else {
				liveTarget = saved.requireLease ? staticMatches(service.ipv4) : darwinIPv4Mode(service.ipv4) === 'static';
			}
		}
		return { original, target: liveTarget && equal(actual4, saved.target.ipv4) && equal(actualDns, saved.target.dns) };
	} finally { session.close(); }
}
