import { CString, FFIType as F, ptr, read, toArrayBuffer, type Pointer } from 'bun:ffi';
import { canonicalDnsServer, type NetAddress } from '@shared';
import { loadSystemLibrary } from '../library.ts';

export interface DarwinInterface {
	readonly device: string;
	readonly index: number;
	readonly loopback: boolean;
	readonly addresses: NetAddress[];
	mac: string | null;
}
export interface DarwinDefaultRoute {
	readonly family: 'ipv4' | 'ipv6';
	readonly index: number;
	readonly device: string;
	readonly gateway: string;
	readonly scoped: boolean;
	readonly usable: boolean;
}
const AF_INET = 2, AF_INET6 = 30, AF_LINK = 18;
const RT_HEADER_BYTES = 92;

export function darwinAddress(bytes: Uint8Array, family: number): string {
	if (family === AF_INET && bytes.length === 4) return [...bytes].join('.');
	if (family !== AF_INET6 || bytes.length !== 16) throw new Error('Invalid Darwin IP address');
	const words = Array.from({ length: 8 }, (_, index) => (bytes[index * 2]! << 8) | bytes[index * 2 + 1]!);
	// Darwin's KAME stack embeds the scope index in the second link-local word.
	if ((words[0]! & 0xffc0) === 0xfe80) words[1] = 0;
	return canonicalDnsServer(words.map(word => word.toString(16)).join(':'));
}

function prefix(bytes: Uint8Array): number {
	let count = 0;
	for (const byte of bytes) for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) count++;
	return count;
}

export function darwinHasPeer(flags: number, family: number, destination: Buffer | null): boolean {
	if (!(flags & 0x10) || !destination || destination[1] !== family) return false;
	if (family === AF_INET) return true;
	return family === AF_INET6 && destination.length >= 24 && destination.subarray(8, 24).some(byte => byte !== 0);
}

/** NET_RT_DUMP uses a 92-byte rt_msghdr and 4-byte sockaddr alignment on Darwin arm64/x64. */
export function parseDarwinDefaultRoutes(buffer: Buffer, family: number, name: (index: number) => string): DarwinDefaultRoute[] {
	if (family !== AF_INET && family !== AF_INET6) throw new Error('Unsupported Darwin route family');
	const routes: DarwinDefaultRoute[] = [];
	for (let offset = 0; offset < buffer.length;) {
		if (offset + RT_HEADER_BYTES > buffer.length) throw new Error('Truncated Darwin route header');
		const length = buffer.readUInt16LE(offset), flags = buffer.readUInt32LE(offset + 8), fields = buffer.readUInt32LE(offset + 12), index = buffer.readUInt16LE(offset + 4);
		if (length < RT_HEADER_BYTES || offset + length > buffer.length || buffer[offset + 2] !== 5) throw new Error('Invalid Darwin route header');
		let cursor = offset + RT_HEADER_BYTES;
		const addresses = new Map<number, Buffer>();
		for (let bit = 1; bit <= 0x80; bit <<= 1) {
			if (!(fields & bit)) continue;
			if (cursor + 2 > offset + length) throw new Error('Truncated Darwin route address');
			const size = buffer[cursor]!;
			const aligned = size ? (size + 3) & ~3 : 4;
			if (cursor + aligned > offset + length) throw new Error('Invalid Darwin route address length');
			addresses.set(bit, buffer.subarray(cursor, cursor + Math.max(size, 2)));
			cursor += aligned;
		}
		const destination = addresses.get(1), mask = addresses.get(4), gateway = addresses.get(2);
		const addressOffset = family === AF_INET ? 4 : 8, addressBytes = family === AF_INET ? 4 : 16;
		const isDefault = destination && destination[1] === family && destination.length >= addressOffset + addressBytes && destination.subarray(addressOffset, addressOffset + addressBytes).every(byte => byte === 0) && (!mask || mask[0]! <= 1 || mask.subarray(addressOffset).every(byte => byte === 0));
		if (isDefault && gateway) {
			let address: string;
			if (gateway[1] === AF_LINK && gateway.length >= 4) address = `link#${gateway.readUInt16LE(2)}`;
			else {
				const start = gateway[1] === AF_INET ? 4 : 8, size = gateway[1] === AF_INET ? 4 : 16;
				if (gateway.length < start + size) throw new Error('Truncated Darwin gateway');
				address = darwinAddress(gateway.subarray(start, start + size), gateway[1]!);
			}
			routes.push({ family: family === AF_INET ? 'ipv4' : 'ipv6', index, device: name(index), gateway: address, scoped: !!(flags & 0x1000000), usable: !!(flags & 1) && !(flags & (8 | 0x1000)) });
		}
		offset += length;
	}
	return routes;
}

