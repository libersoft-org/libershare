import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isIPv4, isIPv6, validateIPv4Config } from '../../../../shared/src/utils.ts';
import type { NetCapabilities, NetWifiNetwork } from '../../../../shared/src/index.ts';
import type { LinuxNetworkSources, NmcliIPv4Profile } from '../../system-network-linux.ts';
import { DBusError, SystemBus, isUniqueDBusName, type DBusRequest, type DBusReply, type DBusVariant, type DBusValue } from './dbus.ts';
import { readLinuxNetlinkState, type LinuxNetlinkState } from './netlink.ts';
import { readNl80211Link, type Nl80211Link } from './nl80211.ts';
import { formatNetlinkAddress } from './netlink-wire.ts';

const NM = 'org.freedesktop.NetworkManager';
const NM_PATH = '/org/freedesktop/NetworkManager';
type Properties = Record<string, DBusVariant>;
type Settings = Record<string, Properties>;

export interface NativeNetworkReadOptions {
	timeoutMs: number;
}
export interface NativeNetworkSources {
	sources: LinuxNetworkSources;
	ipv4ProfilesUnavailable: boolean;
}
export interface NativeNetworkReaderDeps {
	readonly openBus: () => Pick<SystemBus, 'call' | 'close'>;
	readonly netlink: (options: NativeNetworkReadOptions) => Promise<LinuxNetlinkState>;
	readonly wifiLink: (index: number, options: NativeNetworkReadOptions) => Promise<Nl80211Link>;
	readonly readFile: (path: string) => string;
	readonly realpath: (path: string) => string;
	readonly exists: (path: string) => boolean;
	readonly listLinks: () => string[];
}

const nativeDeps: NativeNetworkReaderDeps = {
	openBus: () => new SystemBus(),
	netlink: readLinuxNetlinkState,
	wifiLink: readNl80211Link,
	readFile: path => readFileSync(path, 'utf8'),
	realpath: realpathSync,
	exists: existsSync,
	listLinks: () =>
		readdirSync('/sys/class/net', { withFileTypes: true })
			.filter(entry => entry.isDirectory() || entry.isSymbolicLink())
			.map(entry => entry.name),
};

function budget(options: NativeNetworkReadOptions): () => NativeNetworkReadOptions {
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('Invalid network read timeout');
	const deadline = performance.now() + options.timeoutMs;
	return () => {
		const timeoutMs = deadline - performance.now();
		if (timeoutMs <= 0) throw new Error('Network read timed out');
		return { timeoutMs };
	};
}

function dictionary(value: unknown): Record<string, DBusValue> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array || value instanceof Map) throw new Error('Invalid NetworkManager dictionary');
	return value as Record<string, DBusValue>;
}

function property(values: Properties, name: string, signature: string, fallback?: DBusValue): DBusValue {
	const entry = values[name];
	if (entry === undefined && fallback !== undefined) return fallback;
	if (!entry || entry.sig !== signature) throw new Error(`Invalid NetworkManager property ${name}`);
	return entry.value;
}

function text(values: Properties, name: string, signature = 's', fallback?: string): string {
	const value = property(values, name, signature, fallback);
	if (typeof value !== 'string') throw new Error(`Invalid NetworkManager string ${name}`);
	return value;
}

