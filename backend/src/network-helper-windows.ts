import { dlopen, FFIType, ptr, read, type Pointer } from 'bun:ffi';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, win32 } from 'node:path';
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
const FILE_SHARE_READ = 0x1;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;

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
