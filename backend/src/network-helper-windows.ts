import { dlopen, FFIType, ptr, read, type Pointer } from 'bun:ffi';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { sha256File } from './network-helper-integrity.ts';

const SHELLEXECUTEINFO_SIZE = 112;
const PROCESS_HANDLE_OFFSET = 104;
const SEE_MASK_NOCLOSEPROCESS = 0x40;
const SEE_MASK_NOASYNC = 0x100;
const SEE_MASK_FLAG_NO_UI = 0x400;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;

const FOLDERID_PROGRAM_FILES = Buffer.from([0xb6, 0x63, 0x5e, 0x90, 0xbf, 0xc1, 0x4e, 0x49, 0xb2, 0x9c, 0x65, 0xb7, 0x32, 0xd3, 0xd2, 0x1a]);
const FOLDERID_LOCAL_APP_DATA = Buffer.from([0x85, 0x27, 0xb3, 0xf1, 0xba, 0x6f, 0xcf, 0x4f, 0x9d, 0x55, 0x7b, 0x8e, 0x7f, 0x15, 0x70, 0x91]);
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_SHARE_READ = 0x1;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const ERROR_SHARING_VIOLATION = 32;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** The installed launcher, the only process the elevated helper takes a request from. */
export const WINDOWS_LAUNCHER_FILE = 'lish-network-launcher.exe';

const REQUEST_FILE_NAME = /^network-request-(\d{1,10})-([0-9a-f]{1,16})-[0-9a-f]{32}\.json$/;

function wide(value: string): Buffer {
	if (value.includes('\0')) throw new Error('invalid Windows helper argument');
	return Buffer.from(`${value}\0`, 'utf16le');
}

function pointerValue(value: Uint8Array): bigint {
	return BigInt(ptr(value) as unknown as number | bigint);
}

/**
 * The elevated helper's whole command line.
 *
 * UAC prints this line to the user under "Program location", so it carries one
 * readable file path and nothing encoded. The request itself lives in that file.
 */
