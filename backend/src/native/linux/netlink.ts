import { attributeString, attributeU32, decodeAttributes, formatNetlinkAddress, requireSize, align4, NetlinkError, type NetlinkMessage } from './netlink-wire.ts';
import { requestNetlink, type NetlinkReadOptions } from './netlink-socket.ts';
export type { NetlinkReadOptions } from './netlink-socket.ts';
export { NetlinkError } from './netlink-wire.ts';

export interface LinuxNetlinkAddress {
	index: number;
	family: 'inet' | 'inet6';
	local: string;
	prefixlen: number;
	scope: string;
	flags: number;
	dynamic: boolean;
	tentative: boolean;
	dadfailed: boolean;
	deprecated: boolean;
	label?: string;
	preferred_life_time?: number;
	valid_life_time?: number;
}

export interface LinuxNetlinkLink {
	ifindex: number;
	ifname: string;
	flags: string[];
	operstate: string;
	link_type: string;
	address?: string;
	linkinfo?: { info_kind: string };
}

export interface LinuxNetlinkNexthop {
	dev?: string;
	gateway?: string;
	weight: number;
	flags: string[];
}

export interface LinuxNetlinkRoute {
	dst: 'default';
	dev?: string;
	gateway?: string;
	metric?: number;
	protocol: string;
	prefsrc?: string;
	flags: string[];
	pref?: string;
	nexthops?: LinuxNetlinkNexthop[];
}

export interface LinuxNetlinkState {
	links: LinuxNetlinkLink[];
	addresses: LinuxNetlinkAddress[];
	routes4: LinuxNetlinkRoute[];
	routes6: LinuxNetlinkRoute[];
}

export function decodeNetlinkAddresses(messages: NetlinkMessage[]): LinuxNetlinkAddress[] {
	const result: LinuxNetlinkAddress[] = [];
	for (const { type, body } of messages) {
		if (type !== 20) throw new NetlinkError('Unexpected address reply');
		requireSize(body, 8, 'ifaddrmsg');
		const family = body[0]!;
		if (family !== 2 && family !== 10) continue;
		if (body[1]! > (family === 2 ? 32 : 128)) throw new NetlinkError('Invalid address prefix');
		const attrs = decodeAttributes(body.subarray(8));
		const address = attrs.get(2) ?? attrs.get(1);
		if (!address) throw new NetlinkError('Address reply has no address');
		const flags = attrs.has(8) ? attributeU32(attrs.get(8)!) : body[2]!;
		const scopes: Record<number, string> = { 0: 'global', 200: 'site', 253: 'link', 254: 'host', 255: 'nowhere' };
		const entry: LinuxNetlinkAddress = { index: body.readUInt32LE(4), family: family === 2 ? 'inet' : 'inet6', local: formatNetlinkAddress(address, family), prefixlen: body[1]!, scope: scopes[body[3]!] ?? String(body[3]), flags, dynamic: !(flags & 0x80), tentative: !!(flags & 0x40), dadfailed: !!(flags & 8), deprecated: !!(flags & 0x20) };
		if (attrs.has(3)) entry.label = attributeString(attrs.get(3)!);
		const cache = attrs.get(6);
		if (cache) {
			requireSize(cache, 16, 'ifa_cacheinfo');
			entry.preferred_life_time = cache.readUInt32LE();
			entry.valid_life_time = cache.readUInt32LE(4);
		}
		result.push(entry);
	}
	return result;
}

export function decodeNetlinkLinks(messages: NetlinkMessage[]): LinuxNetlinkLink[] {
	return messages.map(({ type, body }) => {
		if (type !== 16) throw new NetlinkError('Unexpected link reply');
		requireSize(body, 16, 'ifinfomsg');
		const attrs = decodeAttributes(body.subarray(16));
		if (!attrs.has(3)) throw new NetlinkError('Link reply has no interface name');
		const flags = body.readUInt32LE(8);
		const flagNames: Array<[number, string]> = [
			[1, 'UP'],
			[2, 'BROADCAST'],
			[8, 'LOOPBACK'],
			[16, 'POINTOPOINT'],
			[64, 'RUNNING'],
			[128, 'NOARP'],
			[256, 'PROMISC'],
			[512, 'ALLMULTI'],
			[4096, 'MULTICAST'],
			[65536, 'LOWER_UP'],
			[131072, 'DORMANT'],
		];
		const state = attrs.get(16);
		if (state) requireSize(state, 1, 'operstate');
		const entry: LinuxNetlinkLink = { ifindex: body.readInt32LE(4), ifname: attributeString(attrs.get(3)!), flags: flagNames.filter(([bit]) => flags & bit).map(([, name]) => name), operstate: ['UNKNOWN', 'NOTPRESENT', 'DOWN', 'LOWERLAYERDOWN', 'TESTING', 'DORMANT', 'UP'][state?.[0] ?? 0] ?? 'UNKNOWN', link_type: body.readUInt16LE(2) === 772 ? 'loopback' : body.readUInt16LE(2) === 1 ? 'ether' : String(body.readUInt16LE(2)) };
		if (attrs.has(1)) entry.address = [...attrs.get(1)!].map(byte => byte.toString(16).padStart(2, '0')).join(':');
		if (attrs.has(18)) {
			const kind = decodeAttributes(attrs.get(18)!).get(1);
			if (kind) entry.linkinfo = { info_kind: attributeString(kind) };
		}
		return entry;
	});
}

