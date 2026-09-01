import { dlopen, FFIType, ptr, read, type Pointer } from 'bun:ffi';

const SHELLEXECUTEINFO_SIZE = 112;
const PROCESS_HANDLE_OFFSET = 104;
const SEE_MASK_NOCLOSEPROCESS = 0x40;
const SEE_MASK_NOASYNC = 0x100;
const SEE_MASK_FLAG_NO_UI = 0x400;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;

const FOLDERID_PROGRAM_FILES = Buffer.from([0xb6, 0x63, 0x5e, 0x90, 0xbf, 0xc1, 0x4e, 0x49, 0xb2, 0x9c, 0x65, 0xb7, 0x32, 0xd3, 0xd2, 0x1a]);

function wide(value: string): Buffer {
	if (value.includes('\0')) throw new Error('invalid Windows helper argument');
	return Buffer.from(`${value}\0`, 'utf16le');
}

function pointerValue(value: Uint8Array): bigint {
	return BigInt(ptr(value) as unknown as number | bigint);
}

export function windowsHelperParameters(request: string, responsePipe: string): string {
	if (!/^[A-Za-z0-9_-]{1,8192}$/.test(request) || !/^\\\\\.\\pipe\\lish-network-helper-[0-9a-f]{48}$/.test(responsePipe)) throw new Error('invalid Windows helper launch arguments');
	return `--request ${request} --response-pipe ${responsePipe}`;
}

export function windowsProgramFilesPath(): string {
	if (process.platform !== 'win32') throw new Error('Windows known folders are unavailable');
	const shell = dlopen('shell32.dll', {
		SHGetKnownFolderPath: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	});
	const ole = dlopen('ole32.dll', {
		CoTaskMemFree: { args: [FFIType.ptr], returns: FFIType.void },
	});
	const out = new BigUint64Array(1);
	try {
		const result = shell.symbols.SHGetKnownFolderPath(ptr(FOLDERID_PROGRAM_FILES), 0, null, ptr(out));
		if (result !== 0 || out[0] === 0n) throw new Error(`SHGetKnownFolderPath failed with ${result}`);
		const value = Number(out[0]) as Pointer;
		try {
			const units: number[] = [];
			for (let offset = 0; offset < 64 * 1024; offset += 2) {
				const unit = read.u16(value, offset);
				if (unit === 0) return Buffer.from(new Uint16Array(units).buffer).toString('utf16le');
				units.push(unit);
			}
			throw new Error('Program Files path is too long');
		} finally {
			ole.symbols.CoTaskMemFree(value);
		}
	} finally {
		shell.close();
		ole.close();
	}
}

export async function runElevatedWindowsProcess(file: string, parameters: string, timeoutMs: number): Promise<number> {
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
	const info = new Uint8Array(SHELLEXECUTEINFO_SIZE);
	const view = new DataView(info.buffer);
	view.setUint32(0, SHELLEXECUTEINFO_SIZE, true);
	view.setUint32(4, SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI, true);
	view.setBigUint64(16, pointerValue(verb), true);
	view.setBigUint64(24, pointerValue(executable), true);
	view.setBigUint64(32, pointerValue(args), true);
	view.setInt32(48, 0, true);
	let processHandle: Pointer | null = null;
	try {
		if (!shell.symbols.ShellExecuteExW(ptr(info))) {
			const error = kernel.symbols.GetLastError();
			if (error === 1223) throw new Error('network helper elevation was cancelled');
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
				throw new Error('network helper process timed out');
			}
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		const exitCode = new Uint32Array(1);
		if (!kernel.symbols.GetExitCodeProcess(processHandle, ptr(exitCode))) throw new Error(`GetExitCodeProcess failed with ${kernel.symbols.GetLastError()}`);
		return exitCode[0]!;
	} finally {
		if (processHandle) kernel.symbols.CloseHandle(processHandle);
		shell.close();
		kernel.close();
	}
}
