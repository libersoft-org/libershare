import { FFIType as F, ptr, read } from 'bun:ffi';
import { closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { loadSystemLibrary } from '../library.ts';

export const DARWIN_NTP_PATH: string = '/private/etc/ntp.conf';
export interface DarwinNtpFile {
	readonly content: string;
	readonly uid: number;
	readonly gid: number;
	readonly mode: number;
	readonly xattrs: Readonly<Record<string, string>>;
	readonly identity: string;
	readonly fingerprint: string;
}

function xattrLibrary() {
	return loadSystemLibrary('/usr/lib/libSystem.B.dylib', {
		flistxattr: { args: [F.i32, F.ptr, F.u64, F.i32], returns: F.i64 },
		fgetxattr: { args: [F.i32, F.ptr, F.ptr, F.u64, F.u32, F.i32], returns: F.i64 },
		fsetxattr: { args: [F.i32, F.ptr, F.ptr, F.u64, F.u32, F.i32], returns: F.i32 },
		__error: { args: [], returns: F.ptr },
	});
}

function size(value: bigint | number): number {
	const count = Number(value);
	if (!Number.isSafeInteger(count) || count < 0 || count > 16 * 1024 * 1024) throw new Error('Cannot read macOS file attributes completely');
	return count;
}

export function darwinNtpFingerprint(file: Pick<DarwinNtpFile, 'content' | 'uid' | 'gid' | 'mode' | 'xattrs'> | null): string | null {
	if (!file) return null;
	const attrs = Object.fromEntries(Object.entries(file.xattrs).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
	return createHash('sha256').update(JSON.stringify({ content: file.content, uid: file.uid, gid: file.gid, mode: file.mode, xattrs: attrs })).digest('hex');
}

/** Read content and all attributes through one descriptor; links are never followed for writes. */
export function readDarwinNtpFile(path: string = DARWIN_NTP_PATH): DarwinNtpFile | null {
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
	let library: ReturnType<typeof xattrLibrary> | undefined;
	try {
		library = xattrLibrary();
		const before = fstatSync(fd, { bigint: true });
		if (!before.isFile() || before.size > 16n * 1024n * 1024n) throw new Error('The macOS NTP configuration is not a bounded regular file');
		const content = readFileSync(fd).toString('base64');
		const nameSize = size(library.symbols.flistxattr(fd, null, 0n, 0)), names = Buffer.alloc(Math.max(nameSize, 1));
		if (nameSize && Number(library.symbols.flistxattr(fd, ptr(names), BigInt(nameSize), 0)) !== nameSize) throw new Error('The macOS NTP attribute names changed during the read');
		const xattrs: Record<string, string> = {};
		for (const name of names.subarray(0, nameSize).toString('utf8').split('\0').filter(Boolean)) {
			const encoded = Buffer.from(`${name}\0`), valueSize = size(library.symbols.fgetxattr(fd, ptr(encoded), null, 0n, 0, 0)), value = Buffer.alloc(Math.max(valueSize, 1));
			if (Number(library.symbols.fgetxattr(fd, ptr(encoded), ptr(value), BigInt(valueSize), 0, 0)) !== valueSize) throw new Error('A macOS NTP attribute changed during the read');
			xattrs[name] = value.subarray(0, valueSize).toString('base64');
		}
		const after = fstatSync(fd, { bigint: true });
		if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('The macOS NTP file changed during the snapshot');
		const file = { content, uid: Number(before.uid), gid: Number(before.gid), mode: Number(before.mode & 0o7777n), xattrs, identity: `${before.dev}:${before.ino}:${before.mtimeNs}:${before.ctimeNs}` };
		return { ...file, fingerprint: darwinNtpFingerprint(file)! };
	} finally { library?.close(); closeSync(fd); }
}

export function syncDarwinTimeDirectory(directory: string = '/private/etc'): void {
	const fd = openSync(directory, constants.O_RDONLY);
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Failure before rename leaves the original bytes, ownership, mode and xattrs untouched. */
export function writeDarwinNtpFile(content: Uint8Array, expected: DarwinNtpFile | null, path: string = DARWIN_NTP_PATH): void {
	const temporary = `${path}.lish-${randomUUID()}`;
	let fd: number | undefined, published = false;
	const library = xattrLibrary();
	try {
		fd = openSync(temporary, 'wx', 0o600);
		writeFileSync(fd, content);
		fchownSync(fd, expected?.uid ?? 0, expected?.gid ?? 0);
		fchmodSync(fd, expected?.mode ?? 0o644);
		for (const [name, encoded] of Object.entries(expected?.xattrs ?? {})) {
			const key = Buffer.from(`${name}\0`), value = Buffer.from(encoded, 'base64');
			if (library.symbols.fsetxattr(fd, ptr(key), value.length ? ptr(value) : null, BigInt(value.length), 0, 0) !== 0) throw new Error(`Cannot preserve a macOS NTP attribute: errno ${read.i32(library.symbols.__error()!)}`);
		}
		fsyncSync(fd); closeSync(fd); fd = undefined;
		const current = readDarwinNtpFile(path);
		if (current?.identity !== expected?.identity || current?.fingerprint !== expected?.fingerprint) throw new Error('The macOS NTP configuration changed before publication');
		renameSync(temporary, path); published = true;
		syncDarwinTimeDirectory(dirname(path));
	} catch (error) {
		if (error && typeof error === 'object') Object.assign(error, { published });
		throw error;
	} finally {
		try {
			if (fd !== undefined) closeSync(fd);
			if (!published) { try { lstatSync(temporary); unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
		} finally { library.close(); }
	}
}