/** Worker-only BSD reads; every pointer is copied before freeifaddrs or library close. */
export function readDarwinKernelNetwork(): { interfaces: DarwinInterface[]; routes: DarwinDefaultRoute[] } {
	const system = loadSystemLibrary('/usr/lib/libSystem.B.dylib', {
		getifaddrs: { args: [F.ptr], returns: F.i32 }, freeifaddrs: { args: [F.ptr], returns: F.void },
		if_nametoindex: { args: [F.ptr], returns: F.u32 }, if_indextoname: { args: [F.u32, F.ptr], returns: F.ptr },
		sysctl: { args: [F.ptr, F.u32, F.ptr, F.ptr, F.ptr, F.u64], returns: F.i32 }, __error: { args: [], returns: F.ptr },
	});
	const head = new BigUint64Array(1);
	const bytes = (address: Pointer, offset: number, count: number): Buffer => Buffer.from(new Uint8Array(toArrayBuffer(address, offset, count)));
	try {
		if (system.symbols.getifaddrs(ptr(head)) !== 0) throw new Error('Darwin getifaddrs failed');
		const interfaces = new Map<string, DarwinInterface>();
		const seen = new Set<number>();
		try {
			for (let current = Number(head[0]) as Pointer; current; current = read.ptr(current, 0) as Pointer) {
				if (seen.has(current) || seen.size >= 65536) throw new Error('Invalid Darwin interface list');
				seen.add(current);
				const name = read.ptr(current, 8) as Pointer;
				if (!name) throw new Error('Darwin interface has no name');
				const device = new CString(name).toString(), flags = read.u32(current, 16);
				let entry = interfaces.get(device);
				if (!entry) { entry = { device, index: system.symbols.if_nametoindex(name), loopback: !!(flags & 8), addresses: [], mac: null }; interfaces.set(device, entry); }
				const address = read.ptr(current, 24) as Pointer, mask = read.ptr(current, 32) as Pointer, destination = read.ptr(current, 40) as Pointer;
				if (!address) continue;
				const family = read.u8(address, 1), size = read.u8(address, 0);
				if (family === AF_LINK) {
					const nameLength = read.u8(address, 5), macLength = read.u8(address, 6);
					if (macLength === 6 && 8 + nameLength + macLength <= size) entry.mac = [...bytes(address, 8 + nameLength, 6)].map(byte => byte.toString(16).padStart(2, '0')).join(':');
				} else if ((family === AF_INET || family === AF_INET6) && !darwinHasPeer(flags, family, flags & 0x10 && destination ? bytes(destination, 0, read.u8(destination)) : null)) {
					const start = family === AF_INET ? 4 : 8, length = family === AF_INET ? 4 : 16;
					if (size < start + length) throw new Error('Truncated Darwin interface address');
					entry.addresses.push({ family: family === AF_INET ? 'ipv4' : 'ipv6', address: darwinAddress(bytes(address, start, length), family), prefixLength: mask ? prefix(bytes(mask, start, length)) : 0 });
				}
			}
		} finally { if (head[0]) system.symbols.freeifaddrs(Number(head[0]) as Pointer); }
		const name = (index: number): string => {
			const out = Buffer.alloc(32);
			if (!system.symbols.if_indextoname(index, ptr(out))) throw new Error('Darwin route interface disappeared');
			return out.toString('utf8', 0, out.indexOf(0));
		};
		const routes: DarwinDefaultRoute[] = [];
		for (const family of [AF_INET, AF_INET6]) {
			const mib = new Int32Array([4, 17, 0, family, 1, 0]), size = new BigUint64Array(1);
			let complete = false;
			for (let attempt = 0; attempt < 3; attempt++) {
				if (system.symbols.sysctl(ptr(mib), 6, null, ptr(size), null, 0n) !== 0 || size[0]! > 64n * 1024n * 1024n) throw new Error('Cannot size Darwin routes');
				const buffer = Buffer.alloc(Number(size[0]) + 4096); size[0] = BigInt(buffer.length);
				if (system.symbols.sysctl(ptr(mib), 6, ptr(buffer), ptr(size), null, 0n) !== 0) {
					if (read.i32(system.symbols.__error()!) === 12) continue;
					throw new Error('Cannot read Darwin routes');
				}
				if (size[0]! > BigInt(buffer.length)) throw new Error('Darwin route dump exceeded its buffer');
				routes.push(...parseDarwinDefaultRoutes(buffer.subarray(0, Number(size[0])), family, name)); complete = true; break;
			}
			if (!complete) throw new Error('Darwin routes changed during every read');
		}
		return { interfaces: [...interfaces.values()], routes };
	} finally { system.close(); }
}
