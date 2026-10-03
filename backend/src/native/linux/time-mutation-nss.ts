import { CString, FFIType, ptr, read } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';
import { SystemBus, type DBusValue } from './dbus.ts';

export interface NativeTimeServiceIdentity {
	readonly uid: number;
	readonly gid: number;
	readonly groups: readonly number[];
}

const symbols = {
	getpwnam_r: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	getpwuid_r: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	getgrnam_r: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	getgrgid_r: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	getgrouplist: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
} as const;

function accountName(name: string): Buffer {
	if (!name || name.includes('\0') || Buffer.byteLength(name) > 255) throw new Error('Invalid service account name');
	return Buffer.from(`${name}\0`);
}

/** Reentrant NSS lookups keep another worker from replacing borrowed passwd/group storage. */
export function resolveNativeTimeServiceIdentity(user: string, group: string, supplementary: readonly string[]): NativeTimeServiceIdentity {
	if (process.platform !== 'linux') throw new Error('NSS time accounts require Linux');
	const library = loadSystemLibrary('libc.so.6', symbols);
	const libc = library.symbols;
	try {
		const lookup = (name: string, passwd: boolean): { id: number; gid: number; name: string } => {
			const encoded = accountName(name);
			const numeric = /^\d+$/.test(name);
			if (numeric && (!Number.isSafeInteger(Number(name)) || Number(name) > 0xfffffffe)) throw new Error('Invalid service account ID');
			for (let size = 4096; size <= 1024 * 1024; size *= 2) {
				const buffer = Buffer.alloc(size);
				const record = Buffer.alloc(passwd ? 48 : 32);
				const out = new BigUint64Array(1);
				const status = passwd ? (numeric ? libc.getpwuid_r(Number(name), ptr(record), ptr(buffer), BigInt(size), ptr(out)) : libc.getpwnam_r(ptr(encoded), ptr(record), ptr(buffer), BigInt(size), ptr(out))) : numeric ? libc.getgrgid_r(Number(name), ptr(record), ptr(buffer), BigInt(size), ptr(out)) : libc.getgrnam_r(ptr(encoded), ptr(record), ptr(buffer), BigInt(size), ptr(out));
				if (status === 34) continue;
				if (status !== 0 || !out[0]) throw new Error('The time service account could not be resolved through NSS');
				const namePointer = read.ptr(ptr(record), 0);
				if (!namePointer) throw new Error('NSS returned no account name');
				return { id: record.readUInt32LE(16), gid: passwd ? record.readUInt32LE(20) : record.readUInt32LE(16), name: new CString(namePointer).toString() };
			}
			throw new Error('The time service NSS record is too large');
		};
		const account = lookup(user, true);
		const gid = group ? lookup(group, false).id : account.gid;
		const encoded = accountName(account.name);
		let groups: number[] | undefined;
		for (let size = 16; size <= 65536;) {
			const values = new Uint32Array(size);
			const count = new Int32Array([size]);
			const status = libc.getgrouplist(ptr(encoded), gid, ptr(values), ptr(count));
			if (count[0]! < 0 || count[0]! > 65536) throw new Error('Invalid NSS group count');
			if (status >= 0 && count[0]! <= size) {
				groups = [...values.subarray(0, count[0])];
				break;
			}
			if (count[0]! <= size) throw new Error('NSS group lookup failed');
			size = count[0]!;
		}
		if (!groups) throw new Error('The time service group list is unavailable');
		return { uid: account.id, gid, groups: [...new Set([gid, ...groups, ...supplementary.map(name => lookup(name, false).id)])] };
	} finally {
		library.close();
	}
}

/** Only called in the read worker, where NSS and sd-bus may block. */
export async function readNativeTimeServiceIdentity(timeoutMs: number): Promise<NativeTimeServiceIdentity> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid service account deadline');
	const deadline = performance.now() + timeoutMs;
	const bus = new SystemBus();
	const destination = 'org.freedesktop.systemd1';
	try {
		const request = async (path: string, iface: string, member: string, signature: string, args: DBusValue[]) => {
			const remaining = deadline - performance.now();
			if (remaining <= 0) throw new Error('Service account read timed out');
			const reply = await bus.call({ kind: 'read', destination, path, interface: iface, member, signature, args, timeoutUsec: BigInt(Math.max(1, Math.floor(remaining * 1000))) });
			if (reply.type !== 'method_return') throw new Error('The time service properties are unavailable');
			return reply;
		};
		const loaded = await request('/org/freedesktop/systemd1', `${destination}.Manager`, 'LoadUnit', 's', ['systemd-timesyncd.service']);
		const path = loaded.values[0];
		if (loaded.signature !== 'o' || typeof path !== 'string') throw new Error('Invalid time service unit');
		const property = async (iface: string, name: string, signature: string): Promise<DBusValue> => {
			const reply = await request(path, 'org.freedesktop.DBus.Properties', 'Get', 'ss', [iface, name]);
			const value = reply.values[0];
			if (reply.signature !== 'v' || !value || typeof value !== 'object' || !('sig' in value) || value.sig !== signature || !('value' in value)) throw new Error(`Invalid time service property ${name}`);
			return value.value;
		};
		const [load, user, group, groups, dynamic] = await Promise.all([property(`${destination}.Unit`, 'LoadState', 's'), property(`${destination}.Service`, 'User', 's'), property(`${destination}.Service`, 'Group', 's'), property(`${destination}.Service`, 'SupplementaryGroups', 'as'), property(`${destination}.Service`, 'DynamicUser', 'b')]);
		if (load !== 'loaded' || typeof user !== 'string' || typeof group !== 'string' || !Array.isArray(groups) || groups.some(name => typeof name !== 'string') || typeof dynamic !== 'boolean' || (dynamic && !user)) throw new Error('The time service identity is unknown');
		return resolveNativeTimeServiceIdentity(user || 'root', group, groups as string[]);
	} finally {
		bus.close();
	}
}
