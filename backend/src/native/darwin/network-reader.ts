import { canonicalDnsServer, isIPv4, isIPv6, validateIPv4Config, type NetAddress, type NetInterfaceInfo, type NetMedium } from '@shared';
import { DarwinNetworkSession, darwinStrings, type DarwinDictionary, type DarwinService } from './network-framework.ts';
import { readDarwinKernelNetwork, type DarwinDefaultRoute, type DarwinInterface } from './routes.ts';

export interface DarwinNetworkSources {
	readonly interfaces: readonly DarwinInterface[];
	readonly routes: readonly DarwinDefaultRoute[];
	readonly services: readonly Omit<DarwinService, 'ref'>[];
	readonly ports: ReadonlyMap<string, { name: string; type: string }>;
	readonly values: ReadonlyMap<string, DarwinDictionary | null>;
}

export function darwinIPv4Mode(configuration: DarwinDictionary | null): NetInterfaceInfo['ipv4Mode'] {
	return configuration?.['ConfigMethod'] === 'DHCP' ? 'dhcp' : configuration?.['ConfigMethod'] === 'Manual' ? 'static' : 'unknown';
}
export function darwinIPv4Addresses(configuration: DarwinDictionary | null): NetAddress[] {
	const addresses = darwinStrings(configuration?.['Addresses']), masks = darwinStrings(configuration?.['SubnetMasks']);
	return addresses.flatMap((address, index) => {
		const mask = masks[index];
		if (!isIPv4(address) || !mask || !isIPv4(mask)) return [];
		const bits = mask.split('.').map(byte => Number(byte).toString(2).padStart(8, '0')).join('');
		if (!/^1*0*$/.test(bits)) return [];
		return [{ family: 'ipv4' as const, address, prefixLength: bits.indexOf('0') < 0 ? 32 : bits.indexOf('0') }];
	});
}
export function darwinRouter(configuration: DarwinDictionary | null): string | null {
	const router = configuration?.['Router'];
	return typeof router === 'string' && isIPv4(router) ? router : null;
}
function resolvers(configuration: DarwinDictionary | null): string[] {
	return darwinStrings(configuration?.['ServerAddresses']).filter(value => {
		const parts = value.split('%');
		return parts.length === 1 ? isIPv4(value) || isIPv6(value) : parts.length === 2 && /^[0-9a-z]{1,15}$/i.test(parts[1]!) && isIPv6(parts[0]!);
	});
}
function medium(port: { name: string; type: string } | undefined): NetMedium {
	if (!port) return 'other';
	if (port.type === 'IEEE80211' || /^Wi-Fi$|AirPort/i.test(port.name)) return 'wireless';
	return /Ethernet/i.test(port.name) ? 'wired' : 'other';
}
function dnsForService(source: DarwinNetworkSources, service: Omit<DarwinService, 'ref'> | undefined, device: string): string[] {
	const manual = resolvers(service?.dns ?? null);
	if (manual.length) return manual;
	const live = source.values.get(`State:/Network/Service/${service?.id}/DNS`) ?? source.values.get(`State:/Network/Interface/${device}/DNS`) ?? null;
	const dns = resolvers(live);
	if (dns.length) return dns;
	const packet = source.values.get(`State:/Network/Service/${service?.id}/DHCP`)?.['Option_6'];
	if (!Buffer.isBuffer(packet) || packet.length % 4) return [];
	return Array.from({ length: packet.length / 4 }, (_, index) => [...packet.subarray(index * 4, index * 4 + 4)].join('.'));
}

export function buildDarwinNetworkState(source: DarwinNetworkSources): NetInterfaceInfo[] {
	const primary4 = source.routes.find(route => route.family === 'ipv4' && !route.scoped);
	const primary6 = source.routes.find(route => route.family === 'ipv6' && !route.scoped && route.usable);
	const fallback6 = source.routes.filter(route => route.family === 'ipv6' && route.usable && source.interfaces.some(iface => iface.device === route.device && !iface.loopback && source.values.get(`State:/Network/Interface/${iface.device}/Link`)?.['Active'] !== false)).sort((a, b) => Number(a.scoped) - Number(b.scoped) || a.device.localeCompare(b.device))[0];
	const primary = primary4 ?? primary6 ?? fallback6;
	return source.interfaces.filter(iface => !iface.loopback).map(iface => {
		const bindings = source.services.filter(service => service.enabled && service.device === iface.device), service = bindings.length === 1 ? bindings[0] : undefined;
		const ipv4Mode = darwinIPv4Mode(service?.ipv4 ?? null), live4 = iface.addresses.filter(address => address.family === 'ipv4');
		const stored4 = ipv4Mode === 'static' && !live4.length ? darwinIPv4Addresses(service?.ipv4 ?? null) : [];
		const addresses = [...iface.addresses, ...stored4], ipv4 = addresses.filter(address => address.family === 'ipv4');
		const active4 = service ? source.values.get(`State:/Network/Service/${service.id}/IPv4`) ?? null : null;
		const gateway = darwinRouter(service?.ipv4 ?? null) ?? darwinRouter(active4) ?? (primary?.device === iface.device ? primary4?.gateway ?? null : null);
		const safeStatic = ipv4Mode !== 'static' || (ipv4.length === 1 && validateIPv4Config({ mode: 'static', address: ipv4[0]!.address, prefixLength: ipv4[0]!.prefixLength, gateway: gateway ?? '' }, { staticGatewayRequired: true }) === null);
		const link = source.values.get(`State:/Network/Interface/${iface.device}/Link`)?.['Active'];
		return { id: iface.device, name: bindings[0]?.name ?? source.ports.get(iface.device)?.name ?? iface.device, medium: medium(source.ports.get(iface.device)), link: link === true ? 'up' : link === false ? 'down' : 'unknown', defaultRoute: primary?.device === iface.device, mac: iface.mac, addresses, ipv4Mode, ipv4Configurable: !!service && ipv4Mode !== 'unknown' && safeStatic && ipv4.length <= 1 && source.routes.filter(route => route.family === 'ipv4' && route.device === iface.device).length <= 1, wifiConfigurable: false, gateway, dns: dnsForService(source, service, iface.device).map(canonicalDnsServer) };
	});
}

/** Worker entry: SCPreferences policy and SCDynamicStore state share BSD interface identities. */
export function readNativeDarwinNetwork(): NetInterfaceInfo[] {
	const session = new DarwinNetworkSession();
	try {
		const kernel = readDarwinKernelNetwork();
		const present = darwinStrings(session.value('State:/Network/Interface')?.['Interfaces']);
		if (!present.length && kernel.interfaces.length) throw new Error('The macOS interface inventory is unavailable');
		const values = new Map<string, DarwinDictionary | null>();
		for (const key of session.keys('State:/Network/(Interface|Service|Global)(/.*)?')) values.set(key, session.value(key));
		return buildDarwinNetworkState({ ...kernel, services: session.services(), ports: session.ports(), values });
	} finally { session.close(); }
}
