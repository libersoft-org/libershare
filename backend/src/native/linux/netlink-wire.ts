export interface NetlinkMessage {
	type: number;
	flags: number;
	body: Buffer;
}

export class NetlinkError extends Error {
	readonly errno: number | undefined;
	constructor(message: string, errno?: number) {
		super(message);
		this.name = 'NetlinkError';
		this.errno = errno;
	}
}

export function align4(length: number): number {
	return Math.ceil(length / 4) * 4;
}

export function requireSize(data: Uint8Array, length: number, name: string): void {
	if (data.length < length) throw new NetlinkError(`Truncated ${name}`);
}

export function decodeAttributes(data: Buffer): Map<number, Buffer> {
	const result = new Map<number, Buffer>();
	for (let offset = 0; offset < data.length;) {
		requireSize(data.subarray(offset), 4, 'netlink attribute');
		const length = data.readUInt16LE(offset);
		if (length < 4 || offset + align4(length) > data.length) throw new NetlinkError('Invalid netlink attribute length');
		result.set(data.readUInt16LE(offset + 2) & 0x3fff, data.subarray(offset + 4, offset + length));
		offset += align4(length);
	}
	return result;
}

export function encodeAttribute(type: number, data: Buffer): Buffer {
	const result = Buffer.alloc(align4(4 + data.length));
	result.writeUInt16LE(4 + data.length);
	result.writeUInt16LE(type, 2);
	data.copy(result, 4);
	return result;
}

export function attributeU32(data: Buffer): number {
	if (data.length !== 4) throw new NetlinkError('Invalid u32 attribute length');
	return data.readUInt32LE();
}

export function attributeString(data: Buffer): string {
	const end = data.indexOf(0);
	if (end < 0) throw new NetlinkError('Unterminated netlink string');
	return data.toString('utf8', 0, end);
}

export function decodeNetlinkDatagram(data: Buffer, sequence: number): { messages: NetlinkMessage[]; done: boolean; acknowledged: boolean } {
	const messages: NetlinkMessage[] = [];
	let done = false;
	let acknowledged = false;
	for (let offset = 0; offset < data.length;) {
		requireSize(data.subarray(offset), 16, 'netlink header');
		const length = data.readUInt32LE(offset);
		if (length < 16 || offset + align4(length) > data.length) throw new NetlinkError('Invalid netlink message length');
		const type = data.readUInt16LE(offset + 4);
		const flags = data.readUInt16LE(offset + 6);
		if (data.readUInt32LE(offset + 8) !== sequence) throw new NetlinkError('Foreign netlink sequence');
		if (flags & 0x10) throw new NetlinkError('Netlink dump interrupted');
		const body = data.subarray(offset + 16, offset + length);
		if (done) throw new NetlinkError('Netlink data after dump completion');
		if (type === 2 || type === 3) {
			if (type === 2 || body.length) {
				requireSize(body, 4, 'netlink result');
				const error = body.readInt32LE();
				if (error !== 0) throw new NetlinkError(`Netlink error ${error}`, Math.abs(error));
			}
			if (type === 3) done = true;
			else acknowledged = true;
		} else if (type === 4) throw new NetlinkError('Netlink receive overrun');
		else if (type !== 1) messages.push({ type, flags, body });
		offset += align4(length);
	}
	return { messages, done, acknowledged };
}

export function decodeNetlinkDump(datagrams: Buffer[], sequence: number): NetlinkMessage[] {
	const messages: NetlinkMessage[] = [];
	let done = false;
	for (const datagram of datagrams) {
		if (done) throw new NetlinkError('Netlink datagram after dump completion');
		const reply = decodeNetlinkDatagram(datagram, sequence);
		messages.push(...reply.messages);
		done = reply.done;
	}
	if (!done) throw new NetlinkError('Incomplete netlink dump');
	return messages;
}

export function formatNetlinkAddress(data: Buffer, family: number): string {
	if (family === 2 && data.length === 4) return [...data].join('.');
	if (family !== 10 || data.length !== 16) throw new NetlinkError('Invalid netlink address');
	const groups = Array.from({ length: 8 }, (_, i) => data.readUInt16BE(i * 2).toString(16));
	let bestStart = -1;
	let bestLength = 1;
	for (let i = 0; i < groups.length;) {
		if (groups[i] !== '0') {
			i++;
			continue;
		}
		let end = i + 1;
		while (groups[end] === '0') end++;
		if (end - i > bestLength) {
			bestStart = i;
			bestLength = end - i;
		}
		i = end;
	}
	return bestStart < 0 ? groups.join(':') : `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLength).join(':')}`;
}