function routeFlags(flags: number): string[] {
	return (
		[
			[1, 'dead'],
			[2, 'pervasive'],
			[4, 'onlink'],
			[8, 'offload'],
			[16, 'linkdown'],
			[32, 'unresolved'],
			[64, 'trap'],
		] as const
	)
		.filter(([bit]) => flags & bit)
		.map(([, name]) => name);
}

export function decodeNetlinkRoutes(messages: NetlinkMessage[], ifnames: ReadonlyMap<number, string>): LinuxNetlinkRoute[] {
	const result: LinuxNetlinkRoute[] = [];
	const interfaceName = (index: number): string => {
		const name = ifnames.get(index);
		if (!name) throw new NetlinkError('Route references an unknown interface');
		return name;
	};
	for (const { type, body } of messages) {
		if (type !== 24) throw new NetlinkError('Unexpected route reply');
		requireSize(body, 12, 'rtmsg');
		const family = body[0]!;
		const attrs = decodeAttributes(body.subarray(12));
		const table = attrs.has(15) ? attributeU32(attrs.get(15)!) : body[4];
		if ((family !== 2 && family !== 10) || body[1] !== 0 || table !== 254 || body[7] !== 1) continue;
		const protocols: Record<number, string> = { 2: 'kernel', 3: 'boot', 4: 'static', 9: 'ra', 16: 'dhcp' };
		const entry: LinuxNetlinkRoute = { dst: 'default', protocol: protocols[body[5]!] ?? String(body[5]), flags: routeFlags(body.readUInt32LE(8)) };
		if (attrs.has(5)) entry.gateway = formatNetlinkAddress(attrs.get(5)!, family);
		if (attrs.has(4)) entry.dev = interfaceName(attributeU32(attrs.get(4)!));
		if (attrs.has(6)) entry.metric = attributeU32(attrs.get(6)!);
		if (attrs.has(7)) entry.prefsrc = formatNetlinkAddress(attrs.get(7)!, family);
		if (attrs.has(20)) {
			const pref = attrs.get(20)!;
			requireSize(pref, 1, 'route preference');
			entry.pref = ({ 0: 'medium', 1: 'high', 3: 'low' } as Record<number, string>)[pref[0]!] ?? String(pref[0]);
		}
		const multipath = attrs.get(9);
		if (multipath) {
			entry.nexthops = [];
			for (let offset = 0; offset < multipath.length;) {
				requireSize(multipath.subarray(offset), 8, 'rtnexthop');
				const length = multipath.readUInt16LE(offset);
				if (length < 8 || offset + align4(length) > multipath.length) throw new NetlinkError('Invalid nexthop length');
				const nested = decodeAttributes(multipath.subarray(offset + 8, offset + length));
				const hop: LinuxNetlinkNexthop = { dev: interfaceName(multipath.readUInt32LE(offset + 4)), weight: multipath[offset + 3]! + 1, flags: routeFlags(multipath[offset + 2]!) };
				if (nested.has(5)) hop.gateway = formatNetlinkAddress(nested.get(5)!, family);
				entry.nexthops.push(hop);
				offset += align4(length);
			}
		}
		result.push(entry);
	}
	return result;
}

export async function readLinuxNetlinkState(options: NetlinkReadOptions = {}): Promise<LinuxNetlinkState> {
	const deadline = performance.now() + (options.timeoutMs ?? 5000);
	const remaining = (): NetlinkReadOptions => ({ ...options, timeoutMs: Math.max(0, deadline - performance.now()) });
	const links = decodeNetlinkLinks(await requestNetlink(0, 18, Buffer.alloc(16), true, remaining()));
	const addresses = decodeNetlinkAddresses(await requestNetlink(0, 22, Buffer.alloc(8), true, remaining()));
	const ifnames = new Map(links.map(link => [link.ifindex, link.ifname]));
	const route4 = Buffer.alloc(12);
	route4[0] = 2;
	const route6 = Buffer.alloc(12);
	route6[0] = 10;
	const routes4 = decodeNetlinkRoutes(await requestNetlink(0, 26, route4, true, remaining()), ifnames);
	const routes6 = decodeNetlinkRoutes(await requestNetlink(0, 26, route6, true, remaining()), ifnames);
	return { links, addresses, routes4, routes6 };
}
