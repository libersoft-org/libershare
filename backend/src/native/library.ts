import { dlopen, FFIType, ptr, type FFIFunction, type Library } from 'bun:ffi';
import { lstatSync, realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export class NativeLibraryUnavailable extends Error {
	readonly code = 'NATIVE_LIBRARY_UNAVAILABLE';
	readonly library: string;
	constructor(library: string, reason: string) {
		super(`System library ${library} is unavailable: ${reason}`);
		this.name = 'NativeLibraryUnavailable';
		this.library = library;
	}
}

interface PathInfo {
	readonly uid: number;
	readonly mode: number;
	isDirectory(): boolean;
	isFile(): boolean;
}
export interface LinuxLibraryFilesystem {
	readonly realpath: (path: string) => string;
	readonly stat: (path: string) => PathInfo;
}
const linuxFilesystem: LinuxLibraryFilesystem = { realpath: realpathSync, stat: lstatSync };

function trustedLinuxPath(path: string, filesystem: LinuxLibraryFilesystem, file: boolean): boolean {
	let current = path;
	let leaf = true;
	while (true) {
		const info = filesystem.stat(current);
		if (info.uid !== 0 || (info.mode & 0o022) !== 0 || (leaf && file ? !info.isFile() : !info.isDirectory())) return false;
		if (current === '/') return true;
		current = posix.dirname(current);
		leaf = false;
	}
}

/** Root-owned aliases and their resolved targets must both stay in trusted system directories. */
export function linuxSystemLibraryPath(name: string, filesystem: LinuxLibraryFilesystem = linuxFilesystem, architecture: string = process.arch): string {
	if (!/^lib[A-Za-z0-9_.+-]+\.so(?:\.\d+)*$/.test(name)) throw new NativeLibraryUnavailable(name, 'invalid library name');
	const triplet = architecture === 'x64' ? 'x86_64-linux-gnu' : architecture === 'arm64' ? 'aarch64-linux-gnu' : undefined;
	if (!triplet) throw new NativeLibraryUnavailable(name, 'unsupported architecture');
	const directories = [`/usr/lib/${triplet}`, `/lib/${triplet}`, '/usr/lib64', '/lib64', '/usr/lib', '/lib'];
	const roots: string[] = [];
	for (const directory of directories) {
		try {
			const resolved = filesystem.realpath(directory);
			if (trustedLinuxPath(resolved, filesystem, false)) roots.push(resolved);
		} catch {
			// A distribution need not provide every conventional system directory.
		}
	}
	for (const root of new Set(roots)) {
		try {
			const path = filesystem.realpath(posix.join(root, name));
			if (!roots.some(directory => path.startsWith(`${directory}/`))) continue;
			if (trustedLinuxPath(path, filesystem, true)) return path;
		} catch {
			// Missing files and inaccessible metadata cannot establish a trusted candidate.
		}
	}
	throw new NativeLibraryUnavailable(name, 'no trusted system file found');
}

let systemDirectory: string | undefined;
export function windowsSystemDirectory(): string {
	if (process.platform !== 'win32') throw new NativeLibraryUnavailable('kernel32.dll', 'Windows only');
	if (systemDirectory) return systemDirectory;
	// kernel32 is a Windows KnownDLL; this bootstrap does not use the ordinary DLL search path.
	const kernel = dlopen('kernel32.dll', { GetSystemDirectoryW: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 } });
	try {
		const buffer = new Uint16Array(32768);
		const length = kernel.symbols.GetSystemDirectoryW(ptr(buffer), buffer.length);
		if (length === 0 || length >= buffer.length) throw new NativeLibraryUnavailable('kernel32.dll', 'GetSystemDirectoryW failed');
		const path = Buffer.from(buffer.buffer, 0, length * 2).toString('utf16le');
		if (!win32.isAbsolute(path) || path.includes('\0')) throw new NativeLibraryUnavailable('kernel32.dll', 'invalid system directory');
		systemDirectory = path;
		return path;
	} finally {
		kernel.close();
	}
}

export function windowsSystemLibraryPath(name: string): string {
	if (!/^[A-Za-z0-9_.-]+\.dll$/i.test(name)) throw new NativeLibraryUnavailable(name, 'invalid library name');
	return win32.join(windowsSystemDirectory(), name);
}

export function darwinSystemLibraryPath(path: string): string {
	if (path.includes('\0') || path.split('/').some(part => part === '..' || part === '.')) throw new NativeLibraryUnavailable(path, 'invalid library path');
	if (!path.startsWith('/usr/lib/') && !path.startsWith('/System/Library/Frameworks/') && !path.startsWith('/System/Library/PrivateFrameworks/')) throw new NativeLibraryUnavailable(path, 'outside system directories');
	// A framework in the dyld shared cache need not exist as a regular file.
	return path;
}

export function loadSystemLibrary<Fns extends Record<string, FFIFunction>>(name: string, symbols: Fns): Library<Fns> {
	const path = process.platform === 'win32' ? windowsSystemLibraryPath(name) : process.platform === 'linux' ? linuxSystemLibraryPath(name) : process.platform === 'darwin' ? darwinSystemLibraryPath(name) : undefined;
	if (!path) throw new NativeLibraryUnavailable(name, 'unsupported platform');
	try {
		return dlopen(path, symbols);
	} catch {
		throw new NativeLibraryUnavailable(name, 'library or required symbols could not be loaded');
	}
}