function number(values: Properties, name: string, fallback?: number, signature = 'u'): number {
	const value = property(values, name, signature, fallback);
	if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid NetworkManager number ${name}`);
	return value;
}

function array(values: Properties, name: string, signature: string, fallback?: DBusValue[]): DBusValue[] {
	const value = property(values, name, signature, fallback);
	if (!Array.isArray(value)) throw new Error(`Invalid NetworkManager array ${name}`);
	return value;
}

function paths(values: Properties, name: string): string[] {
	return array(values, name, 'ao').map(value => {
		if (typeof value !== 'string' || !/^\/(?:[A-Za-z0-9_]+\/?)*$/.test(value)) throw new Error(`Invalid NetworkManager object path ${name}`);
		return value;
	});
}

function networkIPv4(value: DBusValue): string {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('Invalid legacy IPv4 address');
	const bytes = Buffer.alloc(4);
	bytes.writeUInt32LE(value);
	return formatNetlinkAddress(bytes, 2);
}

export function parseNativeNameservers(values: Properties, family: 4 | 6): string[] {
	let addresses: string[];
	if (values['NameserverData']) addresses = array(values, 'NameserverData', 'aa{sv}').map(entry => text(dictionary(entry) as Properties, 'address'));
	else
		addresses = array(values, 'Nameservers', family === 4 ? 'au' : 'aay').map(value => {
			if (family === 4) return networkIPv4(value);
			if (!(value instanceof Uint8Array)) throw new Error('Invalid legacy IPv6 resolver');
			return formatNetlinkAddress(Buffer.from(value), 10);
		});
	if (addresses.some(address => (family === 4 ? !isIPv4(address) : !isIPv6(address)))) throw new Error('Invalid NetworkManager resolver');
	return addresses;
}

export function parseNativeIPv4Profile(settings: Settings, expectedDevice: string, activeInstances: number): NmcliIPv4Profile {
	const connection = dictionary(settings['connection']) as Properties;
	const ipv4 = settings['ipv4'];
	if (!ipv4) {
		const type = text(connection, 'type');
		const portType = text(connection, 'port-type', 's', text(connection, 'slave-type', 's', ''));
		const controller = text(connection, 'controller', 's', text(connection, 'master', 's', ''));
		if (!['wpan', '6lowpan', 'ovs-bridge'].includes(type) && !(type !== 'ovs-interface' && controller && ['bridge', 'bond', 'team', 'ovs-bridge', 'ovs-port'].includes(portType))) throw new Error('NetworkManager profile has no IPv4 section');
		return { method: '', gateway: null, address: null, prefixLength: null, safe: false };
	}
	const method = text(ipv4, 'method');
	let gateway = text(ipv4, 'gateway', 's', '');
	const addresses = ipv4['address-data']
		? array(ipv4, 'address-data', 'aa{sv}').map(value => {
				const entry = dictionary(value) as Properties;
				return { address: text(entry, 'address'), prefix: number(entry, 'prefix') };
			})
		: array(ipv4, 'addresses', 'aau', []).map(value => {
				if (!Array.isArray(value) || value.length !== 3 || typeof value[1] !== 'number') throw new Error('Invalid legacy IPv4 profile address');
				if (!gateway && value[2] !== 0) gateway = networkIPv4(value[2]!);
				return { address: networkIPv4(value[0]!), prefix: value[1] };
			});
	const single = addresses.length === 1 ? addresses[0]! : undefined;
	const simple = single !== undefined && validateIPv4Config({ mode: 'static', address: single.address, prefixLength: single.prefix, gateway }) === null;
	const bound = text(connection, 'interface-name', 's', '') === expectedDevice && [0, 1].includes(number(connection, 'multi-connect', 0, 'i')) && activeInstances === 1;
	const neverDefault = property(ipv4, 'never-default', 'b', false);
	if (typeof neverDefault !== 'boolean') throw new Error('Invalid NetworkManager never-default');
	const safe = bound && ['auto', 'manual'].includes(method) && !neverDefault && array(ipv4, 'route-data', 'aa{sv}', []).length === 0 && array(ipv4, 'routes', 'aau', []).length === 0 && number(ipv4, 'route-table', 0) === 0 && array(ipv4, 'routing-rules', 'aa{sv}', []).length === 0 && (!gateway || isIPv4(gateway)) && (method === 'auto' ? addresses.length === 0 && !gateway : simple);
	return { method, gateway: gateway || null, address: simple ? single!.address : null, prefixLength: simple ? single!.prefix : null, safe };
}

interface NetworkManagerRead {
	root: Properties;
	all: (path: string, iface: string) => Promise<Properties>;
	call: (path: string, iface: string, member: string, signature?: string, args?: DBusValue[]) => Promise<DBusReply>;
}

async function networkManager(bus: Pick<SystemBus, 'call'>, remaining: () => NativeNetworkReadOptions): Promise<NetworkManagerRead> {
	const owner = await bus.call({ kind: 'read', destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'GetNameOwner', signature: 's', args: [NM], timeoutUsec: BigInt(Math.ceil(remaining().timeoutMs * 1000)) });
	if (owner.type === 'error') throw new DBusError(owner);
	const destination = owner.values[0];
	if (owner.signature !== 's' || !isUniqueDBusName(destination)) throw new Error('Invalid NetworkManager owner');
	const call: NetworkManagerRead['call'] = async (path, iface, member, signature = '', args = []) => {
		const request: DBusRequest = { kind: 'read', destination, path, interface: iface, member, signature, args, timeoutUsec: BigInt(Math.ceil(remaining().timeoutMs * 1000)) };
		const reply = await bus.call(request);
		if (reply.type === 'error') throw new DBusError(reply);
		if (reply.sender !== destination) throw new Error('NetworkManager reply owner changed');
		return reply;
	};
	const all: NetworkManagerRead['all'] = async (path, iface) => {
		const reply = await call(path, 'org.freedesktop.DBus.Properties', 'GetAll', 's', [iface]);
		if (reply.signature !== 'a{sv}' || reply.values.length !== 1) throw new Error('Invalid NetworkManager properties reply');
		return dictionary(reply.values[0]) as Properties;
	};
	const root = await all(NM_PATH, NM);
	if (number(root, 'State') === 0) throw new Error('NetworkManager state is unknown');
	return { root, all, call };
}

async function mapBounded<T, R>(values: T[], read: (value: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	for (let start = 0; start < values.length; start += 16) results.push(...(await Promise.all(values.slice(start, start + 16).map(read))));
	return results;
}

async function nmDevices(nm: NetworkManagerRead): Promise<{ dns: Map<string, string[]>; managedDevices: Set<string> }> {
	const entries = await mapBounded(paths(nm.root, 'Devices'), async path => {
		const props = await nm.all(path, `${NM}.Device`);
		const managed = property(props, 'Managed', 'b');
		if (typeof managed !== 'boolean') throw new Error('Invalid managed device flag');
		const dns: string[] = [];
		for (const family of [4, 6] as const) {
			const ipPath = text(props, `Ip${family}Config`, 'o');
			if (ipPath !== '/') dns.push(...parseNativeNameservers(await nm.all(ipPath, `${NM}.IP${family}Config`), family));
		}
		return { name: text(props, 'Interface'), managed, dns };
	});
	return { dns: new Map(entries.map(entry => [entry.name, entry.dns])), managedDevices: new Set(entries.filter(entry => entry.managed).map(entry => entry.name)) };
}

async function nmProfiles(nm: NetworkManagerRead): Promise<{ connections: Map<string, string>; ipv4Profiles: Map<string, NmcliIPv4Profile> }> {
	const active = await mapBounded(paths(nm.root, 'ActiveConnections'), async path => {
		const props = await nm.all(path, `${NM}.Connection.Active`);
		const devices = await mapBounded(paths(props, 'Devices'), async device => text(await nm.all(device, `${NM}.Device`), 'Interface'));
		return { uuid: text(props, 'Uuid'), path: text(props, 'Connection', 'o'), devices };
	});
	const connections = new Map<string, string>();
	const counts = new Map<string, number>();
	for (const item of active)
		for (const device of item.devices) {
			if (connections.has(device)) throw new Error('Multiple active profiles on one device');
			connections.set(device, item.uuid);
			counts.set(item.uuid, (counts.get(item.uuid) ?? 0) + 1);
		}
	const ipv4Profiles = new Map<string, NmcliIPv4Profile>();
	await mapBounded(active, async item => {
		const reply = await nm.call(item.path, `${NM}.Settings.Connection`, 'GetSettings');
		if (reply.signature !== 'a{sa{sv}}' || reply.values.length !== 1) throw new Error('Invalid NetworkManager settings reply');
		const settings = dictionary(reply.values[0]) as Settings;
		if (text(dictionary(settings['connection']) as Properties, 'uuid') !== item.uuid) throw new Error('NetworkManager profile UUID changed');
		for (const device of item.devices) ipv4Profiles.set(device, parseNativeIPv4Profile(settings, device, counts.get(item.uuid)!));
	});
	return { connections, ipv4Profiles };
}

export async function readNativeLinuxNetwork(options: NativeNetworkReadOptions, deps: NativeNetworkReaderDeps = nativeDeps): Promise<NativeNetworkSources> {
	const remaining = budget(options);
	const state = await deps.netlink(remaining());
	const names = new Set(deps.listLinks().filter(name => name.length > 0 && !name.includes('/') && !name.includes('\0') && name !== '.' && name !== '..' && deps.exists(`/sys/class/net/${name}/operstate`)));
	const links = state.links
		.filter(link => names.has(link.ifname))
		.map(link => {
			const root = `/sys/class/net/${link.ifname}`;
			const operstate = deps.readFile(`${root}/operstate`).trim().toUpperCase();
			let carrier: string;
			try {
				carrier = deps.readFile(`${root}/carrier`).trim();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EINVAL') throw error;
				carrier = '0';
			}
			if (carrier !== '0' && carrier !== '1') throw new Error('Invalid sysfs carrier');
			const flags = carrier === '0' && link.flags.includes('UP') ? [...link.flags, 'NO-CARRIER'] : link.flags;
			return { ...link, flags, operstate, ...(deps.realpath(root).includes('/virtual/') && !link.linkinfo ? { linkinfo: { info_kind: 'virtual' } } : {}) };
		});
	const sources: LinuxNetworkSources = { addr: JSON.stringify(links.map(link => ({ ...link, addr_info: state.addresses.filter(address => address.index === link.ifindex) }))), link: JSON.stringify(links), route: JSON.stringify(state.routes4), route6: JSON.stringify(state.routes6), wireless: new Set(), nativeWifi: new Map() };
	for (const link of links) {
		if (!deps.exists(`/sys/class/net/${link.ifname}/phy80211`)) continue;
		sources.wireless!.add(link.ifname);
		try {
			sources.nativeWifi!.set(link.ifname, await deps.wifiLink(link.ifindex, remaining()));
		} catch {
			/* Drivers may not implement station queries. */
		}
	}
	try {
		const proc = deps.readFile('/proc/net/wireless');
		sources.procSignals = new Map(
			proc.split('\n').flatMap(line => {
				const match = line.match(/^\s*([a-zA-Z0-9._-]+):\s*[0-9a-f]+\s+(-?\d+)\.?\s+(-?\d+)\.?/);
				const level = Number(match?.[3]);
				return match?.[1] && level < 0 ? [[match[1], Math.min(100, Math.max(0, Math.round(2 * (level + 100))))] as [string, number]] : [];
			})
		);
	} catch {
		sources.procSignals = new Map();
	}
	try {
		sources.resolvers = deps
			.readFile('/etc/resolv.conf')
			.split('\n')
			.flatMap(line => line.match(/^\s*nameserver\s+(\S+)/)?.[1] ?? []);
	} catch {
		sources.resolvers = [];
	}
	let bus: ReturnType<NativeNetworkReaderDeps['openBus']> | undefined;
	let ipv4ProfilesUnavailable = false;
	try {
		bus = deps.openBus();
		const nm = await networkManager(bus, remaining);
		const [devices, profiles] = await Promise.allSettled([nmDevices(nm), nmProfiles(nm)]);
		if (devices.status === 'fulfilled') {
			sources.nmDns = devices.value.dns;
			sources.managedDevices = devices.value.managedDevices;
		}
		if (profiles.status === 'fulfilled') {
			sources.activeConnections = profiles.value.connections;
			sources.ipv4Profiles = profiles.value.ipv4Profiles;
		} else ipv4ProfilesUnavailable = (sources.managedDevices?.size ?? 0) > 0;
	} catch {
		/* Kernel state remains useful when NetworkManager is absent or inaccessible. */
	} finally {
		bus?.close();
	}
	return { sources, ipv4ProfilesUnavailable };
}

export async function readNativeLinuxCapabilities(options: NativeNetworkReadOptions, deps: Pick<NativeNetworkReaderDeps, 'openBus'> = nativeDeps): Promise<NetCapabilities> {
	const remaining = budget(options);
	let bus: ReturnType<NativeNetworkReaderDeps['openBus']> | undefined;
	try {
		bus = deps.openBus();
		const nm = await networkManager(bus, remaining);
		const reply = await nm.call(NM_PATH, NM, 'GetPermissions');
		if (reply.signature !== 'a{ss}' || reply.values.length !== 1) throw new Error('Invalid NetworkManager permissions');
		const permissions = dictionary(reply.values[0]);
		const verdicts = ['settings.modify.system', 'network-control', 'checkpoint-rollback'].map(name => permissions[`${NM}.${name}`]);
		const nativeIPv4 = verdicts.every(value => value === 'yes');
		const elevation = !nativeIPv4 && verdicts.every(value => value === 'yes' || value === 'auth');
		return { ipv4: nativeIPv4 || elevation, ...(elevation ? { ipv4Elevation: true } : {}), wifi: nativeIPv4 && permissions[`${NM}.wifi.scan`] === 'yes', staticGatewayRequired: false };
	} catch {
		return { ipv4: false, wifi: false, staticGatewayRequired: false };
	} finally {
		bus?.close();
	}
}

export async function scanNativeLinuxWifi(device: string, options: NativeNetworkReadOptions, deps: Pick<NativeNetworkReaderDeps, 'openBus'> = nativeDeps): Promise<NetWifiNetwork[]> {
	const remaining = budget(options);
	const bus = deps.openBus();
	try {
		const nm = await networkManager(bus, remaining);
		const reply = await nm.call(NM_PATH, NM, 'GetDeviceByIpIface', 's', [device]);
		if (reply.signature !== 'o' || typeof reply.values[0] !== 'string') throw new Error('Invalid wireless device path');
		const path = reply.values[0];
		const before = await nm.all(path, `${NM}.Device.Wireless`);
		const lastScan = property(before, 'LastScan', 'x');
		await nm.call(path, `${NM}.Device.Wireless`, 'RequestScan', 'a{sv}', [{}]);
		let wireless: Properties;
		do {
			await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining().timeoutMs)));
			wireless = await nm.all(path, `${NM}.Device.Wireless`);
		} while (property(wireless, 'LastScan', 'x') === lastScan);
		const active = text(wireless, 'ActiveAccessPoint', 'o');
		const networks = await mapBounded(paths(wireless, 'AccessPoints'), async apPath => {
			const ap = await nm.all(apPath, `${NM}.AccessPoint`);
			const ssid = property(ap, 'Ssid', 'ay');
			if (!(ssid instanceof Uint8Array) || ssid.length > 32) throw new Error('Invalid access point SSID');
			const wpa = number(ap, 'WpaFlags'),
				rsn = number(ap, 'RsnFlags');
			const flags = number(ap, 'Flags');
			const enterprise = !!((wpa | rsn) & (0x200 | 0x2000));
			const owe = !!((wpa | rsn) & (0x800 | 0x1000));
			// NetworkManager 1.46 devices.c renders SECURITY in this order.
			const security = [flags & 1 && !wpa && !rsn ? 'WEP' : '', wpa ? 'WPA1' : '', rsn & 0x300 ? 'WPA2' : '', rsn & 0x400 ? 'WPA3' : '', rsn & 0x800 ? 'OWE' : rsn & 0x1000 ? 'OWE-TM' : '', (wpa | rsn) & 0x200 ? '802.1X' : '', (wpa | rsn) & 0x2000 ? 'WPA-EAP-SUITE-B-192' : ''].filter(Boolean).join(' ');
			const bssid = text(ap, 'HwAddress');
			if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(bssid)) throw new Error('Invalid access point BSSID');
			const secured = !!(flags & 1) || !!wpa || !!rsn;
			const network = { ssid: Buffer.from(ssid).toString('utf8'), ssidHex: Buffer.from(ssid).toString('hex'), bssid: bssid.toUpperCase(), signal: Math.min(100, Math.max(0, number(ap, 'Strength', undefined, 'y'))), secured, security, supported: !enterprise && !owe && (!secured || !!((wpa | rsn) & (0x100 | 0x400))), active: apPath === active };
			return { network, path: apPath, frequency: number(ap, 'Frequency'), bitrate: number(ap, 'MaxBitrate'), wep: security === 'WEP' };
		});
		// The legacy parser re-sorts nmcli by strength, retaining compare_aps order for ties.
		networks.sort((a, b) => b.network.signal - a.network.signal || Number(a.wep) - Number(b.wep) || a.frequency - b.frequency || b.bitrate - a.bitrate || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		const distinct = new Map<string, NetWifiNetwork>();
		for (const { network } of networks) {
			if (!network.ssid) continue;
			const key = `${network.ssidHex}\0${network.bssid}\0${network.security}`;
			const previous = distinct.get(key);
			if (!previous) distinct.set(key, network);
			else if (network.active) previous.active = true;
		}
		return [...distinct.values()];
	} finally {
		bus.close();
	}
}
