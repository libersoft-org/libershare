import { ptr, type Library } from 'bun:ffi';
import { isAbsolute } from 'node:path';
import { loadSystemLibrary } from '../library.ts';

const symbols = { ShellExecuteW: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'i32'], returns: 'i64' } } as const;
const comSymbols = { CoInitializeEx: { args: ['ptr', 'u32'], returns: 'i32' }, CoUninitialize: { args: [], returns: 'void' } } as const;
let library: Library<typeof symbols> | undefined;
let com: Library<typeof comSymbols> | undefined;

/** COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE, as ShellExecute's documentation asks of its caller. */
const COINIT_SHELL = 0x2 | 0x4;
/** RPC_E_CHANGED_MODE: the thread already joined a different apartment, which stays as it is. */
const RPC_E_CHANGED_MODE = 0x80010106 | 0;

export function checkShellExecuteResult(result: number | bigint): void {
	if (Number(result) <= 32) throw new Error(`Windows could not open the file (ShellExecuteW ${result})`);
}

/** Shell extensions that handle the file may use COM, so the calling thread joins an apartment first. */
export function openWindowsPath(path: string): void {
	if (!isAbsolute(path) || path.includes('\0')) throw new Error('Invalid local path');
	const shell = (library ??= loadSystemLibrary('shell32.dll', symbols)).symbols;
	const ole = (com ??= loadSystemLibrary('ole32.dll', comSymbols)).symbols;
	const initialized = ole.CoInitializeEx(null, COINIT_SHELL);
	if (initialized < 0 && initialized !== RPC_E_CHANGED_MODE) throw new Error(`Windows could not prepare to open the file (CoInitializeEx ${initialized >>> 0})`);
	try {
		const verb = Buffer.from('open\0', 'utf16le');
		const file = Buffer.from(path + '\0', 'utf16le');
		checkShellExecuteResult(shell.ShellExecuteW(null, ptr(verb), ptr(file), null, null, 1));
	} finally {
		// S_OK and S_FALSE both count one initialization that this call must balance.
		if (initialized >= 0) ole.CoUninitialize();
	}
}