export function windowsHelperParameters(requestFile: string): string {
	if (!/^[A-Za-z]:\\[^"\p{Cc}]{1,1024}$/u.test(requestFile)) throw new Error('invalid Windows helper launch arguments');
	return `--request-file "${requestFile}"`;
}

/**
 * A running process, named so that a recycled process id cannot pass for it.
 *
 * Windows hands process ids out again once the process is gone, so the id alone
 * says nothing about who holds it now. Its creation time does.
 */
export interface WindowsProcessIdentity {
	readonly pid: number;
	readonly created: bigint;
}

function processCreationTime(kernel: { symbols: { GetProcessTimes: (handle: bigint, creation: Pointer, exit: Pointer, kernelTime: Pointer, userTime: Pointer) => number } }, handle: bigint): bigint | null {
	const times = new Uint8Array(32);
	const at = (offset: number): Pointer => ptr(times, offset);
	if (!kernel.symbols.GetProcessTimes(handle, at(0), at(8), at(16), at(24))) return null;
	return new DataView(times.buffer).getBigUint64(0, true);
}

/** This process, as the launcher names itself in the request file it writes. */
export function windowsCurrentProcessIdentity(): WindowsProcessIdentity {
	if (process.platform !== 'win32') throw new Error('Windows process identities are unavailable');
	const kernel = dlopen('kernel32.dll', {
		GetCurrentProcess: { args: [], returns: FFIType.u64 },
		GetProcessTimes: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	});
	try {
		const created = processCreationTime(kernel, BigInt(kernel.symbols.GetCurrentProcess()));
		if (created === null) throw new Error('GetProcessTimes failed');
		return { pid: process.pid, created };
	} finally {
		kernel.close();
	}
}

/**
 * Where a process's image lives, or null when it is gone or the id now belongs
 * to something else.
 */
export function windowsProcessImagePath(identity: WindowsProcessIdentity): string | null {
	if (process.platform !== 'win32') throw new Error('Windows process identities are unavailable');
	const kernel = dlopen('kernel32.dll', {
		OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
		GetProcessTimes: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		QueryFullProcessImageNameW: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
	});
	try {
		const handle = BigInt(kernel.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, identity.pid));
		if (handle === 0n) return null;
		try {
			if (processCreationTime(kernel, handle) !== identity.created) return null;
			const image = new Uint16Array(32 * 1024);
			const size = new Uint32Array([image.length]);
			if (!kernel.symbols.QueryFullProcessImageNameW(handle, 0, ptr(image), ptr(size))) return null;
			return Buffer.from(image.buffer, 0, size[0]! * 2).toString('utf16le');
		} finally {
			kernel.symbols.CloseHandle(handle);
		}
	} finally {
		kernel.close();
	}
}

/**
 * The name of the file one request lives in, which carries its launcher's identity.
 *
 * The name is fixed when the launcher hands it to UAC, so from that moment it is
 * out of reach of everything else in the session, and the elevated helper can
 * read out of it whose request this is. A random tail keeps two launchers, or a
 * launcher and a file left behind by an earlier one, from ever sharing a name.
 */
export function windowsRequestFileName(identity: WindowsProcessIdentity): string {
	return `network-request-${identity.pid}-${identity.created.toString(16)}-${randomBytes(16).toString('hex')}.json`;
}

/** The launcher a request file names, or null when the name is not one a launcher wrote. */
export function parseWindowsRequestFileName(path: string): WindowsProcessIdentity | null {
	const match = REQUEST_FILE_NAME.exec(win32.basename(path));
	return match ? { pid: Number(match[1]), created: BigInt(`0x${match[2]}`) } : null;
}

/**
 * Fail unless the launcher that asked for this change is still there waiting for
 * the answer, running out of the installed launcher next to this helper.
 *
 * Holding the file open is a liveness signal and nothing more: anyone in the
 * session can hold a file. UAC keeps its prompt on screen after the launcher is
 * gone (killed on the backend's timeout, or with the whole app closed), and the
 * file it left behind is then free for anything in the session to rewrite and
 * hold open in its place. So the owner is checked, not just the lock: a live
 * process, the same one the file is named after, out of a binary only an
 * administrator can replace.
 */
export async function assertWindowsRequestOwner(path: string): Promise<void> {
	const identity = parseWindowsRequestFileName(path);
	if (!identity) throw new Error('network helper request file was not named by a launcher');
	const launcher = join(dirname(process.execPath), WINDOWS_LAUNCHER_FILE);
	if (!(await verifyWindowsInstalledSibling(launcher, process.execPath))) throw new Error('privileged network helper is not installed next to its launcher');
	const image = windowsProcessImagePath(identity);
	if (image === null) throw new Error('the launcher that asked for this change is no longer running');
	if (image.toLowerCase() !== (await realpath(launcher)).toLowerCase()) throw new Error('the process that asked for this change is not the installed launcher');
	if (!windowsRequestFileHeld(path)) throw new Error('the launcher no longer holds the request it asked for');
}

/** The request file the launcher hands to the elevated helper, held until {@link WindowsRequestFile.release}. */
export interface WindowsRequestFile {
	readonly path: string;
	release(): void;
}

/**
 * Write the request the elevated helper will read, then hold the file open with
 * read-only sharing until the helper is done.
 *
 * The user approves the prompt without seeing the request, so nothing in the
 * session may swap the file between that approval and the helper's read. With
 * this handle open, any attempt to write to or delete the file fails with a
 * sharing violation. A writer that got in before the handle was taken would be
 * frozen in place too, so the content is read back and compared once the file is
 * guarded.
 */
export function writeWindowsRequestFile(path: string, content: string): WindowsRequestFile {
	if (process.platform !== 'win32') throw new Error('Windows request files are unavailable');
	mkdirSync(dirname(path), { recursive: true });
	// A launcher killed while its prompt was up never reaches its own cleanup, so
	// leftovers are swept on the way in. One still held by a live launcher stays:
	// Windows refuses to delete a file opened without delete sharing.
	for (const entry of readdirSync(dirname(path))) {
		if (entry !== win32.basename(path) && REQUEST_FILE_NAME.test(entry)) {
			try {
				unlinkSync(join(dirname(path), entry));
			} catch {}
		}
	}
	writeFileSync(path, content, 'utf8');
	const kernel = dlopen('kernel32.dll', {
		CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
		CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
	});
	const handle = BigInt(kernel.symbols.CreateFileW(ptr(wide(path)), GENERIC_READ, FILE_SHARE_READ, null, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null));
	const release = (): void => {
		if (handle !== INVALID_HANDLE_VALUE) kernel.symbols.CloseHandle(handle);
		kernel.close();
		try {
			unlinkSync(path);
		} catch {}
	};
	if (handle === INVALID_HANDLE_VALUE) {
		release();
		throw new Error('network request file is in use');
	}
	if (readFileSync(path, 'utf8') !== content) {
		release();
		throw new Error('network request file was modified');
	}
	return { path, release };
}

/**
 * True while something still holds the request file open for writing.
 *
 * The launcher keeps the file open with read-only sharing, so a write-open fails
 * with a sharing violation exactly as long as it lives. That is only a lock,
 * never proof of who took it, so {@link assertWindowsRequestOwner} is what the
 * elevated helper asks; this is one of its checks.
 */
export function windowsRequestFileHeld(path: string): boolean {
	if (process.platform !== 'win32') throw new Error('Windows request files are unavailable');
	const kernel = dlopen('kernel32.dll', {
		CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
		CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
		GetLastError: { args: [], returns: FFIType.u32 },
	});
	try {
		const handle = BigInt(kernel.symbols.CreateFileW(ptr(wide(path)), GENERIC_WRITE, 0, null, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null));
		if (handle === INVALID_HANDLE_VALUE) return kernel.symbols.GetLastError() === ERROR_SHARING_VIOLATION;
		kernel.symbols.CloseHandle(handle);
		return false;
	} finally {
		kernel.close();
	}
}

function windowsKnownFolderPath(folder: Buffer): string {
	if (process.platform !== 'win32') throw new Error('Windows known folders are unavailable');
	const shell = dlopen('shell32.dll', {
		SHGetKnownFolderPath: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	});
	const ole = dlopen('ole32.dll', {
		CoTaskMemFree: { args: [FFIType.ptr], returns: FFIType.void },
	});
	const out = new BigUint64Array(1);
	try {
		const result = shell.symbols.SHGetKnownFolderPath(ptr(folder), 0, null, ptr(out));
		if (result !== 0 || out[0] === 0n) throw new Error(`SHGetKnownFolderPath failed with ${result}`);
		const value = Number(out[0]) as Pointer;
		try {
			const units: number[] = [];
			for (let offset = 0; offset < 64 * 1024; offset += 2) {
				const unit = read.u16(value, offset);
				if (unit === 0) return Buffer.from(new Uint16Array(units).buffer).toString('utf16le');
				units.push(unit);
			}
			throw new Error('known folder path is too long');
		} finally {
			ole.symbols.CoTaskMemFree(value);
		}
	} finally {
		shell.close();
		ole.close();
	}
}

export function windowsProgramFilesPath(): string {
	return windowsKnownFolderPath(FOLDERID_PROGRAM_FILES);
}

/** The launching user's local profile data folder, where the request file for the helper lives. */
export function windowsLocalAppDataPath(): string {
	return windowsKnownFolderPath(FOLDERID_LOCAL_APP_DATA);
}

function windowsSystemDirectory(): string {
	if (process.platform !== 'win32') throw new Error('Windows system directory is unavailable');
	const kernel = dlopen('kernel32.dll', {
		GetSystemDirectoryW: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
	});
	const buffer = new Uint16Array(32 * 1024);
	try {
		const length = kernel.symbols.GetSystemDirectoryW(ptr(buffer), buffer.length);
		if (length === 0 || length >= buffer.length) throw new Error('GetSystemDirectoryW failed');
		return Buffer.from(buffer.buffer, buffer.byteOffset, length * 2).toString('utf16le');
	} finally {
		kernel.close();
	}
}

export function windowsPowerShellPath(): string {
	return win32.join(windowsSystemDirectory(), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function windowsSystemEnvironment(): NodeJS.ProcessEnv {
	const systemDirectory = windowsSystemDirectory();
	const windowsDirectory = win32.dirname(systemDirectory);
	return {
		SystemRoot: windowsDirectory,
		WINDIR: windowsDirectory,
		ComSpec: win32.join(systemDirectory, 'cmd.exe'),
		PATH: [systemDirectory, win32.join(systemDirectory, 'Wbem'), win32.dirname(windowsPowerShellPath())].join(';'),
		PATHEXT: '.COM;.EXE;.BAT;.CMD',
	};
}

/**
 * A helper binary the backend may hand to UAC: a sibling of the running
 * executable, installed under Program Files.
 *
 * The location is part of the trust, not a convenience. An elevated process
 * loads DLLs from its own directory before the system ones, so a helper in a
 * user-writable place (a portable ZIP, a per-user install under LOCALAPPDATA)
 * could be made to run planted code as administrator the next time the user
 * approves a genuine prompt. Program Files is writable only by administrators,
 * which closes that. Bundles that cannot land there stay read-only on purpose.
 */
async function windowsInstalledSibling(path: string, executable: string): Promise<{ path: string; executable: string } | null> {
	const [resolvedPath, resolvedExecutable] = await Promise.all([realpath(path), realpath(executable)]);
	if (dirname(resolvedPath).toLowerCase() !== dirname(resolvedExecutable).toLowerCase()) return null;
	const prefix = `${windowsProgramFilesPath().replace(/[\\/]+$/, '')}\\`.toLowerCase();
	if (!resolvedExecutable.toLowerCase().startsWith(prefix)) return null;
	return { path: resolvedPath, executable: resolvedExecutable };
}

export async function verifyWindowsInstalledSibling(path: string, executable: string): Promise<boolean> {
	try {
		return (await windowsInstalledSibling(path, executable)) !== null;
	} catch {
		return false;
	}
}

export async function verifyWindowsInstalledHelper(path: string, executable: string, expectedHash: string): Promise<boolean> {
	try {
		const sibling = await windowsInstalledSibling(path, executable);
		return sibling !== null && (await sha256File(sibling.path)) === expectedHash;
	} catch {
		return false;
	}
}

/**
 * Why an elevated apply did not happen, as an exit code from the launcher.
 *
 * The launcher cannot pass the helper's own text back: the elevated process
 * owns a separate console the unelevated caller never reads. A small fixed set
 * of codes is what survives that boundary, and it is enough to tell "you
 * cancelled the prompt" apart from "the change itself failed".
 */
export const WINDOWS_LAUNCHER_EXIT = { untrusted: 11, cancelled: 12, timeout: 13 } as const;

/** Outcome of one elevation attempt. Only genuine Win32 faults throw. */
export type WindowsElevationOutcome = { kind: 'exited'; code: number } | { kind: 'cancelled' } | { kind: 'timeout' };

export async function runElevatedWindowsProcess(file: string, parameters: string, timeoutMs: number): Promise<WindowsElevationOutcome> {
	if (process.platform !== 'win32') throw new Error('Windows elevation is unavailable');
	const shell = dlopen('shell32.dll', {
		ShellExecuteExW: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
	const kernel = dlopen('kernel32.dll', {
		WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
		GetExitCodeProcess: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
		GetLastError: { args: [], returns: FFIType.u32 },
	});
	const verb = wide('runas');
	const executable = wide(file);
	const args = wide(parameters);
	const workingDirectory = wide(dirname(file));
	const info = new Uint8Array(SHELLEXECUTEINFO_SIZE);
	const view = new DataView(info.buffer);
	view.setUint32(0, SHELLEXECUTEINFO_SIZE, true);
	view.setUint32(4, SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI, true);
	view.setBigUint64(16, pointerValue(verb), true);
	view.setBigUint64(24, pointerValue(executable), true);
	view.setBigUint64(32, pointerValue(args), true);
	view.setBigUint64(40, pointerValue(workingDirectory), true);
	view.setInt32(48, 0, true);
	let processHandle: Pointer | null = null;
	try {
		if (!shell.symbols.ShellExecuteExW(ptr(info))) {
			const error = kernel.symbols.GetLastError();
			// ERROR_CANCELLED is what UAC reports for both "No" and a prompt that
			// timed out, and it is an ordinary answer rather than a fault.
			if (error === 1223) return { kind: 'cancelled' };
			throw new Error(`ShellExecuteExW failed with ${error}`);
		}
		processHandle = Number(view.getBigUint64(PROCESS_HANDLE_OFFSET, true)) as Pointer;
		if (!processHandle) throw new Error('ShellExecuteExW returned no process handle');
		const started = Date.now();
		while (true) {
			const wait = kernel.symbols.WaitForSingleObject(processHandle, 0);
			if (wait === WAIT_OBJECT_0) break;
			if (wait !== WAIT_TIMEOUT) throw new Error(`WaitForSingleObject failed with ${wait}`);
			if (Date.now() - started >= timeoutMs) {
				kernel.symbols.TerminateProcess(processHandle, 1);
				return { kind: 'timeout' };
			}
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		const exitCode = new Uint32Array(1);
		if (!kernel.symbols.GetExitCodeProcess(processHandle, ptr(exitCode))) throw new Error(`GetExitCodeProcess failed with ${kernel.symbols.GetLastError()}`);
		return { kind: 'exited', code: exitCode[0]! };
	} finally {
		if (processHandle) kernel.symbols.CloseHandle(processHandle);
		shell.close();
		kernel.close();
	}
}
