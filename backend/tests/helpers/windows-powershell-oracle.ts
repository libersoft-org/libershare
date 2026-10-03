import { readFileSync } from 'node:fs';
import { windowsPowerShellPath } from '../../src/network-helper-windows.ts';

export function windowsOraclePath(): string {
	const executable = process.env['WINDOWS_ORACLE_PWSH'];
	if (!executable) return windowsPowerShellPath();
	if (process.arch === 'arm64') {
		const bytes = readFileSync(executable);
		if (bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4) !== 0xaa64) throw new Error('The Windows ARM64 oracle must run natively');
	}
	return executable;
}
