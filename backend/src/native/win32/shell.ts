import { ptr, type Library } from 'bun:ffi';
import { isAbsolute } from 'node:path';
import { loadSystemLibrary } from '../library.ts';

const symbols = { ShellExecuteW: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'i32'], returns: 'i64' } } as const;
let library: Library<typeof symbols> | undefined;

export function checkShellExecuteResult(result: number | bigint): void {
	if (Number(result) <= 32) throw new Error(`Windows could not open the file (ShellExecuteW ${result})`);
}

export function openWindowsPath(path: string): void {
	if (!isAbsolute(path) || path.includes('\0')) throw new Error('Invalid local path');
	const shell = (library ??= loadSystemLibrary('shell32.dll', symbols)).symbols;
	const verb = Buffer.from('open\0', 'utf16le');
	const file = Buffer.from(path + '\0', 'utf16le');
	checkShellExecuteResult(shell.ShellExecuteW(null, ptr(verb), ptr(file), null, null, 1));
}
