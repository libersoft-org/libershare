import { attributeU32, decodeAttributes, encodeAttribute, requireSize, NetlinkError, type NetlinkMessage } from './netlink-wire.ts';
import { requestNetlink, type NetlinkReadOptions } from './netlink-socket.ts';

export interface Nl80211Link {
	ssid: string | null;
	bssid: string | null;
	signal: number | null;
}

export interface Nl80211Bss extends Nl80211Link {
	frequency: number | null;
	status: number | null;
	capability: number | null;
	informationElements: Buffer;
}

function genericAttributes(message: NetlinkMessage): Map<number, Buffer> {
	requireSize(message.body, 4, 'genlmsghdr');
	return decodeAttributes(message.body.subarray(4));
}

function macAddress(data: Buffer): string {
	if (data.length !== 6) throw new NetlinkError('Invalid BSSID length');
	return [...data].map(byte => byte.toString(16).padStart(2, '0')).join(':');
}

function ssidFromElements(data: Buffer): string | null {
	let ssid: string | null = null;
	for (let offset = 0; offset < data.length;) {
		requireSize(data.subarray(offset), 2, '802.11 information element');
		const length = data[offset + 1]!;
		if (offset + 2 + length > data.length) throw new NetlinkError('Invalid 802.11 information element length');
		if (data[offset] === 0) {
			if (length > 32) throw new NetlinkError('Invalid SSID length');
			ssid = data.toString('utf8', offset + 2, offset + 2 + length);
		}
		offset += 2 + length;
	}
	return ssid;
}

function isWirelessClient(interfaces: NetlinkMessage[]): boolean {
	if (interfaces.length !== 1) throw new NetlinkError('Expected one wireless interface');
	const type = genericAttributes(interfaces[0]!).get(5);
	if (!type) throw new NetlinkError('Missing wireless interface type');
	return [2, 8].includes(attributeU32(type));
}

function associatedBss(interfaces: NetlinkMessage[], scan: Nl80211Bss[]): Nl80211Bss | undefined {
	if (!isWirelessClient(interfaces)) return undefined;
	const associated = scan.filter(bss => bss.status === 1);
	if (associated.length > 1) throw new NetlinkError('Ambiguous wireless association');
	return associated[0];
}

export function decodeNl80211Link(interfaces: NetlinkMessage[], scan: Nl80211Bss[], stations: NetlinkMessage[]): Nl80211Link {
	const associated = associatedBss(interfaces, scan);
	if (!associated) return { ssid: null, bssid: null, signal: null };
	const matching = stations.map(genericAttributes).filter(station => {
		const mac = station.get(6);
		return mac !== undefined && macAddress(mac) === associated.bssid;
	});
	if (matching.length !== 1) throw new NetlinkError('Missing or ambiguous associated station');
	const info = matching[0]!.get(21);
	const signal = info ? decodeAttributes(info).get(7) : undefined;
	if (signal) requireSize(signal, 1, 'station signal');
	return { ssid: associated.ssid, bssid: associated.bssid, signal: signal ? signal.readInt8() : null };
}

export function decodeNl80211Scan(messages: NetlinkMessage[]): Nl80211Bss[] {
	return messages.map(message => {
		const bss = genericAttributes(message).get(47);
		if (!bss) throw new NetlinkError('Missing scan BSS');
		const attrs = decodeAttributes(bss);
		const mac = attrs.get(1);
		if (!mac) throw new NetlinkError('Missing scan BSSID');
		const elements = attrs.get(6) ?? attrs.get(11) ?? Buffer.alloc(0);
		const signal = attrs.get(7);
		if (signal) requireSize(signal, 4, 'BSS signal');
		const capability = attrs.get(5);
		if (capability) requireSize(capability, 2, 'BSS capability');
		return { ssid: ssidFromElements(elements), bssid: macAddress(mac), signal: signal ? signal.readInt32LE() / 100 : null, frequency: attrs.has(2) ? attributeU32(attrs.get(2)!) : null, status: attrs.has(9) ? attributeU32(attrs.get(9)!) : null, capability: capability ? capability.readUInt16LE() : null, informationElements: Buffer.from(elements) };
	});
}

async function wirelessRequests(ifindex: number, options: NetlinkReadOptions): Promise<(command: number, dump: boolean, attributes?: Buffer[]) => Promise<NetlinkMessage[]>> {
	if (!Number.isInteger(ifindex) || ifindex <= 0 || ifindex > 0x7fffffff) throw new NetlinkError('Invalid wireless interface index');
	const deadline = performance.now() + (options.timeoutMs ?? 5000);
	const remaining = (): NetlinkReadOptions => ({ ...options, timeoutMs: Math.max(0, deadline - performance.now()) });
	const family = await requestNetlink(16, 0x10, Buffer.concat([Buffer.from([3, 1, 0, 0]), encodeAttribute(2, Buffer.from('nl80211\0'))]), false, remaining());
	if (family.length !== 1 || family[0]!.type !== 0x10) throw new NetlinkError('Invalid generic netlink family reply');
	const id = genericAttributes(family[0]!).get(1);
	if (!id || id.length !== 2) throw new NetlinkError('Missing nl80211 family ID');
	const familyId = id.readUInt16LE();
	const index = Buffer.alloc(4);
	index.writeUInt32LE(ifindex);
	return async (command, dump, attributes = []) => {
		const messages = await requestNetlink(16, familyId, Buffer.concat([Buffer.from([command, 1, 0, 0]), encodeAttribute(3, index), ...attributes]), dump, remaining());
		if (messages.some(message => message.type !== familyId)) throw new NetlinkError('Unexpected nl80211 reply family');
		return messages;
	};
}

export async function readNl80211Link(ifindex: number, options: NetlinkReadOptions = {}): Promise<Nl80211Link> {
	const deadline = performance.now() + (options.timeoutMs ?? 5000);
	const remaining = (): NetlinkReadOptions => ({ ...options, timeoutMs: Math.max(0, deadline - performance.now()) });
	const request = await wirelessRequests(ifindex, remaining());
	const interfaces = await request(5, false);
	if (!isWirelessClient(interfaces)) return { ssid: null, bssid: null, signal: null };
	const scan = await readNl80211Scan(ifindex, remaining());
	const associated = associatedBss(interfaces, scan);
	if (!associated) return { ssid: null, bssid: null, signal: null };
	if (!associated.bssid) throw new NetlinkError('Missing associated BSSID');
	const mac = Buffer.from(associated.bssid.replaceAll(':', ''), 'hex');
	return decodeNl80211Link(interfaces, scan, await request(17, false, [encodeAttribute(6, mac)]));
}

/** Reads the kernel scan cache without requesting an active radio scan. */
export async function readNl80211Scan(ifindex: number, options: NetlinkReadOptions = {}): Promise<Nl80211Bss[]> {
	const request = await wirelessRequests(ifindex, options);
	return decodeNl80211Scan(await request(32, true));
}
